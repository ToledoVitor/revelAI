import {
  FailureMessageByCode,
  InvalidRetryMessageByCode,
  type InvalidRetryCode,
} from "@revelai/contracts";
import {
  parseExtractionManifest,
  type ExtractionManifest,
} from "../media/extraction-manifest.js";

const PRE_ROLL_FRAME_COUNT = 40;
const ACTIVE_FRAME_COUNT = 600;
const REQUIRED_PRE_ROLL_FRAMES = 32;
const REQUIRED_STABLE_ACTIVE_FRAMES = 576;
const REQUIRED_USABLE_TRACK_FRAMES = 480;
const MAX_UNSTABLE_RUN = 3;
const CALIBRATION_CONFIDENCE = 0.8;
const MAX_MEDIAN_REPROJECTION_ERROR = 4;
const MAX_REPROJECTION_ERROR = 8;
const MAX_WALL_EDGE_ERROR = 8;
const MAX_MEDIAN_DRIFT = 6;
const MAX_DRIFT = 12;

const CORNER_IDS = [
  "a-top-left",
  "a-top-right",
  "a-bottom-right",
  "a-bottom-left",
  "b-top-left",
  "b-top-right",
  "b-bottom-right",
  "b-bottom-left",
] as const;

type Point = Readonly<{ x: number; y: number }>;

type AcceptedGeometry = Readonly<{
  frameIndex: number;
  valid: true;
  homography: readonly number[];
  inverse: readonly number[];
  inlierCount: number;
  medianReprojectionError: number;
  maxReprojectionError: number;
  wallEdgeError: number;
  orientationValid: true;
  wallSideValid: true;
  anchorPoints: Readonly<Record<(typeof CORNER_IDS)[number], Point>>;
}>;

type RejectedGeometry = Readonly<{
  frameIndex: number;
  valid: false;
  homography: null;
  inverse: null;
  inlierCount: number;
  medianReprojectionError: number | null;
  maxReprojectionError: number | null;
  wallEdgeError: number | null;
  orientationValid: boolean;
  wallSideValid: boolean;
  anchorPoints: null;
}>;

type Geometry = AcceptedGeometry | RejectedGeometry;

type EvidenceBinding = Readonly<{
  attemptId: string;
  generation: number;
  mediaId: string;
  mediaSha256: string;
  rawPreRollSha256: string;
  calibrationSessionId: string;
  calibrationNonce: string;
}>;

type PreRollEvidence = Readonly<{
  frameIndex: number;
  confidencePresent: boolean;
  geometry: Geometry;
}>;

type ActiveEvidence = Readonly<{
  frameIndex: number;
  stable: boolean;
  geometry: Geometry;
  anchorMedianDrift: number | null;
  anchorMaximumDrift: number | null;
  mappedBall: Point | null;
  mappedFeet: readonly Readonly<{
    side: "left" | "right";
    point: Point;
    confidence: number;
  }>[];
  usableTracks: boolean;
}>;

type VerifiedEvidence = Readonly<{
  binding: EvidenceBinding;
  provenance: Readonly<
    | {
        kind: "demo";
        fixtureId: "wall-pass-balanced-v1" | "wall-pass-insufficient-v1";
        providerVersion: "demo-observations-v1";
      }
    | {
        kind: "roboflow";
        workspaceId: string;
        workflowId: "revelai-wall-pass-geometry-v1";
        workflowVersion: "1.0.0";
        modelBundleId: string;
        providerVersion: string;
      }
  >;
  selectedReferenceFrameIndex: number | null;
  referenceDistanceSums: Readonly<Record<number, number>>;
  preRoll: readonly PreRollEvidence[];
  active: readonly ActiveEvidence[];
  activeStableCount: number;
  longestUnstableRun: number;
  contacts: readonly Readonly<{
    timestampMs: number;
    side: "left" | "right";
    point: Point;
  }>[];
  wallImpacts: readonly Readonly<{ timestampMs: number; point: Point }>[];
  passEvidence: readonly (
    | Readonly<{
        kind: "complete";
        startedAtMs: number;
        wallImpactAtMs: number;
        completedAtMs: number;
        side: "left" | "right";
      }>
    | Readonly<{
        kind: "missed";
        startedAtMs: number;
        deadlineAtMs: number;
        side: "left" | "right";
      }>
  )[];
}>;

