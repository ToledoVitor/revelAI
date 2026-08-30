import { z } from "zod";
import { AttemptModeSchema, AttemptStatusSchema } from "./attempts.js";
import { FailureMessageByCode, InvalidRetryMessageByCode } from "./errors.js";
import { NonEmptyStringSchema, UtcIsoTimestampSchema } from "./primitives.js";

const DemoProviderVersionSchema = z.literal("demo-observations-v1");
const RoboflowWorkflowVersionSchema = z.literal("1.0.0");
const RuleVersionSchema = z.literal("wall-pass-v1-score-1");

export const FreeDemoAnalysisProvenanceSchema = z
  .object({
    kind: z.literal("demo"),
    fixtureId: z.enum(["free-well-framed-active-v1", "free-limited-ball-v1"]),
    providerVersion: DemoProviderVersionSchema,
  })
  .strict();

export const FreeRoboflowAnalysisProvenanceSchema = z
  .object({
    kind: z.literal("roboflow"),
    workspaceId: NonEmptyStringSchema,
    workflowId: z.literal("revelai-free-training-v1"),
    workflowVersion: RoboflowWorkflowVersionSchema,
    modelBundleId: NonEmptyStringSchema,
    providerVersion: NonEmptyStringSchema,
  })
  .strict();

export const FreeAnalysisProvenanceSchema = z.discriminatedUnion("kind", [
  FreeDemoAnalysisProvenanceSchema,
  FreeRoboflowAnalysisProvenanceSchema,
]);

export const VerifiedDemoAnalysisProvenanceSchema = z
  .object({
    kind: z.literal("demo"),
    fixtureId: z.enum(["wall-pass-balanced-v1", "wall-pass-insufficient-v1"]),
    providerVersion: DemoProviderVersionSchema,
  })
  .strict();

export const VerifiedRoboflowAnalysisProvenanceSchema = z
  .object({
    kind: z.literal("roboflow"),
    workspaceId: NonEmptyStringSchema,
    workflowId: z.literal("revelai-wall-pass-geometry-v1"),
    workflowVersion: RoboflowWorkflowVersionSchema,
    modelBundleId: NonEmptyStringSchema,
    providerVersion: NonEmptyStringSchema,
  })
  .strict();

export const VerifiedAnalysisProvenanceSchema = z.discriminatedUnion("kind", [
  VerifiedDemoAnalysisProvenanceSchema,
  VerifiedRoboflowAnalysisProvenanceSchema,
]);

export const AnalysisProvenanceSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("demo"),
      fixtureId: z.enum([
        "free-well-framed-active-v1",
        "free-limited-ball-v1",
        "wall-pass-balanced-v1",
        "wall-pass-insufficient-v1",
      ]),
      providerVersion: DemoProviderVersionSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("roboflow"),
      workspaceId: NonEmptyStringSchema,
      workflowId: z.enum([
        "revelai-free-training-v1",
        "revelai-wall-pass-geometry-v1",
      ]),
      workflowVersion: RoboflowWorkflowVersionSchema,
      modelBundleId: NonEmptyStringSchema,
      providerVersion: NonEmptyStringSchema,
    })
    .strict(),
]);

const PercentSchema = z.number().finite().int().min(0).max(100);
const RoundedPercentSchema = z
  .number()
  .finite()
  .min(0)
  .max(100)
  .refine(
    (value) => Number(value.toFixed(2)) === value,
    "Percentage values must be rounded to two decimal places",
  );

export const FreeObservationSchema = z
  .discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("athlete-visibility"),
        unit: z.literal("percent"),
        value: PercentSchema,
        range: z.enum(["limited", "partial", "consistent"]),
      })
      .strict(),
    z
      .object({
        kind: z.literal("ball-visibility"),
        unit: z.literal("percent"),
        value: PercentSchema,
        range: z.enum(["limited", "partial", "consistent"]),
      })
      .strict(),
    z
      .object({
        kind: z.literal("movement-activity"),
        unit: z.literal("percent"),
        value: PercentSchema,
        range: z.enum(["low", "moderate", "high"]),
      })
      .strict(),
  ])
  .superRefine((observation, context) => {
    const expectedRange =
      observation.kind === "movement-activity"
        ? observation.value <= 19
          ? "low"
          : observation.value <= 59
            ? "moderate"
            : "high"
        : observation.value <= 49
          ? "limited"
          : observation.value <= 79
            ? "partial"
            : "consistent";

    if (observation.range !== expectedRange) {
      context.addIssue({
        code: "custom",
        message: "Free observation range must match its percentage value",
        path: ["range"],
      });
    }
  });

