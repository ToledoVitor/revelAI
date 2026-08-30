import { describe, expect, it } from "vitest";
import {
  AttemptOutcomeSchema,
  FreeInsightSchema,
  FreeInsightTipSchema,
  FreeAnalysisProvenanceSchema,
  LeaderboardResponseSchema,
  VerifiedAnalysisProvenanceSchema,
  VerifiedResultSchema,
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
    kind: "demo",
    fixtureId: "wall-pass-balanced-v1",
    providerVersion: "demo-observations-v1",
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

describe("outcome and result transport contracts", () => {
  it("accepts only the four Portuguese guidance literals", () => {
    for (const tip of [
      "Mantenha o corpo inteiro visível.",
      "Mantenha a bola visível durante a sequência.",
      "Grave uma sequência com mais movimento contínuo.",
      "Boa cobertura para uma análise aproximada.",
    ]) {
      expect(FreeInsightTipSchema.safeParse(tip).success).toBe(true);
    }
    expect(FreeInsightTipSchema.safeParse("Use mais força.").success).toBe(
      false,
    );
  });

  it("accepts only deterministic free-insight tip combinations and omits rank fields", () => {
    expect(FreeInsightSchema.safeParse(freeInsight).success).toBe(true);
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
    expect(
      FreeInsightSchema.safeParse({
        ...freeInsight,
        tips: [
          "Mantenha a bola visível durante a sequência.",
          "Mantenha o corpo inteiro visível.",
        ],
      }).success,
    ).toBe(false);
    expect(
      FreeInsightSchema.safeParse({
        ...freeInsight,
        tips: ["Mantenha o corpo inteiro visível.", "Use mais força."],
      }).success,
    ).toBe(false);
    expect(
      FreeInsightSchema.safeParse({ ...freeInsight, score: 76 }).success,
    ).toBe(false);
    expect(
      FreeInsightSchema.safeParse({
        ...freeInsight,
        observations: [
          {
            kind: "athlete-visibility",
            unit: "percent",
            value: 49,
            range: "consistent",
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("keeps free and verified provenance branches correlated", () => {
    expect(
      FreeAnalysisProvenanceSchema.safeParse(freeInsight.provenance).success,
    ).toBe(true);
    expect(
      FreeAnalysisProvenanceSchema.safeParse(verifiedResult.provenance).success,
    ).toBe(false);
    expect(
      VerifiedAnalysisProvenanceSchema.safeParse(verifiedResult.provenance)
        .success,
    ).toBe(true);
    expect(
      VerifiedAnalysisProvenanceSchema.safeParse({
        kind: "roboflow",
        workspaceId: "workspace",
        workflowId: "revelai-free-training-v1",
        workflowVersion: "1.0.0",
        modelBundleId: "bundle",
        providerVersion: "provider",
      }).success,
    ).toBe(false);
  });

  it("accepts pending, valid, invalid, and retry-classified failed outcomes", () => {
    expect(
      AttemptOutcomeSchema.safeParse({
        state: "pending",
        attemptId: "attempt-free-1",
        mode: "free",
        status: "processing",
      }).success,
    ).toBe(true);
    expect(
      AttemptOutcomeSchema.safeParse({ state: "valid", result: freeInsight })
        .success,
    ).toBe(true);
    expect(
      AttemptOutcomeSchema.safeParse({
        state: "invalid",
        attemptId: "attempt-verified-1",
        mode: "verified",
        code: "calibration_not_verified",
        message: "Refaça a calibração antes de tentar novamente.",
        retryable: true,
      }).success,
    ).toBe(true);
    expect(
      AttemptOutcomeSchema.safeParse({
        state: "failed",
        attemptId: "attempt-free-1",
        mode: "free",
        code: "analysis_temporary_unavailable",
        message: "A análise está indisponível temporariamente.",
        retryable: true,
      }).success,
    ).toBe(true);
    expect(
      AttemptOutcomeSchema.safeParse({
        state: "failed",
        attemptId: "attempt-free-1",
        mode: "free",
        code: "analysis_internal_error",
        message: "A análise não pôde ser concluída.",
        retryable: true,
      }).success,
    ).toBe(false);
    expect(
      AttemptOutcomeSchema.safeParse({
        state: "failed",
        attemptId: "attempt-free-1",
        mode: "free",
        code: "analysis_configuration_invalid",
        message: "A análise não está disponível agora.",
        retryable: false,
      }).success,
    ).toBe(true);
    expect(
      AttemptOutcomeSchema.safeParse({
        state: "failed",
        attemptId: "attempt-free-1",
        mode: "free",
        code: "analysis_internal_error",
        message: "A análise não pôde ser concluída.",
        retryable: false,
      }).success,
    ).toBe(true);
  });

  it("keeps every invalid retry code retryable", () => {
    for (const [code, message] of [
      ["capture_requirements_not_met", "A captura não atende aos requisitos."],
      [
        "video_not_continuous",
        "Grave um vídeo contínuo para tentar novamente.",
      ],
      [
        "calibration_not_verified",
        "Refaça a calibração antes de tentar novamente.",
      ],
      [
        "tracking_insufficient",
        "Não foi possível acompanhar a atividade no vídeo.",
      ],
    ]) {
      expect(
        AttemptOutcomeSchema.safeParse({
          state: "invalid",
          attemptId: "attempt-verified-1",
          mode: "verified",
          code,
          message,
          retryable: true,
        }).success,
      ).toBe(true);
    }
  });

  it("permits ranking data only on ranked verified results", () => {
    expect(
      VerifiedResultSchema.safeParse({
        ...verifiedResult,
        competitiveStatus: "demo",
        competitiveEligible: false,
      }).success,
    ).toBe(true);
    expect(
      VerifiedResultSchema.safeParse({
        ...verifiedResult,
        provenance: {
          kind: "roboflow",
          workspaceId: "workspace",
          workflowId: "revelai-wall-pass-geometry-v1",
          workflowVersion: "1.0.0",
          modelBundleId: "bundle",
          providerVersion: "provider",
        },
        competitiveStatus: "demo",
        competitiveEligible: false,
      }).success,
    ).toBe(false);
    expect(
      VerifiedResultSchema.safeParse({
        ...verifiedResult,
        competitiveStatus: "demo",
        competitiveEligible: false,
        rankingSnapshot: { kind: "frozen" },
      }).success,
    ).toBe(false);
    expect(
      VerifiedResultSchema.safeParse({
        ...verifiedResult,
        provenance: {
          kind: "roboflow",
          workspaceId: "workspace",
          workflowId: "revelai-wall-pass-geometry-v1",
          workflowVersion: "1.0.0",
          modelBundleId: "bundle",
          providerVersion: "provider",
        },
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
          asOfAttemptId: "attempt-verified-1",
          calculatedAt: "2026-08-30T12:00:00.000Z",
        },
      }).success,
    ).toBe(true);
    expect(
      VerifiedResultSchema.safeParse({
        ...verifiedResult,
        provenance: {
          kind: "roboflow",
          workspaceId: "workspace",
          workflowId: "revelai-wall-pass-geometry-v1",
          workflowVersion: "1.0.0",
          modelBundleId: "bundle",
          providerVersion: "provider",
        },
        competitiveStatus: "experimental",
        competitiveEligible: false,
      }).success,
    ).toBe(true);
  });

  it("separates a live leaderboard response from a frozen report rank", () => {
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
            rank: 1,
            score: 76,
            completedAt: "2026-08-30T12:00:00.000Z",
          },
        ],
        nextCursor: null,
      }).success,
    ).toBe(true);
  });
});