type ExpectedAttempt = Readonly<{
  attemptId: string;
  generation: number;
  challenge: Readonly<{ id: "wall-pass"; version: 1 }>;
  calibrationSessionId: string;
  calibrationNonce: string;
  mediaId: string;
  mediaSha256: string;
  rawPreRollSha256: string;
}>;

export type IntegrityDecision =
  | Readonly<{ kind: "integrity-valid" }>
  | Readonly<{
      kind: "integrity-invalid";
      code: InvalidRetryCode;
      message: string;
      retryable: true;
    }>
  | Readonly<{
      kind: "analysis-temporary-unavailable";
      code: "analysis_temporary_unavailable";
      message: string;
      retryable: true;
    }>;

export type PublicIntegrityDecision =
  | Readonly<{ state: "valid" }>
  | Readonly<{
      state: "invalid";
      code: InvalidRetryCode;
      message: string;
      retryable: true;
    }>
  | Readonly<{
      state: "failed";
      code: "analysis_temporary_unavailable";
      message: string;
      retryable: true;
    }>;

/**
 * API-only policy point. Inputs are deliberately unknown until every C5/C6
 * boundary is parsed: no provider-provided verdict can reach a result write.
 */
export function evaluateVerifiedIntegrity(input: unknown): IntegrityDecision {
  const parsed = parseEvaluationInput(input);
  if (!parsed) return invalid("calibration_not_verified");
  if (!isExpectedVerifiedAttempt(parsed.expected))
    return invalid("calibration_not_verified");

  const manifest = parseVerifiedManifest(parsed.manifest);
  if (!manifest) return invalid("video_not_continuous");
  if (!sameManifestBinding(manifest, parsed.expected))
    return invalid("video_not_continuous");
  if (!isContinuousEvidence(parsed.continuity))
    return invalid("video_not_continuous");

  const evidence = parseVerifiedEvidence(parsed.evidence);
  if (!evidence || !sameEvidenceBinding(evidence.binding, parsed.expected))
    return invalid("calibration_not_verified");
  if (!hasVerifiedCalibration(evidence))
    return invalid("calibration_not_verified");
  if (!hasBoundMappedEvents(evidence, manifest))
    return invalid("calibration_not_verified");
  if (countUsableTracks(evidence.active) < REQUIRED_USABLE_TRACK_FRAMES)
    return invalid("tracking_insufficient");
  return Object.freeze({ kind: "integrity-valid" });
}

/** Maps already-classified infrastructure failure without exposing its cause. */
export function temporaryIntegrityDecision(): IntegrityDecision {
  return Object.freeze({
    kind: "analysis-temporary-unavailable",
    code: "analysis_temporary_unavailable",
    message: FailureMessageByCode.analysis_temporary_unavailable,
    retryable: true,
  });
}

/** Only this projection is eligible for route/result serialization. */
export function serializeIntegrityDecision(
  decision: IntegrityDecision,
): PublicIntegrityDecision {
  if (decision.kind === "integrity-valid")
    return Object.freeze({ state: "valid" });
  if (decision.kind === "integrity-invalid")
    return Object.freeze({
      state: "invalid",
      code: decision.code,
      message: decision.message,
      retryable: true,
    });
  return Object.freeze({
    state: "failed",
    code: decision.code,
    message: decision.message,
    retryable: true,
  });
}

function invalid(code: InvalidRetryCode): IntegrityDecision {
  return Object.freeze({
    kind: "integrity-invalid",
    code,
    message: InvalidRetryMessageByCode[code],
    retryable: true,
  });
}

function parseEvaluationInput(value: unknown): Readonly<{
  expected: ExpectedAttempt;
  continuity: unknown;
  manifest: unknown;
  evidence: unknown;
}> | null {
  if (!hasExactKeys(value, ["expected", "continuity", "manifest", "evidence"]))
    return null;
  const expected = parseExpectedAttempt(value.expected);
  return expected
    ? Object.freeze({
        expected,
        continuity: value.continuity,
        manifest: value.manifest,
        evidence: value.evidence,
      })
    : null;
}

