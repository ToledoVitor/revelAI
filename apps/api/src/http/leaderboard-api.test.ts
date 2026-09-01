import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LeaderboardResponseSchema,
  passingWorkflowBenchmarkReceiptFixture,
  RouteErrorSchema,
} from "@revelai/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createProductionAttemptApi } from "../composition/sqlite-media-upload-composition.js";
import { openSqliteDatabase } from "../database/sqlite-database.js";
import { createC5PipelineTestSupport } from "../media/c5-pipeline-test-support.js";
import { SQLiteRetentionRepository } from "../media/sqlite-retention-repository.js";
import { InMemoryAnalysisQueue } from "../queue/in-memory-analysis-queue.js";
import {
  createStoredMediaAttachment,
  type TerminalCandidate,
} from "../repositories/attempt-repository.js";
import { SQLiteAttemptRepository } from "../repositories/sqlite-attempt-repository.js";
import {
  issueRankedPolicyFinalization,
  resolveProductionSQLiteCompetitivePolicyLookupPort,
  SQLiteCompetitivePolicyRepository,
} from "../repositories/sqlite-competitive-policy-repository.js";
import { createLocalC8AcceptedMediaCleaner } from "../services/local-c8-accepted-media-cleaner.js";

const directories: string[] = [];
const calculatedAt = "2030-01-15T12:00:00.000Z";

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("wall-pass live leaderboard HTTP", () => {
  it("serves the public demo leaderboard without an athlete header", async () => {
    const fixture = await makeLeaderboardApi();
    try {
      const readsBefore = fixture.clockReadCount();
      const response = await fixture.app.inject({
        method: "GET",
        url: "/v1/leaderboards/wall-pass?version=1&ruleVersion=wall-pass-v1-score-1&limit=20",
      });

      expect(response.statusCode).toBe(200);
      expect(fixture.clockReadCount()).toBe(readsBefore + 1);
      expect(LeaderboardResponseSchema.parse(response.json())).toEqual({
        view: "live",
        challengeId: "wall-pass",
        challengeVersion: 1,
        ruleVersion: "wall-pass-v1-score-1",
        calculatedAt,
        cohortSize: 0,
        entries: [],
        nextCursor: null,
      });
    } finally {
      await fixture.close();
    }
  });

  it("projects real ranked SQLite entries as a public live tied page", async () => {
    const fixture = await makeLeaderboardApi();
    try {
      const rankedPolicy = await activatePassingCompetitivePolicy(fixture);
      await finalizeVerifiedAttempt(fixture, {
        attemptId: "11111111-1111-4111-8111-111111111111",
        sessionId: "21111111-1111-4111-8111-111111111111",
        mediaId: "31111111-1111-4111-8111-111111111111",
        candidate: rankedCandidate("11111111-1111-4111-8111-111111111111", 84),
        rankedPolicy,
      });
      await finalizeVerifiedAttempt(fixture, {
        attemptId: "12222222-2222-4222-8222-222222222222",
        sessionId: "22222222-2222-4222-8222-222222222222",
        mediaId: "32222222-2222-4222-8222-222222222222",
        candidate: rankedCandidate("12222222-2222-4222-8222-222222222222", 84),
        rankedPolicy,
      });
      await finalizeVerifiedAttempt(fixture, {
        attemptId: "13333333-3333-4333-8333-333333333333",
        sessionId: "23333333-3333-4333-8333-333333333333",
        mediaId: "33333333-3333-4333-8333-333333333333",
        candidate: demoCandidate("13333333-3333-4333-8333-333333333333"),
      });
      await finalizeVerifiedAttempt(fixture, {
        attemptId: "14444444-4444-4444-8444-444444444444",
        sessionId: "24444444-4444-4444-8444-444444444444",
        mediaId: "34444444-4444-4444-8444-444444444444",
        candidate: experimentalCandidate(
          "14444444-4444-4444-8444-444444444444",
        ),
      });

      const first = await fixture.app.inject({
        method: "GET",
        url: "/v1/leaderboards/wall-pass?version=1&ruleVersion=wall-pass-v1-score-1&limit=1",
      });

      expect(first.statusCode).toBe(200);
      const firstPage = LeaderboardResponseSchema.parse(first.json());
      expect(firstPage).toMatchObject({
        view: "live",
        cohortSize: 2,
        entries: [
          {
            rank: 1,
            score: 84,
            completedAt: calculatedAt,
          },
        ],
      });
      expect(firstPage.nextCursor).toEqual(expect.any(String));
      expect(JSON.stringify(firstPage)).not.toMatch(
        /athlete|media|receipt|policy|provenance/i,
      );

      const second = await fixture.app.inject({
        method: "GET",
        url: `/v1/leaderboards/wall-pass?version=1&ruleVersion=wall-pass-v1-score-1&limit=1&cursor=${encodeURIComponent(firstPage.nextCursor!)}`,
      });

      expect(second.statusCode).toBe(200);
      expect(LeaderboardResponseSchema.parse(second.json())).toMatchObject({
        cohortSize: 2,
        entries: [
          {
            rank: 1,
            score: 84,
            completedAt: calculatedAt,
          },
        ],
        nextCursor: null,
      });
      expect(
        LeaderboardResponseSchema.parse(second.json()).entries[0]?.entryId,
      ).not.toBe(firstPage.entries[0]?.entryId);
    } finally {
      await fixture.close();
    }
  }, 10_000);

  it("keeps an authenticated page cursor stable as the clock advances", async () => {
    const fixture = await makeLeaderboardApi();
    try {
      const rankedPolicy = await activatePassingCompetitivePolicy(fixture);
      await finalizeVerifiedAttempt(fixture, {
        attemptId: "15555555-5555-4555-8555-555555555555",
        sessionId: "25555555-5555-4555-8555-555555555555",
        mediaId: "35555555-5555-4555-8555-555555555555",
        candidate: rankedCandidate("15555555-5555-4555-8555-555555555555", 82),
        rankedPolicy,
      });
      await finalizeVerifiedAttempt(fixture, {
        attemptId: "16666666-6666-4666-8666-666666666666",
        sessionId: "26666666-6666-4666-8666-666666666666",
        mediaId: "36666666-6666-4666-8666-666666666666",
        candidate: rankedCandidate("16666666-6666-4666-8666-666666666666", 81),
        rankedPolicy,
      });
      const first = await fixture.app.inject({
        method: "GET",
        url: "/v1/leaderboards/wall-pass?version=1&ruleVersion=wall-pass-v1-score-1&limit=1",
      });
      const firstPage = LeaderboardResponseSchema.parse(first.json());
      const cursor = firstPage.nextCursor;
      expect(cursor).toEqual(expect.any(String));
      const readsAfterFirstPage = fixture.clockReadCount();
      const tamperedCursor = `${cursor!.slice(0, -1)}${
        cursor!.at(-1) === "A" ? "B" : "A"
      }`;
      const tampered = await fixture.app.inject({
        method: "GET",
        url: `/v1/leaderboards/wall-pass?version=1&ruleVersion=wall-pass-v1-score-1&limit=1&cursor=${encodeURIComponent(tamperedCursor)}`,
      });
      expect(tampered.statusCode).toBe(400);
      expect(RouteErrorSchema.parse(tampered.json()).code).toBe(
        "invalid_request",
      );

      fixture.setCalculatedAt("2030-01-15T12:00:00.001Z");
      const second = await fixture.app.inject({
        method: "GET",
        url: `/v1/leaderboards/wall-pass?version=1&ruleVersion=wall-pass-v1-score-1&limit=1&cursor=${encodeURIComponent(cursor!)}`,
      });
      expect(second.statusCode).toBe(200);
      expect(LeaderboardResponseSchema.parse(second.json())).toMatchObject({
        calculatedAt: firstPage.calculatedAt,
        cohortSize: 2,
        entries: [{ score: 81, rank: 2 }],
        nextCursor: null,
      });
      expect(fixture.clockReadCount()).toBe(readsAfterFirstPage);
    } finally {
      await fixture.close();
    }
  });

  it("keeps malformed leaderboard namespace requests public and query grammar canonical", async () => {
    const fixture = await makeLeaderboardApi();
    try {
      const canonical = await fixture.app.inject({
        method: "GET",
        url: "/v1/leaderboards/wall-pass?version=1&ruleVersion=wall-pass-v1-score-1&limit=50",
      });
      expect(canonical.statusCode).toBe(200);

      for (const url of [
        "/v1/leaderboards/wall-passx",
        "/v1/leaderboards/wall-pass/",
        "/v1/leaderboards/not-wall-pass",
        "/v1/leaderboards/wall-pass?version=01&ruleVersion=wall-pass-v1-score-1",
        "/v1/leaderboards/wall-pass?version=1.0&ruleVersion=wall-pass-v1-score-1",
        "/v1/leaderboards/wall-pass?version=1e0&ruleVersion=wall-pass-v1-score-1",
        "/v1/leaderboards/wall-pass?version=%201&ruleVersion=wall-pass-v1-score-1",
        "/v1/leaderboards/wall-pass?version=1%20&ruleVersion=wall-pass-v1-score-1",
        "/v1/leaderboards/wall-pass?version=1&version=1&ruleVersion=wall-pass-v1-score-1",
        "/v1/leaderboards/wall-pass?version=1&ruleVersion=wall-pass-v1-score-1&ruleVersion=wall-pass-v1-score-1",
        "/v1/leaderboards/wall-pass?version=2&ruleVersion=wall-pass-v1-score-1",
        "/v1/leaderboards/wall-pass?version=1&ruleVersion=wall-pass-v1-score-2",
        "/v1/leaderboards/wall-pass?version=1&ruleVersion=wall-pass-v1-score-1&unknown=true",
        "/v1/leaderboards/wall-pass?version=1&ruleVersion=wall-pass-v1-score-1&limit=01",
        "/v1/leaderboards/wall-pass?version=1&ruleVersion=wall-pass-v1-score-1&limit=%2B1",
        "/v1/leaderboards/wall-pass?version=1&ruleVersion=wall-pass-v1-score-1&limit=-1",
        "/v1/leaderboards/wall-pass?version=1&ruleVersion=wall-pass-v1-score-1&limit=1.0",
        "/v1/leaderboards/wall-pass?version=1&ruleVersion=wall-pass-v1-score-1&limit=1e1",
        "/v1/leaderboards/wall-pass?version=1&ruleVersion=wall-pass-v1-score-1&limit=%201",
        "/v1/leaderboards/wall-pass?version=1&ruleVersion=wall-pass-v1-score-1&limit=1%20",
        "/v1/leaderboards/wall-pass?version=1&ruleVersion=wall-pass-v1-score-1&limit=0",
        "/v1/leaderboards/wall-pass?version=1&ruleVersion=wall-pass-v1-score-1&limit=51",
        "/v1/leaderboards/wall-pass?version=1&ruleVersion=wall-pass-v1-score-1&limit=1&limit=1",
        "/v1/leaderboards/wall-pass?version=1&ruleVersion=wall-pass-v1-score-1&cursor=tampered",
        "/v1/leaderboards/wall-pass//?version=1&ruleVersion=wall-pass-v1-score-1",
        "/v1/leaderboards/wall-pass%2F?version=1&ruleVersion=wall-pass-v1-score-1",
        "/v1/leaderboards/wall-pass;malformed?version=1&ruleVersion=wall-pass-v1-score-1",
        "/v1/leaderboards/wall-pass%3Bmalformed?version=1&ruleVersion=wall-pass-v1-score-1",
      ]) {
        const response = await fixture.app.inject({ method: "GET", url });
        expect(response.statusCode, url).toBe(400);
        expect(RouteErrorSchema.parse(response.json()).code, url).toBe(
          "invalid_request",
        );
      }

      const wrongMethod = await fixture.app.inject({
        method: "POST",
        url: "/v1/leaderboards/wall-pass?version=1&ruleVersion=wall-pass-v1-score-1",
      });
      expect(wrongMethod.statusCode).toBe(400);
      expect(RouteErrorSchema.parse(wrongMethod.json()).code).toBe(
        "invalid_request",
      );

      const lookalikeOutsideNamespace = await fixture.app.inject({
        method: "GET",
        url: "/v1/leaderboardsx",
      });
      expect(lookalikeOutsideNamespace.statusCode).toBe(400);
      expect(
        RouteErrorSchema.parse(lookalikeOutsideNamespace.json()).code,
      ).toBe("invalid_athlete_identity");
    } finally {
      await fixture.close();
    }
  });

  it("fails closed without invoking post-composition list-method getters", async () => {
    const fixture = await makeLeaderboardApi();
    const prototype = SQLiteAttemptRepository.prototype;
    const originalDescriptor = Object.getOwnPropertyDescriptor(
      prototype,
      "listLiveLeaderboard",
    );
    let ownGetterReads = 0;
    let prototypeGetterReads = 0;
    try {
      Object.defineProperty(fixture.repository, "listLiveLeaderboard", {
        configurable: true,
        get: () => {
          ownGetterReads += 1;
          throw new Error("must not read an attacker-owned getter");
        },
      });

      const ownMutation = await fixture.app.inject({
        method: "GET",
        url: "/v1/leaderboards/wall-pass?version=1&ruleVersion=wall-pass-v1-score-1",
      });

      expect(ownMutation.statusCode).toBe(503);
      expect(ownMutation.json()).toMatchObject({ code: "service_not_ready" });
      expect(ownGetterReads).toBe(0);

      delete (fixture.repository as { listLiveLeaderboard?: unknown })
        .listLiveLeaderboard;
      Object.defineProperty(prototype, "listLiveLeaderboard", {
        configurable: true,
        get: () => {
          prototypeGetterReads += 1;
          throw new Error("must not read a mutated prototype getter");
        },
      });
      const prototypeMutation = await fixture.app.inject({
        method: "GET",
        url: "/v1/leaderboards/wall-pass?version=1&ruleVersion=wall-pass-v1-score-1",
      });

      expect(prototypeMutation.statusCode).toBe(503);
      expect(prototypeMutation.json()).toMatchObject({
        code: "service_not_ready",
      });
      expect(prototypeGetterReads).toBe(0);
    } finally {
      if (originalDescriptor)
        Object.defineProperty(
          prototype,
          "listLiveLeaderboard",
          originalDescriptor,
        );
      await fixture.close();
    }
  });
});

