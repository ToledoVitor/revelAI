import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import {
  AttemptListResponseSchema,
  AttemptReadResponseSchema,
  AttemptResultResponseSchema,
  ChallengeListResponseSchema,
  LeaderboardResponseSchema,
  MediaUploadAcceptedSchema,
  RouteErrorSchema,
  WorkflowBenchmarkReceiptSchema,
  passingWorkflowBenchmarkReceiptFixture,
} from "@revelai/contracts";
import {
  createDemoVisionProvider,
  VisionProviderError,
  VisionBatchScheduler,
  type VisionProvider,
} from "@revelai/vision";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProductionTrainingAttemptApi } from "../composition/training-analysis-composition.js";
import { openSqliteDatabase } from "../database/sqlite-database.js";
import { createC5PipelineTestSupport } from "../media/c5-pipeline-test-support.js";
import { SQLiteRetentionRepository } from "../media/sqlite-retention-repository.js";
import { createVerifiedFixtureVisionProvider } from "../processing/c7-fixture.test-support.js";
import {
  emitTestDiagnostic,
  registerTestDiagnostic,
  type TestDiagnostic,
} from "../internal/test-diagnostics.js";
import {
  InMemoryAnalysisQueue,
  type QueueScheduler,
} from "../queue/in-memory-analysis-queue.js";
import {
  resolveProductionSQLiteAttemptProcessingPort,
  SQLiteAttemptRepository,
} from "../repositories/sqlite-attempt-repository.js";
import { SQLiteCompetitivePolicyRepository } from "../repositories/sqlite-competitive-policy-repository.js";
import { createLocalC8AcceptedMediaCleaner } from "../services/local-c8-accepted-media-cleaner.js";
import type { BoundedFrameProcessRunner } from "../storage/local-frame-extraction.js";
import type {
  AtomicMediaRenamer,
  LocalMediaProber,
} from "../storage/local-media-storage.js";

const ATHLETE_ID = "11111111-1111-4111-8111-111111111111";
const NOW = "2030-01-15T12:00:00.000Z";
const FREE_SAMPLE_TIMESTAMP_MS = [
  0, 500, 1000, 1500, 2000, 2500, 3000, 3500, 4000, 4500, 5000, 5500, 6000,
  6500, 7000, 7500, 8100, 8600, 9100, 9600, 10100, 10600, 11100, 11600, 12100,
  12600, 13100, 13600, 14100, 14600, 15100, 15600, 16100, 16600, 17100, 17600,
  18100, 18600, 19100, 19600, 20100, 20600, 21100, 21600, 22100, 22600, 23100,
  23600, 24200, 24700, 25200, 25700, 26200, 26700, 27200, 27700, 28200, 28700,
  29200, 29700, 30200, 30700, 31200, 31700, 32200, 32700, 33200, 33700, 34200,
  34700, 35200, 35700, 36200, 36700, 37200, 37700, 38200, 38700, 39200, 39700,
  40300, 40800, 41300, 41800, 42300, 42800, 43300, 43800, 44300, 44800, 45300,
  45800, 46300, 46800, 47300, 47800, 48300, 48800, 49300, 49800, 50300, 50800,
  51300, 51800, 52300, 52800, 53300, 53800, 54300, 54800, 55300, 55800, 56400,
  56900, 57400, 57900, 58400, 58900, 59400, 59900, 60400, 60900, 61400, 61900,
  62400, 62900, 63400, 63900,
] as const;
const directories: string[] = [];

class ManualScheduler implements QueueScheduler {
  public readonly tasks: Array<() => Promise<void>> = [];
  private readonly hourlyTasks = new Map<number, () => void>();
  private nextHourlyTask = 0;

  public schedule(task: () => Promise<void>): void {
    this.tasks.push(task);
  }

  public async runAll(): Promise<void> {
    while (this.tasks.length > 0) await this.tasks.shift()!();
  }

  public everyHour(task: () => void): number {
    const handle = this.nextHourlyTask;
    this.nextHourlyTask += 1;
    this.hourlyTasks.set(handle, task);
    return handle;
  }

  public cancel(handle: unknown): void {
    if (typeof handle === "number") this.hourlyTasks.delete(handle);
  }

  public async runHourly(): Promise<void> {
    for (const task of this.hourlyTasks.values()) task();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  public get hourlyTaskCount(): number {
    return this.hourlyTasks.size;
  }
}

function runNext(scheduler: ManualScheduler): Promise<void> {
  const task = scheduler.tasks.shift();
  if (!task) throw new Error("C10 expected one scheduled queue delivery");
  return task();
}

function deferred<Value>(): Readonly<{
  promise: Promise<Value>;
  resolve(value: Value): void;
}> {
  let resolve: (value: Value) => void = () => undefined;
  const promise = new Promise<Value>((settle) => {
    resolve = settle;
  });
  return Object.freeze({ promise, resolve });
}

async function waitForC4Boundary(
  gate: Promise<void>,
  operation: string,
): Promise<void> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      gate,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () =>
            reject(
              new Error(
                `C4 ${operation} did not reach its transaction boundary`,
              ),
            ),
          5_000,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Core acceptance through the production Fastify seam", () => {
  it("drives calibration, multipart upload, pending, demo result, and reopen-safe empty live leaderboard", async () => {
    const fixture = await makeRoot({
      verifiedProvider: createDemoVisionProvider(),
      c5Mode: "verified",
    });
    try {
      const challenges = await fixture.app.inject({
        method: "GET",
        url: "/v1/challenges",
      });
      expect(challenges.statusCode).toBe(200);
      expect(
        ChallengeListResponseSchema.parse(challenges.json()).items,
      ).toEqual([
        expect.objectContaining({
          id: "wall-pass",
          version: 1,
        }),
      ]);
      const { attemptId, calibrationId, upload } = await createVerifiedAttempt(
        fixture.app,
      );
      expect(MediaUploadAcceptedSchema.parse(upload)).toEqual({
        kind: "media-upload-accepted",
        attemptId,
        mode: "verified",
        acceptedStatus: "uploaded",
        outcome: {
          state: "pending",
          attemptId,
          mode: "verified",
          status: "uploaded",
        },
      });
      const consumed = await fixture.app.inject({
        method: "POST",
        url: "/v1/attempts",
        headers: athleteHeaders(),
        payload: {
          mode: "verified",
          challengeId: "wall-pass",
          challengeVersion: 1,
          calibrationSessionId: calibrationId,
        },
      });
      expect(consumed.statusCode).toBe(409);
      expect(RouteErrorSchema.parse(consumed.json()).code).toBe(
        "calibration_session_consumed",
      );
      await expectPending(fixture.app, attemptId);
      await expectPrivateMediaTree(fixture, attemptId);
      await fixture.restart();
      await expectPending(fixture.app, attemptId);
      await fixture.scheduler.runAll();
      const result = await resultFor(fixture.app, attemptId);
      expect(result).toMatchObject({
        state: "valid",
        result: {
          kind: "verified-result",
          competitiveStatus: "demo",
          competitiveEligible: false,
        },
      });
      expect(JSON.stringify(result)).not.toMatch(
        /rank|percentile|topPercent|receipt|nonce/i,
      );
      const leaderboard = await fixture.app.inject({
        method: "GET",
        url: "/v1/leaderboards/wall-pass?version=1&ruleVersion=wall-pass-v1-score-1&limit=20",
      });
      expect(LeaderboardResponseSchema.parse(leaderboard.json())).toMatchObject(
        { cohortSize: 0, entries: [] },
      );
      await fixture.queue.enqueue({
        attemptId,
        generation: 1,
        mode: "verified",
      });
      await fixture.scheduler.runAll();
      const persisted = fixture.database.raw
        .prepare(
          "SELECT COUNT(*) AS count FROM terminal_results WHERE attempt_id = ?",
        )
        .get(attemptId);
      expect(persisted).toEqual({ count: 1 });
      await fixture.restart();
      expect(await resultFor(fixture.app, attemptId)).toEqual(result);
    } finally {
      await fixture.close();
    }
  });

  it("keeps a portrait Free multipart flow personal, noncompetitive, and retryable after an incomplete upload", async () => {
    const free = trackedFreeProvider();
    const diagnostics = trackedC10Diagnostics();
    const probeInputs: Array<Readonly<{ magicContainer: string }>> = [];
    const fixture = await makeRoot({
      verifiedProvider: createDemoVisionProvider(),
      freeProvider: free.provider,
      diagnostics: diagnostics.observer,
      approvedPolicy: true,
      c5Mode: "free",
      c5Prober: {
        probe: async (input) => {
          probeInputs.push({ magicContainer: input.magicContainer });
          return Object.freeze({
            container: "mov" as const,
            durationSeconds: 64,
            displayWidth: 720,
            displayHeight: 1280,
            nominalFps: 30,
            codec: "h264",
            sourceRotationDegrees: 0 as const,
          });
        },
      },
    });
    try {
      expect(
        fixture.database.raw
          .prepare(
            "SELECT COUNT(*) AS count FROM approved_competitive_model_policies WHERE active = 1",
          )
          .get(),
      ).toEqual({ count: 1 });
      const created = await fixture.app.inject({
        method: "POST",
        url: "/v1/attempts",
        headers: athleteHeaders(),
        payload: { mode: "free" },
      });
      expect(created.statusCode).toBe(201);
      const attemptId = (created.json() as { id: string }).id;
      await expect(
        fixture.app.inject({
          method: "POST",
          url: `/v1/attempts/${attemptId}/media`,
          headers: multipartHeaders("free-abort"),
          payload: Readable.from(
            (async function* () {
              yield multipart("free-abort").subarray(0, -8);
              throw new Error("client disconnected");
            })(),
          ),
        }),
      ).rejects.toThrow("client disconnected");
      const afterDisconnect = await fixture.app.inject({
        method: "GET",
        url: `/v1/attempts/${attemptId}`,
        headers: athleteHeaders(),
      });
      expect(
        AttemptReadResponseSchema.parse(afterDisconnect.json()),
      ).toMatchObject({
        id: attemptId,
        status: "awaiting-upload",
        mode: "free",
      });
      const upload = await fixture.app.inject({
        method: "POST",
        url: `/v1/attempts/${attemptId}/media`,
        headers: multipartHeaders("free-portrait"),
        payload: multipart("free-portrait", "portrait.mov", "video/quicktime"),
      });
      expect(upload.statusCode).toBe(202);
      expect(MediaUploadAcceptedSchema.parse(upload.json())).toMatchObject({
        attemptId,
        mode: "free",
        outcome: { state: "pending", status: "uploaded" },
      });
      const pending = await resultResponse(fixture.app, attemptId);
      expect(pending.statusCode).toBe(202);
      expect(AttemptResultResponseSchema.parse(pending.json())).toEqual({
        state: "pending",
        attemptId,
        mode: "free",
        status: "uploaded",
      });
      await expectPrivateMediaTree(fixture, attemptId);
      const receipt = await durableReceiptFor(fixture, attemptId);
      await fixture.scheduler.runAll();
      const result = await resultFor(fixture.app, attemptId);
      expect(result).toMatchObject({
        state: "valid",
        result: { kind: "free-insight", approximate: true },
      });
      expect(JSON.stringify(result)).not.toMatch(
        /score|rank|percentile|leaderboard|calibration|verified/i,
      );
      if (result.state !== "valid" || result.result.kind !== "free-insight")
        throw new Error("Free fixture must produce a FreeInsight");
      expect(probeInputs).toEqual([{ magicContainer: "mov" }]);
      expect(free.freeFrames.map((frame) => frame.timestampMs)).toEqual(
        FREE_SAMPLE_TIMESTAMP_MS,
      );
      expect(result.result.observations).toEqual([
        {
          kind: "athlete-visibility",
          unit: "percent",
          value: 100,
          range: "consistent",
        },
        {
          kind: "ball-visibility",
          unit: "percent",
          value: 100,
          range: "consistent",
        },
        {
          kind: "movement-activity",
          unit: "percent",
          value: 100,
          range: "high",
        },
      ]);
      expect(result.result.tips).toEqual([
        "Boa cobertura para uma análise aproximada.",
      ]);
      expect(free.freeCalls).toBe(128);
      expect(free.verifiedCalls).toBe(0);
      expect(diagnostics.freeTerminalPersistenceCalls).toBe(1);
      expect(diagnostics.calls).toEqual({
        calibration: 0,
        integrityScoring: 0,
        policyLookup: 0,
        rankedFinalization: 0,
        leaderboard: 0,
      });
      expect(
        fixture.database.raw
          .prepare(
            "SELECT COUNT(*) AS count FROM approved_competitive_model_policies WHERE active = 1",
          )
          .get(),
      ).toEqual({ count: 1 });
      expect(
        fixture.database.raw
          .prepare(
            "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'c10_free_forbid_%'",
          )
          .get(),
      ).toEqual({ count: 0 });

      expect(receipt).toMatchObject({
        kind: "c5-storage-extraction-receipt-v1",
        authority: { attemptId, mode: "free" },
        activeScenes: null,
        manifest: {
          kind: "extraction-manifest",
          mode: "free",
          display: { width: 720, height: 1280, rotationDegrees: 0 },
          frames: {
            count: 128,
            items: FREE_SAMPLE_TIMESTAMP_MS.map((timestampMs, ordinal) => ({
              ordinal,
              timestampSeconds: timestampMs / 1000,
            })),
          },
        },
      });

      const list = await fixture.app.inject({
        method: "GET",
        url: "/v1/attempts?limit=20",
        headers: athleteHeaders(),
      });
      expect(list.statusCode).toBe(200);
      expect(AttemptListResponseSchema.parse(list.json()).items).toEqual([
        expect.objectContaining({
          id: attemptId,
          mode: "free",
          status: "valid",
        }),
      ]);
      const read = await fixture.app.inject({
        method: "GET",
        url: `/v1/attempts/${attemptId}`,
        headers: athleteHeaders(),
      });
      expect(read.statusCode).toBe(200);
      expect(AttemptReadResponseSchema.parse(read.json())).toMatchObject({
        id: attemptId,
        mode: "free",
        status: "valid",
      });
      const candidate = fixture.database.raw
        .prepare(
          "SELECT candidate_json FROM terminal_results WHERE attempt_id = ?",
        )
        .get(attemptId) as Readonly<{ candidate_json: string }>;
      expect(candidate.candidate_json).toContain("free-insight");
      expect(candidate.candidate_json).not.toMatch(
        /score|rank|policy|calibration|verified|leaderboard/i,
      );
      await fixture.restart();
      expect(await resultFor(fixture.app, attemptId)).toEqual(result);
      expect(free.verifiedCalls).toBe(0);
    } finally {
      await fixture.close();
    }
  });