function parseExpectedAttempt(value: unknown): ExpectedAttempt | null {
  if (
    !hasExactKeys(value, [
      "attemptId",
      "generation",
      "challenge",
      "calibrationSessionId",
      "calibrationNonce",
      "mediaId",
      "mediaSha256",
      "rawPreRollSha256",
    ]) ||
    !hasExactKeys(value.challenge, ["id", "version"]) ||
    value.challenge.id !== "wall-pass" ||
    value.challenge.version !== 1 ||
    !isUuid(value.attemptId) ||
    !isPositiveInteger(value.generation) ||
    !isUuid(value.calibrationSessionId) ||
    !isNonce(value.calibrationNonce) ||
    !isUuid(value.mediaId) ||
    !isDigest(value.mediaSha256) ||
    !isDigest(value.rawPreRollSha256)
  )
    return null;
  return Object.freeze({
    attemptId: value.attemptId,
    generation: value.generation,
    challenge: Object.freeze({ id: "wall-pass", version: 1 }),
    calibrationSessionId: value.calibrationSessionId,
    calibrationNonce: value.calibrationNonce,
    mediaId: value.mediaId,
    mediaSha256: value.mediaSha256,
    rawPreRollSha256: value.rawPreRollSha256,
  });
}

function isExpectedVerifiedAttempt(value: ExpectedAttempt): boolean {
  return (
    value.challenge.id === "wall-pass" &&
    value.challenge.version === 1 &&
    isUuid(value.attemptId) &&
    isPositiveInteger(value.generation) &&
    isUuid(value.calibrationSessionId) &&
    isNonce(value.calibrationNonce) &&
    isUuid(value.mediaId) &&
    isDigest(value.mediaSha256) &&
    isDigest(value.rawPreRollSha256)
  );
}

function parseVerifiedManifest(value: unknown): ExtractionManifest | null {
  try {
    const manifest = parseExtractionManifest(value);
    return manifest.mode === "verified" ? manifest : null;
  } catch {
    return null;
  }
}

function sameManifestBinding(
  manifest: ExtractionManifest & Readonly<{ mode: "verified" }>,
  expected: ExpectedAttempt,
): boolean {
  return (
    manifest.attemptId === expected.attemptId &&
    manifest.generation === expected.generation &&
    manifest.mediaId === expected.mediaId &&
    manifest.mediaSha256 === expected.mediaSha256 &&
    manifest.rawPreRollSha256 === expected.rawPreRollSha256 &&
    manifest.frames.count === PRE_ROLL_FRAME_COUNT + ACTIVE_FRAME_COUNT &&
    manifest.preRoll.count === PRE_ROLL_FRAME_COUNT &&
    manifest.active.count === ACTIVE_FRAME_COUNT
  );
}

function isContinuousEvidence(value: unknown): boolean {
  return (
    hasExactKeys(value, [
      "kind",
      "timelineContinuous",
      "activeSceneChangeFree",
    ]) &&
    value.kind === "verified-continuity-evidence-v1" &&
    value.timelineContinuous === true &&
    value.activeSceneChangeFree === true
  );
}

