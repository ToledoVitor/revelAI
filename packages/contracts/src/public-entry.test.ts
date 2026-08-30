import { describe, expect, it } from "vitest";
import {
  AthleteIdentityHeaderSchema,
  AttemptIdPathParamsSchema,
  AttemptListQuerySchema,
  AttemptListResponseSchema,
  AttemptOutcomeSchema,
  AttemptReadResponseSchema,
  AttemptResultResponseSchema,
  CalibrationSessionCreateInputSchema,
  CalibrationSessionIdPathParamsSchema,
  CalibrationSessionReadyInputSchema,
  CalibrationSessionSchema,
  ChallengeListResponseSchema,
  CreateAttemptInputSchema,
  CreateAttemptResponseSchema,
  DeleteAttemptResponseSchema,
  FreeInsightSchema,
  HealthResponseSchema,
  LeaderboardQuerySchema,
  LeaderboardResponseSchema,
  MediaUploadAcceptedSchema,
  MediaUploadPartSchema,
  MediaUploadRequestSchema,
  ReadinessResponseSchema,
  RouteErrorMessageByCode,
  RouteErrorSchema,
  UtcIsoTimestampSchema,
  WorkflowBenchmarkReceiptSchema,
  passingWorkflowBenchmarkReceiptFixture,
  type AttemptListResponse,
  type AttemptOutcome,
  type AttemptReadResponse,
  type AttemptResultResponse,
  type CreateAttemptResponse,
  type DeleteAttemptResponse,
  type HealthResponse,
  type LeaderboardQuery,
  type LeaderboardResponse,
  type ReadinessResponse,
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

const pendingSummary = {
  id: "attempt-free-1",
  mode: "free",
  status: "awaiting-upload",
  createdAt: "2026-08-30T12:00:00.000Z",
  outcome: {
    state: "pending",
    attemptId: "attempt-free-1",
    mode: "free",
    status: "awaiting-upload",
  },
};

function expectJsonRoundTrip(
  schema: { parse: (value: unknown) => unknown },
  value: unknown,
): void {
  const parsed = schema.parse(value);
  expect(schema.parse(JSON.parse(JSON.stringify(parsed)))).toStrictEqual(
    parsed,
  );
}

describe("public contracts entry point", () => {
  it("round-trips a representative matrix of every public request and response", () => {
    const mediaPart = {
      kind: "file",
      fieldName: "media",
      filename: "attempt.mp4",
      declaredMime: "video/mp4; charset=binary",
      fileBytes: 1,
    };
    const mediaUploadAccepted = {
      kind: "media-upload-accepted",
      attemptId: "attempt-free-1",
      mode: "free",
      acceptedStatus: "uploaded",
      outcome: {
        state: "pending",
        attemptId: "attempt-free-1",
        mode: "free",
        status: "uploaded",
      },
    };
    const calibrationSession = {
      id: "calibration-1",
      challengeId: "wall-pass",
      challengeVersion: 1,
      state: "ready",
      nonce: "1234567890123456789012345678901234567890123",
      issuedAt: "2026-08-30T12:00:00.000Z",
      expiresAt: "2026-08-30T12:15:00.000Z",
      requiredGates: ["device", "space", "athlete", "rehearsal", "record"],
    };
    const liveLeaderboard = {
      view: "live",
      challengeId: "wall-pass",
      challengeVersion: 1,
      ruleVersion: "wall-pass-v1-score-1",
      calculatedAt: "2026-08-30T12:00:00.000Z",
      cohortSize: 3,
      entries: [
        {
          entryId: "entry-a",
          rank: 1,
          score: 96,
          completedAt: "2026-08-30T12:00:00.000Z",
        },
        {
          entryId: "entry-b",
          rank: 1,
          score: 96,
          completedAt: "2026-08-30T12:00:00.000Z",
        },
        {
          entryId: "entry-c",
          rank: 3,
          score: 90,
          completedAt: "2026-08-30T12:00:00.000Z",
        },
      ],
      nextCursor: null,
    };

    for (const [schema, value] of [
      [
        AthleteIdentityHeaderSchema,
        {
          "x-revelai-athlete-id": "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
        },
      ],
      [CreateAttemptInputSchema, { mode: "free" }],
      [
        CreateAttemptInputSchema,
        {
          mode: "verified",
          challengeId: "wall-pass",
          challengeVersion: 1,
          calibrationSessionId: "calibration-1",
        },
      ],
      [
        CalibrationSessionCreateInputSchema,
        {
          challengeId: "wall-pass",
          challengeVersion: 1,
        },
      ],
      [
        CalibrationSessionReadyInputSchema,
        {
          requiredGates: ["device", "space", "athlete", "rehearsal", "record"],
        },
      ],
      [CalibrationSessionSchema, calibrationSession],
      [AttemptIdPathParamsSchema, { id: "attempt-free-1" }],
      [CalibrationSessionIdPathParamsSchema, { id: "calibration-1" }],
      [AttemptListQuerySchema, { limit: "20", cursor: "page-2" }],
      [MediaUploadPartSchema, mediaPart],
      [MediaUploadRequestSchema, { parts: [mediaPart], multipartBytes: 2 }],
      [MediaUploadAcceptedSchema, mediaUploadAccepted],
      [
        ChallengeListResponseSchema,
        {
          items: [
            {
              id: "wall-pass",
              version: 1,
              sport: "futsal",
              activeDurationSeconds: 60,
              calibrationPreRollSeconds: 4,
              requiredGates: [
                "device",
                "space",
                "athlete",
                "rehearsal",
                "record",
              ],
            },
          ],
        },
      ],
      [CreateAttemptResponseSchema, pendingSummary],
      [AttemptReadResponseSchema, pendingSummary],
      [
        AttemptListResponseSchema,
        { items: [pendingSummary], nextCursor: null },
      ],
      [FreeInsightSchema, freeInsight],
      [AttemptOutcomeSchema, { state: "valid", result: freeInsight }],
      [AttemptResultResponseSchema, { state: "valid", result: freeInsight }],
      [
        LeaderboardQuerySchema,
        {
          version: "1",
          ruleVersion: "wall-pass-v1-score-1",
          limit: "20",
        },
      ],
      [LeaderboardResponseSchema, liveLeaderboard],
      [
        RouteErrorSchema,
        {
          code: "invalid_request",
          message: RouteErrorMessageByCode.invalid_request,
          retryable: false,
        },
      ],
      [HealthResponseSchema, { status: "ok" }],
      [ReadinessResponseSchema, { status: "ready" }],
      [UtcIsoTimestampSchema, "2028-02-29T00:00:00.000Z"],
      [WorkflowBenchmarkReceiptSchema, passingWorkflowBenchmarkReceiptFixture],
    ]) {
      expectJsonRoundTrip(schema, value);
    }

    expect(DeleteAttemptResponseSchema.parse(undefined)).toBeUndefined();
  });

  it("exposes inferred transport types from the same root schemas", () => {
    const create: CreateAttemptResponse =
      CreateAttemptResponseSchema.parse(pendingSummary);
    const read: AttemptReadResponse =
      AttemptReadResponseSchema.parse(pendingSummary);
    const list: AttemptListResponse = AttemptListResponseSchema.parse({
      items: [pendingSummary],
      nextCursor: null,
    });
    const outcome: AttemptOutcome = AttemptOutcomeSchema.parse({
      state: "valid",
      result: freeInsight,
    });
    const result: AttemptResultResponse =
      AttemptResultResponseSchema.parse(outcome);
    const leaderboardQuery: LeaderboardQuery = LeaderboardQuerySchema.parse({
      version: "1",
      ruleVersion: "wall-pass-v1-score-1",
    });
    const leaderboard: LeaderboardResponse = LeaderboardResponseSchema.parse({
      view: "live",
      challengeId: "wall-pass",
      challengeVersion: 1,
      ruleVersion: "wall-pass-v1-score-1",
      calculatedAt: "2026-08-30T12:00:00.000Z",
      cohortSize: 0,
      entries: [],
      nextCursor: null,
    });
    const deletion: DeleteAttemptResponse =
      DeleteAttemptResponseSchema.parse(undefined);
    const health: HealthResponse = HealthResponseSchema.parse({ status: "ok" });
    const readiness: ReadinessResponse = ReadinessResponseSchema.parse({
      status: "ready",
    });

    expect({
      create,
      read,
      list,
      result,
      leaderboardQuery,
      leaderboard,
      deletion,
      health,
      readiness,
    }).toBeDefined();
  });
});