  it("writes exactly one ranked result only for a parsed receipt and mocked Roboflow provider", async () => {
    const workflowRequests: Array<
      Readonly<{
        url: string;
        init: Readonly<{
          method: string;
          headers: Readonly<Record<string, string>>;
          body: string;
        }>;
      }>
    > = [];
    const fixture = await makeRoot({
      verifiedProvider: createVerifiedFixtureVisionProvider("roboflow", {
        onWorkflowRequest: (url, init) => workflowRequests.push({ url, init }),
      }),
      approvedPolicy: true,
      c5Mode: "verified",
    });
    try {
      const { attemptId } = await createVerifiedAttempt(fixture.app);
      await fixture.queue.enqueue({
        attemptId,
        generation: 1,
        mode: "verified",
      });
      await fixture.scheduler.runAll();
      const result = await resultFor(fixture.app, attemptId);
      expect(result).toMatchObject({
        state: "valid",
        result: {
          competitiveStatus: "ranked",
          competitiveEligible: true,
          rankingSnapshot: { rank: 1, cohortSize: 1 },
        },
      });
      expect(JSON.stringify(result)).not.toMatch(
        /authorization|api[_-]?key|base64/i,
      );
      expect(workflowRequests).toHaveLength(640);
      for (const request of workflowRequests) {
        expect(request.url).toBe(
          "http://127.0.0.1:9001/infer/workflows/revelai-workspace/revelai-wall-pass-geometry-v1",
        );
        expect(request.init).toMatchObject({
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json",
          },
        });
        expect(request.init.headers).not.toHaveProperty("authorization");
        expect(JSON.parse(request.init.body)).toEqual({
          inputs: {
            image: {
              type: "base64",
              value: expect.any(String),
            },
          },
        });
      }
      expect(
        fixture.database.raw
          .prepare(
            "SELECT COUNT(*) AS count FROM leaderboard_entries WHERE attempt_id = ?",
          )
          .get(attemptId),
      ).toEqual({ count: 1 });
    } finally {
      await fixture.close();
    }
  }, 20_000);

  it("keeps HTTP-ranked ties in one live cohort while deletion wins over a queued finalizer", async () => {
    const fixture = await makeRoot({
      verifiedProvider: createVerifiedFixtureVisionProvider("roboflow"),
      approvedPolicy: true,
      c5Mode: "verified",
    });
    try {
      const first = await createVerifiedAttempt(fixture.app);
      const second = await createVerifiedAttempt(fixture.app);
      await fixture.scheduler.runAll();
      const firstResult = await rankedResultFor(fixture.app, first.attemptId);
      const secondResult = await rankedResultFor(fixture.app, second.attemptId);
      expect(firstResult.rankingSnapshot).toMatchObject({
        cohortSize: 1,
        rank: 1,
        percentile: 100,
        topPercent: 0,
      });
      expect(secondResult.rankingSnapshot).toMatchObject({
        cohortSize: 2,
        rank: 1,
        percentile: 100,
        topPercent: 0,
      });

      const live = await liveLeaderboard(fixture.app);
      expect(live).toMatchObject({ cohortSize: 2, nextCursor: null });
      expect(live.entries).toHaveLength(2);
      expect(live.entries.map((entry) => entry.rank)).toEqual([1, 1]);
      expect(live.entries.map((entry) => entry.score)).toEqual([
        firstResult.score,
        secondResult.score,
      ]);
      expect(JSON.stringify(live)).not.toMatch(
        /athlete|media|receipt|policy|provenance|calibration/i,
      );

      const racing = await createVerifiedAttempt(fixture.app);
      const racingRow = fixture.database.raw
        .prepare(
          "SELECT media_json, processing_context_json FROM attempts WHERE id = ?",
        )
        .get(racing.attemptId) as Readonly<{
        media_json: string;
        processing_context_json: string;
      }>;
      const racingMedia = JSON.parse(racingRow.media_json) as Readonly<{
        id: string;
      }>;
      const deleted = fixture.app.inject({
        method: "DELETE",
        url: `/v1/attempts/${racing.attemptId}`,
        headers: athleteHeaders(),
      });
      await Promise.all([fixture.scheduler.runAll(), deleted]);
      expect((await deleted).statusCode).toBe(204);
      const afterDelete = await resultResponse(fixture.app, racing.attemptId);
      expect(afterDelete.statusCode).toBe(404);
      expect(RouteErrorSchema.parse(afterDelete.json()).code).toBe(
        "attempt_not_found",
      );
      expect(await liveLeaderboard(fixture.app)).toMatchObject({
        cohortSize: 2,
      });
      expect(
        fixture.database.raw
          .prepare(
            "SELECT COUNT(*) AS count FROM leaderboard_entries WHERE attempt_id = ?",
          )
          .get(racing.attemptId),
      ).toEqual({ count: 0 });
      expect(
        fixture.database.raw
          .prepare(
            "SELECT COUNT(*) AS count FROM media_retention_records WHERE attempt_id = ? AND cleanup_requested_at = ?",
          )
          .get(racing.attemptId, NOW),
      ).toEqual({ count: 1 });
      await expectPrivateRetainedOriginal(fixture, racingMedia.id);
      expect(fixture.scheduler.tasks).toEqual([]);
      await fixture.restart();
      expect(
        fixture.database.raw
          .prepare(
            "SELECT COUNT(*) AS count FROM media_retention_records WHERE attempt_id = ? AND cleanup_requested_at = ?",
          )
          .get(racing.attemptId, NOW),
      ).toEqual({ count: 1 });
      expect(fixture.scheduler.hourlyTaskCount).toBe(2);
      await fixture.scheduler.runHourly();
      await fixture.stopForDrain();
      await expect(
        lstat(join(fixture.mediaRoot, "originals", racingMedia.id)),
      ).rejects.toThrow();
      expect(
        fixture.database.raw
          .prepare(
            "SELECT COUNT(*) AS count FROM media_retention_records WHERE attempt_id = ?",
          )
          .get(racing.attemptId),
      ).toEqual({ count: 0 });
    } finally {
      await fixture.close();
    }
  }, 20_000);

  it("finalizes equal-score HTTP attempts concurrently through independent SQLite workers", async () => {
    const entered = deferred<void>();
    const release = deferred<void>();
    let arrivals = 0;
    const gatedProvider = () => {
      let gated = false;
      return createVerifiedFixtureVisionProvider("roboflow", {
        beforeWorkflowResponse: async (frameIndex) => {
          if (frameIndex !== 639 || gated) return;
          gated = true;
          arrivals += 1;
          if (arrivals === 2) entered.resolve();
          await release.promise;
        },
      });
    };
    const primary = await makeRoot({
      verifiedProvider: gatedProvider(),
      approvedPolicy: true,
      c5Mode: "verified",
    });
    let secondary: Awaited<ReturnType<typeof makeRoot>> | undefined;
    try {
      secondary = await makeRoot({
        verifiedProvider: gatedProvider(),
        approvedPolicy: true,
        activatePolicy: false,
        c5Mode: "verified",
        root: primary.root,
        repositoryIdPrefix: "cccccccc",
        appIdPrefix: "eeeeeeee",
      });
      const first = await createVerifiedAttempt(primary.app);
      const firstDelivery = runNext(primary.scheduler);
      const second = await createVerifiedAttempt(primary.app);
      await secondary.queue.enqueue({
        attemptId: second.attemptId,
        generation: 1,
        mode: "verified",
      });
      const secondDelivery = runNext(secondary.scheduler);
      await entered.promise;
      expect(arrivals).toBe(2);
      release.resolve();
      await Promise.all([firstDelivery, secondDelivery]);
      await primary.scheduler.runAll();

      const firstResult = await rankedResultFor(primary.app, first.attemptId);
      const secondResult = await rankedResultFor(primary.app, second.attemptId);
      expect(
        [
          firstResult.rankingSnapshot.cohortSize,
          secondResult.rankingSnapshot.cohortSize,
        ].sort(),
      ).toEqual([1, 2]);
      expect(await liveLeaderboard(primary.app)).toMatchObject({
        cohortSize: 2,
        entries: [
          { rank: 1, score: firstResult.score },
          { rank: 1, score: secondResult.score },
        ],
      });
      const ordered = primary.database.raw
        .prepare(
          "SELECT attempt_id, id, completed_at, commit_sequence FROM leaderboard_entries ORDER BY score DESC, completed_at ASC, attempt_id ASC",
        )
        .all() as readonly Readonly<{
        attempt_id: string;
        id: string;
        completed_at: string;
        commit_sequence: number;
      }>[];
      expect(ordered).toHaveLength(2);
      expect(ordered.map((entry) => entry.completed_at)).toEqual([NOW, NOW]);
      expect(ordered.map((entry) => entry.attempt_id)).toEqual(
        [first.attemptId, second.attemptId].sort(),
      );
      expect(ordered.map((entry) => entry.commit_sequence).sort()).toEqual([
        1, 2,
      ]);
      const live = await liveLeaderboard(primary.app);
      expect(live.entries.map((entry) => entry.entryId)).toEqual(
        ordered.map((entry) => entry.id),
      );
      expect(JSON.stringify(live)).not.toContain(ATHLETE_ID);
      const otherVersion = await primary.app.inject({
        method: "GET",
        url: "/v1/leaderboards/wall-pass?version=1&ruleVersion=wall-pass-v1-score-2&limit=20",
      });
      expect(otherVersion.statusCode).toBe(400);
      expect(RouteErrorSchema.parse(otherVersion.json()).code).toBe(
        "invalid_request",
      );
      expect(
        primary.database.raw
          .prepare("SELECT COUNT(*) AS count FROM leaderboard_entries")
          .get(),
      ).toEqual({ count: 2 });
    } finally {
      release.resolve();
      await secondary?.close();
      await primary.close();
    }
  }, 30_000);

  it("coordinates C4 finalization and DELETE at transaction entry without restart resurrection", async () => {
    const finalizationEntered = deferred<void>();
    const tombstoneEntered = deferred<void>();
    const release = deferred<void>();
    const diagnostics = Object.freeze({
      beforeC4TransactionEntry: async (
        input: Readonly<{ operation: string }>,
      ) => {
        if (input.operation === "finalize") finalizationEntered.resolve();
        if (input.operation === "tombstone") tombstoneEntered.resolve();
        await release.promise;
      },
    });
    const primary = await makeRoot({
      verifiedProvider: createVerifiedFixtureVisionProvider("roboflow"),
      approvedPolicy: true,
      c5Mode: "verified",
      diagnostics,
    });
    let secondary: Awaited<ReturnType<typeof makeRoot>> | undefined;
    try {
      secondary = await makeRoot({
        verifiedProvider: createVerifiedFixtureVisionProvider("roboflow"),
        approvedPolicy: true,
        activatePolicy: false,
        c5Mode: "verified",
        root: primary.root,
        repositoryIdPrefix: "cccccccc",
        appIdPrefix: "eeeeeeee",
        diagnostics,
      });
      const attempt = await createVerifiedAttempt(primary.app);
      const finalizer = runNext(primary.scheduler);
      await waitForC4Boundary(finalizationEntered.promise, "finalization");
      const deleting = secondary.app.inject({
        method: "DELETE",
        url: `/v1/attempts/${attempt.attemptId}`,
        headers: athleteHeaders(),
      });
      await waitForC4Boundary(tombstoneEntered.promise, "tombstone");
      for (const table of [
        "terminal_results",
        "leaderboard_entries",
        "canonical_observations",
      ])
        expect(
          primary.database.raw
            .prepare(
              `SELECT COUNT(*) AS count FROM ${table} WHERE attempt_id = ?`,
            )
            .get(attempt.attemptId),
        ).toEqual({ count: 0 });
      release.resolve();
      const [, deleted] = await Promise.all([finalizer, deleting]);
      expect(deleted.statusCode).toBe(204);
      await primary.scheduler.runAll();
      await secondary.close();
      secondary = undefined;
      await primary.restart();
      await primary.scheduler.runAll();
      const missing = await resultResponse(primary.app, attempt.attemptId);
      expect(missing.statusCode).toBe(404);
      expect(RouteErrorSchema.parse(missing.json()).code).toBe(
        "attempt_not_found",
      );
      for (const table of [
        "terminal_results",
        "leaderboard_entries",
        "canonical_observations",
      ])
        expect(
          primary.database.raw
            .prepare(
              `SELECT COUNT(*) AS count FROM ${table} WHERE attempt_id = ?`,
            )
            .get(attempt.attemptId),
        ).toEqual({ count: 0 });
      expect(await liveLeaderboard(primary.app)).toMatchObject({
        cohortSize: 0,
        entries: [],
      });
    } finally {
      release.resolve();
      await secondary?.close();
      await primary.close();
    }
  }, 20_000);

  it("contains queue, media, provider, integrity, and readiness failures at the public seam", async () => {
    const unavailable = await makeRoot({
      verifiedProvider: createDemoVisionProvider(),
      c5Mode: "free",
      queueAvailable: () => false,
    });
    try {
      const attemptId = await createFreeAttempt(unavailable.app);
      const listener = await unavailable.app.listen({
        host: "127.0.0.1",
        port: 0,
      });
      const endpoint = new URL(listener);
      const response = await responseBeforeRequestBody({
        host: endpoint.hostname,
        port: Number(endpoint.port),
        request: [
          `POST /v1/attempts/${attemptId}/media HTTP/1.1`,
          `Host: ${endpoint.host}`,
          `X-RevelAI-Athlete-Id: ${ATHLETE_ID}`,
          "Content-Type: multipart/form-data; boundary=queue-unavailable",
          "Content-Length: 1048576",
          "Connection: close",
          "",
          "",
        ].join("\r\n"),
      });
      expect(response).toMatch(/^HTTP\/1\.1 503 /);
      expect(response).not.toMatch(
        /private-before-body|path|media|sql|stack|base64/i,
      );
      expect(attemptRow(unavailable, attemptId)).toMatchObject({
        status: "awaiting-upload",
        media_json: null,
      });
      const readiness = await unavailable.app.inject({
        method: "GET",
        url: "/ready",
      });
      expect(readiness.statusCode).toBe(503);
      expect(RouteErrorSchema.parse(readiness.json()).code).toBe(
        "service_not_ready",
      );
    } finally {
      await unavailable.close();
    }

    const enqueueFailure = await makeRoot({
      verifiedProvider: createDemoVisionProvider(),
      c5Mode: "free",
      queueBeforeEnqueue: () => {
        throw new Error("injected local queue enqueue rejection");
      },
    });
    try {
      const attemptId = await createFreeAttempt(enqueueFailure.app);
      const response = await enqueueFailure.app.inject({
        method: "POST",
        url: `/v1/attempts/${attemptId}/media`,
        headers: multipartHeaders("enqueue-rollback"),
        payload: multipart("enqueue-rollback", "private-enqueue.mp4"),
      });
      expect(response.statusCode).toBe(503);
      expect(RouteErrorSchema.parse(response.json()).code).toBe(
        "queue_unavailable",
      );
      expect(response.body).not.toMatch(
        /private-enqueue|path|sql|stack|media/i,
      );
      expect(attemptRow(enqueueFailure, attemptId)).toMatchObject({
        status: "awaiting-upload",
        media_json: null,
        processing_context_json: null,
      });
      await expectEmptyMediaDirectories(enqueueFailure);
    } finally {
      await enqueueFailure.close();
    }

    const probeFailure = await makeRoot({
      verifiedProvider: createDemoVisionProvider(),
      c5Mode: "free",
      c5Prober: {
        probe: async () => {
          throw new Error("/private/probe/ffprobe failure");
        },
      },
    });
    try {
      const attemptId = await createFreeAttempt(probeFailure.app);
      const response = await probeFailure.app.inject({
        method: "POST",
        url: `/v1/attempts/${attemptId}/media`,
        headers: multipartHeaders("probe-cleanup"),
        payload: multipart("probe-cleanup", "private-probe.mp4"),
      });
      expect(response.statusCode).toBe(422);
      expect(RouteErrorSchema.parse(response.json()).code).toBe(
        "media_probe_failed",
      );
      expect(response.body).not.toMatch(
        /private-probe|ffprobe|path|stack|sql/i,
      );
      expect(attemptRow(probeFailure, attemptId)).toMatchObject({
        status: "awaiting-upload",
        media_json: null,
      });
      await expectEmptyMediaDirectories(probeFailure);
    } finally {
      await probeFailure.close();
    }

    const extractionFailure = await makeRoot({
      verifiedProvider: createDemoVisionProvider(),
      c5Mode: "free",
      c5Runner: {
        run: async () =>
          Object.freeze({
            exitCode: 1,
            termination: "completed" as const,
            stdout: "",
            stderr: "/private/ffmpeg/extraction-failure",
          }),
      },
    });
    try {
      const attemptId = await createFreeAttempt(extractionFailure.app);
      const response = await extractionFailure.app.inject({
        method: "POST",
        url: `/v1/attempts/${attemptId}/media`,
        headers: multipartHeaders("extraction-cleanup"),
        payload: multipart("extraction-cleanup", "private-extraction.mp4"),
      });
      expect(response.statusCode).toBe(422);
      expect(RouteErrorSchema.parse(response.json()).code).toBe(
        "media_probe_failed",
      );
      expect(response.body).not.toMatch(
        /private-extraction|ffmpeg|path|stack|sql/i,
      );
      expect(attemptRow(extractionFailure, attemptId)).toMatchObject({
        status: "awaiting-upload",
        media_json: null,
      });
      await expectEmptyMediaDirectories(extractionFailure);
    } finally {
      await extractionFailure.close();
    }

    let recoveredWorkflowCalls = 0;
    const recovered = await makeRoot({
      verifiedProvider: createVerifiedFixtureVisionProvider("roboflow", {
        temporaryWorkflowFailures: 1,
        onWorkflowRequest: () => {
          recoveredWorkflowCalls += 1;
        },
      }),
      approvedPolicy: true,
      c5Mode: "verified",
    });
    try {
      const { attemptId } = await createVerifiedAttempt(recovered.app);
      await recovered.scheduler.runAll();
      await rankedResultFor(recovered.app, attemptId);
      expect(recoveredWorkflowCalls).toBeGreaterThan(640);
      expect(
        processingEventCount(recovered, attemptId, "processing-claimed"),
      ).toBe(1);
    } finally {
      await recovered.close();
    }

    const deadline = await makeRoot({
      verifiedProvider: createDemoVisionProvider(),
      c5Mode: "verified",
      verifiedScheduler: immediatelyExpiredVisionScheduler(),
    });
    try {
      const { attemptId } = await createVerifiedAttempt(deadline.app);
      await deadline.scheduler.runAll();
      expect(await resultFor(deadline.app, attemptId)).toMatchObject({
        state: "failed",
        code: "analysis_temporary_unavailable",
        retryable: true,
      });
      expect(
        processingEventCount(deadline, attemptId, "processing-claimed"),
      ).toBe(3);
      expect(await liveLeaderboard(deadline.app)).toMatchObject({
        cohortSize: 0,
        entries: [],
      });
    } finally {
      await deadline.close();
    }

    const exhausted = await makeRoot({
      verifiedProvider: createVerifiedFixtureVisionProvider("roboflow", {
        temporaryWorkflowFailures: Number.POSITIVE_INFINITY,
      }),
      approvedPolicy: true,
      c5Mode: "verified",
    });
    try {
      const { attemptId } = await createVerifiedAttempt(exhausted.app);
      await exhausted.scheduler.runAll();
      const outcome = await resultFor(exhausted.app, attemptId);
      expect(outcome).toMatchObject({
        state: "failed",
        mode: "verified",
        code: "analysis_temporary_unavailable",
        retryable: true,
      });
      expect(
        processingEventCount(exhausted, attemptId, "processing-claimed"),
      ).toBe(3);
      expect(await liveLeaderboard(exhausted.app)).toMatchObject({
        cohortSize: 0,
        entries: [],
      });
      expect(JSON.stringify(outcome)).not.toMatch(
        /authorization|api[_-]?key|payload|evidence|stack|sql/i,
      );
    } finally {
      await exhausted.close();
    }

    const invalid = await makeRoot({
      verifiedProvider: createDemoVisionProvider({
        free: "free-well-framed-active-v1",
        verified: "wall-pass-insufficient-v1",
      }),
      c5Mode: "verified",
    });
    try {
      const { attemptId } = await createVerifiedAttempt(invalid.app);
      await invalid.scheduler.runAll();
      const outcome = await resultFor(invalid.app, attemptId);
      expect(outcome).toMatchObject({
        state: "invalid",
        mode: "verified",
        code: "calibration_not_verified",
        retryable: true,
      });
      expect(JSON.stringify(outcome)).not.toMatch(
        /nonce|homography|reprojection|drift|confidence|threshold|evidence/i,
      );
      expect(await liveLeaderboard(invalid.app)).toMatchObject({
        cohortSize: 0,
        entries: [],
      });
    } finally {
      await invalid.close();
    }

    const cameraContinuity = await makeRoot({
      verifiedProvider: createVerifiedFixtureVisionProvider("roboflow", {
        fiducialXOffsetForFrame: (frameIndex) => (frameIndex >= 320 ? 80 : 0),
      }),
      c5Mode: "verified",
    });
    try {
      const { attemptId } = await createVerifiedAttempt(cameraContinuity.app);
      await cameraContinuity.scheduler.runAll();
      const outcome = await resultFor(cameraContinuity.app, attemptId);
      expect(outcome).toMatchObject({
        state: "invalid",
        code: "calibration_not_verified",
        retryable: true,
      });
      expect(JSON.stringify(outcome)).not.toMatch(
        /homography|camera|fiducial|drift|evidence|payload/i,
      );
      expect(await liveLeaderboard(cameraContinuity.app)).toMatchObject({
        cohortSize: 0,
        entries: [],
      });
    } finally {
      await cameraContinuity.close();
    }
  }, 30_000);

  it("enters unobserved C4 finalization and tombstone transactions before its caller continues", async () => {
    const fixture = await makeRoot({
      verifiedProvider: createDemoVisionProvider(),
      c5Mode: "free",
    });
    try {
      const attemptId = await createFreeAttempt(fixture.app);
      const uploaded = await fixture.app.inject({
        method: "POST",
        url: `/v1/attempts/${attemptId}/media`,
        headers: multipartHeaders("unobserved-c4-order"),
        payload: multipart("unobserved-c4-order"),
      });
      expect(uploaded.statusCode).toBe(202);
      const claim = await fixture.repository.claimProcessing({
        attemptId,
        generation: 1,
        mode: "free",
      });
      if (!claim) throw new Error("C10 ordering fixture requires a claim");

      const calls: string[] = [];
      const exec = fixture.database.raw.exec.bind(fixture.database.raw);
      const execSpy = vi
        .spyOn(fixture.database.raw, "exec")
        .mockImplementation((sql) => {
          if (sql === "BEGIN IMMEDIATE" || sql === "COMMIT") calls.push(sql);
          return exec(sql);
        });
      try {
        const finalizing = fixture.repository.finalizeTerminalResult({
          attemptId,
          generation: claim.generation,
          leaseId: claim.leaseId,
          candidate: {
            state: "failed",
            attemptId,
            mode: "free",
            code: "analysis_temporary_unavailable",
            message: "A análise está indisponível temporariamente.",
            retryable: true,
          },
        });
        calls.push("finalize-caller-next");
        expect(calls).toEqual([
          "BEGIN IMMEDIATE",
          "COMMIT",
          "finalize-caller-next",
        ]);
        await finalizing;

        calls.splice(0);
        const tombstoning = fixture.repository.tombstoneAttempt({
          attemptId,
          athleteId: ATHLETE_ID,
        });
        calls.push("tombstone-caller-next");
        expect(calls).toEqual([
          "BEGIN IMMEDIATE",
          "COMMIT",
          "tombstone-caller-next",
        ]);
        await tombstoning;
      } finally {
        execSpy.mockRestore();
      }
    } finally {
      await fixture.close();
    }
  });

  it("clears the C4 transaction-boundary deadline after its barrier opens", async () => {
    vi.useFakeTimers();
    try {
      const boundary = deferred<void>();
      const waiting = waitForC4Boundary(boundary.promise, "timer cleanup");
      expect(vi.getTimerCount()).toBe(1);

      boundary.resolve();
      await waiting;

      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("contains private diagnostic failures without changing Free terminal behavior", async () => {
    const fixture = await makeRoot({
      verifiedProvider: createDemoVisionProvider(),
      c5Mode: "free",
      diagnostics: Object.freeze({
        onEvent: () => {
          throw new Error("test diagnostic must not affect production flow");
        },
        beforeC4TransactionEntry: () => {
          throw new Error("test barrier must not affect production flow");
        },
      }),
    });
    try {
      const attemptId = await createFreeAttempt(fixture.app);
      const uploaded = await fixture.app.inject({
        method: "POST",
        url: `/v1/attempts/${attemptId}/media`,
        headers: multipartHeaders("diagnostic-containment"),
        payload: multipart("diagnostic-containment"),
      });
      expect(uploaded.statusCode).toBe(202);
      await fixture.scheduler.runAll();
      await expect(resultFor(fixture.app, attemptId)).resolves.toMatchObject({
        state: "valid",
        result: { kind: "free-insight" },
      });
    } finally {
      await fixture.close();
    }
  });

  it("removes real root diagnostic registrations before close returns", async () => {
    const events: string[] = [];
    const fixture = await makeRoot({
      verifiedProvider: createDemoVisionProvider(),
      c5Mode: "verified",
      diagnostics: Object.freeze({
        onEvent: () => events.push("observed"),
      }),
    });

    await fixture.close();
    emitTestDiagnostic(fixture.repository, { kind: "policy-lookup" });

    expect(events).toEqual([]);
  });

  it("contains real local-storage create, chmod, publication, traversal, and symlink failures", async () => {
    const createFailure = await makeRoot({
      verifiedProvider: createDemoVisionProvider(),
      c5Mode: "free",
    });
    try {
      await writeFile(createFailure.mediaRoot, "C10 media root is a file", {
        mode: 0o600,
      });
      const attemptId = await createFreeAttempt(createFailure.app);
      const response = await createFailure.app.inject({
        method: "POST",
        url: `/v1/attempts/${attemptId}/media`,
        headers: multipartHeaders("storage-create"),
        payload: multipart("storage-create", "C10-create-private.mp4"),
      });
      expect(response.statusCode).toBe(422);
      expect(RouteErrorSchema.parse(response.json()).code).toBe(
        "media_probe_failed",
      );
      expect(response.body).not.toMatch(
        /C10-create|root is a file|path|stack|sql/i,
      );
      expect(attemptRow(createFailure, attemptId)).toMatchObject({
        status: "awaiting-upload",
        media_json: null,
      });
    } finally {
      await createFailure.close();
    }

    const writeFailure = await makeRoot({
      verifiedProvider: createDemoVisionProvider(),
      c5Mode: "free",
    });
    const writePrototypeHandle = await open(
      join(writeFailure.root, ".c10-filehandle-prototype"),
      "w",
      0o600,
    );
    const writeSpy = vi
      .spyOn(Object.getPrototypeOf(writePrototypeHandle), "write")
      .mockRejectedValueOnce(
        new Error("C10 real FileHandle.write fault /private/write"),
      );
    try {
      const attemptId = await createFreeAttempt(writeFailure.app);
      const response = await writeFailure.app.inject({
        method: "POST",
        url: `/v1/attempts/${attemptId}/media`,
        headers: multipartHeaders("storage-write"),
        payload: multipart("storage-write", "C10-write-private.mp4"),
      });
      expect(response.statusCode).toBe(422);
      expect(RouteErrorSchema.parse(response.json()).code).toBe(
        "media_probe_failed",
      );
      expect(response.body).not.toMatch(
        /C10|FileHandle|private|path|stack|sql/i,
      );
      expect(attemptRow(writeFailure, attemptId)).toMatchObject({
        status: "awaiting-upload",
        media_json: null,
      });
      await expectEmptyMediaDirectories(writeFailure);
      await expectNoTemporaryOrPublicationFacts(writeFailure, attemptId);
      await writeFailure.restart();
      await expectEmptyMediaDirectories(writeFailure);
    } finally {
      writeSpy.mockRestore();
      await writePrototypeHandle.close();
      await rm(join(writeFailure.root, ".c10-filehandle-prototype"), {
        force: true,
      });
      await writeFailure.close();
    }

    let temporaryDirectory = "";
    const chmodFailure = await makeRoot({
      verifiedProvider: createDemoVisionProvider(),
      c5Mode: "free",
      c5Prober: {
        probe: async () => {
          await chmod(temporaryDirectory, 0o000);
          return Object.freeze({
            container: "mp4" as const,
            durationSeconds: 64,
            displayWidth: 1280,
            displayHeight: 720,
            nominalFps: 30,
            codec: "h264",
            sourceRotationDegrees: 0 as const,
          });
        },
      },
    });
    temporaryDirectory = join(chmodFailure.mediaRoot, "temporary");
    try {
      const attemptId = await createFreeAttempt(chmodFailure.app);
      const response = await chmodFailure.app.inject({
        method: "POST",
        url: `/v1/attempts/${attemptId}/media`,
        headers: multipartHeaders("storage-chmod"),
        payload: multipart("storage-chmod", "C10-chmod-private.mp4"),
      });
      expect(response.statusCode).toBe(422);
      expect(RouteErrorSchema.parse(response.json()).code).toBe(
        "media_probe_failed",
      );
      expect(response.body).not.toMatch(/C10-chmod|chmod|path|stack|sql/i);
      expect(attemptRow(chmodFailure, attemptId)).toMatchObject({
        status: "awaiting-upload",
        media_json: null,
      });
    } finally {
      await chmod(temporaryDirectory, 0o700).catch(() => undefined);
      await chmodFailure.scheduler.runHourly();
      await chmodFailure.close();
    }

    const publicationFailure = await makeRoot({
      verifiedProvider: createDemoVisionProvider(),
      c5Mode: "free",
      c5Renamer: {
        rename: async () => {
          throw new Error("C10 production rename fault /private/payload");
        },
      },
    });
    try {
      const attemptId = await createFreeAttempt(publicationFailure.app);
      const response = await publicationFailure.app.inject({
        method: "POST",
        url: `/v1/attempts/${attemptId}/media`,
        headers: multipartHeaders("storage-publication"),
        payload: multipart(
          "storage-publication",
          "C10-publication-private.mp4",
        ),
      });
      expect(response.statusCode).toBe(422);
      expect(RouteErrorSchema.parse(response.json()).code).toBe(
        "media_probe_failed",
      );
      expect(response.body).not.toMatch(
        new RegExp(
          "C10-publication|production rename|private/payload|path|stack|sql",
          "i",
        ),
      );
      expect(attemptRow(publicationFailure, attemptId)).toMatchObject({
        status: "awaiting-upload",
        media_json: null,
      });
      await expectEmptyMediaDirectories(publicationFailure);
      await expectNoTemporaryOrPublicationFacts(publicationFailure, attemptId);
      await publicationFailure.restart();
      await expectEmptyMediaDirectories(publicationFailure);
    } finally {
      await publicationFailure.close();
    }

    const hostile = await makeRoot({
      verifiedProvider: createDemoVisionProvider(),
      c5Mode: "free",
    });
    try {
      const outside = join(hostile.root, "C10-outside-private.txt");
      await writeFile(outside, "unchanged", { mode: 0o600 });
      await mkdir(join(hostile.mediaRoot, "originals"), { recursive: true });
      await symlink(
        outside,
        join(
          hostile.mediaRoot,
          "originals",
          "dddddddd-dddd-4ddd-8ddd-000000000000",
        ),
      );
      const symlinkAttempt = await createFreeAttempt(hostile.app);
      const symlinkResponse = await hostile.app.inject({
        method: "POST",
        url: `/v1/attempts/${symlinkAttempt}/media`,
        headers: multipartHeaders("storage-symlink"),
        payload: multipart("storage-symlink", "C10-symlink-private.mp4"),
      });
      expect(symlinkResponse.statusCode).toBe(422);
      expect(RouteErrorSchema.parse(symlinkResponse.json()).code).toBe(
        "media_probe_failed",
      );
      expect(await readFile(outside, "utf8")).toBe("unchanged");
      expect(attemptRow(hostile, symlinkAttempt)).toMatchObject({
        status: "awaiting-upload",
        media_json: null,
      });

      await unlink(
        join(
          hostile.mediaRoot,
          "originals",
          "dddddddd-dddd-4ddd-8ddd-000000000000",
        ),
      );
      const traversalAttempt = await createFreeAttempt(hostile.app);
      const traversal = await hostile.app.inject({
        method: "POST",
        url: `/v1/attempts/${traversalAttempt}/media`,
        headers: multipartHeaders("storage-traversal"),
        payload: multipart(
          "storage-traversal",
          "../../C10-traversal-private.mp4",
        ),
      });
      expect(traversal.statusCode).toBe(202);
      expect(traversal.body).not.toMatch(/C10-traversal|\.\.|path|stack|sql/i);
      await expectPrivateMediaTree(hostile, traversalAttempt);
      expect(await readFile(outside, "utf8")).toBe("unchanged");
    } finally {
      await hostile.close();
    }
  }, 20_000);

  it("never returns or logs injected provider secrets, media bytes, or private storage facts", async () => {
    const apiKey = "rf_C10_API_KEY_SENTINEL_8be37d";
    const authorization = "Bearer C10_AUTHORIZATION_SENTINEL_5d94a1";
    const mediaBytes = "C10_MEDIA_BYTES_SENTINEL_4fa91b";
    const rawPayload = "C10_RAW_PROVIDER_PAYLOAD_SENTINEL_7ac22e";
    const filename = "C10_FILENAME_SENTINEL_0e56ab.mp4";
    const rawPath = "/private/C10_PATH_SENTINEL_2c8a50";
    const rawSql = "SELECT C10_SQL_SENTINEL_89ad2e";
    const calibration = "C10_CALIBRATION_SENTINEL_9146bc";
    const evidence = "C10_EVIDENCE_SENTINEL_7fe243";
    const logs: unknown[] = [];
    const workflowBodies: string[] = [];
    const providerFailure = new Error(
      [rawPayload, rawPath, rawSql, calibration, evidence].join(" "),
    );
    providerFailure.stack = `C10_STACK_SENTINEL_1da762 ${providerFailure.message}`;
    const fixture = await makeRoot({
      verifiedProvider: createVerifiedFixtureVisionProvider("roboflow", {
        apiKey,
        apiUrl: "https://roboflow.c10.invalid",
        onWorkflowRequest: (_url, init) => workflowBodies.push(init.body),
        workflowError: providerFailure,
      }),
      approvedPolicy: true,
      c5Mode: "verified",
      logs,
    });
    try {
      const { attemptId, upload, uploadBody } = await createVerifiedAttempt(
        fixture.app,
        {
          authorization,
          boundary: "redaction-sentinel",
          filename,
          payloadSuffix: mediaBytes,
        },
      );
      await fixture.scheduler.runAll();
      const result = await resultResponse(fixture.app, attemptId);
      const listed = await fixture.app.inject({
        method: "GET",
        url: "/v1/attempts?limit=20",
        headers: athleteHeaders(),
      });
      const leaderboard = await fixture.app.inject({
        method: "GET",
        url: "/v1/leaderboards/wall-pass?version=1&ruleVersion=wall-pass-v1-score-1&limit=20",
      });
      expect(result.statusCode).toBe(200);
      expect(AttemptResultResponseSchema.parse(result.json())).toMatchObject({
        state: "failed",
        code: "analysis_configuration_invalid",
      });
      expect(workflowBodies).not.toEqual([]);
      expect(workflowBodies.every((body) => body.includes(apiKey))).toBe(true);
      const candidate = fixture.database.raw
        .prepare(
          "SELECT candidate_json FROM terminal_results WHERE attempt_id = ?",
        )
        .get(attemptId) as Readonly<{ candidate_json: string }>;
      expectNoLeaks(
        [
          upload,
          uploadBody,
          result.body,
          listed.body,
          leaderboard.body,
          candidate.candidate_json,
          JSON.stringify(logs),
        ],
        [
          apiKey,
          authorization,
          mediaBytes,
          rawPayload,
          filename,
          rawPath,
          rawSql,
          calibration,
          evidence,
          "C10_STACK_SENTINEL_1da762",
          fixture.root,
          ATHLETE_ID,
          "api_key",
          "authorization",
          "base64",
          "rawPayload",
          "stack",
          "sql",
          "calibration",
          "evidence",
        ],
      );
    } finally {
      await fixture.close();
    }
  });

  it("keeps a tombstone durable when local deletion fails, then retries after restart", async () => {
    const fixture = await makeRoot({
      verifiedProvider: createDemoVisionProvider(),
      c5Mode: "free",
    });
    try {
      const attemptId = await createFreeAttempt(fixture.app);
      const upload = await fixture.app.inject({
        method: "POST",
        url: `/v1/attempts/${attemptId}/media`,
        headers: multipartHeaders("tombstone-retry"),
        payload: multipart("tombstone-retry"),
      });
      expect(upload.statusCode).toBe(202);
      await fixture.scheduler.runAll();
      const media = JSON.parse(
        (
          fixture.database.raw
            .prepare("SELECT media_json FROM attempts WHERE id = ?")
            .get(attemptId) as Readonly<{ media_json: string }>
        ).media_json,
      ) as Readonly<{ id: string }>;
      const original = join(fixture.mediaRoot, "originals", media.id);
      await chmod(join(fixture.mediaRoot, "originals"), 0o500);
      const deleted = await fixture.app.inject({
        method: "DELETE",
        url: `/v1/attempts/${attemptId}`,
        headers: athleteHeaders(),
      });
      expect(deleted.statusCode).toBe(204);
      await fixture.scheduler.runHourly();
      expect(
        fixture.database.raw
          .prepare(
            "SELECT COUNT(*) AS count FROM media_retention_records WHERE attempt_id = ? AND cleanup_requested_at = ?",
          )
          .get(attemptId, NOW),
      ).toEqual({ count: 1 });
      await expect(lstat(original)).resolves.toMatchObject({});
      await chmod(join(fixture.mediaRoot, "originals"), 0o700);
      await fixture.restart();
      await fixture.scheduler.runHourly();
      await fixture.stopForDrain();
      await expect(lstat(original)).rejects.toThrow();
      expect(
        fixture.database.raw
          .prepare(
            "SELECT COUNT(*) AS count FROM media_retention_records WHERE attempt_id = ?",
          )
          .get(attemptId),
      ).toEqual({ count: 0 });
      expect(
        fixture.database.raw
          .prepare(
            "SELECT COUNT(*) AS count FROM attempts WHERE id = ? AND deletion_state = 'tombstoned'",
          )
          .get(attemptId),
      ).toEqual({ count: 1 });
    } finally {
      await chmod(join(fixture.mediaRoot, "originals"), 0o700).catch(
        () => undefined,
      );
      await fixture.close();
    }
  });

  it("reclaims an expired HTTP-upload processing lease, then persists a dead letter across restart", async () => {
    const fixture = await makeRoot({
      verifiedProvider: createDemoVisionProvider(),
      c5Mode: "free",
    });
    try {
      const attemptId = await createFreeAttempt(fixture.app);
      const uploaded = await fixture.app.inject({
        method: "POST",
        url: `/v1/attempts/${attemptId}/media`,
        headers: multipartHeaders("lease-reclaim"),
        payload: multipart("lease-reclaim"),
      });
      expect(uploaded.statusCode).toBe(202);
      const first = await fixture.repository.claimProcessing({
        attemptId,
        generation: 1,
        mode: "free",
      });
      expect(first).toMatchObject({ generation: 1, mode: "free" });
      expect(await resultResponse(fixture.app, attemptId)).toMatchObject({
        statusCode: 202,
      });
      await fixture.restart();
      fixture.setNow("2030-01-15T12:06:00.000Z");
      const reclaimed = await fixture.repository.claimProcessing({
        attemptId,
        generation: 1,
        mode: "free",
      });
      expect(reclaimed).toMatchObject({ generation: 1, mode: "free" });
      if (!first || !reclaimed)
        throw new Error("C10 lease fixture must produce both claims");
      expect(reclaimed.leaseId).not.toBe(first.leaseId);
      await expect(
        fixture.repository.deadLetterProcessingClaim({
          attemptId,
          generation: 1,
          leaseId: reclaimed.leaseId,
        }),
      ).resolves.toEqual({ kind: "dead-lettered" });
      expect(
        fixture.database.raw
          .prepare(
            "SELECT retry_attempts, state FROM processing_recovery_records WHERE attempt_id = ? AND generation = 1",
          )
          .get(attemptId),
      ).toEqual({ retry_attempts: 1, state: "dead-lettered" });
      await fixture.restart();
      expect(
        await fixture.repository.claimProcessing({
          attemptId,
          generation: 1,
          mode: "free",
        }),
      ).toBeNull();
      expect(
        fixture.database.raw
          .prepare(
            "SELECT COUNT(*) AS count FROM terminal_results WHERE attempt_id = ?",
          )
          .get(attemptId),
      ).toEqual({ count: 0 });
      const pending = await resultResponse(fixture.app, attemptId);
      expect(pending.statusCode).toBe(202);
      expect(AttemptResultResponseSchema.parse(pending.json())).toMatchObject({
        state: "pending",
        status: "uploaded",
      });
      await fixture.scheduler.runAll();
      expect(fixture.scheduler.tasks).toEqual([]);
    } finally {
      await fixture.close();
    }
  });

  it("uses worker deliveries for before-expiry, exact-expiry, and max-budget lease recovery", async () => {
    const base = createDemoVisionProvider();
    const entered = deferred<void>();
    const release = deferred<void>();
    let freeCalls = 0;
    let carryInAttemptId: string | undefined;
    const fixture = await makeRoot({
      verifiedProvider: createDemoVisionProvider(),
      c5Mode: "free",
      freeProvider: Object.freeze({
        ...base,
        analyzeFree: async (
          ...args: Parameters<VisionProvider["analyzeFree"]>
        ) => {
          freeCalls += 1;
          if (args[0].attemptId === carryInAttemptId)
            throw new VisionProviderError("provider_temporary_unavailable");
          if (freeCalls === 1) {
            entered.resolve();
            await release.promise;
          }
          return base.analyzeFree(...args);
        },
      }) satisfies VisionProvider,
    });
    try {
      const attemptId = await createFreeAttempt(fixture.app);
      const upload = await fixture.app.inject({
        method: "POST",
        url: `/v1/attempts/${attemptId}/media`,
        headers: multipartHeaders("lease-worker"),
        payload: multipart("lease-worker"),
      });
      expect(upload.statusCode).toBe(202);
      const firstDelivery = runNext(fixture.scheduler);
      await entered.promise;
      expect(
        processingEventCount(fixture, attemptId, "processing-claimed"),
      ).toBe(1);

      fixture.setNow("2030-01-15T12:04:59.999Z");
      await fixture.queue.enqueue({ attemptId, generation: 1, mode: "free" });
      await runNext(fixture.scheduler);
      expect(
        processingEventCount(fixture, attemptId, "processing-claimed"),
      ).toBe(1);

      fixture.setNow("2030-01-15T12:05:00.000Z");
      await fixture.queue.enqueue({ attemptId, generation: 1, mode: "free" });
      await runNext(fixture.scheduler);
      expect(
        processingEventCount(fixture, attemptId, "processing-claimed"),
      ).toBe(2);
      expect(await resultFor(fixture.app, attemptId)).toMatchObject({
        state: "valid",
        result: { kind: "free-insight" },
      });
      release.resolve();
      await firstDelivery;
      await fixture.scheduler.runAll();
      expect(
        fixture.database.raw
          .prepare(
            "SELECT COUNT(*) AS count FROM terminal_results WHERE attempt_id = ?",
          )
          .get(attemptId),
      ).toEqual({ count: 1 });

      const carryIn = await createFreeAttempt(fixture.app);
      const carryUpload = await fixture.app.inject({
        method: "POST",
        url: `/v1/attempts/${carryIn}/media`,
        headers: multipartHeaders("lease-carry-in"),
        payload: multipart("lease-carry-in"),
      });
      expect(carryUpload.statusCode).toBe(202);
      fixture.database.raw
        .prepare(
          "INSERT INTO processing_recovery_records (attempt_id, generation, retry_attempts, state, created_at, updated_at) VALUES (?, 1, ?, 'retrying', ?, ?)",
        )
        .run(carryIn, Number.MAX_SAFE_INTEGER, NOW, NOW);
      carryInAttemptId = carryIn;
      await fixture.scheduler.runAll();
      expect(await resultFor(fixture.app, carryIn)).toMatchObject({
        state: "failed",
        mode: "free",
        code: "analysis_temporary_unavailable",
        retryable: true,
      });
      expect(processingEventCount(fixture, carryIn, "processing-claimed")).toBe(
        1,
      );
      expect(processingEventCount(fixture, carryIn, "processing-failed")).toBe(
        1,
      );
      expect(await liveLeaderboard(fixture.app)).toMatchObject({
        cohortSize: 0,
        entries: [],
      });
    } finally {
      release.resolve();
      await fixture.close();
    }
  }, 20_000);

  it("redacts real database and storage readiness failures and catches scheduled run failures", async () => {
    const databaseLogs: unknown[] = [];
    const databaseFailure = await makeRoot({
      verifiedProvider: createDemoVisionProvider(),
      c5Mode: "free",
      logs: databaseLogs,
    });
    try {
      databaseFailure.database.close();
      const response = await databaseFailure.app.inject({
        method: "GET",
        url: "/ready",
      });
      expect(response.statusCode).toBe(503);
      expect(RouteErrorSchema.parse(response.json())).toMatchObject({
        code: "service_not_ready",
        retryable: true,
      });
      expect(response.body).not.toMatch(/sqlite|database|path|sql|stack/i);
      await databaseFailure.scheduler.runHourly();
      await databaseFailure.stopForDrain();
      expect(databaseLogs).toEqual(
        expect.arrayContaining([
          { category: "media_delivery_recovery_run_failed" },
          { category: "retention_cleanup_run_failed" },
        ]),
      );
      expect(JSON.stringify(databaseLogs)).not.toMatch(
        /sqlite|api\.sqlite|path|sql|stack|11111111/i,
      );
    } finally {
      await databaseFailure.close();
    }

    const storageFailure = await makeRoot({
      verifiedProvider: createDemoVisionProvider(),
      c5Mode: "free",
    });
    try {
      await rm(storageFailure.mediaRoot, { recursive: true, force: true });
      await writeFile(storageFailure.mediaRoot, "not-a-directory", {
        mode: 0o600,
      });
      const response = await storageFailure.app.inject({
        method: "GET",
        url: "/ready",
      });
      expect(response.statusCode).toBe(503);
      expect(RouteErrorSchema.parse(response.json())).toMatchObject({
        code: "service_not_ready",
        retryable: true,
      });
      expect(response.body).not.toMatch(
        /not-a-directory|media|path|filesystem|stack/i,
      );
    } finally {
      await storageFailure.close();
    }
  });

  it("table-drives every competitive receipt and tuple mismatch to zero leaderboard impact", async () => {
    const cases: readonly Readonly<{
      name: string;
      activePolicy?: boolean;
      receiptMutation?: "failed" | "stale" | "missing";
      invalidate?: boolean;
      provider?: VisionProvider;
      policyColumn?:
        | "workspace_id"
        | "model_bundle_id"
        | "provider_version"
        | "calibration_evidence_version"
        | "extraction_evidence_version"
        | "observation_evidence_version";
      expected: "experimental" | "configuration-failed";
    }>[] = [
      {
        name: "missing receipt",
        activePolicy: true,
        receiptMutation: "missing",
        expected: "experimental",
      },
      {
        name: "active receipt changed to failed",
        activePolicy: true,
        receiptMutation: "failed",
        expected: "experimental",
      },
      {
        name: "active receipt changed to stale",
        activePolicy: true,
        receiptMutation: "stale",
        expected: "experimental",
      },
      {
        name: "invalidated receipt",
        activePolicy: true,
        invalidate: true,
        expected: "experimental",
      },
      {
        name: "provider workspace tuple",
        activePolicy: true,
        provider: createVerifiedFixtureVisionProvider("roboflow", {
          workspaceId: "unapproved-workspace",
        }),
        expected: "experimental",
      },
      {
        name: "provider model tuple",
        activePolicy: true,
        provider: createVerifiedFixtureVisionProvider("roboflow", {
          verifiedModelBundleId: "unapproved-wall-pass-bundle-v1",
        }),
        expected: "experimental",
      },
      {
        name: "provider version tuple",
        activePolicy: true,
        provider: createVerifiedFixtureVisionProvider("roboflow", {
          verifiedProviderVersion: "unapproved-provider-v2",
        }),
        expected: "experimental",
      },
      {
        name: "malformed workflow-id contract configuration",
        activePolicy: true,
        provider: createVerifiedFixtureVisionProvider("roboflow", {
          workflowId: "unexpected-workflow-id",
        }),
        expected: "configuration-failed",
      },
      {
        name: "malformed workflow-version contract configuration",
        activePolicy: true,
        provider: createVerifiedFixtureVisionProvider("roboflow", {
          workflowVersion: "2.0.0",
        }),
        expected: "configuration-failed",
      },
      {
        name: "stored workspace tuple",
        activePolicy: true,
        policyColumn: "workspace_id",
        expected: "experimental",
      },
      {
        name: "stored model tuple",
        activePolicy: true,
        policyColumn: "model_bundle_id",
        expected: "experimental",
      },
      {
        name: "stored provider-version tuple",
        activePolicy: true,
        policyColumn: "provider_version",
        expected: "experimental",
      },
      {
        name: "stored calibration-evidence tuple",
        activePolicy: true,
        policyColumn: "calibration_evidence_version",
        expected: "experimental",
      },
      {
        name: "stored extraction-evidence tuple",
        activePolicy: true,
        policyColumn: "extraction_evidence_version",
        expected: "experimental",
      },
      {
        name: "stored observation-evidence tuple",
        activePolicy: true,
        policyColumn: "observation_evidence_version",
        expected: "experimental",
      },
    ];
    for (const scenario of cases) {
      const fixture = await makeRoot({
        verifiedProvider:
          scenario.provider ?? createVerifiedFixtureVisionProvider("roboflow"),
        ...(scenario.activePolicy ? { approvedPolicy: true } : {}),
        c5Mode: "verified",
      });
      try {
        if (scenario.activePolicy) {
          if (!fixture.policy)
            throw new Error("C10 active-policy fixture requires policy");
          expect(
            await fixture.policy.getActiveCompetitivePolicy(competitiveTuple()),
            `${scenario.name}: baseline policy`,
          ).not.toBeNull();
        }
        if (scenario.receiptMutation === "failed")
          fixture.database.raw
            .prepare(
              "UPDATE workflow_benchmark_receipts SET status = 'failed' WHERE id = ?",
            )
            .run(passingWorkflowBenchmarkReceiptFixture.id);
        if (scenario.receiptMutation === "stale")
          fixture.database.raw
            .prepare(
              "UPDATE workflow_benchmark_receipts SET valid_until = ? WHERE id = ?",
            )
            .run(
              "2030-01-15T11:59:59.999Z",
              passingWorkflowBenchmarkReceiptFixture.id,
            );
        if (scenario.receiptMutation === "missing") {
          fixture.database.raw.pragma("foreign_keys = OFF");
          fixture.database.raw
            .prepare("DELETE FROM workflow_benchmark_receipts WHERE id = ?")
            .run(passingWorkflowBenchmarkReceiptFixture.id);
          fixture.database.raw.pragma("foreign_keys = ON");
          expect(
            fixture.database.raw
              .prepare(
                "SELECT COUNT(*) AS count FROM approved_competitive_model_policies WHERE id = ?",
              )
              .get("99999999-9999-4999-8999-999999999999"),
            `${scenario.name}: only the receipt is removed`,
          ).toEqual({ count: 1 });
          expect(
            fixture.database.raw
              .prepare(
                "SELECT COUNT(*) AS count FROM workflow_benchmark_receipts WHERE id = ?",
              )
              .get(passingWorkflowBenchmarkReceiptFixture.id),
            `${scenario.name}: receipt is removed`,
          ).toEqual({ count: 0 });
        }
        if (scenario.invalidate) {
          if (!fixture.policy)
            throw new Error("C10 invalidation fixture requires a policy");
          await fixture.policy.invalidateBenchmarkReceipt({
            receiptId: passingWorkflowBenchmarkReceiptFixture.id,
            invalidatedAt: NOW,
            reason: "operator_revoked",
          });
        }
        if (scenario.policyColumn) {
          fixture.database.raw.pragma("foreign_keys = OFF");
          fixture.database.raw
            .prepare(
              `UPDATE approved_competitive_model_policies SET ${scenario.policyColumn} = ?`,
            )
            .run(`unapproved-${scenario.policyColumn}`);
          fixture.database.raw.pragma("foreign_keys = ON");
        }
        if (
          scenario.receiptMutation ||
          scenario.invalidate ||
          scenario.policyColumn
        ) {
          if (!fixture.policy)
            throw new Error("C10 mutated-policy fixture requires policy");
          expect(
            await fixture.policy.getActiveCompetitivePolicy(competitiveTuple()),
            `${scenario.name}: mutation must remove eligibility`,
          ).toBeNull();
        }
        const { attemptId } = await createVerifiedAttempt(fixture.app);
        await fixture.scheduler.runAll();
        const outcome = await resultFor(fixture.app, attemptId);
        if (scenario.expected === "experimental")
          expect(outcome, scenario.name).toMatchObject({
            state: "valid",
            result: {
              kind: "verified-result",
              competitiveStatus: "experimental",
              competitiveEligible: false,
            },
          });
        else
          expect(outcome, scenario.name).toMatchObject({
            state: "failed",
            code: "analysis_configuration_invalid",
          });
        expect(
          fixture.database.raw
            .prepare(
              "SELECT COUNT(*) AS count FROM leaderboard_entries WHERE attempt_id = ?",
            )
            .get(attemptId),
          scenario.name,
        ).toEqual({ count: 0 });
        expect(await liveLeaderboard(fixture.app), scenario.name).toMatchObject(
          {
            cohortSize: 0,
            entries: [],
          },
        );
      } finally {
        await fixture.close();
      }
    }
    for (const lockedColumn of [
      "workflow_id",
      "workflow_version",
      "challenge_id",
      "challenge_version",
      "rule_version",
    ] as const) {
      const fixture = await makeRoot({
        verifiedProvider: createVerifiedFixtureVisionProvider("roboflow"),
        approvedPolicy: true,
        c5Mode: "verified",
      });
      try {
        const replacement =
          lockedColumn === "challenge_version"
            ? 2
            : `unapproved-${lockedColumn}`;
        expect(() =>
          fixture.database.raw
            .prepare(
              `UPDATE approved_competitive_model_policies SET ${lockedColumn} = ?`,
            )
            .run(replacement),
        ).toThrow();
        expect(
          fixture.database.raw
            .prepare("SELECT COUNT(*) AS count FROM leaderboard_entries")
            .get(),
        ).toEqual({ count: 0 });
      } finally {
        await fixture.close();
      }
    }
  }, 30_000);
});

async function makeRoot(
  input: Readonly<{
    verifiedProvider: VisionProvider;
    freeProvider?: VisionProvider;
    approvedPolicy?: boolean;
    c5Mode: "free" | "verified";
    queueAvailable?: () => boolean | Promise<boolean>;
    queueBeforeEnqueue?: (
      job: Readonly<{
        attemptId: string;
        generation: number;
        mode?: "free" | "verified";
      }>,
    ) => void | Promise<void>;
    c5Prober?: LocalMediaProber;
    c5Runner?: BoundedFrameProcessRunner;
    c5Renamer?: AtomicMediaRenamer;
    verifiedScheduler?: VisionBatchScheduler;
    diagnostics?: TestDiagnostic;
    logs?: unknown[];
    root?: string;
    activatePolicy?: boolean;
    repositoryIdPrefix?: string;
    appIdPrefix?: string;
  }>,
) {
  const root =
    input.root ?? (await mkdtemp(join(tmpdir(), "revelai-c10-http-")));
  if (!input.root) directories.push(root);
  const mediaRoot = join(root, "media");
  const scheduler = new ManualScheduler();
  const queue = new InMemoryAnalysisQueue({
    scheduler,
    ...(input.queueAvailable ? { available: input.queueAvailable } : {}),
    ...(input.queueBeforeEnqueue
      ? { beforeEnqueue: input.queueBeforeEnqueue }
      : {}),
  });
  let database = openSqliteDatabase(join(root, "api.sqlite"));
  let app: ReturnType<typeof createProductionTrainingAttemptApi>;
  let repository: SQLiteAttemptRepository;
  let policy: SQLiteCompetitivePolicyRepository | undefined;
  let closed = false;
  let now = NOW;
  const freeProvider = input.freeProvider ?? createDemoVisionProvider();
  const diagnosticCleanups: Array<() => void> = [];
  const cleanupDiagnostics = () => {
    for (const cleanup of diagnosticCleanups.splice(0).reverse()) cleanup();
  };

  const start = async (activatePolicy: boolean): Promise<void> => {
    const c5 = createC5PipelineTestSupport({
      root: mediaRoot,
      mode: input.c5Mode,
      ...(input.c5Prober ? { prober: input.c5Prober } : {}),
      ...(input.c5Runner ? { runner: input.c5Runner } : {}),
      ...(input.c5Renamer ? { renamer: input.c5Renamer } : {}),
    });
    repository = new SQLiteAttemptRepository({
      database,
      clock: { now: () => now },
      ids: { next: ids(input.repositoryIdPrefix ?? "aaaaaaaa") },
      handoffVerifier: c5.handoffVerifier,
    });
    if (input.diagnostics) {
      diagnosticCleanups.push(
        registerTestDiagnostic(repository, input.diagnostics),
      );
      const processing =
        resolveProductionSQLiteAttemptProcessingPort(repository);
      if (processing)
        diagnosticCleanups.push(
          registerTestDiagnostic(processing.processing, input.diagnostics),
        );
    }
    const retention = new SQLiteRetentionRepository({ database });
    if (input.approvedPolicy) {
      policy = new SQLiteCompetitivePolicyRepository({
        database,
        clock: { now: () => NOW },
      });
      if (input.diagnostics)
        diagnosticCleanups.push(
          registerTestDiagnostic(policy, input.diagnostics),
        );
      if (activatePolicy && input.approvedPolicy) {
        const receipt = WorkflowBenchmarkReceiptSchema.parse(
          passingWorkflowBenchmarkReceiptFixture,
        );
        await policy.storeBenchmarkReceipt(receipt);
        await policy.activateCompetitivePolicy({
          id: "99999999-9999-4999-8999-999999999999",
          receiptId: receipt.id,
          receiptSha256: receipt.receiptSha256,
          receiptSchemaVersion: receipt.schemaVersion,
          workspaceId: receipt.workflow.workspaceId,
          modelBundleId: receipt.workflow.modelBundleId,
          workflowId: receipt.workflow.workflowId,
          workflowVersion: receipt.workflow.workflowVersion,
          providerVersion: receipt.workflow.providerVersion,
          calibrationEvidenceVersion:
            receipt.evidence.calibrationEvidenceVersion,
          extractionEvidenceVersion: receipt.evidence.extractionEvidenceVersion,
          observationEvidenceVersion:
            receipt.evidence.observationEvidenceVersion,
          challengeId: "wall-pass",
          challengeVersion: 1,
          ruleVersion: "wall-pass-v1-score-1",
        });
      }
    }
    app = createProductionTrainingAttemptApi({
      repository,
      retention,
      queue,
      mediaPipeline: c5.pipeline,
      cleaner: createLocalC8AcceptedMediaCleaner({
        repository,
        storage: c5.storage,
      }),
      scheduler,
      clock: { now: () => now },
      ids: { next: ids(input.appIdPrefix ?? "bbbbbbbb") },
      ...(input.logs
        ? {
            log: { event: (event: unknown) => input.logs!.push(event) },
            retentionLog: {
              event: (event: unknown) => input.logs!.push(event),
            },
          }
        : {}),
      freeTraining: {
        provider: freeProvider,
        clock: { now: () => now },
      },
      verifiedTraining: {
        provider: input.verifiedProvider,
        ...(input.verifiedScheduler
          ? { scheduler: input.verifiedScheduler }
          : {}),
        policy,
        clock: { now: () => now },
      },
    });
    if (input.diagnostics) {
      diagnosticCleanups.push(
        registerTestDiagnostic(freeProvider, input.diagnostics),
        registerTestDiagnostic(input.verifiedProvider, input.diagnostics),
      );
    }
  };
  await start(input.activatePolicy ?? true);
  return {
    get app() {
      return app;
    },
    get database() {
      return database;
    },
    get repository() {
      return repository;
    },
    get policy() {
      return policy;
    },
    root,
    mediaRoot,
    scheduler,
    queue,
    setNow: (value: string) => {
      now = value;
    },
    restart: async () => {
      if (closed) throw new Error("C10 root is closed");
      cleanupDiagnostics();
      await app.close();
      database.close();
      database = openSqliteDatabase(join(root, "api.sqlite"));
      await start(false);
    },
    stopForDrain: async () => {
      if (closed) throw new Error("C10 root is closed");
      await app.close();
    },
    close: async () => {
      if (closed) return;
      closed = true;
      cleanupDiagnostics();
      await scheduler.runAll();
      if (scheduler.tasks.length !== 0)
        throw new Error("C10 queue deliveries did not settle");
      await app.close();
      if (scheduler.hourlyTaskCount !== 0)
        throw new Error("C10 hourly resources did not settle");
      database.close();
    },
  };
}

function trackedFreeProvider() {
  const provider = createDemoVisionProvider();
  let freeCalls = 0;
  let verifiedCalls = 0;
  const freeFrames: Array<
    Readonly<{
      index: number;
      timestampMs: number;
      sourceWidth: number;
      sourceHeight: number;
    }>
  > = [];
  return Object.freeze({
    provider: Object.freeze({
      ...provider,
      analyzeFree: async (
        ...args: Parameters<VisionProvider["analyzeFree"]>
      ) => {
        freeCalls += 1;
        freeFrames.push(
          Object.freeze({
            index: args[0].frame.index,
            timestampMs: args[0].frame.timestampMs,
            sourceWidth: args[0].frame.sourceWidth,
            sourceHeight: args[0].frame.sourceHeight,
          }),
        );
        return provider.analyzeFree(...args);
      },
      analyzeVerified: async (
        ...args: Parameters<VisionProvider["analyzeVerified"]>
      ) => {
        verifiedCalls += 1;
        return provider.analyzeVerified(...args);
      },
    }) satisfies VisionProvider,
    get freeCalls() {
      return freeCalls;
    },
    get verifiedCalls() {
      return verifiedCalls;
    },
    get freeFrames() {
      return Object.freeze([...freeFrames]);
    },
  });
}

function trackedC10Diagnostics() {
  const calls = {
    calibration: 0,
    integrityScoring: 0,
    policyLookup: 0,
    rankedFinalization: 0,
    leaderboard: 0,
  };
  let freeTerminalPersistenceCalls = 0;
  const observer: TestDiagnostic = Object.freeze({
    onEvent: (event) => {
      switch (event.kind) {
        case "c4-calibration":
          calls.calibration += 1;
          return;
        case "verified-integrity-scoring":
        case "free-forbidden-integrity-scoring":
          calls.integrityScoring += 1;
          return;
        case "policy-lookup":
        case "free-forbidden-policy-lookup":
          calls.policyLookup += 1;
          return;
        case "c4-ranked-finalization":
        case "free-forbidden-ranked-finalization":
          calls.rankedFinalization += 1;
          return;
        case "c4-leaderboard-write":
        case "free-forbidden-leaderboard":
        case "free-forbidden-finalization":
          calls.leaderboard += 1;
          return;
        case "free-terminal-persistence":
          freeTerminalPersistenceCalls += 1;
          return;
        case "free-forbidden-calibration":
          calls.calibration += 1;
      }
    },
  });
  return Object.freeze({
    observer,
    get calls() {
      return Object.freeze({ ...calls });
    },
    get freeTerminalPersistenceCalls() {
      return freeTerminalPersistenceCalls;
    },
  });
}

function immediatelyExpiredVisionScheduler(): VisionBatchScheduler {
  return new VisionBatchScheduler({
    clock: {
      now: () => 0,
      sleep: async () => undefined,
      schedule: (_milliseconds, callback) => {
        callback();
        return () => undefined;
      },
    },
  });
}

async function createVerifiedAttempt(
  app: Awaited<ReturnType<typeof makeRoot>>["app"],
  input: Readonly<{
    authorization?: string;
    boundary?: string;
    filename?: string;
    payloadSuffix?: string;
  }> = {},
): Promise<
  Readonly<{
    attemptId: string;
    calibrationId: string;
    upload: unknown;
    uploadBody: string;
  }>
> {
  const calibration = await app.inject({
    method: "POST",
    url: "/v1/calibration-sessions",
    headers: athleteHeaders(),
    payload: { challengeId: "wall-pass", challengeVersion: 1 },
  });
  expect(calibration.statusCode).toBe(201);
  const calibrationId = (calibration.json() as { id: string }).id;
  const ready = await app.inject({
    method: "POST",
    url: `/v1/calibration-sessions/${calibrationId}/ready`,
    headers: athleteHeaders(),
    payload: {
      requiredGates: ["device", "space", "athlete", "rehearsal", "record"],
    },
  });
  expect(ready.statusCode).toBe(204);
  const created = await app.inject({
    method: "POST",
    url: "/v1/attempts",
    headers: athleteHeaders(),
    payload: {
      mode: "verified",
      challengeId: "wall-pass",
      challengeVersion: 1,
      calibrationSessionId: calibrationId,
    },
  });
  expect(created.statusCode).toBe(201);
  const attemptId = (created.json() as { id: string }).id;
  const boundary = input.boundary ?? "verified";
  const upload = await app.inject({
    method: "POST",
    url: `/v1/attempts/${attemptId}/media`,
    headers: {
      ...multipartHeaders(boundary),
      ...(input.authorization ? { authorization: input.authorization } : {}),
    },
    payload: multipart(
      boundary,
      input.filename,
      "video/mp4",
      input.payloadSuffix,
    ),
  });
  expect(upload.statusCode).toBe(202);
  return Object.freeze({
    attemptId,
    calibrationId,
    upload: upload.json(),
    uploadBody: upload.body,
  });
}

async function createFreeAttempt(
  app: Awaited<ReturnType<typeof makeRoot>>["app"],
): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/v1/attempts",
    headers: athleteHeaders(),
    payload: { mode: "free" },
  });
  expect(response.statusCode).toBe(201);
  return (response.json() as Readonly<{ id: string }>).id;
}

