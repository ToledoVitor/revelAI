import { describe, expect, it } from "vitest";
import {
  AttemptListResponseSchema,
  AttemptReadResponseSchema,
  AttemptOutcomeSchema,
  CreateAttemptResponseSchema,
  FreeInsightSchema,
  LeaderboardResponseSchema,
  MediaUploadFixtureDescriptorSchema,
  MediaUploadPartSchema,
  MediaUploadRequestSchema,
  passingWorkflowBenchmarkReceiptFixture,
  RankingSnapshotSchema,
  RouteErrorSchema,
  UtcIsoTimestampSchema,
  VerifiedResultSchema,
  WorkflowBenchmarkReceiptSchema,
  workflowBenchmarkReceiptDigest,
  type AttemptOutcome,
} from "./index.js";

const freeInsight = {
  kind: "free-insight",
  attemptId: "attempt-free-1",
  provenance: {
    kind: "demo",
    fixtureId: "free-well-framed-active-v1",
    providerVersion: "demo-observations-v1",
  },
  approximate: true,
  observations: [
    {
      kind: "athlete-visibility",
      unit: "percent",
      value: 90,
      range: "consistent",
    },
    {
      kind: "ball-visibility",
      unit: "percent",
      value: 90,
      range: "consistent",
    },
    {
      kind: "movement-activity",
      unit: "percent",
      value: 80,
      range: "high",
    },
  ],
  tips: ["Boa cobertura para uma análise aproximada."],
  generatedAt: "2026-08-30T12:00:00.000Z",
};

const verifiedResult = {
  kind: "verified-result",
  attemptId: "attempt-verified-1",
  challengeId: "wall-pass",
  challengeVersion: 1,
  ruleVersion: "wall-pass-v1-score-1",
  provenance: {
    kind: "roboflow",
    workspaceId: "workspace",
    workflowId: "revelai-wall-pass-geometry-v1",
    workflowVersion: "1.0.0",
    modelBundleId: "bundle",
    providerVersion: "provider",
  },
  metrics: {
    validPasses: 24,
    accuracyPercent: 80,
    meanCadenceSeconds: 2.5,
    leftFootPercent: 50,
    rightFootPercent: 50,
  },
  score: 76,
  completedAt: "2026-08-30T12:00:00.000Z",
};

function requiresLiteralTemporaryFailureRetryability(
  outcome: AttemptOutcome,
): void {
  if (
    outcome.state === "failed" &&
    outcome.code === "analysis_temporary_unavailable"
  ) {
    const retryable: true = outcome.retryable;
    void retryable;
  }
}

void requiresLiteralTemporaryFailureRetryability;

