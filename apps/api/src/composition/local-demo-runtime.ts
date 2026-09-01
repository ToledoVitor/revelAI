import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ApiEnvInput } from "@revelai/config";
import {
  AttemptResultResponseSchema,
  LeaderboardResponseSchema,
  type AttemptOutcome,
} from "@revelai/contracts";
import { parseApiEnv } from "@revelai/config";
import { createProductionTrainingAttemptApi } from "./training-analysis-composition.js";
import {
  openSqliteDatabase,
  type SqliteDatabase,
} from "../database/sqlite-database.js";
import { FfprobeMediaProber } from "../media/ffprobe-media-prober.js";
import {
  createMediaPipeline,
  createMediaPipelineCapability,
} from "../media/media-pipeline.js";
import { SQLiteRetentionRepository } from "../media/sqlite-retention-repository.js";
import { InMemoryAnalysisQueue } from "../queue/in-memory-analysis-queue.js";
import { SQLiteAttemptRepository } from "../repositories/sqlite-attempt-repository.js";
import { SQLiteCompetitivePolicyRepository } from "../repositories/sqlite-competitive-policy-repository.js";
import { createLocalC8AcceptedMediaCleaner } from "../services/local-c8-accepted-media-cleaner.js";
import { createLocalFrameExtraction } from "../storage/local-frame-extraction.js";
import { createLocalMediaStorage } from "../storage/local-media-storage.js";
import {
  createConfiguredVisionProvider,
  createHostFrameProcessRunner,
  preflightMediaBinaries,
  type LocalDemoProcessRunner,
} from "../demo/local-demo-support.js";

export type LocalDemoRuntime = Readonly<{
  app: ReturnType<typeof createProductionTrainingAttemptApi>;
  queue: InMemoryAnalysisQueue;
  database: SqliteDatabase;
  close(): Promise<void>;
  closeResources(): Promise<void>;
  waitForCheckFrameProcess(): Promise<void>;
  releaseCheckFrameProcess(): void;
}>;

type CheckFrameProcessGate = Readonly<{
  wait(): Promise<void>;
  waitUntilBlocked(): Promise<void>;
  release(): void;
  close(): void;
}>;

/**
 * Composes the real C4/C5/C6/C7/C8 root. Check mode changes only the media
 * process/probe edges so CI does not claim host codec proof or need binaries.
 */
export async function createLocalDemoRuntime(
  input: Readonly<{
    check: boolean;
    environment: ApiEnvInput;
    processRunner: LocalDemoProcessRunner;
  }>,
): Promise<LocalDemoRuntime> {
  const config = parseApiEnv(input.environment);
  if (!input.check) await preflightMediaBinaries(input.processRunner);

  let app: ReturnType<typeof createProductionTrainingAttemptApi> | undefined;
  let database: SqliteDatabase | undefined;
  let queue: InMemoryAnalysisQueue | undefined;
  let checkFrameProcessGate: CheckFrameProcessGate | undefined;
  let resourcesClosed = false;
  try {
    await mkdir(config.paths.dataDir, { recursive: true, mode: 0o700 });
    database = openSqliteDatabase(config.paths.databasePath);
    const retention = new SQLiteRetentionRepository({ database });
    checkFrameProcessGate = input.check
      ? createCheckFrameProcessGate()
      : undefined;
    const adapters = input.check
      ? createCheckMediaAdapters(checkFrameProcessGate!)
      : createHostMediaAdapters(input.processRunner);
    const storage = createLocalMediaStorage({
      root: config.paths.mediaDir,
      ids: { next: randomUUID },
      prober: adapters.prober,
    });
    const extraction = createLocalFrameExtraction({
      root: config.paths.mediaDir,
      ids: { next: randomUUID },
      retention,
      runner: adapters.frameRunner,
    });
    const pipeline = createMediaPipeline(
      createMediaPipelineCapability({ storage, extraction }),
    );
    const repository = new SQLiteAttemptRepository({
      database,
      clock: { now: () => new Date().toISOString() },
      ids: { next: randomUUID },
      handoffVerifier: pipeline.handoffVerifier(),
    });
    queue = new InMemoryAnalysisQueue();
    const provider = createConfiguredVisionProvider(config.visionProvider);
    // This durable lookup starts empty. Demo never imports/reads a receipt
    // directory and thus cannot activate a normal competitive policy.
    const policy = new SQLiteCompetitivePolicyRepository({
      database,
      clock: { now: () => new Date().toISOString() },
    });
    app = createProductionTrainingAttemptApi({
      repository,
      retention,
      queue,
      mediaPipeline: pipeline,
      cleaner: createLocalC8AcceptedMediaCleaner({ repository, storage }),
      freeTraining: { provider },
      verifiedTraining: { provider, policy },
    });
    const closeResources = async (): Promise<void> => {
      if (resourcesClosed) return;
      resourcesClosed = true;
      checkFrameProcessGate?.close();
      queue!.close();
      database!.close();
    };
    return Object.freeze({
      app,
      queue,
      database,
      close: async () => {
        // A blocked check-only frame adapter must settle while C4/C5 can still
        // unwind its staged upload. It is never allowed to resume after close.
        checkFrameProcessGate?.close();
        try {
          await app!.close();
        } finally {
          await closeResources();
        }
      },
      closeResources,
      waitForCheckFrameProcess: async () => {
        if (!checkFrameProcessGate)
          throw new Error("Local demo check frame process is unavailable.");
        await checkFrameProcessGate.waitUntilBlocked();
      },
      releaseCheckFrameProcess: () => {
        if (!checkFrameProcessGate)
          throw new Error("Local demo check frame process is unavailable.");
        checkFrameProcessGate.release();
      },
    });
  } catch (error) {
    checkFrameProcessGate?.close();
    await app?.close().catch(() => undefined);
    queue?.close();
    database?.close();
    throw error;
  }
}