function parseVerifiedEvidence(value: unknown): VerifiedEvidence | null {
  if (
    !hasExactKeys(value, [
      "kind",
      "binding",
      "provenance",
      "selectedReferenceFrameIndex",
      "referenceDistanceSums",
      "preRoll",
      "active",
      "activeStableCount",
      "longestUnstableRun",
      "contacts",
      "wallImpacts",
      "passEvidence",
    ]) ||
    value.kind !== "wall-pass-geometry-evidence-v1" ||
    !Array.isArray(value.preRoll) ||
    !Array.isArray(value.active) ||
    !Array.isArray(value.contacts) ||
    !Array.isArray(value.wallImpacts) ||
    !Array.isArray(value.passEvidence) ||
    !isNonNegativeInteger(value.activeStableCount) ||
    !isNonNegativeInteger(value.longestUnstableRun)
  )
    return null;
  const binding = parseEvidenceBinding(value.binding);
  const provenance = parseVerifiedProvenance(value.provenance);
  const preRoll = value.preRoll.map(parsePreRollEvidence);
  const active = value.active.map(parseActiveEvidence);
  const contacts = value.contacts.map(parseContact);
  const wallImpacts = value.wallImpacts.map(parseWallImpact);
  const passEvidence = value.passEvidence.map(parsePassEvidence);
  const referenceDistanceSums = parseReferenceDistanceSums(
    value.referenceDistanceSums,
  );
  if (
    !binding ||
    !provenance ||
    preRoll.some(isNull) ||
    active.some(isNull) ||
    contacts.some(isNull) ||
    wallImpacts.some(isNull) ||
    passEvidence.some(isNull) ||
    !referenceDistanceSums ||
    (value.selectedReferenceFrameIndex !== null &&
      !isNonNegativeInteger(value.selectedReferenceFrameIndex))
  )
    return null;
  return Object.freeze({
    binding,
    provenance,
    selectedReferenceFrameIndex: value.selectedReferenceFrameIndex,
    referenceDistanceSums,
    preRoll: Object.freeze(preRoll),
    active: Object.freeze(active),
    activeStableCount: value.activeStableCount,
    longestUnstableRun: value.longestUnstableRun,
    contacts: Object.freeze(contacts),
    wallImpacts: Object.freeze(wallImpacts),
    passEvidence: Object.freeze(passEvidence),
  });
}

function parseEvidenceBinding(value: unknown): EvidenceBinding | null {
  if (
    !hasExactKeys(value, [
      "attemptId",
      "generation",
      "mediaId",
      "mediaSha256",
      "rawPreRollSha256",
      "calibrationSessionId",
      "calibrationNonce",
    ]) ||
    !isUuid(value.attemptId) ||
    !isPositiveInteger(value.generation) ||
    !isUuid(value.mediaId) ||
    !isDigest(value.mediaSha256) ||
    !isDigest(value.rawPreRollSha256) ||
    !isUuid(value.calibrationSessionId) ||
    !isNonce(value.calibrationNonce)
  )
    return null;
  return Object.freeze({
    attemptId: value.attemptId,
    generation: value.generation,
    mediaId: value.mediaId,
    mediaSha256: value.mediaSha256,
    rawPreRollSha256: value.rawPreRollSha256,
    calibrationSessionId: value.calibrationSessionId,
    calibrationNonce: value.calibrationNonce,
  });
}

function parseVerifiedProvenance(
  value: unknown,
): VerifiedEvidence["provenance"] | null {
  if (!isRecord(value) || typeof value.kind !== "string") return null;
  if (
    value.kind === "demo" &&
    hasExactKeys(value, ["kind", "fixtureId", "providerVersion"]) &&
    (value.fixtureId === "wall-pass-balanced-v1" ||
      value.fixtureId === "wall-pass-insufficient-v1") &&
    value.providerVersion === "demo-observations-v1"
  )
    return Object.freeze({
      kind: "demo",
      fixtureId: value.fixtureId,
      providerVersion: value.providerVersion,
    });
  if (
    value.kind === "roboflow" &&
    hasExactKeys(value, [
      "kind",
      "workspaceId",
      "workflowId",
      "workflowVersion",
      "modelBundleId",
      "providerVersion",
    ]) &&
    isNonEmptyString(value.workspaceId) &&
    value.workflowId === "revelai-wall-pass-geometry-v1" &&
    value.workflowVersion === "1.0.0" &&
    isNonEmptyString(value.modelBundleId) &&
    isNonEmptyString(value.providerVersion)
  )
    return Object.freeze({
      kind: "roboflow",
      workspaceId: value.workspaceId,
      workflowId: value.workflowId,
      workflowVersion: value.workflowVersion,
      modelBundleId: value.modelBundleId,
      providerVersion: value.providerVersion,
    });
  return null;
}

function parsePreRollEvidence(value: unknown): PreRollEvidence | null {
  if (
    !hasExactKeys(value, [
      "frameIndex",
      "confidencePresent",
      "geometry",
      "inference",
    ]) ||
    !isNonNegativeInteger(value.frameIndex) ||
    typeof value.confidencePresent !== "boolean" ||
    !isInferenceBinding(value.inference)
  )
    return null;
  const geometry = parseGeometry(value.geometry, value.frameIndex);
  return geometry
    ? Object.freeze({
        frameIndex: value.frameIndex,
        confidencePresent: value.confidencePresent,
        geometry,
      })
    : null;
}

