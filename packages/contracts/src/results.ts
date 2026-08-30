import { z } from "zod";
import { AttemptModeSchema, AttemptStatusSchema } from "./attempts.js";
import { FailureCodeSchema, InvalidRetryCodeSchema } from "./errors.js";
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
  .strict();

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
    percentile: z.number().finite().min(0).max(100),
    topPercent: z.number().finite().min(0).max(100),
    scoreCountAtFinalization: z.number().int().min(1),
    asOfAttemptId: NonEmptyStringSchema,
    calculatedAt: UtcIsoTimestampSchema,
  })
  .strict();

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

export const VerifiedResultSchema = z.discriminatedUnion("competitiveStatus", [
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
]);

export const AttemptOutcomeSchema = z.discriminatedUnion("state", [
  z
    .object({
      state: z.literal("pending"),
      attemptId: NonEmptyStringSchema,
      mode: AttemptModeSchema,
      status: z.enum(["awaiting-upload", "uploaded", "processing"]),
    })
    .strict(),
  z
    .object({
      state: z.literal("valid"),
      result: z.union([FreeInsightSchema, VerifiedResultSchema]),
    })
    .strict(),
  z
    .object({
      state: z.literal("invalid"),
      attemptId: NonEmptyStringSchema,
      mode: z.literal("verified"),
      code: InvalidRetryCodeSchema,
      message: NonEmptyStringSchema,
      retryable: z.literal(true),
    })
    .strict(),
  z
    .object({
      state: z.literal("failed"),
      attemptId: NonEmptyStringSchema,
      mode: AttemptModeSchema,
      code: FailureCodeSchema,
      message: NonEmptyStringSchema,
      retryable: z.boolean(),
    })
    .strict()
    .superRefine((outcome, context) => {
      const retryable = outcome.code === "analysis_temporary_unavailable";

      if (outcome.retryable !== retryable) {
        context.addIssue({
          code: "custom",
          message: "Failure retryability must match its code",
          path: ["retryable"],
        });
      }
    }),
]);

const AttemptSummaryCommonFields = {
  id: NonEmptyStringSchema,
  status: AttemptStatusSchema,
  createdAt: UtcIsoTimestampSchema,
  outcome: AttemptOutcomeSchema,
};

export const AttemptSummarySchema = z.discriminatedUnion("mode", [
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
]);

export const AttemptListResponseSchema = z
  .object({
    items: z.array(AttemptSummarySchema),
    nextCursor: NonEmptyStringSchema.nullable(),
  })
  .strict();

export const AttemptReadResponseSchema = AttemptSummarySchema;
export const AttemptResultResponseSchema = AttemptOutcomeSchema;

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
  .strict();

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
export type VerifiedAnalysisProvenance = z.infer<
  typeof VerifiedAnalysisProvenanceSchema
>;
export type AnalysisProvenance = z.infer<typeof AnalysisProvenanceSchema>;
export type FreeObservation = z.infer<typeof FreeObservationSchema>;
export type FreeInsightTip = z.infer<typeof FreeInsightTipSchema>;
export type FreeInsight = z.infer<typeof FreeInsightSchema>;
export type VerifiedMetrics = z.infer<typeof VerifiedMetricsSchema>;
export type RankingSnapshot = z.infer<typeof RankingSnapshotSchema>;
export type VerifiedResult = z.infer<typeof VerifiedResultSchema>;
export type AttemptOutcome = z.infer<typeof AttemptOutcomeSchema>;
export type AttemptSummary = z.infer<typeof AttemptSummarySchema>;
export type AttemptListResponse = z.infer<typeof AttemptListResponseSchema>;
export type LeaderboardResponse = z.infer<typeof LeaderboardResponseSchema>;