function attemptRow(
  fixture: Awaited<ReturnType<typeof makeRoot>>,
  attemptId: string,
) {
  return fixture.database.raw
    .prepare(
      "SELECT status, media_json, processing_context_json FROM attempts WHERE id = ?",
    )
    .get(attemptId);
}

function processingEventCount(
  fixture: Awaited<ReturnType<typeof makeRoot>>,
  attemptId: string,
  eventType: string,
): number {
  return (
    fixture.database.raw
      .prepare(
        "SELECT COUNT(*) AS count FROM processing_events WHERE attempt_id = ? AND event_type = ?",
      )
      .get(attemptId, eventType) as Readonly<{ count: number }>
  ).count;
}

async function durableReceiptFor(
  fixture: Awaited<ReturnType<typeof makeRoot>>,
  attemptId: string,
): Promise<unknown> {
  const row = fixture.database.raw
    .prepare("SELECT processing_context_json FROM attempts WHERE id = ?")
    .get(attemptId) as Readonly<{ processing_context_json: string }>;
  const context = JSON.parse(row.processing_context_json) as Readonly<{
    processing: Readonly<{ receipt: Readonly<{ frameBatchId: string }> }>;
  }>;
  return JSON.parse(
    await readFile(
      join(
        fixture.mediaRoot,
        "frames",
        context.processing.receipt.frameBatchId,
        ".receipt.json",
      ),
      "utf8",
    ),
  );
}