function parseActiveEvidence(value: unknown): ActiveEvidence | null {
  if (
    !hasExactKeys(value, [
      "frameIndex",
      "stable",
      "geometry",
      "inference",
      "anchorMedianDrift",
      "anchorMaximumDrift",
      "mappedBall",
      "mappedFeet",
      "usableTracks",
    ]) ||
    !isNonNegativeInteger(value.frameIndex) ||
    typeof value.stable !== "boolean" ||
    !isNullableFinite(value.anchorMedianDrift) ||
    !isNullableFinite(value.anchorMaximumDrift) ||
    !isNullablePoint(value.mappedBall) ||
    !Array.isArray(value.mappedFeet) ||
    !value.mappedFeet.every(isMappedFoot) ||
    typeof value.usableTracks !== "boolean" ||
    !isInferenceBinding(value.inference)
  )
    return null;
  const geometry = parseGeometry(value.geometry, value.frameIndex);
  if (!geometry) return null;
  return Object.freeze({
    frameIndex: value.frameIndex,
    stable: value.stable,
    geometry,
    anchorMedianDrift: value.anchorMedianDrift,
    anchorMaximumDrift: value.anchorMaximumDrift,
    mappedBall: value.mappedBall,
    mappedFeet: Object.freeze(value.mappedFeet),
    usableTracks: value.usableTracks,
  });
}

function isInferenceBinding(value: unknown): boolean {
  if (value === undefined) return true;
  if (
    !hasExactKeys(value, ["sha256", "transform"]) ||
    !isDigest(value.sha256) ||
    !hasExactKeys(value.transform, [
      "sourceWidth",
      "sourceHeight",
      "inferenceWidth",
      "inferenceHeight",
      "scale",
      "scaledWidth",
      "scaledHeight",
      "padLeft",
      "padTop",
    ])
  )
    return false;
  return (
    isPositiveInteger(value.transform.sourceWidth) &&
    isPositiveInteger(value.transform.sourceHeight) &&
    value.transform.inferenceWidth === 1280 &&
    value.transform.inferenceHeight === 720 &&
    isFinitePositive(value.transform.scale) &&
    isPositiveInteger(value.transform.scaledWidth) &&
    isPositiveInteger(value.transform.scaledHeight) &&
    isNonNegativeInteger(value.transform.padLeft) &&
    isNonNegativeInteger(value.transform.padTop)
  );
}

function parseGeometry(value: unknown, frameIndex: number): Geometry | null {
  if (
    !hasExactKeys(value, [
      "frameIndex",
      "valid",
      "homography",
      "inverse",
      "inlierCount",
      "medianReprojectionError",
      "maxReprojectionError",
      "wallEdgeError",
      "orientationValid",
      "wallSideValid",
      "anchorPoints",
    ]) ||
    value.frameIndex !== frameIndex ||
    !isNonNegativeInteger(value.inlierCount) ||
    typeof value.valid !== "boolean" ||
    typeof value.orientationValid !== "boolean" ||
    typeof value.wallSideValid !== "boolean"
  )
    return null;
  if (
    value.valid === true &&
    isMatrix(value.homography) &&
    isMatrix(value.inverse) &&
    isFiniteNumber(value.medianReprojectionError) &&
    isFiniteNumber(value.maxReprojectionError) &&
    isFiniteNumber(value.wallEdgeError) &&
    value.orientationValid === true &&
    value.wallSideValid === true &&
    isAnchorPoints(value.anchorPoints)
  )
    return Object.freeze({
      frameIndex,
      valid: true,
      homography: Object.freeze([...value.homography]),
      inverse: Object.freeze([...value.inverse]),
      inlierCount: value.inlierCount,
      medianReprojectionError: value.medianReprojectionError,
      maxReprojectionError: value.maxReprojectionError,
      wallEdgeError: value.wallEdgeError,
      orientationValid: true,
      wallSideValid: true,
      anchorPoints: value.anchorPoints,
    });
  if (
    value.valid === false &&
    value.homography === null &&
    value.inverse === null &&
    isNullableFinite(value.medianReprojectionError) &&
    isNullableFinite(value.maxReprojectionError) &&
    isNullableFinite(value.wallEdgeError) &&
    value.anchorPoints === null
  )
    return Object.freeze({
      frameIndex,
      valid: false,
      homography: null,
      inverse: null,
      inlierCount: value.inlierCount,
      medianReprojectionError: value.medianReprojectionError,
      maxReprojectionError: value.maxReprojectionError,
      wallEdgeError: value.wallEdgeError,
      orientationValid: value.orientationValid,
      wallSideValid: value.wallSideValid,
      anchorPoints: null,
    });
  return null;
}