async function makeLeaderboardApi() {
  const directory = await mkdtemp(join(tmpdir(), "revelai-leaderboard-api-"));
  directories.push(directory);
  const database = openSqliteDatabase(join(directory, "api.sqlite"));
  const c5 = createC5PipelineTestSupport({ root: join(directory, "c5") });
  let nextId = 0;
  const ids = {
    next: () => {
      nextId += 1;
      return `aaaaaaaa-aaaa-4aaa-8aaa-${nextId.toString(16).padStart(12, "0")}`;
    },
  };
  let currentCalculatedAt = calculatedAt;
  let clockReads = 0;
  const clock = {
    now: () => {
      clockReads += 1;
      return currentCalculatedAt;
    },
  };
  const repository = new SQLiteAttemptRepository({
    database,
    clock,
    ids,
    handoffVerifier: c5.handoffVerifier,
  });
  const queue = new InMemoryAnalysisQueue();
  const retention = new SQLiteRetentionRepository({ database });
  const app = createProductionAttemptApi({
    repository,
    retention,
    mediaPipeline: c5.pipeline,
    queue,
    cleaner: createLocalC8AcceptedMediaCleaner({
      repository,
      storage: c5.storage,
    }),
    scheduler: { everyHour: () => 1, cancel: () => undefined },
    clock,
  });
  return Object.freeze({
    app,
    c5,
    database,
    repository,
    retention,
    clockReadCount: () => clockReads,
    setCalculatedAt(value: string) {
      currentCalculatedAt = value;
    },
    close: async () => {
      await app.close();
      database.close();
    },
  });
}