async function expectEmptyMediaDirectories(
  fixture: Awaited<ReturnType<typeof makeRoot>>,
): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const contents = await Promise.all(
      ["originals", "frames", "temporary"].map((directory) =>
        readdir(join(fixture.mediaRoot, directory)),
      ),
    );
    if (contents.every((directory) => directory.length === 0)) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  for (const directory of ["originals", "frames", "temporary"])
    expect(await readdir(join(fixture.mediaRoot, directory))).toEqual([]);
}

async function expectNoTemporaryOrPublicationFacts(
  fixture: Awaited<ReturnType<typeof makeRoot>>,
  attemptId: string,
): Promise<void> {
  expect(
    fixture.database.raw
      .prepare(
        "SELECT COUNT(*) AS count FROM media_retention_records WHERE attempt_id = ?",
      )
      .get(attemptId),
  ).toEqual({ count: 0 });
}

async function expectPrivateMediaTree(
  fixture: Awaited<ReturnType<typeof makeRoot>>,
  attemptId: string,
): Promise<void> {
  const row = fixture.database.raw
    .prepare(
      "SELECT mode, media_json, processing_context_json FROM attempts WHERE id = ?",
    )
    .get(attemptId) as Readonly<{
    mode: "free" | "verified";
    media_json: string;
    processing_context_json: string;
  }>;
  const media = JSON.parse(row.media_json) as Readonly<{ id: string }>;
  const processing = JSON.parse(row.processing_context_json) as Readonly<{
    processing: Readonly<{
      receipt: Readonly<{ frameBatchId: string }>;
    }>;
  }>;
  const originalDirectory = join(fixture.mediaRoot, "originals", media.id);
  const frameDirectory = join(
    fixture.mediaRoot,
    "frames",
    processing.processing.receipt.frameBatchId,
  );
  for (const directory of [
    fixture.mediaRoot,
    join(fixture.mediaRoot, "originals"),
    join(fixture.mediaRoot, "frames"),
    join(fixture.mediaRoot, "temporary"),
    originalDirectory,
    frameDirectory,
  ]) {
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect((await lstat(directory)).isSymbolicLink()).toBe(false);
  }
  expect(await readdir(originalDirectory)).toEqual(["payload"]);
  await expect(lstat(join(originalDirectory, ".owner"))).rejects.toThrow();
  const payload = join(originalDirectory, "payload");
  expect((await stat(payload)).mode & 0o777).toBe(0o600);
  expect((await lstat(payload)).isSymbolicLink()).toBe(false);
  const frames = await readdir(frameDirectory);
  const jpegFrames = frames.filter((frame) => frame.endsWith(".jpg"));
  expect(jpegFrames).toHaveLength(row.mode === "verified" ? 640 : 128);
  expect(frames).toEqual(
    expect.arrayContaining([".complete", ".receipt.json"]),
  );
  for (const file of ["payload", ...frames]) {
    const path = file === "payload" ? payload : join(frameDirectory, file);
    expect((await lstat(path)).isSymbolicLink()).toBe(false);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  }
  expect(await readdir(join(fixture.mediaRoot, "temporary"))).toEqual([]);
}