function parseReferenceDistanceSums(
  value: unknown,
): Readonly<Record<number, number>> | null {
  if (!isRecord(value)) return null;
  const entries = Object.entries(value);
  if (
    entries.some(
      ([key, distance]) =>
        !/^(?:0|[1-9]\d*)$/.test(key) ||
        !isFiniteNumber(distance) ||
        distance < 0,
    )
  )
    return null;
  return Object.freeze(
    Object.fromEntries(
      entries.map(([key, distance]) => [Number(key), distance]),
    ),
  );
}

function parseContact(
  value: unknown,
): VerifiedEvidence["contacts"][number] | null {
  if (
    !hasExactKeys(value, ["timestampMs", "side", "point"]) ||
    !isNonNegativeInteger(value.timestampMs) ||
    (value.side !== "left" && value.side !== "right") ||
    !isPoint(value.point)
  )
    return null;
  return Object.freeze({
    timestampMs: value.timestampMs,
    side: value.side,
    point: value.point,
  });
}

function parseWallImpact(
  value: unknown,
): VerifiedEvidence["wallImpacts"][number] | null {
  if (
    !hasExactKeys(value, ["timestampMs", "point"]) ||
    !isNonNegativeInteger(value.timestampMs) ||
    !isPoint(value.point)
  )
    return null;
  return Object.freeze({ timestampMs: value.timestampMs, point: value.point });
}

function parsePassEvidence(
  value: unknown,
): VerifiedEvidence["passEvidence"][number] | null {
  if (
    !isRecord(value) ||
    (value.kind !== "complete" && value.kind !== "missed")
  )
    return null;
  if (
    value.kind === "complete" &&
    hasExactKeys(value, [
      "kind",
      "startedAtMs",
      "wallImpactAtMs",
      "completedAtMs",
      "side",
    ]) &&
    isNonNegativeInteger(value.startedAtMs) &&
    isNonNegativeInteger(value.wallImpactAtMs) &&
    isNonNegativeInteger(value.completedAtMs) &&
    (value.side === "left" || value.side === "right")
  )
    return Object.freeze({
      kind: "complete",
      startedAtMs: value.startedAtMs,
      wallImpactAtMs: value.wallImpactAtMs,
      completedAtMs: value.completedAtMs,
      side: value.side,
    });
  if (
    value.kind === "missed" &&
    hasExactKeys(value, ["kind", "startedAtMs", "deadlineAtMs", "side"]) &&
    isNonNegativeInteger(value.startedAtMs) &&
    isNonNegativeInteger(value.deadlineAtMs) &&
    (value.side === "left" || value.side === "right")
  )
    return Object.freeze({
      kind: "missed",
      startedAtMs: value.startedAtMs,
      deadlineAtMs: value.deadlineAtMs,
      side: value.side,
    });
  return null;
}

