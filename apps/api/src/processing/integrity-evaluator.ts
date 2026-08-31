import {
  assertWallPassCanonicalEvidence,
  evaluateWallPassV1,
  type WallPassEvaluation,
} from "@revelai/domain";
import {
  FailureMessageByCode,
  InvalidRetryMessageByCode,
  type InvalidRetryCode,
} from "@revelai/contracts";
import {
  isAssembledVerifiedEvidence,
  type VerifiedObservationEvidence,
} from "@revelai/vision";
import { isMediaProbeAdmissible } from "../media/eligibility.js";
import {
  parseExtractionManifest,
  verifiedExtractionIdentity,
  type ExtractionManifest,
} from "../media/extraction-manifest.js";

const REQUIRED_PRE_ROLL_FRAMES = 32;
const REQUIRED_STABLE_ACTIVE_FRAMES = 576;
const REQUIRED_USABLE_TRACK_FRAMES = 480;
const MAX_UNSTABLE_RUN = 3;
const MAX_MEDIAN_REPROJECTION_ERROR = 4;
const MAX_REPROJECTION_ERROR = 8;
const MAX_WALL_EDGE_ERROR = 8;
const MAX_MEDIAN_DRIFT = 6;
const MAX_DRIFT = 12;

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

type CandidateData = Readonly<{
  scoreEvidence: VerifiedObservationEvidence["canonicalEvents"];
  provenance: VerifiedObservationEvidence["provenance"];
  calibrationEvidenceVersion: "wall-pass-calibration-evidence-v1";
}>;

const verifiedCandidates = new WeakSet<object>();
const candidateData = new WeakMap<object, CandidateData>();

/** Opaque runtime capability: only an accepted C5/C6 chain can create it. */
export type VerifiedAttemptCandidate = Readonly<{
  kind: "verified-attempt-candidate";
}>;

export type IntegrityDecision =
  | Readonly<{ kind: "integrity-valid"; candidate: VerifiedAttemptCandidate }>
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

export type CandidatePolicyFacts = Readonly<{
  provenance: VerifiedObservationEvidence["provenance"];
  calibrationEvidenceVersion: "wall-pass-calibration-evidence-v1";
}>;

/** Rejects structural JSON: evidence must be C6's frozen, registered output. */
export function evaluateVerifiedIntegrity(input: unknown): IntegrityDecision {
  const parsed = parseInput(input);
  if (!parsed) return invalid("calibration_not_verified");
  const manifest = parseManifest(parsed.manifest);
  if (!manifest || !isMediaProbeAdmissible("verified", manifest.probe))
    return invalid("video_not_continuous");
  if (!sameBinding(parsed.evidence, manifest, parsed.expected))
    return invalid("video_not_continuous");
  if (!hasVerifiedCalibration(parsed.evidence))
    return invalid("calibration_not_verified");
  if (!hasBoundCanonicalEvents(parsed.evidence))
    return invalid("calibration_not_verified");
  if (
    parsed.evidence.active.filter((frame) => frame.usableTracks).length <
    REQUIRED_USABLE_TRACK_FRAMES
  )
    return invalid("tracking_insufficient");

  const candidate = Object.freeze({
    kind: "verified-attempt-candidate" as const,
  });
  candidateData.set(
    candidate,
    Object.freeze({
      scoreEvidence: parsed.evidence.canonicalEvents,
      provenance: parsed.evidence.provenance,
      calibrationEvidenceVersion: "wall-pass-calibration-evidence-v1",
    }),
  );
  verifiedCandidates.add(candidate);
  return Object.freeze({ kind: "integrity-valid", candidate });
}

/** C3 owns all score semantics; no raw score input can cross this seam. */
export function scoreVerifiedCandidate(
  candidate: VerifiedAttemptCandidate,
): WallPassEvaluation {
  return evaluateWallPassV1(candidateInternals(candidate).scoreEvidence);
}

/** Policy gets provenance only after the candidate capability check. */
export function candidatePolicyFacts(
  candidate: VerifiedAttemptCandidate,
): CandidatePolicyFacts {
  const data = candidateInternals(candidate);
  return Object.freeze({
    provenance: data.provenance,
    calibrationEvidenceVersion: data.calibrationEvidenceVersion,
  });
}

export function temporaryIntegrityDecision(): IntegrityDecision {
  return Object.freeze({
    kind: "analysis-temporary-unavailable",
    code: "analysis_temporary_unavailable",
    message: FailureMessageByCode.analysis_temporary_unavailable,
    retryable: true,
  });
}

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

function candidateInternals(
  candidate: VerifiedAttemptCandidate,
): CandidateData {
  if (!verifiedCandidates.has(candidate))
    throw new Error("invalid verified candidate");
  return candidateData.get(candidate)!;
}

function parseInput(value: unknown): Readonly<{
  expected: ExpectedAttempt;
  manifest: ExtractionManifest;
  evidence: VerifiedObservationEvidence;
}> | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["expected", "manifest", "evidence"])
  )
    return null;
  const expected = parseExpected(value.expected);
  if (!expected || !isAssembledVerifiedEvidence(value.evidence)) return null;
  return Object.freeze({
    expected,
    manifest: value.manifest as ExtractionManifest,
    evidence: value.evidence,
  });
}