async function expectPrivateRetainedOriginal(
  fixture: Awaited<ReturnType<typeof makeRoot>>,
  mediaId: string,
): Promise<void> {
  const originalDirectory = join(fixture.mediaRoot, "originals", mediaId);
  for (const path of [originalDirectory, join(originalDirectory, "payload")]) {
    expect((await lstat(path)).isSymbolicLink()).toBe(false);
  }
  expect((await stat(originalDirectory)).mode & 0o777).toBe(0o700);
  expect((await stat(join(originalDirectory, "payload"))).mode & 0o777).toBe(
    0o600,
  );
}

async function expectPending(
  app: Awaited<ReturnType<typeof makeRoot>>["app"],
  attemptId: string,
): Promise<void> {
  const response = await app.inject({
    method: "GET",
    url: `/v1/attempts/${attemptId}/result`,
    headers: athleteHeaders(),
  });
  expect(AttemptResultResponseSchema.parse(response.json())).toMatchObject({
    state: "pending",
  });
}

async function resultFor(
  app: Awaited<ReturnType<typeof makeRoot>>["app"],
  attemptId: string,
) {
  const response = await resultResponse(app, attemptId);
  expect(response.statusCode).toBe(200);
  return AttemptResultResponseSchema.parse(response.json());
}

async function rankedResultFor(
  app: Awaited<ReturnType<typeof makeRoot>>["app"],
  attemptId: string,
) {
  const outcome = await resultFor(app, attemptId);
  if (
    outcome.state !== "valid" ||
    outcome.result.kind !== "verified-result" ||
    outcome.result.competitiveStatus !== "ranked"
  )
    throw new Error("ranked C10 result required");
  return outcome.result;
}

