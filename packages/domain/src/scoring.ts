import { DomainError } from "./attempt-machine.js";
import {
  WALL_PASS_CHALLENGE_ID,
  WALL_PASS_CHALLENGE_VERSION,
  WALL_PASS_RULE_VERSION,
  WALL_PASS_V1_SCORE_RULE,
  assertWallPassCanonicalEvidence,
  type WallPassCanonicalContact,
  type WallPassCanonicalEvidence,
  type WallPassCanonicalImpact,
} from "./wall-pass-v1.js";

export type WallPassMetrics = Readonly<{
  validPasses: number;
  accuracyPercent: number;
  meanCadenceSeconds: number;
  leftFootPercent: number;
  rightFootPercent: number;
}>;

export type WallPassEvaluation = Readonly<{
  challengeId: typeof WALL_PASS_CHALLENGE_ID;
  challengeVersion: typeof WALL_PASS_CHALLENGE_VERSION;
  ruleVersion: typeof WALL_PASS_RULE_VERSION;
  opportunities: number;
  missedPasses: number;
  metrics: WallPassMetrics;
  score: number;
}>;

type CompletedPass = Readonly<{
  startingContact: WallPassCanonicalContact;
  completedAtMs: number;
}>;

type CanonicalWallPassScoreInput = Readonly<{
  opportunities: number;
  validPasses: number;
  leftPasses: number;
  rightPasses: number;
  meanCadenceSeconds: number;
}>;

export function evaluateWallPassV1(
  evidence: WallPassCanonicalEvidence,
): WallPassEvaluation {
  assertWallPassCanonicalEvidence(evidence);

  const completedPasses = findCompletedPasses(evidence);
  const opportunities = countOutboundContacts(evidence.contacts);
  const missedPasses = opportunities - completedPasses.length;
  const scoreInput = calculateCanonicalScoreInput(
    completedPasses,
    opportunities,
  );
  const metrics = freezeMetrics(scoreInput);
  const score = scoreCanonicalWallPassV1(scoreInput);

  return Object.freeze({
    challengeId: WALL_PASS_CHALLENGE_ID,
    challengeVersion: WALL_PASS_CHALLENGE_VERSION,
    ruleVersion: WALL_PASS_RULE_VERSION,
    opportunities,
    missedPasses,
    metrics,
    score,
  });
}

function scoreCanonicalWallPassV1(input: CanonicalWallPassScoreInput): number {
  assertCanonicalScoreInput(input);
  const rawMetrics = calculateRawMetrics(input);

  const { scoring } = WALL_PASS_V1_SCORE_RULE;
  const volume = clamp(
    (scoring.maximumScore * input.validPasses) / scoring.targetValidPasses,
  );
  const cadence =
    input.validPasses <
    WALL_PASS_V1_SCORE_RULE.metrics.zeroCadenceBelowPassCount
      ? 0
      : clamp(
          (scoring.maximumScore *
            (scoring.slowestCadenceSeconds - input.meanCadenceSeconds)) /
            (scoring.slowestCadenceSeconds - scoring.fastestCadenceSeconds),
        );
  const balance = clamp(
    scoring.maximumScore -
      2 * Math.abs(rawMetrics.leftFootPercent - scoring.maximumScore / 2),
  );
  const weightedScore =
    scoring.weights.volume * volume +
    scoring.weights.accuracy * rawMetrics.accuracyPercent +
    scoring.weights.cadence * cadence +
    scoring.weights.balance * balance;

  return clamp(roundHalfUp(weightedScore, scoring.finalDecimalPlaces));
}

export function roundHalfUp(value: number, decimalPlaces: number): number {
  if (
    !Number.isFinite(value) ||
    !Number.isInteger(decimalPlaces) ||
    decimalPlaces < 0
  ) {
    throw new DomainError(
      "invalid_wall_pass_score_input",
      "Half-up rounding requires a finite value and non-negative integer precision.",
    );
  }

  const factor = 10 ** decimalPlaces;
  const scaled = value * factor;
  const representationalAdjustment =
    Number.EPSILON * Math.max(1, Math.abs(scaled));
  return Math.floor(scaled + 0.5 + representationalAdjustment) / factor;
}

function findCompletedPasses(
  evidence: WallPassCanonicalEvidence,
): readonly CompletedPass[] {
  const completedPasses: CompletedPass[] = [];

  for (const [index, startingContact] of evidence.contacts.entries()) {
    if (startingContact.outbound.kind !== "outbound") {
      continue;
    }

    const returnContact = evidence.contacts[index + 1];
    const nextWallImpact = findNextWallImpact(
      evidence.wallImpacts,
      startingContact.timestampMs,
    );

    if (
      returnContact &&
      nextWallImpact &&
      isCompletedPass(startingContact, nextWallImpact, returnContact)
    ) {
      completedPasses.push(
        Object.freeze({
          startingContact,
          completedAtMs: returnContact.timestampMs,
        }),
      );
    }
  }

  return completedPasses;
}

function findNextWallImpact(
  wallImpacts: readonly WallPassCanonicalImpact[],
  contactTimestampMs: number,
): WallPassCanonicalImpact | undefined {
  return wallImpacts.find(
    (wallImpact) => wallImpact.timestampMs > contactTimestampMs,
  );
}

function isCompletedPass(
  contact: WallPassCanonicalContact,
  wallImpact: WallPassCanonicalImpact,
  returnContact: WallPassCanonicalContact,
): boolean {
  const { passSequence } = WALL_PASS_V1_SCORE_RULE;
  const impactDelayMs = wallImpact.timestampMs - contact.timestampMs;
  const returnDelayMs = returnContact.timestampMs - wallImpact.timestampMs;

  return (
    wallImpact.timestampMs < returnContact.timestampMs &&
    impactDelayMs >= passSequence.minimumImpactAfterContactMs &&
    impactDelayMs <= passSequence.maximumImpactAfterContactMs &&
    returnDelayMs >= passSequence.minimumReturnAfterImpactMs &&
    returnDelayMs <= passSequence.maximumReturnAfterImpactMs
  );
}