export const FreeInsightTipSchema = z.enum([
  "Mantenha o corpo inteiro visível.",
  "Mantenha a bola visível durante a sequência.",
  "Grave uma sequência com mais movimento contínuo.",
  "Boa cobertura para uma análise aproximada.",
]);

export const FreeInsightTipsSchema = z.union([
  z.tuple([z.literal("Mantenha o corpo inteiro visível.")]),
  z.tuple([z.literal("Mantenha a bola visível durante a sequência.")]),
  z.tuple([z.literal("Grave uma sequência com mais movimento contínuo.")]),
  z.tuple([z.literal("Boa cobertura para uma análise aproximada.")]),
  z.tuple([
    z.literal("Mantenha o corpo inteiro visível."),
    z.literal("Mantenha a bola visível durante a sequência."),
  ]),
]);

export const FreeInsightSchema = z
  .object({
    kind: z.literal("free-insight"),
    attemptId: NonEmptyStringSchema,
    provenance: FreeAnalysisProvenanceSchema,
    approximate: z.literal(true),
    observations: z.array(FreeObservationSchema),
    tips: FreeInsightTipsSchema,
    generatedAt: UtcIsoTimestampSchema,
  })
  .strict()
  .superRefine((insight, context) => {
    const athleteObservation = insight.observations.filter(
      (observation) => observation.kind === "athlete-visibility",
    );
    const ballObservation = insight.observations.filter(
      (observation) => observation.kind === "ball-visibility",
    );
    const movementObservation = insight.observations.filter(
      (observation) => observation.kind === "movement-activity",
    );

    if (
      athleteObservation.length !== 1 ||
      ballObservation.length !== 1 ||
      movementObservation.length !== 1
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Free insight must contain exactly one observation of each kind",
        path: ["observations"],
      });
      return;
    }

    const expectedTips =
      athleteObservation[0].range === "limited"
        ? ballObservation[0].range === "limited"
          ? [
              "Mantenha o corpo inteiro visível.",
              "Mantenha a bola visível durante a sequência.",
            ]
          : ["Mantenha o corpo inteiro visível."]
        : ballObservation[0].range === "limited"
          ? ["Mantenha a bola visível durante a sequência."]
          : movementObservation[0].range === "low"
            ? ["Grave uma sequência com mais movimento contínuo."]
            : ["Boa cobertura para uma análise aproximada."];

    if (
      insight.tips.length !== expectedTips.length ||
      insight.tips.some((tip, index) => tip !== expectedTips[index])
    ) {
      context.addIssue({
        code: "custom",
        message: "Free insight tips must match its deterministic observations",
        path: ["tips"],
      });
    }
  });

export const VerifiedMetricsSchema = z
  .object({
    validPasses: z.number().int().min(0),
    accuracyPercent: z.number().finite().min(0).max(100),
    meanCadenceSeconds: z.number().finite().min(0),
    leftFootPercent: z.number().finite().min(0).max(100),
    rightFootPercent: z.number().finite().min(0).max(100),
  })
  .strict();

export const RankingSnapshotSchema = z
  .object({
    kind: z.literal("frozen"),
    challengeId: z.literal("wall-pass"),
    challengeVersion: z.literal(1),
    ruleVersion: RuleVersionSchema,
    rank: z.number().int().min(1),
    cohortSize: z.number().int().min(1),
    percentile: RoundedPercentSchema,
    topPercent: RoundedPercentSchema,
    scoreCountAtFinalization: z.number().int().min(1),
    asOfAttemptId: NonEmptyStringSchema,
    calculatedAt: UtcIsoTimestampSchema,
  })
  .strict()
  .superRefine((snapshot, context) => {
    if (snapshot.rank > snapshot.cohortSize) {
      context.addIssue({
        code: "custom",
        message: "Frozen rank cannot exceed its cohort size",
        path: ["rank"],
      });
    }

    if (snapshot.scoreCountAtFinalization !== snapshot.cohortSize) {
      context.addIssue({
        code: "custom",
        message: "Frozen score count must equal its cohort size",
        path: ["scoreCountAtFinalization"],
      });
    }

    const expectedTopPercent = Number((100 - snapshot.percentile).toFixed(2));

    if (snapshot.topPercent !== expectedTopPercent) {
      context.addIssue({
        code: "custom",
        message: "Frozen top percent must complement percentile",
        path: ["topPercent"],
      });
    }
  });