async function liveLeaderboard(
  app: Awaited<ReturnType<typeof makeRoot>>["app"],
) {
  const response = await app.inject({
    method: "GET",
    url: "/v1/leaderboards/wall-pass?version=1&ruleVersion=wall-pass-v1-score-1&limit=20",
  });
  expect(response.statusCode).toBe(200);
  return LeaderboardResponseSchema.parse(response.json());
}

async function resultResponse(
  app: Awaited<ReturnType<typeof makeRoot>>["app"],
  attemptId: string,
) {
  return app.inject({
    method: "GET",
    url: `/v1/attempts/${attemptId}/result`,
    headers: athleteHeaders(),
  });
}

function athleteHeaders() {
  return { "x-revelai-athlete-id": ATHLETE_ID };
}

function competitiveTuple() {
  return {
    workspaceId: "revelai-workspace",
    modelBundleId: "wall-pass-bundle-v1",
    workflowId: "revelai-wall-pass-geometry-v1",
    workflowVersion: "1.0.0",
    providerVersion: "roboflow-inference-v1",
    calibrationEvidenceVersion: "wall-pass-calibration-evidence-v1",
    extractionEvidenceVersion: "c5-frame-manifest-v1",
    observationEvidenceVersion: "wall-pass-geometry-evidence-v1",
    challengeId: "wall-pass",
    challengeVersion: 1,
    ruleVersion: "wall-pass-v1-score-1",
  } as const;
}

