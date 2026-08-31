import { DomainError } from "./attempt-machine.js";

export type FootSide = "left" | "right";

export type CanonicalOutboundMovement =
  | Readonly<{ kind: "not-outbound" }>
  | Readonly<{
      kind: "outbound";
      movementTowardWallMeters: number;
      observedWithinMs: number;
    }>;

export type WallPassCanonicalContact = Readonly<{
  timestampMs: number;
  side: FootSide;
  sideConfidence: number;
  /** C6 partition identity; legacy C3 fixtures are one implicit track. */
  trackId?: number;
  outbound: CanonicalOutboundMovement;
}>;

export type WallPassCanonicalImpact = Readonly<{
  timestampMs: number;
  confidence: number;
  trackId?: number;
}>;

export type WallPassCanonicalEvidence = Readonly<{
  contacts: readonly WallPassCanonicalContact[];
  wallImpacts: readonly WallPassCanonicalImpact[];
}>;

export const WALL_PASS_CHALLENGE_ID = "wall-pass";
export const WALL_PASS_CHALLENGE_VERSION = 1;
export const WALL_PASS_RULE_VERSION = "wall-pass-v1-score-1";

export const WALL_PASS_V1_CHALLENGE = Object.freeze({
  id: WALL_PASS_CHALLENGE_ID,
  version: WALL_PASS_CHALLENGE_VERSION,
  sport: "futsal",
  activeWindow: Object.freeze({
    startMs: 4_000,
    endMs: 64_000,
    durationSeconds: 60,
  }),
  calibrationPreRollSeconds: 4,
  requiredFeet: Object.freeze(["left", "right"] as const),
  markerDistanceMeters: 3,
});

export const WALL_PASS_V1_SCORE_RULE = Object.freeze({
  ruleVersion: WALL_PASS_RULE_VERSION,
  units: Object.freeze({
    timestamp: "ms",
    duration: "seconds",
    distance: "metres",
    confidence: "ratio",
    score: "points",
    percentage: "percent",
  }),
  confidence: Object.freeze({
    minimumBallAndAthlete: 0.7,
    minimumAnatomicalFoot: 0.65,
  }),
  tracking: Object.freeze({
    maximumBallTrackGapMs: 300,
    contactMergeWindowMs: 300,
    minimumContactFrames: 2,
    maximumContactDistanceMeters: 0.35,
    wallDistanceMeters: 0.25,
    wallDirectionReversalWindowMs: 500,
  }),
  outbound: Object.freeze({
    minimumMovementTowardWallMeters: 0.25,
    maximumObservationWindowMs: 700,
  }),
  passSequence: Object.freeze({
    minimumImpactAfterContactMs: 200,
    maximumImpactAfterContactMs: 2_000,
    minimumReturnAfterImpactMs: 200,
    maximumReturnAfterImpactMs: 4_000,
  }),
  metrics: Object.freeze({
    decimalPlaces: 2,
    zeroCadenceBelowPassCount: 2,
  }),
  scoring: Object.freeze({
    minimumScore: 0,
    maximumScore: 100,
    targetValidPasses: 40,
    fastestCadenceSeconds: 0.75,
    slowestCadenceSeconds: 5,
    weights: Object.freeze({
      volume: 0.4,
      accuracy: 0.3,
      cadence: 0.2,
      balance: 0.1,
    }),
    finalDecimalPlaces: 0,
  }),
});

export const WALL_PASS_V1 = WALL_PASS_V1_CHALLENGE;
export const WALL_PASS_V1_SCORE_1 = WALL_PASS_V1_SCORE_RULE;

export function assertWallPassCanonicalEvidence(
  evidence: WallPassCanonicalEvidence,
): void {
  if (
    !isRecord(evidence) ||
    !Array.isArray(evidence.contacts) ||
    !Array.isArray(evidence.wallImpacts)
  ) {
    invalidEvidence();
  }

  let previousContactTimestamp = Number.NEGATIVE_INFINITY;
  for (const contact of evidence.contacts) {
    if (
      !isFiniteNumber(contact.timestampMs) ||
      contact.timestampMs <= previousContactTimestamp ||
      !isInsideActiveWindow(contact.timestampMs) ||
      (contact.side !== "left" && contact.side !== "right") ||
      !isConfidenceAtLeast(
        contact.sideConfidence,
        WALL_PASS_V1_SCORE_RULE.confidence.minimumAnatomicalFoot,
      ) ||
      (contact.trackId !== undefined &&
        (!Number.isSafeInteger(contact.trackId) || contact.trackId < 0))
    ) {
      invalidEvidence();
    }

    assertOutboundMovement(contact.outbound);
    previousContactTimestamp = contact.timestampMs;
  }

  let previousImpactTimestamp = Number.NEGATIVE_INFINITY;
  for (const wallImpact of evidence.wallImpacts) {
    if (
      !isFiniteNumber(wallImpact.timestampMs) ||
      wallImpact.timestampMs <= previousImpactTimestamp ||
      !isInsideActiveWindow(wallImpact.timestampMs) ||
      !isConfidenceAtLeast(
        wallImpact.confidence,
        WALL_PASS_V1_SCORE_RULE.confidence.minimumBallAndAthlete,
      ) ||
      (wallImpact.trackId !== undefined &&
        (!Number.isSafeInteger(wallImpact.trackId) || wallImpact.trackId < 0))
    ) {
      invalidEvidence();
    }

    previousImpactTimestamp = wallImpact.timestampMs;
  }
}

function assertOutboundMovement(outbound: CanonicalOutboundMovement): void {
  if (!isRecord(outbound)) {
    invalidEvidence();
  }

  if (outbound.kind === "not-outbound") {
    return;
  }

  if (
    outbound.kind !== "outbound" ||
    !isFiniteNumber(outbound.movementTowardWallMeters) ||
    !isFiniteNumber(outbound.observedWithinMs) ||
    outbound.movementTowardWallMeters <
      WALL_PASS_V1_SCORE_RULE.outbound.minimumMovementTowardWallMeters ||
    outbound.observedWithinMs < 0 ||
    outbound.observedWithinMs >
      WALL_PASS_V1_SCORE_RULE.outbound.maximumObservationWindowMs
  ) {
    invalidEvidence();
  }
}

function isInsideActiveWindow(timestampMs: number): boolean {
  return (
    timestampMs >= WALL_PASS_V1_CHALLENGE.activeWindow.startMs &&
    timestampMs < WALL_PASS_V1_CHALLENGE.activeWindow.endMs
  );
}

function isConfidenceAtLeast(confidence: number, minimum: number): boolean {
  return isFiniteNumber(confidence) && confidence >= minimum && confidence <= 1;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function invalidEvidence(): never {
  throw new DomainError(
    "invalid_wall_pass_evidence",
    "Canonical wall-pass evidence violates wall-pass-v1 requirements.",
  );
}