const VerifiedResultSharedFields = {
  kind: z.literal("verified-result"),
  attemptId: NonEmptyStringSchema,
  challengeId: z.literal("wall-pass"),
  challengeVersion: z.literal(1),
  ruleVersion: RuleVersionSchema,
  provenance: VerifiedAnalysisProvenanceSchema,
  metrics: VerifiedMetricsSchema,
  score: z.number().int().min(0).max(100),
  completedAt: UtcIsoTimestampSchema,
};

export const VerifiedResultSchema = z
  .discriminatedUnion("competitiveStatus", [
    z
      .object({
        ...VerifiedResultSharedFields,
        competitiveStatus: z.literal("ranked"),
        competitiveEligible: z.literal(true),
        provenance: VerifiedRoboflowAnalysisProvenanceSchema,
        rankingSnapshot: RankingSnapshotSchema,
      })
      .strict(),
    z
      .object({
        ...VerifiedResultSharedFields,
        competitiveStatus: z.literal("demo"),
        competitiveEligible: z.literal(false),
        provenance: VerifiedDemoAnalysisProvenanceSchema,
      })
      .strict(),
    z
      .object({
        ...VerifiedResultSharedFields,
        competitiveStatus: z.literal("experimental"),
        competitiveEligible: z.literal(false),
        provenance: VerifiedRoboflowAnalysisProvenanceSchema,
      })
      .strict(),
  ])
  .superRefine((result, context) => {
    if (
      result.competitiveStatus === "ranked" &&
      result.rankingSnapshot.asOfAttemptId !== result.attemptId
    ) {
      context.addIssue({
        code: "custom",
        message: "Frozen ranking snapshot must belong to this attempt",
        path: ["rankingSnapshot", "asOfAttemptId"],
      });
    }
  });

const PendingAttemptOutcomeSchema = z
  .object({
    state: z.literal("pending"),
    attemptId: NonEmptyStringSchema,
    mode: AttemptModeSchema,
    status: z.enum(["awaiting-upload", "uploaded", "processing"]),
  })
  .strict();

const ValidAttemptOutcomeSchema = z
  .object({
    state: z.literal("valid"),
    result: z.union([FreeInsightSchema, VerifiedResultSchema]),
  })
  .strict();

const InvalidAttemptOutcomeSchema = z.discriminatedUnion("code", [
  z
    .object({
      state: z.literal("invalid"),
      attemptId: NonEmptyStringSchema,
      mode: z.literal("verified"),
      code: z.literal("capture_requirements_not_met"),
      message: z.literal(
        InvalidRetryMessageByCode.capture_requirements_not_met,
      ),
      retryable: z.literal(true),
    })
    .strict(),
  z
    .object({
      state: z.literal("invalid"),
      attemptId: NonEmptyStringSchema,
      mode: z.literal("verified"),
      code: z.literal("video_not_continuous"),
      message: z.literal(InvalidRetryMessageByCode.video_not_continuous),
      retryable: z.literal(true),
    })
    .strict(),
  z
    .object({
      state: z.literal("invalid"),
      attemptId: NonEmptyStringSchema,
      mode: z.literal("verified"),
      code: z.literal("calibration_not_verified"),
      message: z.literal(InvalidRetryMessageByCode.calibration_not_verified),
      retryable: z.literal(true),
    })
    .strict(),
  z
    .object({
      state: z.literal("invalid"),
      attemptId: NonEmptyStringSchema,
      mode: z.literal("verified"),
      code: z.literal("tracking_insufficient"),
      message: z.literal(InvalidRetryMessageByCode.tracking_insufficient),
      retryable: z.literal(true),
    })
    .strict(),
]);

const FailedAttemptOutcomeSchema = z.discriminatedUnion("code", [
  z
    .object({
      state: z.literal("failed"),
      attemptId: NonEmptyStringSchema,
      mode: AttemptModeSchema,
      code: z.literal("analysis_temporary_unavailable"),
      message: z.literal(FailureMessageByCode.analysis_temporary_unavailable),
      retryable: z.literal(true),
    })
    .strict(),
  z
    .object({
      state: z.literal("failed"),
      attemptId: NonEmptyStringSchema,
      mode: AttemptModeSchema,
      code: z.literal("analysis_configuration_invalid"),
      message: z.literal(FailureMessageByCode.analysis_configuration_invalid),
      retryable: z.literal(false),
    })
    .strict(),
  z
    .object({
      state: z.literal("failed"),
      attemptId: NonEmptyStringSchema,
      mode: AttemptModeSchema,
      code: z.literal("analysis_internal_error"),
      message: z.literal(FailureMessageByCode.analysis_internal_error),
      retryable: z.literal(false),
    })
    .strict(),
]);