function multipartHeaders(boundary: string) {
  return {
    ...athleteHeaders(),
    "content-type": `multipart/form-data; boundary=${boundary}`,
  };
}
function multipart(
  boundary: string,
  filename = "attempt.mp4",
  contentType = "video/mp4",
  payloadSuffix = "",
) {
  const brand = contentType === "video/quicktime" ? "qt  " : "isom";
  return Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="media"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`,
    ),
    Buffer.concat([
      Buffer.from([0, 0, 0, 16, 0x66, 0x74, 0x79, 0x70]),
      Buffer.from(brand, "ascii"),
      Buffer.from([1, 2, 3, 4]),
      Buffer.from(payloadSuffix, "utf8"),
    ]),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
}

async function responseBeforeRequestBody(
  input: Readonly<{
    host: string;
    port: number;
    request: string;
  }>,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: input.host, port: input.port });
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error("queue preflight did not respond before the body"));
    }, 3_000);
    const settle = (operation: () => void): void => {
      clearTimeout(timeout);
      socket.removeAllListeners();
      operation();
    };
    socket.once("connect", () => socket.write(input.request));
    socket.once("data", (chunk) =>
      settle(() => {
        socket.end();
        resolve(chunk.toString("utf8"));
      }),
    );
    socket.once("error", (error) => settle(() => reject(error)));
  });
}

function expectNoLeaks(
  values: readonly unknown[],
  forbidden: readonly string[],
): void {
  const rendered = values.map((value) => JSON.stringify(value)).join("\n");
  for (const value of forbidden) expect(rendered).not.toContain(value);
}

function ids(prefix: string) {
  let sequence = 0;
  return () =>
    `${prefix}-${prefix.slice(0, 4)}-4${prefix.slice(0, 3)}-8${prefix.slice(0, 3)}-${(++sequence).toString(16).padStart(12, "0")}`;
}