/** Runs the same Fastify/C4–C7/worker trace that the executable check owns. */
export async function runLocalDemoCheckTrace(
  runtime: LocalDemoRuntime,
): Promise<AttemptOutcome> {
  const athleteId = randomUUID();
  const athleteHeaders = { "x-revelai-athlete-id": athleteId };
  const [health, ready] = await Promise.all([
    runtime.app.inject({ method: "GET", url: "/health" }),
    runtime.app.inject({ method: "GET", url: "/ready" }),
  ]);
  assertStatus(health.statusCode, 200);
  assertStatus(ready.statusCode, 200);

  const calibration = await runtime.app.inject({
    method: "POST",
    url: "/v1/calibration-sessions",
    headers: athleteHeaders,
    payload: { challengeId: "wall-pass", challengeVersion: 1 },
  });
  assertStatus(calibration.statusCode, 201);
  const calibrationId = opaqueId(calibration.json());
  const readyCalibration = await runtime.app.inject({
    method: "POST",
    url: `/v1/calibration-sessions/${calibrationId}/ready`,
    headers: athleteHeaders,
    payload: {
      requiredGates: ["device", "space", "athlete", "rehearsal", "record"],
    },
  });
  assertStatus(readyCalibration.statusCode, 204);

  const created = await runtime.app.inject({
    method: "POST",
    url: "/v1/attempts",
    headers: athleteHeaders,
    payload: {
      mode: "verified",
      challengeId: "wall-pass",
      challengeVersion: 1,
      calibrationSessionId: calibrationId,
    },
  });
  assertStatus(created.statusCode, 201);
  const attemptId = opaqueId(created.json());
  const boundary = "revelai-check";
  const uploading = runtime.app.inject({
    method: "POST",
    url: `/v1/attempts/${attemptId}/media`,
    headers: {
      ...athleteHeaders,
      "content-type": `multipart/form-data; boundary=${boundary}`,
    },
    payload: multipartFixture(boundary),
  });

  let upload: Awaited<typeof uploading> | undefined;
  try {
    await waitForCheckFrameProcess(runtime);

    const pending = await runtime.app.inject({
      method: "GET",
      url: `/v1/attempts/${attemptId}/result`,
      headers: athleteHeaders,
    });
    assertStatus(pending.statusCode, 202);
    const parsedPending = AttemptResultResponseSchema.safeParse(pending.json());
    if (!parsedPending.success || parsedPending.data.state !== "pending")
      throw new Error(
        "Local demo check did not observe the pending upload state.",
      );
  } finally {
    runtime.releaseCheckFrameProcess();
    upload = await uploading.catch(() => undefined);
  }
  if (!upload)
    throw new Error("Local demo check upload did not settle successfully.");
  assertStatus(upload.statusCode, 202);
  let terminal: AttemptOutcome | undefined;
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await runtime.app.inject({
      method: "GET",
      url: `/v1/attempts/${attemptId}/result`,
      headers: athleteHeaders,
    });
    const parsed = AttemptResultResponseSchema.safeParse(result.json());
    if (result.statusCode === 200 && parsed.success) {
      terminal = parsed.data;
      break;
    }
    if (
      result.statusCode !== 202 ||
      !parsed.success ||
      parsed.data.state !== "pending"
    )
      throw new Error("Local demo check could not parse an attempt result.");
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  if (
    !terminal ||
    terminal.state !== "valid" ||
    terminal.result.kind !== "verified-result" ||
    terminal.result.competitiveStatus !== "demo" ||
    terminal.result.competitiveEligible !== false
  )
    throw new Error("Local demo check did not reach a terminal demo result.");

  const leaderboard = await runtime.app.inject({
    method: "GET",
    url: "/v1/leaderboards/wall-pass?version=1&ruleVersion=wall-pass-v1-score-1&limit=20",
  });
  assertStatus(leaderboard.statusCode, 200);
  const parsedLeaderboard = LeaderboardResponseSchema.safeParse(
    leaderboard.json(),
  );
  if (
    !parsedLeaderboard.success ||
    parsedLeaderboard.data.cohortSize !== 0 ||
    parsedLeaderboard.data.entries.length !== 0
  )
    throw new Error("Local demo check found a normal leaderboard entry.");
  return terminal;
}