export const AttemptOutcomeSchema = z.discriminatedUnion("state", [
  PendingAttemptOutcomeSchema,
  ValidAttemptOutcomeSchema,
  InvalidAttemptOutcomeSchema,
  FailedAttemptOutcomeSchema,
]);

const AttemptSummaryCommonFields = {
  id: NonEmptyStringSchema,
  status: AttemptStatusSchema,
  createdAt: UtcIsoTimestampSchema,
  outcome: AttemptOutcomeSchema,
};

export const AttemptSummarySchema = z
  .discriminatedUnion("mode", [
    z
      .object({
        ...AttemptSummaryCommonFields,
        mode: z.literal("free"),
      })
      .strict(),
    z
      .object({
        ...AttemptSummaryCommonFields,
        mode: z.literal("verified"),
        challenge: z
          .object({ id: z.literal("wall-pass"), version: z.literal(1) })
          .strict(),
      })
      .strict(),
  ])
  .superRefine((summary, context) => {
    const outcome = summary.outcome;

    if (outcome.state === "pending") {
      if (
        outcome.attemptId !== summary.id ||
        outcome.mode !== summary.mode ||
        outcome.status !== summary.status
      ) {
        context.addIssue({
          code: "custom",
          message: "Pending summary outcome must match its outer attempt",
          path: ["outcome"],
        });
      }

      return;
    }

    if (outcome.state === "valid") {
      const resultMode =
        outcome.result.kind === "free-insight" ? "free" : "verified";

      if (
        summary.status !== "valid" ||
        outcome.result.attemptId !== summary.id ||
        resultMode !== summary.mode
      ) {
        context.addIssue({
          code: "custom",
          message: "Valid summary outcome must match its outer attempt",
          path: ["outcome"],
        });
      }

      return;
    }

    if (
      outcome.attemptId !== summary.id ||
      outcome.mode !== summary.mode ||
      outcome.state !== summary.status
    ) {
      context.addIssue({
        code: "custom",
        message: "Terminal summary outcome must match its outer attempt",
        path: ["outcome"],
      });
    }
  });

export const AttemptListResponseSchema = z
  .object({
    items: z.array(AttemptSummarySchema),
    nextCursor: NonEmptyStringSchema.nullable(),
  })
  .strict()
  .superRefine((response, context) => {
    for (const [index, summary] of response.items.entries()) {
      const previous = response.items[index - 1];

      if (
        previous !== undefined &&
        Date.parse(summary.createdAt) > Date.parse(previous.createdAt)
      ) {
        context.addIssue({
          code: "custom",
          message: "Attempt history must be ordered by reverse creation time",
          path: ["items", index, "createdAt"],
        });
      }
    }
  });

export const AttemptReadResponseSchema = AttemptSummarySchema;
export const AttemptResultResponseSchema = AttemptOutcomeSchema;
export const CreateAttemptResponseSchema = AttemptSummarySchema;

export const LeaderboardQuerySchema = z
  .object({
    version: z.coerce.number().int().pipe(z.literal(1)),
    ruleVersion: RuleVersionSchema,
    limit: z.coerce.number().int().min(1).max(50).optional().default(20),
    cursor: NonEmptyStringSchema.optional(),
  })
  .strict();

