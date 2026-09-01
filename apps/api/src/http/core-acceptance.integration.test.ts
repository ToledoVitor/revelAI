import { lstat, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
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
  failedWorkflowBenchmarkReceiptFixture,
  passingWorkflowBenchmarkReceiptFixture,
  staleWorkflowBenchmarkReceiptFixture,
} from "@revelai/contracts";
import {
  createDemoVisionProvider,
  VisionBatchScheduler,
  type VisionProvider,
} from "@revelai/vision";
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
import type { BoundedFrameProcessRunner } from "../storage/local-frame-extraction.js";
import type { LocalMediaProber } from "../storage/local-media-storage.js";

const ATHLETE_ID = "11111111-1111-4111-8111-111111111111";
const NOW = "2030-01-15T12:00:00.000Z";
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
    const fixture = await makeRoot({
      verifiedProvider: createDemoVisionProvider(),
      freeProvider: free.provider,
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
      expect(result.result.observations).toHaveLength(3);
      expect(result.result.tips).toEqual([
        "Boa cobertura para uma análise aproximada.",
      ]);
      expect(free.freeCalls).toBeGreaterThan(0);
      expect(free.verifiedCalls).toBe(0);

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

  it("contains queue, media, provider, integrity, and readiness failures at the public seam", async () => {
    let preflightReads = 0;
    const unavailable = await makeRoot({
      verifiedProvider: createDemoVisionProvider(),
      c5Mode: "free",
      queueAvailable: () => false,
    });
    try {
      const attemptId = await createFreeAttempt(unavailable.app);
      const response = await unavailable.app.inject({
        method: "POST",
        url: `/v1/attempts/${attemptId}/media`,
        headers: multipartHeaders("queue-unavailable"),
        payload: Readable.from(
          (async function* () {
            preflightReads += 1;
            yield multipart("queue-unavailable", "private-before-body.mp4");
          })(),
        ),
      });
      expect(response.statusCode).toBe(503);
      expect(RouteErrorSchema.parse(response.json())).toMatchObject({
        code: "queue_unavailable",
        retryable: true,
      });
      expect(response.body).not.toMatch(
        /private-before-body|path|media|sql|stack|base64/i,
      );
      expect(preflightReads).toBe(1);
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

    let availabilityCalls = 0;
    const enqueueFailure = await makeRoot({
      verifiedProvider: createDemoVisionProvider(),
      c5Mode: "free",
      queueAvailable: () => {
        availabilityCalls += 1;
        return availabilityCalls < 3;
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
  }, 30_000);

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

  it("table-drives non-current competitive receipts and tuples to experimental HTTP results", async () => {
    const cases: readonly Readonly<{
      name: string;
      receipt?: unknown;
      approvedPolicy?: boolean;
      invalidate?: boolean;
      provider?: VisionProvider;
    }>[] = [
      {
        name: "unapproved receipt",
        receipt: failedWorkflowBenchmarkReceiptFixture,
      },
      {
        name: "stale receipt",
        receipt: staleWorkflowBenchmarkReceiptFixture,
      },
      {
        name: "invalidated receipt",
        approvedPolicy: true,
        invalidate: true,
      },
      {
        name: "unapproved provider tuple",
        approvedPolicy: true,
        provider: createVerifiedFixtureVisionProvider("roboflow", {
          verifiedModelBundleId: "unapproved-wall-pass-bundle-v1",
        }),
      },
    ];
    for (const scenario of cases) {
      const fixture = await makeRoot({
        verifiedProvider:
          scenario.provider ?? createVerifiedFixtureVisionProvider("roboflow"),
        ...(scenario.approvedPolicy ? { approvedPolicy: true } : {}),
        ...(scenario.receipt ? { benchmarkReceipt: scenario.receipt } : {}),
        c5Mode: "verified",
      });
      try {
        if (scenario.invalidate) {
          if (!fixture.policy)
            throw new Error("C10 invalidation fixture requires a policy");
          await fixture.policy.invalidateBenchmarkReceipt({
            receiptId: passingWorkflowBenchmarkReceiptFixture.id,
            invalidatedAt: NOW,
            reason: "operator_revoked",
          });
        }
        const { attemptId } = await createVerifiedAttempt(fixture.app);
        await fixture.scheduler.runAll();
        const outcome = await resultFor(fixture.app, attemptId);
        expect(outcome, scenario.name).toMatchObject({
          state: "valid",
          result: {
            kind: "verified-result",
            competitiveStatus: "experimental",
            competitiveEligible: false,
          },
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
  }, 30_000);
});

async function makeRoot(
  input: Readonly<{
    verifiedProvider: VisionProvider;
    freeProvider?: VisionProvider;
    approvedPolicy?: boolean;
    c5Mode: "free" | "verified";
    queueAvailable?: () => boolean | Promise<boolean>;
    c5Prober?: LocalMediaProber;
    c5Runner?: BoundedFrameProcessRunner;
    verifiedScheduler?: VisionBatchScheduler;
    logs?: unknown[];
    benchmarkReceipt?: unknown;
  }>,
) {
  const root = await mkdtemp(join(tmpdir(), "revelai-c10-http-"));
  directories.push(root);
  const mediaRoot = join(root, "media");
  const scheduler = new ManualScheduler();
  const queue = new InMemoryAnalysisQueue({
    scheduler,
    ...(input.queueAvailable ? { available: input.queueAvailable } : {}),
  });
  let database = openSqliteDatabase(join(root, "api.sqlite"));
  let app: ReturnType<typeof createProductionTrainingAttemptApi>;
  let repository: SQLiteAttemptRepository;
  let policy: SQLiteCompetitivePolicyRepository | undefined;
  let closed = false;
  let now = NOW;

  const start = async (activatePolicy: boolean): Promise<void> => {
    const c5 = createC5PipelineTestSupport({
      root: mediaRoot,
      mode: input.c5Mode,
      ...(input.c5Prober ? { prober: input.c5Prober } : {}),
      ...(input.c5Runner ? { runner: input.c5Runner } : {}),
    });
    repository = new SQLiteAttemptRepository({
      database,
      clock: { now: () => now },
      ids: { next: ids("aaaaaaaa") },
      handoffVerifier: c5.handoffVerifier,
    });
    const retention = new SQLiteRetentionRepository({ database });
    if (input.approvedPolicy || input.benchmarkReceipt) {
      policy = new SQLiteCompetitivePolicyRepository({
        database,
        clock: { now: () => NOW },
      });
      if (activatePolicy && input.benchmarkReceipt) {
        await policy.storeBenchmarkReceipt(
          WorkflowBenchmarkReceiptSchema.parse(input.benchmarkReceipt),
        );
      }
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
      ids: { next: ids("bbbbbbbb") },
      ...(input.logs
        ? {
            log: { event: (event: unknown) => input.logs!.push(event) },
            retentionLog: {
              event: (event: unknown) => input.logs!.push(event),
            },
          }
        : {}),
      freeTraining: {
        provider: input.freeProvider ?? createDemoVisionProvider(),
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
  };
  await start(true);
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
    mediaRoot,
    scheduler,
    queue,
    setNow: (value: string) => {
      now = value;
    },
    restart: async () => {
      if (closed) throw new Error("C10 root is closed");
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
  return Object.freeze({
    provider: Object.freeze({
      ...provider,
      analyzeFree: async (
        ...args: Parameters<VisionProvider["analyzeFree"]>
      ) => {
        freeCalls += 1;
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
): Promise<
  Readonly<{ attemptId: string; calibrationId: string; upload: unknown }>
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
  const upload = await app.inject({
    method: "POST",
    url: `/v1/attempts/${attemptId}/media`,
    headers: multipartHeaders("verified"),
    payload: multipart("verified"),
  });
  expect(upload.statusCode).toBe(202);
  return Object.freeze({
    attemptId,
    calibrationId,
    upload: upload.json(),
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

async function expectEmptyMediaDirectories(
  fixture: Awaited<ReturnType<typeof makeRoot>>,
): Promise<void> {
  for (const directory of ["originals", "frames", "temporary"])
    expect(await readdir(join(fixture.mediaRoot, directory))).toEqual([]);
}

async function expectPrivateMediaTree(
  fixture: Awaited<ReturnType<typeof makeRoot>>,
  attemptId: string,
): Promise<void> {
  const row = fixture.database.raw
    .prepare(
      "SELECT media_json, processing_context_json FROM attempts WHERE id = ?",
    )
    .get(attemptId) as Readonly<{
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
  const payload = join(originalDirectory, "payload");
  expect((await stat(payload)).mode & 0o777).toBe(0o600);
  expect((await lstat(payload)).isSymbolicLink()).toBe(false);
  const frames = await readdir(frameDirectory);
  const jpegFrames = frames.filter((frame) => frame.endsWith(".jpg"));
  expect(jpegFrames).toHaveLength(640);
  expect((await stat(join(frameDirectory, jpegFrames[0]!))).mode & 0o777).toBe(
    0o600,
  );
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