function createHostMediaAdapters(processRunner: LocalDemoProcessRunner) {
  return Object.freeze({
    prober: new FfprobeMediaProber({ runner: processRunner }),
    frameRunner: createHostFrameProcessRunner(processRunner),
  });
}

function createCheckMediaAdapters(gate: CheckFrameProcessGate) {
  return Object.freeze({
    prober: Object.freeze({
      probe: async () =>
        Object.freeze({
          container: "mp4" as const,
          durationSeconds: 64,
          displayWidth: 1280,
          displayHeight: 720,
          nominalFps: 30,
          codec: "h264",
          sourceRotationDegrees: 0 as const,
        }),
    }),
    frameRunner: Object.freeze({
      run: async (command: Readonly<{ outputDirectory: string }>) => {
        await gate.wait();
        const timestamps = Array.from(
          { length: 640 },
          (_, index) => index / 10,
        );
        await Promise.all(
          timestamps.map((_, index) =>
            writeFile(
              join(
                command.outputDirectory,
                `decoded-${String(index).padStart(6, "0")}.jpg`,
              ),
              deterministicCheckJpeg,
              { mode: 0o600 },
            ),
          ),
        );
        return Object.freeze({
          exitCode: 0 as const,
          termination: "completed" as const,
          stdout: timestamps
            .slice(40)
            .flatMap((timestamp, index) => [
              `frame:${index} pts:${Math.round(timestamp * 1000)} pts_time:${timestamp.toFixed(6)}`,
              "lavfi.scene_score=0.1",
            ])
            .join("\n"),
          stderr: timestamps
            .map(
              (timestamp, index) =>
                `[Parsed_showinfo_0] n: ${index} pts: ${Math.round(timestamp * 1000)} pts_time:${timestamp.toFixed(6)}`,
            )
            .join("\n"),
        });
      },
    }),
  });
}

function createCheckFrameProcessGate(): CheckFrameProcessGate {
  let resume: () => void = () => undefined;
  let blocked: () => void = () => undefined;
  let released = false;
  let closed = false;
  const releasePromise = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const blockedPromise = new Promise<void>((resolve) => {
    blocked = resolve;
  });
  return Object.freeze({
    wait: async () => {
      blocked();
      await releasePromise;
      if (closed) throw new Error("Local demo check frame process was closed.");
    },
    waitUntilBlocked: () => blockedPromise,
    release: () => {
      if (closed || released) return;
      released = true;
      resume();
    },
    close: () => {
      if (closed) return;
      closed = true;
      resume();
    },
  });
}

async function waitForCheckFrameProcess(
  runtime: LocalDemoRuntime,
): Promise<void> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      runtime.waitForCheckFrameProcess(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () =>
            reject(
              new Error("Local demo check did not reach frame extraction."),
            ),
          5_000,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function opaqueId(value: unknown): string {
  if (
    typeof value !== "object" ||
    value === null ||
    !("id" in value) ||
    typeof value.id !== "string"
  )
    throw new Error("Local demo check received an invalid identifier.");
  return value.id;
}

function assertStatus(actual: number, expected: number): void {
  if (actual !== expected)
    throw new Error(
      `Local demo check received status ${actual} instead of ${expected}.`,
    );
}

function multipartFixture(boundary: string): Buffer {
  return Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="media"; filename="demo.mp4"\r\nContent-Type: video/mp4\r\n\r\n`,
    ),
    Buffer.from([
      0, 0, 0, 16, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 1, 2, 3, 4,
    ]),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
}

const deterministicCheckJpeg = Uint8Array.from(
  Buffer.from(
    "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3+iiigD//2Q==",
    "base64",
  ),
);
