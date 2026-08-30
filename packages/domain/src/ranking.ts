import { DomainError } from "./attempt-machine.js";
import { roundHalfUp } from "./scoring.js";
import {
  WALL_PASS_CHALLENGE_ID,
  WALL_PASS_CHALLENGE_VERSION,
  WALL_PASS_RULE_VERSION,
  WALL_PASS_V1_SCORE_RULE,
} from "./wall-pass-v1.js";

export type WallPassRankableResult = Readonly<{
  attemptId: string;
  entryId: string;
  score: number;
  completedAt: string;
  state: "valid";
  active: true;
  competitiveEligible: true;
  challengeId: string;
  challengeVersion: number;
  ruleVersion: string;
}>;

export type RankedWallPassResult = Readonly<{
  attemptId: string;
  entryId: string;
  score: number;
  completedAt: string;
  rank: number;
}>;

export type WallPassLiveLeaderboard = Readonly<{
  view: "live";
  challengeId: typeof WALL_PASS_CHALLENGE_ID;
  challengeVersion: typeof WALL_PASS_CHALLENGE_VERSION;
  ruleVersion: typeof WALL_PASS_RULE_VERSION;
  calculatedAt: string;
  cohortSize: number;
  entries: readonly Readonly<{
    entryId: string;
    rank: number;
    score: number;
    completedAt: string;
  }>[];
}>;

export type FrozenWallPassRankingSnapshot = Readonly<{
  kind: "frozen";
  challengeId: typeof WALL_PASS_CHALLENGE_ID;
  challengeVersion: typeof WALL_PASS_CHALLENGE_VERSION;
  ruleVersion: typeof WALL_PASS_RULE_VERSION;
  rank: number;
  cohortSize: number;
  percentile: number;
  topPercent: number;
  scoreCountAtFinalization: number;
  asOfAttemptId: string;
  calculatedAt: string;
}>;

export function calculateLiveWallPassLeaderboard(
  results: readonly WallPassRankableResult[],
  calculatedAt: string,
): WallPassLiveLeaderboard {
  assertTimestamp(calculatedAt);
  const ranked = rankWallPassV1Cohort(results);
  const entries = Object.freeze(
    ranked.map((result) =>
      Object.freeze({
        entryId: result.entryId,
        rank: result.rank,
        score: result.score,
        completedAt: result.completedAt,
      }),
    ),
  );

  return Object.freeze({
    view: "live",
    challengeId: WALL_PASS_CHALLENGE_ID,
    challengeVersion: WALL_PASS_CHALLENGE_VERSION,
    ruleVersion: WALL_PASS_RULE_VERSION,
    calculatedAt,
    cohortSize: ranked.length,
    entries,
  });
}

export function calculateFrozenWallPassSnapshot(
  results: readonly WallPassRankableResult[],
  asOfAttemptId: string,
  calculatedAt: string,
): FrozenWallPassRankingSnapshot {
  assertTimestamp(calculatedAt);
  const ranked = rankWallPassV1Cohort(results);
  const target = ranked.find((result) => result.attemptId === asOfAttemptId);

  if (!target) {
    throw new DomainError(
      "invalid_wall_pass_ranking_input",
      "A frozen ranking snapshot requires its finalized attempt in the cohort.",
    );
  }

  const percentile = roundHalfUp(
    (100 * ranked.filter((result) => result.score <= target.score).length) /
      ranked.length,
    WALL_PASS_V1_SCORE_RULE.metrics.decimalPlaces,
  );
  const topPercent = roundHalfUp(
    100 - percentile,
    WALL_PASS_V1_SCORE_RULE.metrics.decimalPlaces,
  );

  return Object.freeze({
    kind: "frozen",
    challengeId: WALL_PASS_CHALLENGE_ID,
    challengeVersion: WALL_PASS_CHALLENGE_VERSION,
    ruleVersion: WALL_PASS_RULE_VERSION,
    rank: target.rank,
    cohortSize: ranked.length,
    percentile,
    topPercent,
    scoreCountAtFinalization: ranked.length,
    asOfAttemptId,
    calculatedAt,
  });
}

export function rankWallPassV1Cohort(
  results: readonly WallPassRankableResult[],
): readonly RankedWallPassResult[] {
  const compatibleResults = results.filter((result) => {
    assertRankableResult(result);
    return isWallPassV1Result(result);
  });
  assertNoDuplicateAttemptIds(compatibleResults);
  const ordered = [...compatibleResults].sort(compareRankableResults);

  return Object.freeze(
    ordered.map((result) =>
      Object.freeze({
        attemptId: result.attemptId,
        entryId: result.entryId,
        score: result.score,
        completedAt: result.completedAt,
        rank: 1 + ordered.filter((other) => other.score > result.score).length,
      }),
    ),
  );
}

function isWallPassV1Result(result: WallPassRankableResult): boolean {
  return (
    result.challengeId === WALL_PASS_CHALLENGE_ID &&
    result.challengeVersion === WALL_PASS_CHALLENGE_VERSION &&
    result.ruleVersion === WALL_PASS_RULE_VERSION
  );
}

function compareRankableResults(
  first: WallPassRankableResult,
  second: WallPassRankableResult,
): number {
  if (first.score !== second.score) {
    return second.score - first.score;
  }

  if (first.completedAt !== second.completedAt) {
    return first.completedAt < second.completedAt ? -1 : 1;
  }

  if (first.attemptId === second.attemptId) {
    return 0;
  }

  return first.attemptId < second.attemptId ? -1 : 1;
}

function assertRankableResult(result: WallPassRankableResult): void {
  if (
    result.state !== "valid" ||
    result.active !== true ||
    result.competitiveEligible !== true ||
    !Number.isInteger(result.score) ||
    result.score < WALL_PASS_V1_SCORE_RULE.scoring.minimumScore ||
    result.score > WALL_PASS_V1_SCORE_RULE.scoring.maximumScore ||
    result.attemptId.trim().length === 0 ||
    result.entryId.trim().length === 0
  ) {
    throw new DomainError(
      "invalid_wall_pass_ranking_input",
      "Ranking accepts only active, valid, competitively eligible score results.",
    );
  }

  assertTimestamp(result.completedAt);
}

function assertNoDuplicateAttemptIds(
  results: readonly WallPassRankableResult[],
): void {
  const attemptIds = new Set(results.map((result) => result.attemptId));
  if (attemptIds.size !== results.length) {
    throw new DomainError(
      "invalid_wall_pass_ranking_input",
      "A ranking cohort cannot contain the same attempt more than once.",
    );
  }
}

function assertTimestamp(timestamp: string): void {
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(timestamp) ||
    Number.isNaN(Date.parse(timestamp))
  ) {
    throw new DomainError(
      "invalid_wall_pass_ranking_input",
      "Ranking timestamps must be UTC ISO-8601 instants with millisecond precision.",
    );
  }
}