export const LeaderboardResponseSchema = z
  .object({
    view: z.literal("live"),
    challengeId: z.literal("wall-pass"),
    challengeVersion: z.literal(1),
    ruleVersion: RuleVersionSchema,
    calculatedAt: UtcIsoTimestampSchema,
    cohortSize: z.number().int().min(0),
    entries: z.array(
      z
        .object({
          entryId: NonEmptyStringSchema,
          rank: z.number().int().min(1),
          score: z.number().int().min(0).max(100),
          completedAt: UtcIsoTimestampSchema,
        })
        .strict(),
    ),
    nextCursor: NonEmptyStringSchema.nullable(),
  })
  .strict()
  .superRefine((leaderboard, context) => {
    if (leaderboard.entries.length > leaderboard.cohortSize) {
      context.addIssue({
        code: "custom",
        message: "Live leaderboard entries cannot exceed its cohort size",
        path: ["entries"],
      });
    }

    const entryIds = new Set<string>();

    for (const [index, entry] of leaderboard.entries.entries()) {
      if (entry.rank > leaderboard.cohortSize) {
        context.addIssue({
          code: "custom",
          message: "Live leaderboard rank cannot exceed its cohort size",
          path: ["entries", index, "rank"],
        });
      }

      if (entryIds.has(entry.entryId)) {
        context.addIssue({
          code: "custom",
          message: "Live leaderboard entry IDs must be unique",
          path: ["entries", index, "entryId"],
        });
      }
      entryIds.add(entry.entryId);

      const expectedCompetitionRank =
        leaderboard.entries.filter((candidate) => candidate.score > entry.score)
          .length + 1;

      if (entry.rank !== expectedCompetitionRank) {
        context.addIssue({
          code: "custom",
          message:
            "Live leaderboard ranks must use competition ranking for its scores",
          path: ["entries", index, "rank"],
        });
      }

      const previous = leaderboard.entries[index - 1];

      if (previous === undefined) {
        continue;
      }

      if (entry.score > previous.score) {
        context.addIssue({
          code: "custom",
          message:
            "Live leaderboard entries must be ordered by descending score",
          path: ["entries", index, "score"],
        });
      }

      if (entry.score === previous.score && entry.rank !== previous.rank) {
        context.addIssue({
          code: "custom",
          message: "Equal live leaderboard scores must share a rank",
          path: ["entries", index, "rank"],
        });
      }

      if (entry.score < previous.score && entry.rank <= previous.rank) {
        context.addIssue({
          code: "custom",
          message: "Lower live leaderboard scores must have a later rank",
          path: ["entries", index, "rank"],
        });
      }

      if (
        entry.score === previous.score &&
        entry.completedAt < previous.completedAt
      ) {
        context.addIssue({
          code: "custom",
          message:
            "Equal live leaderboard scores must be ordered by completed time",
          path: ["entries", index, "completedAt"],
        });
      }

      if (
        entry.score === previous.score &&
        entry.completedAt === previous.completedAt &&
        entry.entryId <= previous.entryId
      ) {
        context.addIssue({
          code: "custom",
          message:
            "Equal live leaderboard scores and times must be ordered by entry ID",
          path: ["entries", index, "entryId"],
        });
      }
    }
  });

export const DeleteAttemptResponseSchema = z.undefined();
export const HealthResponseSchema = z
  .object({ status: z.literal("ok") })
  .strict();
export const ReadinessResponseSchema = z
  .object({ status: z.literal("ready") })
  .strict();

export type FreeAnalysisProvenance = z.infer<
  typeof FreeAnalysisProvenanceSchema
>;
export type FreeDemoAnalysisProvenance = z.infer<
  typeof FreeDemoAnalysisProvenanceSchema
>;
export type FreeRoboflowAnalysisProvenance = z.infer<
  typeof FreeRoboflowAnalysisProvenanceSchema
>;
export type VerifiedAnalysisProvenance = z.infer<
  typeof VerifiedAnalysisProvenanceSchema
>;
export type VerifiedDemoAnalysisProvenance = z.infer<
  typeof VerifiedDemoAnalysisProvenanceSchema
>;
export type VerifiedRoboflowAnalysisProvenance = z.infer<
  typeof VerifiedRoboflowAnalysisProvenanceSchema
>;
export type AnalysisProvenance = z.infer<typeof AnalysisProvenanceSchema>;
export type FreeObservation = z.infer<typeof FreeObservationSchema>;
export type FreeInsightTip = z.infer<typeof FreeInsightTipSchema>;
export type FreeInsightTips = z.infer<typeof FreeInsightTipsSchema>;
export type FreeInsight = z.infer<typeof FreeInsightSchema>;
export type VerifiedMetrics = z.infer<typeof VerifiedMetricsSchema>;
export type RankingSnapshot = z.infer<typeof RankingSnapshotSchema>;
export type VerifiedResult = z.infer<typeof VerifiedResultSchema>;
export type AttemptOutcome = z.infer<typeof AttemptOutcomeSchema>;
export type AttemptSummary = z.infer<typeof AttemptSummarySchema>;
export type AttemptListResponse = z.infer<typeof AttemptListResponseSchema>;
export type AttemptReadResponse = z.infer<typeof AttemptReadResponseSchema>;
export type AttemptResultResponse = z.infer<typeof AttemptResultResponseSchema>;
export type CreateAttemptResponse = z.infer<typeof CreateAttemptResponseSchema>;
export type LeaderboardQuery = z.infer<typeof LeaderboardQuerySchema>;
export type LeaderboardResponse = z.infer<typeof LeaderboardResponseSchema>;
export type DeleteAttemptResponse = z.infer<typeof DeleteAttemptResponseSchema>;
export type HealthResponse = z.infer<typeof HealthResponseSchema>;
export type ReadinessResponse = z.infer<typeof ReadinessResponseSchema>;
