import {
  AttemptOutcomeSchema,
  LeaderboardResponseSchema,
} from "@revelai/contracts";

/**
 * W6's only competitive fixture. The policy-approved C10-shaped response is
 * parsed at its boundary; Web only renders the server facts and never derives
 * score, rank, eligibility, ties, or a receipt.
 */
export const policyApprovedRankedOutcome = AttemptOutcomeSchema.parse({
  state: "valid",
  result: {
    kind: "verified-result",
    attemptId: "attempt-ranked-policy-approved-w6",
    challengeId: "wall-pass",
    challengeVersion: 1,
    ruleVersion: "wall-pass-v1-score-1",
    provenance: {
      kind: "roboflow",
      workspaceId: "policy-approved-workspace",
      workflowId: "revelai-wall-pass-geometry-v1",
      workflowVersion: "1.0.0",
      modelBundleId: "policy-approved-wall-pass-bundle-v1",
      providerVersion: "roboflow-inference-v1",
    },
    metrics: {
      validPasses: 48,
      accuracyPercent: 92,
      meanCadenceSeconds: 0.79,
      leftFootPercent: 44,
      rightFootPercent: 56,
    },
    score: 84,
    completedAt: "2026-08-30T12:02:00.000Z",
    competitiveStatus: "ranked",
    competitiveEligible: true,
    rankingSnapshot: {
      kind: "frozen",
      challengeId: "wall-pass",
      challengeVersion: 1,
      ruleVersion: "wall-pass-v1-score-1",
      rank: 3,
      cohortSize: 24,
      percentile: 87.5,
      topPercent: 12.5,
      scoreCountAtFinalization: 24,
      asOfAttemptId: "attempt-ranked-policy-approved-w6",
      calculatedAt: "2026-08-30T12:02:00.000Z",
    },
  },
});

export const policyApprovedRankedLeaderboard = LeaderboardResponseSchema.parse({
  view: "live",
  challengeId: "wall-pass",
  challengeVersion: 1,
  ruleVersion: "wall-pass-v1-score-1",
  calculatedAt: "2026-08-30T12:03:00.000Z",
  cohortSize: 24,
  entries: [
    {
      entryId: "attempt-ranked-policy-approved-w6",
      rank: 3,
      score: 84,
      completedAt: "2026-08-30T12:02:00.000Z",
    },
  ],
  nextCursor: null,
});