async function activatePassingCompetitivePolicy(
  fixture: Awaited<ReturnType<typeof makeLeaderboardApi>>,
) {
  const policy = new SQLiteCompetitivePolicyRepository({
    database: fixture.database,
    clock: { now: () => calculatedAt },
  });
  const receipt = passingWorkflowBenchmarkReceiptFixture;
  await policy.storeBenchmarkReceipt(receipt);
  const activation = {
    id: "49999999-9999-4999-8999-999999999999",
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
    challengeId: "wall-pass" as const,
    challengeVersion: 1 as const,
    ruleVersion: "wall-pass-v1-score-1" as const,
  };
  await policy.activateCompetitivePolicy(activation);
  const port = resolveProductionSQLiteCompetitivePolicyLookupPort(policy);
  if (!port) throw new Error("Expected a factory-issued policy lookup port");
  const current = await policy.getActiveCompetitivePolicy(activation);
  if (!current) throw new Error("Expected an active competitive policy");
  const rankedPolicy = issueRankedPolicyFinalization(
    port.finalization,
    current,
  );
  if (!rankedPolicy) throw new Error("Expected ranked finalization authority");
  return rankedPolicy;
}

async function finalizeVerifiedAttempt(
  fixture: Awaited<ReturnType<typeof makeLeaderboardApi>>,
  input: Readonly<{
    attemptId: string;
    sessionId: string;
    mediaId: string;
    candidate: TerminalCandidate;
    rankedPolicy?: ReturnType<typeof issueRankedPolicyFinalization>;
  }>,
): Promise<void> {
  await fixture.repository.issueCalibrationSession({
    id: input.sessionId,
    athleteId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    nonce: "A".repeat(43),
    challengeId: "wall-pass",
    challengeVersion: 1,
  });
  await fixture.repository.readyCalibrationSession({
    id: input.sessionId,
    athleteId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    requiredGates: ["device", "space", "athlete", "rehearsal", "record"],
  });
  await fixture.repository.createAttempt({
    id: input.attemptId,
    athleteId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    input: {
      mode: "verified",
      challengeId: "wall-pass",
      challengeVersion: 1,
      calibrationSessionId: input.sessionId,
    },
  });
  const context = await fixture.repository.prepareMediaUpload({
    attemptId: input.attemptId,
    athleteId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  });
  const job = await fixture.repository.attachPreparedMedia({
    accepted: await fixture.c5.accept(
      context,
      createStoredMediaAttachment({
        id: input.mediaId,
        contentType: "video/mp4",
        bytes: 16,
        uploadedAt: context.uploadedAt,
        deleteAt: "2030-01-16T12:00:00.000Z",
        transition: {
          kind: "upload-transition",
          resourceId: input.mediaId,
          deleteAt: "2030-01-15T13:00:00.000Z",
        },
      }),
      { retentionRepository: fixture.retention },
    ),
  });
  const claim = await fixture.repository.claimProcessing(job);
  if (!claim) throw new Error("Expected an attempt processing claim");
  await fixture.repository.finalizeTerminalResult({
    attemptId: input.attemptId,
    leaseId: claim.leaseId,
    generation: claim.generation,
    candidate: input.candidate,
    ...(input.rankedPolicy ? { rankedPolicy: input.rankedPolicy } : {}),
  });
}