function hasVerifiedCalibration(evidence: VerifiedEvidence): boolean {
  if (!hasExactTimeline(evidence.preRoll, 0, PRE_ROLL_FRAME_COUNT))
    return false;
  if (
    !hasExactTimeline(evidence.active, PRE_ROLL_FRAME_COUNT, ACTIVE_FRAME_COUNT)
  )
    return false;
  const acceptedPreRoll = evidence.preRoll.filter(
    (frame) =>
      frame.confidencePresent && meetsGeometryThresholds(frame.geometry),
  );
  if (acceptedPreRoll.length < REQUIRED_PRE_ROLL_FRAMES) return false;
  if (!hasDeterministicReference(evidence, acceptedPreRoll)) return false;
  const stableCount = evidence.active.filter((frame) => frame.stable).length;
  const longestUnstableRun = longestRun(
    evidence.active.map((frame) => !frame.stable),
  );
  if (
    evidence.activeStableCount !== stableCount ||
    evidence.longestUnstableRun !== longestUnstableRun ||
    stableCount < REQUIRED_STABLE_ACTIVE_FRAMES ||
    longestUnstableRun > MAX_UNSTABLE_RUN
  )
    return false;
  return evidence.active.every((frame) => {
    if (!frame.stable)
      return (
        frame.mappedBall === null &&
        frame.mappedFeet.length === 0 &&
        frame.usableTracks === false
      );
    return (
      meetsGeometryThresholds(frame.geometry) &&
      frame.anchorMedianDrift !== null &&
      frame.anchorMedianDrift <= MAX_MEDIAN_DRIFT &&
      frame.anchorMaximumDrift !== null &&
      frame.anchorMaximumDrift <= MAX_DRIFT &&
      (frame.usableTracks === false || frame.mappedBall !== null)
    );
  });
}

function hasDeterministicReference(
  evidence: VerifiedEvidence,
  acceptedPreRoll: readonly PreRollEvidence[],
): boolean {
  if (evidence.selectedReferenceFrameIndex === null) return false;
  const expectedSums = Object.fromEntries(
    acceptedPreRoll.map((candidate) => [
      candidate.frameIndex,
      acceptedPreRoll.reduce(
        (total, other) =>
          total +
          medianAnchorDistance(
            candidate.geometry as AcceptedGeometry,
            other.geometry as AcceptedGeometry,
          ),
        0,
      ),
    ]),
  ) as Record<number, number>;
  const expectedKeys = Object.keys(expectedSums).sort();
  const actualKeys = Object.keys(evidence.referenceDistanceSums).sort();
  if (
    expectedKeys.length !== actualKeys.length ||
    expectedKeys.some((key, index) => key !== actualKeys[index]) ||
    expectedKeys.some(
      (key) =>
        Math.abs(
          expectedSums[Number(key)]! -
            evidence.referenceDistanceSums[Number(key)]!,
        ) > 1e-8,
    )
  )
    return false;
  const selected = acceptedPreRoll
    .map((frame) => ({
      frameIndex: frame.frameIndex,
      sum: expectedSums[frame.frameIndex]!,
    }))
    .sort(
      (left, right) =>
        left.sum - right.sum || left.frameIndex - right.frameIndex,
    )[0];
  return selected?.frameIndex === evidence.selectedReferenceFrameIndex;
}

function hasBoundMappedEvents(
  evidence: VerifiedEvidence,
  manifest: ExtractionManifest & Readonly<{ mode: "verified" }>,
): boolean {
  const activeByTimestamp = new Map(
    evidence.active.map((frame) => {
      const timestamp = Math.round(
        manifest.frames.items[frame.frameIndex]!.timestampSeconds * 1000,
      );
      return [timestamp, frame] as const;
    }),
  );
  const contactTimes = new Set<number>();
  for (const contact of evidence.contacts) {
    const frame = activeByTimestamp.get(contact.timestampMs);
    if (
      !frame ||
      !frame.stable ||
      !meetsGeometryThresholds(frame.geometry) ||
      !samePoint(frame.mappedBall, contact.point) ||
      !frame.mappedFeet.some((foot) => foot.side === contact.side)
    )
      return false;
    contactTimes.add(contact.timestampMs);
  }
  const wallTimes = new Set<number>();
  for (const wall of evidence.wallImpacts) {
    const frame = activeByTimestamp.get(wall.timestampMs);
    if (
      !frame ||
      !frame.stable ||
      !meetsGeometryThresholds(frame.geometry) ||
      !samePoint(frame.mappedBall, wall.point)
    )
      return false;
    wallTimes.add(wall.timestampMs);
  }
  return evidence.passEvidence.every((pass) =>
    pass.kind === "complete"
      ? contactTimes.has(pass.startedAtMs) &&
        wallTimes.has(pass.wallImpactAtMs) &&
        contactTimes.has(pass.completedAtMs) &&
        pass.startedAtMs < pass.wallImpactAtMs &&
        pass.wallImpactAtMs < pass.completedAtMs
      : contactTimes.has(pass.startedAtMs) &&
        pass.startedAtMs < pass.deadlineAtMs,
  );
}