describe("review regression contracts", () => {
  it("rejects a history item whose outer identity, mode, status, and outcome disagree", () => {
    expect(
      AttemptReadResponseSchema.safeParse({
        id: "attempt-free-1",
        mode: "free",
        status: "valid",
        createdAt: "2026-08-30T12:00:00.000Z",
        outcome: { state: "valid", result: verifiedResult },
      }).success,
    ).toBe(false);
    expect(
      AttemptListResponseSchema.safeParse({
        items: [
          {
            id: "attempt-verified-1",
            mode: "free",
            status: "invalid",
            createdAt: "2026-08-30T12:00:00.000Z",
            outcome: {
              state: "invalid",
              attemptId: "attempt-verified-1",
              mode: "verified",
              code: "tracking_insufficient",
              message: "Não foi possível acompanhar a atividade no vídeo.",
              retryable: true,
            },
          },
        ],
        nextCursor: null,
      }).success,
    ).toBe(false);
    expect(
      AttemptListResponseSchema.safeParse({
        items: [
          {
            id: "attempt-free-older",
            mode: "free",
            status: "awaiting-upload",
            createdAt: "2026-08-30T11:00:00.000Z",
            outcome: {
              state: "pending",
              attemptId: "attempt-free-older",
              mode: "free",
              status: "awaiting-upload",
            },
          },
          {
            id: "attempt-free-newer",
            mode: "free",
            status: "awaiting-upload",
            createdAt: "2026-08-30T12:00:00.000Z",
            outcome: {
              state: "pending",
              attemptId: "attempt-free-newer",
              mode: "free",
              status: "awaiting-upload",
            },
          },
        ],
        nextCursor: null,
      }).success,
    ).toBe(false);
    expect(
      AttemptReadResponseSchema.safeParse({
        id: "attempt-free-1",
        mode: "free",
        status: "processing",
        createdAt: "2026-08-30T12:00:00.000Z",
        outcome: {
          state: "pending",
          attemptId: "another-attempt",
          mode: "free",
          status: "uploaded",
        },
      }).success,
    ).toBe(false);
  });

  it("requires exactly one observation of each kind and derives the free tips", () => {
    for (const [observations, tips] of [
      [
        [
          {
            kind: "athlete-visibility",
            unit: "percent",
            value: 10,
            range: "limited",
          },
          freeInsight.observations[1],
          freeInsight.observations[2],
        ],
        ["Mantenha o corpo inteiro visível."],
      ],
      [
        [
          freeInsight.observations[0],
          {
            kind: "ball-visibility",
            unit: "percent",
            value: 10,
            range: "limited",
          },
          freeInsight.observations[2],
        ],
        ["Mantenha a bola visível durante a sequência."],
      ],
      [
        [
          freeInsight.observations[0],
          freeInsight.observations[1],
          {
            kind: "movement-activity",
            unit: "percent",
            value: 10,
            range: "low",
          },
        ],
        ["Grave uma sequência com mais movimento contínuo."],
      ],
      [
        freeInsight.observations,
        ["Boa cobertura para uma análise aproximada."],
      ],
    ]) {
      expect(
        FreeInsightSchema.safeParse({ ...freeInsight, observations, tips })
          .success,
      ).toBe(true);
    }
    expect(
      FreeInsightSchema.safeParse({
        ...freeInsight,
        observations: freeInsight.observations.slice(0, 2),
      }).success,
    ).toBe(false);
    expect(
      FreeInsightSchema.safeParse({
        ...freeInsight,
        observations: [
          freeInsight.observations[0],
          freeInsight.observations[0],
          freeInsight.observations[2],
        ],
      }).success,
    ).toBe(false);
    expect(
      FreeInsightSchema.safeParse({
        ...freeInsight,
        observations: [
          {
            kind: "athlete-visibility",
            unit: "percent",
            value: 10,
            range: "limited",
          },
          freeInsight.observations[1],
          freeInsight.observations[2],
        ],
        tips: ["Boa cobertura para uma análise aproximada."],
      }).success,
    ).toBe(false);
    expect(
      FreeInsightSchema.safeParse({
        ...freeInsight,
        observations: [
          {
            kind: "athlete-visibility",
            unit: "percent",
            value: 10,
            range: "limited",
          },
          {
            kind: "ball-visibility",
            unit: "percent",
            value: 10,
            range: "limited",
          },
          freeInsight.observations[2],
        ],
        tips: [
          "Mantenha o corpo inteiro visível.",
          "Mantenha a bola visível durante a sequência.",
        ],
      }).success,
    ).toBe(true);
  });

  it("rejects impossible frozen and live ranking facts", () => {
    expect(
      RankingSnapshotSchema.safeParse({
        kind: "frozen",
        challengeId: "wall-pass",
        challengeVersion: 1,
        ruleVersion: "wall-pass-v1-score-1",
        rank: 99,
        cohortSize: 1,
        percentile: 12,
        topPercent: 99,
        scoreCountAtFinalization: 7,
        asOfAttemptId: "another-attempt",
        calculatedAt: "2026-08-30T12:00:00.000Z",
      }).success,
    ).toBe(false);
    expect(
      RankingSnapshotSchema.safeParse({
        kind: "frozen",
        challengeId: "wall-pass",
        challengeVersion: 1,
        ruleVersion: "wall-pass-v1-score-1",
        rank: 1,
        cohortSize: 1,
        percentile: 99.999,
        topPercent: 0,
        scoreCountAtFinalization: 1,
        asOfAttemptId: "attempt-verified-1",
        calculatedAt: "2026-08-30T12:00:00.000Z",
      }).success,
    ).toBe(false);
    expect(
      VerifiedResultSchema.safeParse({
        ...verifiedResult,
        competitiveStatus: "ranked",
        competitiveEligible: true,
        rankingSnapshot: {
          kind: "frozen",
          challengeId: "wall-pass",
          challengeVersion: 1,
          ruleVersion: "wall-pass-v1-score-1",
          rank: 1,
          cohortSize: 1,
          percentile: 100,
          topPercent: 0,
          scoreCountAtFinalization: 1,
          asOfAttemptId: "another-attempt",
          calculatedAt: "2026-08-30T12:00:00.000Z",
        },
      }).success,
    ).toBe(false);
    expect(
      LeaderboardResponseSchema.safeParse({
        view: "live",
        challengeId: "wall-pass",
        challengeVersion: 1,
        ruleVersion: "wall-pass-v1-score-1",
        calculatedAt: "2026-08-30T12:00:00.000Z",
        cohortSize: 1,
        entries: [
          {
            entryId: "entry-1",
            rank: 2,
            score: 76,
            completedAt: "2026-08-30T12:00:00.000Z",
          },
          {
            entryId: "entry-1",
            rank: 1,
            score: 76,
            completedAt: "2026-08-30T12:00:00.000Z",
          },
        ],
        nextCursor: null,
      }).success,
    ).toBe(false);
    expect(
      LeaderboardResponseSchema.safeParse({
        view: "live",
        challengeId: "wall-pass",
        challengeVersion: 1,
        ruleVersion: "wall-pass-v1-score-1",
        calculatedAt: "2026-08-30T12:00:00.000Z",
        cohortSize: 3,
        entries: [
          {
            entryId: "entry-1",
            rank: 1,
            score: 76,
            completedAt: "2026-08-30T12:00:00.000Z",
          },
          {
            entryId: "entry-2",
            rank: 1,
            score: 76,
            completedAt: "2026-08-30T12:00:00.000Z",
          },
          {
            entryId: "entry-3",
            rank: 2,
            score: 75,
            completedAt: "2026-08-30T12:00:00.000Z",
          },
        ],
        nextCursor: null,
      }).success,
    ).toBe(true);
    expect(
      LeaderboardResponseSchema.safeParse({
        view: "live",
        challengeId: "wall-pass",
        challengeVersion: 1,
        ruleVersion: "wall-pass-v1-score-1",
        calculatedAt: "2026-08-30T12:00:00.000Z",
        cohortSize: 3,
        entries: [
          {
            entryId: "entry-1",
            rank: 1,
            score: 76,
            completedAt: "2026-08-30T12:00:00.000Z",
          },
          {
            entryId: "entry-2",
            rank: 1,
            score: 76,
            completedAt: "2026-08-30T12:00:00.000Z",
          },
          {
            entryId: "entry-3",
            rank: 3,
            score: 75,
            completedAt: "2026-08-30T12:00:00.000Z",
          },
        ],
        nextCursor: null,
      }).success,
    ).toBe(true);
    expect(
      LeaderboardResponseSchema.safeParse({
        view: "live",
        challengeId: "wall-pass",
        challengeVersion: 1,
        ruleVersion: "wall-pass-v1-score-1",
        calculatedAt: "2026-08-30T12:00:00.000Z",
        cohortSize: 2,
        entries: [
          {
            entryId: "entry-z",
            rank: 1,
            score: 76,
            completedAt: "2026-08-30T12:00:00.000Z",
          },
          {
            entryId: "entry-a",
            rank: 1,
            score: 76,
            completedAt: "2026-08-30T12:00:00.000Z",
          },
        ],
        nextCursor: null,
      }).success,
    ).toBe(true);
    expect(
      LeaderboardResponseSchema.safeParse({
        view: "live",
        challengeId: "wall-pass",
        challengeVersion: 1,
        ruleVersion: "wall-pass-v1-score-1",
        calculatedAt: "2026-08-30T12:00:00.000Z",
        cohortSize: 100,
        entries: [
          {
            entryId: "opaque-page-two-21",
            rank: 21,
            score: 80,
            completedAt: "2026-08-30T12:00:00.000Z",
          },
          {
            entryId: "opaque-page-two-22",
            rank: 22,
            score: 79,
            completedAt: "2026-08-30T12:01:00.000Z",
          },
        ],
        nextCursor: "page-3",
      }).success,
    ).toBe(true);
    expect(
      LeaderboardResponseSchema.safeParse({
        view: "live",
        challengeId: "wall-pass",
        challengeVersion: 1,
        ruleVersion: "wall-pass-v1-score-1",
        calculatedAt: "2026-08-30T12:00:00.000Z",
        cohortSize: 100,
        entries: [
          {
            entryId: "opaque-cross-page-tie",
            rank: 21,
            score: 80,
            completedAt: "2026-08-30T12:00:00.000Z",
          },
          {
            entryId: "opaque-after-cross-page-tie",
            rank: 23,
            score: 79,
            completedAt: "2026-08-30T12:01:00.000Z",
          },
        ],
        nextCursor: null,
      }).success,
    ).toBe(true);
  });

  it("limits create responses to the initial awaiting-upload snapshot", () => {
    const freeCreateResponse = {
      id: "attempt-free-create-1",
      mode: "free",
      status: "awaiting-upload",
      createdAt: "2026-08-30T12:00:00.000Z",
      outcome: {
        state: "pending",
        attemptId: "attempt-free-create-1",
        mode: "free",
        status: "awaiting-upload",
      },
    };
    const verifiedCreateResponse = {
      id: "attempt-verified-create-1",
      mode: "verified",
      status: "awaiting-upload",
      createdAt: "2026-08-30T12:00:00.000Z",
      challenge: { id: "wall-pass", version: 1 },
      outcome: {
        state: "pending",
        attemptId: "attempt-verified-create-1",
        mode: "verified",
        status: "awaiting-upload",
      },
    };

    expect(
      CreateAttemptResponseSchema.safeParse(freeCreateResponse).success,
    ).toBe(true);
    expect(
      CreateAttemptResponseSchema.safeParse(verifiedCreateResponse).success,
    ).toBe(true);
    for (const status of ["uploaded", "processing"]) {
      expect(
        CreateAttemptResponseSchema.safeParse({
          ...freeCreateResponse,
          status,
          outcome: { ...freeCreateResponse.outcome, status },
        }).success,
      ).toBe(false);
    }
    expect(
      CreateAttemptResponseSchema.safeParse({
        ...freeCreateResponse,
        status: "failed",
        outcome: {
          state: "failed",
          attemptId: "attempt-free-create-1",
          mode: "free",
          code: "analysis_internal_error",
          message: "A análise não pôde ser concluída.",
          retryable: false,
        },
      }).success,
    ).toBe(false);
  });

  it("verifies a receipt digest against canonical content regardless of object key order", () => {
    expect(
      WorkflowBenchmarkReceiptSchema.safeParse({
        ...passingWorkflowBenchmarkReceiptFixture,
        workflow: {
          ...passingWorkflowBenchmarkReceiptFixture.workflow,
          workspaceId: "changed-workspace",
        },
      }).success,
    ).toBe(false);
    const { receiptSha256, ...payload } =
      passingWorkflowBenchmarkReceiptFixture;
    void receiptSha256;
    const reorderedPayload = {
      workflow: payload.workflow,
      schemaVersion: payload.schemaVersion,
      id: payload.id,
      scheduler: payload.scheduler,
      sampling: payload.sampling,
      manifestSet: payload.manifestSet,
      runs: payload.runs,
      pooledDispatchToObservationP95Ms:
        payload.pooledDispatchToObservationP95Ms,
      runAt: payload.runAt,
      validUntil: payload.validUntil,
      status: payload.status,
      invalidatedAt: payload.invalidatedAt,
      invalidationReason: payload.invalidationReason,
    };
    expect(workflowBenchmarkReceiptDigest(payload)).toBe(
      workflowBenchmarkReceiptDigest(reorderedPayload),
    );
  });

  it("accepts only allowlisted safe route and outcome messages", () => {
    for (const message of [
      "/opt/revelai/media.mp4",
      "C:\\revelai\\media.mp4",
      "\\\\server\\share\\media.mp4",
      "secret=sk-live-123",
      "token Bearer abc",
      '{"provider":"raw payload"}',
      "calibration drift was 12 pixels",
    ]) {
      expect(
        RouteErrorSchema.safeParse({
          code: "invalid_request",
          message,
          retryable: false,
        }).success,
      ).toBe(false);
      expect(
        AttemptOutcomeSchema.safeParse({
          state: "failed",
          attemptId: "attempt-free-1",
          mode: "free",
          code: "analysis_internal_error",
          message,
          retryable: false,
        }).success,
      ).toBe(false);
      expect(
        AttemptOutcomeSchema.safeParse({
          state: "invalid",
          attemptId: "attempt-verified-1",
          mode: "verified",
          code: "tracking_insufficient",
          message,
          retryable: true,
        }).success,
      ).toBe(false);
    }
  });

  it("exports named request and response contracts from the public entry point", () => {
    expect(CreateAttemptResponseSchema).toBeDefined();
    expect(MediaUploadFixtureDescriptorSchema).toBeDefined();
  });

  it("accepts calendar-valid UTC timestamps and normalized multipart MIME metadata", () => {
    expect(
      UtcIsoTimestampSchema.safeParse("2026-02-30T00:00:00.000Z").success,
    ).toBe(false);
    expect(
      UtcIsoTimestampSchema.safeParse("2028-02-29T00:00:00.000Z").success,
    ).toBe(true);
    expect(
      MediaUploadPartSchema.parse({
        kind: "file",
        fieldName: "media",
        filename: "ATTEMPT.MP4",
        declaredMime: "Video/MP4; charset=binary",
        fileBytes: 10,
      }).declaredMime,
    ).toBe("video/mp4");
    expect(
      MediaUploadRequestSchema.safeParse({
        parts: [
          {
            kind: "file",
            fieldName: "media",
            filename: "attempt.mp4",
            declaredMime: "video/mp4",
            fileBytes: 10,
          },
        ],
        multipartBytes: 9,
      }).success,
    ).toBe(false);
  });
});
