import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AttemptResultResponseSchema,
  LeaderboardResponseSchema,
  WorkflowBenchmarkReceiptSchema,
  passingWorkflowBenchmarkReceiptFixture,
} from "@revelai/contracts";
import { createDemoVisionProvider, type VisionProvider } from "@revelai/vision";
import { afterEach, describe, expect, it } from "vitest";
import { createProductionTrainingAttemptApi } from "../composition/training-analysis-composition.js";
import { openSqliteDatabase } from "../database/sqlite-database.js";
import { createC5PipelineTestSupport } from "../media/c5-pipeline-test-support.js";
import { SQLiteRetentionRepository } from "../media/sqlite-retention-repository.js";
import { createVerifiedFixtureVisionProvider } from "../processing/c7-fixture.test-support.js";
import {
  InMemoryAnalysisQueue,
  type QueueScheduler,
} from "../queue/in-memory-analysis-queue.js";
import { SQLiteAttemptRepository } from "../repositories/sqlite-attempt-repository.js";
import { SQLiteCompetitivePolicyRepository } from "../repositories/sqlite-competitive-policy-repository.js";
import { createLocalC8AcceptedMediaCleaner } from "../services/local-c8-accepted-media-cleaner.js";

const ATHLETE_ID = "11111111-1111-4111-8111-111111111111";
const NOW = "2030-01-15T12:00:00.000Z";
const directories: string[] = [];

class ManualScheduler implements QueueScheduler {
  public readonly tasks: Array<() => Promise<void>> = [];

  public schedule(task: () => Promise<void>): void {
    this.tasks.push(task);
  }

  public async runAll(): Promise<void> {
    while (this.tasks.length > 0) await this.tasks.shift()!();
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
      const attemptId = await createVerifiedAttempt(fixture.app);
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
      const reopened = fixture.database.reopen();
      const persisted = reopened.raw
        .prepare(
          "SELECT COUNT(*) AS count FROM terminal_results WHERE attempt_id = ?",
        )
        .get(attemptId);
      reopened.close();
      expect(persisted).toEqual({ count: 1 });
    } finally {
      await fixture.close();
    }
  });

  it("keeps a portrait Free multipart flow personal, noncompetitive, and retryable after an incomplete upload", async () => {
    const fixture = await makeRoot({
      verifiedProvider: createDemoVisionProvider(),
      c5Mode: "free",
    });
    try {
      const created = await fixture.app.inject({
        method: "POST",
        url: "/v1/attempts",
        headers: athleteHeaders(),
        payload: { mode: "free" },
      });
      expect(created.statusCode).toBe(201);
      const attemptId = (created.json() as { id: string }).id;
      const aborted = await fixture.app.inject({
        method: "POST",
        url: `/v1/attempts/${attemptId}/media`,
        headers: multipartHeaders("free-abort"),
        payload: multipart("free-abort").subarray(0, -8),
      });
      expect(aborted.statusCode).toBe(400);
      const upload = await fixture.app.inject({
        method: "POST",
        url: `/v1/attempts/${attemptId}/media`,
        headers: multipartHeaders("free-portrait"),
        payload: multipart("free-portrait", "portrait.mov", "video/quicktime"),
      });
      expect(upload.statusCode).toBe(202);
      await fixture.scheduler.runAll();
      const result = await resultFor(fixture.app, attemptId);
      expect(result).toMatchObject({
        state: "valid",
        result: { kind: "free-insight", approximate: true },
      });
      expect(JSON.stringify(result)).not.toMatch(
        /score|rank|percentile|leaderboard|calibration|verified/i,
      );
    } finally {
      await fixture.close();
    }
  });

  it("writes exactly one ranked result only for a parsed receipt and mocked Roboflow provider", async () => {
    const fixture = await makeRoot({
      verifiedProvider: createVerifiedFixtureVisionProvider("roboflow"),
      approvedPolicy: true,
      c5Mode: "verified",
    });
    try {
      const attemptId = await createVerifiedAttempt(fixture.app);
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
      await fixture.scheduler.runAll();
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
});

async function makeRoot(
  input: Readonly<{
    verifiedProvider: VisionProvider;
    approvedPolicy?: boolean;
    c5Mode: "free" | "verified";
  }>,
) {
  const root = await mkdtemp(join(tmpdir(), "revelai-c10-http-"));
  directories.push(root);
  const database = openSqliteDatabase(join(root, "api.sqlite"));
  const c5 = createC5PipelineTestSupport({
    root: join(root, "media"),
    mode: input.c5Mode,
  });
  const scheduler = new ManualScheduler();
  const queue = new InMemoryAnalysisQueue({ scheduler });
  const repository = new SQLiteAttemptRepository({
    database,
    clock: { now: () => NOW },
    ids: { next: ids("aaaaaaaa") },
    handoffVerifier: c5.handoffVerifier,
  });
  const retention = new SQLiteRetentionRepository({ database });
  let policy: SQLiteCompetitivePolicyRepository | undefined;
  if (input.approvedPolicy) {
    policy = new SQLiteCompetitivePolicyRepository({
      database,
      clock: { now: () => NOW },
    });
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
      calibrationEvidenceVersion: receipt.evidence.calibrationEvidenceVersion,
      extractionEvidenceVersion: receipt.evidence.extractionEvidenceVersion,
      observationEvidenceVersion: receipt.evidence.observationEvidenceVersion,
      challengeId: "wall-pass",
      challengeVersion: 1,
      ruleVersion: "wall-pass-v1-score-1",
    });
  }
  const app = createProductionTrainingAttemptApi({
    repository,
    retention,
    queue,
    mediaPipeline: c5.pipeline,
    cleaner: createLocalC8AcceptedMediaCleaner({
      repository,
      storage: c5.storage,
    }),
    scheduler: { everyHour: () => undefined, cancel: () => undefined },
    clock: { now: () => NOW },
    ids: { next: ids("bbbbbbbb") },
    freeTraining: {
      provider: createDemoVisionProvider(),
      clock: { now: () => NOW },
    },
    verifiedTraining: {
      provider: input.verifiedProvider,
      policy,
      clock: { now: () => NOW },
    },
  });
  return {
    app,
    database,
    scheduler,
    close: async () => {
      await app.close();
      database.close();
    },
  };
}

async function createVerifiedAttempt(
  app: Awaited<ReturnType<typeof makeRoot>>["app"],
): Promise<string> {
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
  const upload = await app.inject({
    method: "POST",
    url: `/v1/attempts/${attemptId}/media`,
    headers: multipartHeaders("verified"),
    payload: multipart("verified"),
  });
  expect(upload.statusCode).toBe(202);
  return attemptId;
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
  const response = await app.inject({
    method: "GET",
    url: `/v1/attempts/${attemptId}/result`,
    headers: athleteHeaders(),
  });
  expect(response.statusCode).toBe(200);
  return AttemptResultResponseSchema.parse(response.json());
}

function athleteHeaders() {
  return { "x-revelai-athlete-id": ATHLETE_ID };
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
) {
  return Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="media"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`,
    ),
    Buffer.from([
      0, 0, 0, 16, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 1, 2, 3, 4,
    ]),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
}
function ids(prefix: string) {
  let sequence = 0;
  return () =>
    `${prefix}-${prefix.slice(0, 4)}-4${prefix.slice(0, 3)}-8${prefix.slice(0, 3)}-${(++sequence).toString(16).padStart(12, "0")}`;
}