function rankedCandidate(attemptId: string, score: number): TerminalCandidate {
  return {
    state: "valid",
    result: {
      ...verifiedResultBase(attemptId, score),
      provenance: roboflowProvenance,
      competitiveStatus: "ranked",
      competitiveEligible: true,
    },
  };
}

function demoCandidate(attemptId: string): TerminalCandidate {
  return {
    state: "valid",
    result: {
      ...verifiedResultBase(attemptId, 100),
      provenance: {
        kind: "demo",
        fixtureId: "wall-pass-balanced-v1",
        providerVersion: "demo-observations-v1",
      },
      competitiveStatus: "demo",
      competitiveEligible: false,
    },
  };
}

function experimentalCandidate(attemptId: string): TerminalCandidate {
  return {
    state: "valid",
    result: {
      ...verifiedResultBase(attemptId, 100),
      provenance: roboflowProvenance,
      competitiveStatus: "experimental",
      competitiveEligible: false,
    },
  };
}

const roboflowProvenance = Object.freeze({
  kind: "roboflow" as const,
  workspaceId: "revelai-workspace",
  workflowId: "revelai-wall-pass-geometry-v1",
  workflowVersion: "1.0.0",
  modelBundleId: "wall-pass-bundle-v1",
  providerVersion: "roboflow-inference-v1",
});

function verifiedResultBase(attemptId: string, score: number) {
  return {
    kind: "verified-result" as const,
    attemptId,
    challengeId: "wall-pass" as const,
    challengeVersion: 1 as const,
    ruleVersion: "wall-pass-v1-score-1" as const,
    metrics: {
      validPasses: 24,
      accuracyPercent: 80,
      meanCadenceSeconds: 2.5,
      leftFootPercent: 50,
      rightFootPercent: 50,
    },
    score,
    completedAt: calculatedAt,
  };
}