function countUsableTracks(active: readonly ActiveEvidence[]): number {
  return active.filter((frame) => frame.usableTracks).length;
}

function hasExactTimeline(
  frames: readonly Readonly<{ frameIndex: number }>[],
  firstIndex: number,
  count: number,
): boolean {
  return (
    frames.length === count &&
    frames.every((frame, index) => frame.frameIndex === firstIndex + index)
  );
}

function meetsGeometryThresholds(
  geometry: Geometry,
): geometry is AcceptedGeometry {
  return (
    geometry.valid &&
    geometry.inlierCount >= 4 &&
    geometry.medianReprojectionError <= MAX_MEDIAN_REPROJECTION_ERROR &&
    geometry.maxReprojectionError <= MAX_REPROJECTION_ERROR &&
    geometry.wallEdgeError <= MAX_WALL_EDGE_ERROR &&
    geometry.orientationValid &&
    geometry.wallSideValid
  );
}

function medianAnchorDistance(
  left: AcceptedGeometry,
  right: AcceptedGeometry,
): number {
  const distances = CORNER_IDS.map((corner) =>
    Math.hypot(
      left.anchorPoints[corner].x - right.anchorPoints[corner].x,
      left.anchorPoints[corner].y - right.anchorPoints[corner].y,
    ),
  ).sort((first, second) => first - second);
  return (distances[3]! + distances[4]!) / 2;
}

function longestRun(values: readonly boolean[]): number {
  let current = 0;
  let longest = 0;
  for (const value of values) {
    current = value ? current + 1 : 0;
    longest = Math.max(longest, current);
  }
  return longest;
}

function sameEvidenceBinding(
  binding: EvidenceBinding,
  expected: ExpectedAttempt,
): boolean {
  return (
    binding.attemptId === expected.attemptId &&
    binding.generation === expected.generation &&
    binding.mediaId === expected.mediaId &&
    binding.mediaSha256 === expected.mediaSha256 &&
    binding.rawPreRollSha256 === expected.rawPreRollSha256 &&
    binding.calibrationSessionId === expected.calibrationSessionId &&
    binding.calibrationNonce === expected.calibrationNonce
  );
}

function isMappedFoot(
  value: unknown,
): value is ActiveEvidence["mappedFeet"][number] {
  return (
    hasExactKeys(value, ["side", "point", "confidence"]) &&
    (value.side === "left" || value.side === "right") &&
    isPoint(value.point) &&
    isFiniteNumber(value.confidence) &&
    value.confidence >= CALIBRATION_CONFIDENCE
  );
}

function isAnchorPoints(
  value: unknown,
): value is AcceptedGeometry["anchorPoints"] {
  return (
    hasExactKeys(value, CORNER_IDS) &&
    CORNER_IDS.every((corner) => isPoint(value[corner]))
  );
}

function isMatrix(value: unknown): value is readonly number[] {
  return (
    Array.isArray(value) && value.length === 9 && value.every(isFiniteNumber)
  );
}

function isNullablePoint(value: unknown): value is Point | null {
  return value === null || isPoint(value);
}

function isPoint(value: unknown): value is Point {
  return (
    hasExactKeys(value, ["x", "y"]) &&
    isFiniteNumber(value.x) &&
    isFiniteNumber(value.y)
  );
}

function samePoint(left: Point | null, right: Point): boolean {
  return left !== null && left.x === right.x && left.y === right.y;
}

function hasExactKeys(
  value: unknown,
  expected: readonly string[],
): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value).sort();
  return (
    keys.length === expected.length &&
    keys.every((key, index) => key === [...expected].sort()[index])
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  );
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function isNonce(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNullableFinite(value: unknown): value is number | null {
  return value === null || isFiniteNumber(value);
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isFinitePositive(value: unknown): value is number {
  return isFiniteNumber(value) && value > 0;
}

function isNull<T>(value: T | null): value is null {
  return value === null;
}