function countOutboundContacts(
  contacts: readonly WallPassCanonicalContact[],
): number {
  return contacts.filter((contact) => contact.outbound.kind === "outbound")
    .length;
}

function calculateCanonicalScoreInput(
  completedPasses: readonly CompletedPass[],
  opportunities: number,
): CanonicalWallPassScoreInput {
  const validPasses = completedPasses.length;
  const leftPasses = completedPasses.filter(
    (completedPass) => completedPass.startingContact.side === "left",
  ).length;

  return Object.freeze({
    opportunities,
    validPasses,
    leftPasses,
    rightPasses: validPasses - leftPasses,
    meanCadenceSeconds: calculateRawCadenceSeconds(completedPasses),
  });
}

function calculateRawCadenceSeconds(
  completedPasses: readonly CompletedPass[],
): number {
  if (
    completedPasses.length <
    WALL_PASS_V1_SCORE_RULE.metrics.zeroCadenceBelowPassCount
  ) {
    return 0;
  }

  const deltasMs = completedPasses
    .slice(1)
    .map(
      (completedPass, index) =>
        completedPass.completedAtMs - completedPasses[index]!.completedAtMs,
    );
  const totalMs = deltasMs.reduce((sum, deltaMs) => sum + deltaMs, 0);

  return totalMs / deltasMs.length / 1_000;
}

function calculateRawMetrics(
  input: CanonicalWallPassScoreInput,
): WallPassMetrics {
  return {
    validPasses: input.validPasses,
    accuracyPercent:
      input.opportunities === 0
        ? 0
        : (100 * input.validPasses) / input.opportunities,
    meanCadenceSeconds: input.meanCadenceSeconds,
    leftFootPercent:
      input.validPasses === 0
        ? 0
        : (100 * input.leftPasses) / input.validPasses,
    rightFootPercent:
      input.validPasses === 0
        ? 0
        : (100 * input.rightPasses) / input.validPasses,
  };
}

function freezeMetrics(input: CanonicalWallPassScoreInput): WallPassMetrics {
  const rawMetrics = calculateRawMetrics(input);
  const decimalPlaces = WALL_PASS_V1_SCORE_RULE.metrics.decimalPlaces;
  const accuracyPercent = roundHalfUp(
    rawMetrics.accuracyPercent,
    decimalPlaces,
  );
  const meanCadenceSeconds = roundHalfUp(
    rawMetrics.meanCadenceSeconds,
    decimalPlaces,
  );
  const balance = reconcileFootBalance(
    rawMetrics.leftFootPercent,
    rawMetrics.rightFootPercent,
    decimalPlaces,
  );

  return Object.freeze({
    validPasses: rawMetrics.validPasses,
    accuracyPercent,
    meanCadenceSeconds,
    leftFootPercent: balance.leftFootPercent,
    rightFootPercent: balance.rightFootPercent,
  });
}

function reconcileFootBalance(
  rawLeftFootPercent: number,
  rawRightFootPercent: number,
  decimalPlaces: number,
): Readonly<{ leftFootPercent: number; rightFootPercent: number }> {
  if (rawLeftFootPercent === 0 && rawRightFootPercent === 0) {
    return Object.freeze({ leftFootPercent: 0, rightFootPercent: 0 });
  }

  let leftFootPercent = roundHalfUp(rawLeftFootPercent, decimalPlaces);
  let rightFootPercent = roundHalfUp(rawRightFootPercent, decimalPlaces);
  const remainingHundredth =
    Math.round((100 - leftFootPercent - rightFootPercent) * 100) / 100;

  if (remainingHundredth !== 0) {
    if (rawLeftFootPercent >= rawRightFootPercent) {
      leftFootPercent += remainingHundredth;
    } else {
      rightFootPercent += remainingHundredth;
    }
  }

  return Object.freeze({ leftFootPercent, rightFootPercent });
}

function assertCanonicalScoreInput(input: CanonicalWallPassScoreInput): void {
  if (
    !Number.isInteger(input.opportunities) ||
    !Number.isInteger(input.validPasses) ||
    !Number.isInteger(input.leftPasses) ||
    !Number.isInteger(input.rightPasses) ||
    input.opportunities < 0 ||
    input.validPasses < 0 ||
    input.validPasses > input.opportunities ||
    input.leftPasses < 0 ||
    input.rightPasses < 0 ||
    input.leftPasses + input.rightPasses !== input.validPasses ||
    !isWithin(input.meanCadenceSeconds, 0, Number.POSITIVE_INFINITY)
  ) {
    return invalidScoreInput();
  }

  if (
    input.validPasses <
      WALL_PASS_V1_SCORE_RULE.metrics.zeroCadenceBelowPassCount &&
    input.meanCadenceSeconds !== 0
  ) {
    return invalidScoreInput();
  }
}

function invalidScoreInput(): never {
  throw new DomainError(
    "invalid_wall_pass_score_input",
    "Wall-pass scoring requires coherent metrics within their rule bounds.",
  );
}

function isWithin(value: number, minimum: number, maximum: number): boolean {
  return Number.isFinite(value) && value >= minimum && value <= maximum;
}

function clamp(value: number): number {
  const { minimumScore, maximumScore } = WALL_PASS_V1_SCORE_RULE.scoring;
  return Math.min(maximumScore, Math.max(minimumScore, value));
}