function parseExpected(value: unknown): ExpectedAttempt | null {
  if (
    !isRecord(value) ||
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
    !isRecord(value.challenge) ||
    !hasExactKeys(value.challenge, ["id", "version"]) ||
    value.challenge.id !== "wall-pass" ||
    value.challenge.version !== 1 ||
    !isUuid(value.attemptId) ||
    !isPositiveSafeInteger(value.generation) ||
    !isUuid(value.calibrationSessionId) ||
    !isUuid(value.mediaId) ||
    !isNonce(value.calibrationNonce) ||
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

function parseManifest(
  value: unknown,
): Extract<ExtractionManifest, Readonly<{ mode: "verified" }>> | null {
  try {
    const manifest = parseExtractionManifest(value);
    return manifest.mode === "verified" ? manifest : null;
  } catch {
    return null;
  }
}

function sameBinding(
  evidence: VerifiedObservationEvidence,
  manifest: Extract<ExtractionManifest, Readonly<{ mode: "verified" }>>,
  expected: ExpectedAttempt,
): boolean {
  const binding = evidence.binding;
  return (
    binding.attemptId === expected.attemptId &&
    binding.generation === expected.generation &&
    binding.mediaId === expected.mediaId &&
    binding.mediaSha256 === expected.mediaSha256 &&
    binding.rawPreRollSha256 === expected.rawPreRollSha256 &&
    binding.calibrationSessionId === expected.calibrationSessionId &&
    binding.calibrationNonce === expected.calibrationNonce &&
    manifest.attemptId === expected.attemptId &&
    manifest.generation === expected.generation &&
    manifest.mediaId === expected.mediaId &&
    manifest.mediaSha256 === expected.mediaSha256 &&
    manifest.rawPreRollSha256 === expected.rawPreRollSha256 &&
    binding.extractionVersion === manifest.extractionVersion &&
    binding.extractionIdentity === verifiedExtractionIdentity(manifest)
  );
}

function hasVerifiedCalibration(
  evidence: VerifiedObservationEvidence,
): boolean {
  const preRoll = evidence.preRoll.filter(
    (frame) => frame.confidencePresent && acceptedGeometry(frame.geometry),
  );
  if (
    preRoll.length < REQUIRED_PRE_ROLL_FRAMES ||
    evidence.selectedReferenceFrameIndex === null ||
    !preRoll.some(
      (frame) => frame.frameIndex === evidence.selectedReferenceFrameIndex,
    )
  )
    return false;
  if (
    evidence.active.length !== 600 ||
    evidence.activeStableCount !==
      evidence.active.filter((frame) => frame.stable).length ||
    evidence.activeStableCount < REQUIRED_STABLE_ACTIVE_FRAMES ||
    evidence.longestUnstableRun !== longestUnstableRun(evidence.active)
  )
    return false;
  for (const frame of evidence.active) {
    if (!frame.stable) continue;
    if (
      !acceptedGeometry(frame.geometry) ||
      frame.anchorMedianDrift === null ||
      frame.anchorMaximumDrift === null ||
      frame.anchorMedianDrift < 0 ||
      frame.anchorMedianDrift > MAX_MEDIAN_DRIFT ||
      frame.anchorMaximumDrift < 0 ||
      frame.anchorMaximumDrift > MAX_DRIFT
    )
      return false;
  }
  return evidence.longestUnstableRun <= MAX_UNSTABLE_RUN;
}

function acceptedGeometry(
  geometry: VerifiedObservationEvidence["active"][number]["geometry"],
): boolean {
  return (
    geometry.valid &&
    geometry.inlierCount >= 8 &&
    geometry.medianReprojectionError !== null &&
    geometry.medianReprojectionError >= 0 &&
    geometry.medianReprojectionError <= MAX_MEDIAN_REPROJECTION_ERROR &&
    geometry.maxReprojectionError !== null &&
    geometry.maxReprojectionError >= 0 &&
    geometry.maxReprojectionError <= MAX_REPROJECTION_ERROR &&
    geometry.wallEdgeError !== null &&
    geometry.wallEdgeError >= 0 &&
    geometry.wallEdgeError <= MAX_WALL_EDGE_ERROR &&
    geometry.orientationValid &&
    geometry.wallSideValid &&
    geometry.homography !== null &&
    geometry.inverse !== null
  );
}

function hasBoundCanonicalEvents(
  evidence: VerifiedObservationEvidence,
): boolean {
  try {
    assertWallPassCanonicalEvidence(evidence.canonicalEvents);
  } catch {
    return false;
  }
  const activeByFrame = new Map(
    evidence.active.map((frame) => [frame.frameIndex, frame]),
  );
  let prior = -1;
  const seen = new Set<string>();
  for (const event of evidence.eventGraph) {
    const key = `${event.kind}:${event.timestampMs}`;
    const frame = activeByFrame.get(event.frameIndex);
    if (
      event.timestampMs <= prior ||
      seen.has(key) ||
      event.frameIndex !== event.homographyFrameIndex ||
      !Number.isSafeInteger(event.trackId) ||
      event.trackId < 0 ||
      !frame?.stable ||
      !acceptedGeometry(frame.geometry)
    )
      return false;
    prior = event.timestampMs;
    seen.add(key);
  }
  return (
    evidence.canonicalEvents.contacts.every((contact) =>
      evidence.eventGraph.some(
        (event) =>
          event.kind === "contact" && event.timestampMs === contact.timestampMs,
      ),
    ) &&
    evidence.canonicalEvents.wallImpacts.every((impact) =>
      evidence.eventGraph.some(
        (event) =>
          event.kind === "wall-impact" &&
          event.timestampMs === impact.timestampMs,
      ),
    )
  );
}

function longestUnstableRun(
  active: VerifiedObservationEvidence["active"],
): number {
  let longest = 0;
  let current = 0;
  for (const frame of active) {
    current = frame.stable ? 0 : current + 1;
    longest = Math.max(longest, current);
  }
  return longest;
}
function invalid(code: InvalidRetryCode): IntegrityDecision {
  return Object.freeze({
    kind: "integrity-invalid",
    code,
    message: InvalidRetryMessageByCode[code],
    retryable: true,
  });
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function hasExactKeys(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}
function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  );
}
function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}
function isDigest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}
function isNonce(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
}
