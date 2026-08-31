import { describe, expect, it } from "vitest";
import {
  evaluateVerifiedIntegrity,
  serializeIntegrityDecision,
  temporaryIntegrityDecision,
} from "./integrity-evaluator.js";

const attemptId = "11111111-1111-4111-8111-111111111111";
const mediaId = "22222222-2222-4222-8222-222222222222";
const sessionId = "33333333-3333-4333-8333-333333333333";
const sha256 = "a".repeat(64);
const preRollSha256 = "b".repeat(64);
const nonce = "c".repeat(43);

type PointFixture = { x: number; y: number };
type GeometryFixture = {
  frameIndex: number;
  valid: boolean;
  homography: number[] | null;
  inverse: number[] | null;
  inlierCount: number;
  medianReprojectionError: number | null;
  maxReprojectionError: number | null;
  wallEdgeError: number | null;
  orientationValid: boolean;
  wallSideValid: boolean;
  anchorPoints: Record<string, PointFixture> | null;
};
type IntegrityFixture = {
  expected: {
    attemptId: string;
    generation: number;
    challenge: { id: string; version: number };
    calibrationSessionId: string;
    calibrationNonce: string;
    mediaId: string;
    mediaSha256: string;
    rawPreRollSha256: string;
  };
  continuity: {
    kind: string;
    timelineContinuous: boolean;
    activeSceneChangeFree: boolean;
  };
  manifest: Record<string, unknown>;
  evidence: {
    kind: string;
    binding: {
      attemptId: string;
      generation: number;
      mediaId: string;
      mediaSha256: string;
      rawPreRollSha256: string;
      calibrationSessionId: string;
      calibrationNonce: string;
    };
    provenance: Record<string, string>;
    selectedReferenceFrameIndex: number | null;
    referenceDistanceSums: Record<string, number>;
    preRoll: Array<{
      frameIndex: number;
      confidencePresent: boolean;
      geometry: GeometryFixture;
      inference: undefined;
    }>;
    active: Array<{
      frameIndex: number;
      stable: boolean;
      geometry: GeometryFixture;
      inference: undefined;
      anchorMedianDrift: number | null;
      anchorMaximumDrift: number | null;
      mappedBall: PointFixture | null;
      mappedFeet: Array<{
        side: "left" | "right";
        point: PointFixture;
        confidence: number;
      }>;
      usableTracks: boolean;
    }>;
    activeStableCount: number;
    longestUnstableRun: number;
    contacts: Array<{
      timestampMs: number;
      side: "left" | "right";
      point: PointFixture;
    }>;
    wallImpacts: Array<{ timestampMs: number; point: PointFixture }>;
    passEvidence: Array<Record<string, unknown>>;
  };
};

describe("verified integrity evaluator", () => {
  it("accepts complete bound evidence and serializes no private calibration data", () => {
    const decision = evaluateVerifiedIntegrity(validInput());

    expect(decision).toEqual({ kind: "integrity-valid" });
    expect(JSON.stringify(serializeIntegrityDecision(decision))).not.toMatch(
      /a{64}|b{64}|c{43}|frame|confidence|drift|reprojection|media/i,
    );
  });

  it("keeps temporary analysis failures retryable rather than invalid", () => {
    expect(temporaryIntegrityDecision()).toEqual({
      kind: "analysis-temporary-unavailable",
      code: "analysis_temporary_unavailable",
      message: "A análise está indisponível temporariamente.",
      retryable: true,
    });
  });

  it("gives continuity failure precedence over malformed calibration evidence", () => {
    const input = validInput();
    input.continuity.timelineContinuous = false;
    input.evidence.selectedReferenceFrameIndex = null;

    expect(evaluateVerifiedIntegrity(input)).toMatchObject({
      kind: "integrity-invalid",
      code: "video_not_continuous",
    });
  });

  it("requires exactly the pre-roll threshold while preserving equality", () => {
    const below = validInput();
    for (const frame of below.evidence.preRoll.slice(31))
      frame.confidencePresent = false;

    expect(evaluateVerifiedIntegrity(below)).toMatchObject({
      kind: "integrity-invalid",
      code: "calibration_not_verified",
    });
    expect(evaluateVerifiedIntegrity(validInput())).toEqual({
      kind: "integrity-valid",
    });
  });

  it("requires 576 stable frames and rejects any four-frame unstable run", () => {
    const belowStable = withUnstableFrames(575);
    const fourFrameRun = validInput();
    for (const frame of fourFrameRun.evidence.active.slice(100, 104)) {
      frame.stable = false;
      frame.geometry = invalidGeometry(frame.frameIndex);
      frame.anchorMedianDrift = null;
      frame.anchorMaximumDrift = null;
      frame.mappedBall = null;
      frame.mappedFeet = [];
      frame.usableTracks = false;
    }
    fourFrameRun.evidence.activeStableCount = 596;
    fourFrameRun.evidence.longestUnstableRun = 4;

    expect(evaluateVerifiedIntegrity(belowStable)).toMatchObject({
      code: "calibration_not_verified",
    });
    expect(evaluateVerifiedIntegrity(fourFrameRun)).toMatchObject({
      code: "calibration_not_verified",
    });
  });

  it("enforces inclusive geometry and drift limits", () => {
    const atLimits = validInput();
    const accepted = atLimits.evidence.active[0]!;
    accepted.geometry.medianReprojectionError = 4;
    accepted.geometry.maxReprojectionError = 8;
    accepted.geometry.wallEdgeError = 8;
    accepted.anchorMedianDrift = 6;
    accepted.anchorMaximumDrift = 12;
    const aboveLimits = structuredClone(atLimits);
    aboveLimits.evidence.active[0]!.anchorMaximumDrift = 12.001;

    expect(evaluateVerifiedIntegrity(atLimits)).toEqual({
      kind: "integrity-valid",
    });
    expect(evaluateVerifiedIntegrity(aboveLimits)).toMatchObject({
      code: "calibration_not_verified",
    });
  });

  it("keeps tracking insufficiency distinct after valid calibration", () => {
    const below = validInput();
    for (const frame of below.evidence.active.slice(479)) {
      frame.usableTracks = false;
      frame.mappedBall = null;
    }

    expect(evaluateVerifiedIntegrity(below)).toMatchObject({
      kind: "integrity-invalid",
      code: "tracking_insufficient",
    });
  });

  it("rejects stale mapped events, cross-binding facts, and unparsed evidence", () => {
    const staleMapping = validInput();
    staleMapping.evidence.contacts.push({
      timestampMs: 4000,
      side: "left",
      point: { x: 99, y: 99 },
    });
    const crossBinding = validInput();
    crossBinding.evidence.binding.generation = 2;
    const extraEvidence = validInput();
    (extraEvidence.evidence as Record<string, unknown>).providerVerdict = true;

    for (const input of [staleMapping, crossBinding, extraEvidence])
      expect(evaluateVerifiedIntegrity(input)).toMatchObject({
        kind: "integrity-invalid",
        code: "calibration_not_verified",
      });
  });
});

function withUnstableFrames(stableCount: number): IntegrityFixture {
  const input = validInput();
  for (const frame of input.evidence.active.slice(stableCount)) {
    frame.stable = false;
    frame.geometry = invalidGeometry(frame.frameIndex);
    frame.anchorMedianDrift = null;
    frame.anchorMaximumDrift = null;
    frame.mappedBall = null;
    frame.mappedFeet = [];
    frame.usableTracks = false;
  }
  input.evidence.activeStableCount = stableCount;
  input.evidence.longestUnstableRun = ACTIVE_FRAME_COUNT - stableCount;
  return input;
}

const ACTIVE_FRAME_COUNT = 600;

function validInput(): IntegrityFixture {
  return {
    expected: {
      attemptId,
      generation: 1,
      challenge: { id: "wall-pass", version: 1 },
      calibrationSessionId: sessionId,
      calibrationNonce: nonce,
      mediaId,
      mediaSha256: sha256,
      rawPreRollSha256: preRollSha256,
    },
    continuity: {
      kind: "verified-continuity-evidence-v1",
      timelineContinuous: true,
      activeSceneChangeFree: true,
    },
    manifest: verifiedManifest(),
    evidence: {
      kind: "wall-pass-geometry-evidence-v1",
      binding: {
        attemptId,
        generation: 1,
        mediaId,
        mediaSha256: sha256,
        rawPreRollSha256: preRollSha256,
        calibrationSessionId: sessionId,
        calibrationNonce: nonce,
      },
      provenance: {
        kind: "demo",
        fixtureId: "wall-pass-balanced-v1",
        providerVersion: "demo-observations-v1",
      },
      selectedReferenceFrameIndex: 0,
      referenceDistanceSums: Object.fromEntries(
        Array.from({ length: 40 }, (_, index) => [String(index), 0]),
      ),
      preRoll: Array.from({ length: 40 }, (_, index) => ({
        frameIndex: index,
        confidencePresent: true,
        geometry: geometry(index),
        inference: undefined,
      })),
      active: Array.from({ length: 600 }, (_, offset) => ({
        frameIndex: offset + 40,
        stable: true,
        geometry: geometry(offset + 40),
        inference: undefined,
        anchorMedianDrift: 0,
        anchorMaximumDrift: 0,
        mappedBall: { x: 0, y: 0 },
        mappedFeet: [],
        usableTracks: true,
      })),
      activeStableCount: 600,
      longestUnstableRun: 0,
      contacts: [],
      wallImpacts: [],
      passEvidence: [],
    },
  };
}

function verifiedManifest(): Record<string, unknown> {
  return {
    kind: "extraction-manifest",
    extractionVersion: "c5-frame-manifest-v1",
    mode: "verified",
    attemptId,
    generation: 1,
    mediaId,
    mediaSha256: sha256,
    display: { width: 1280, height: 720, rotationDegrees: 0 },
    probe: {
      container: "mp4",
      durationSeconds: 64,
      displayWidth: 1280,
      displayHeight: 720,
      nominalFps: 30,
      codec: "h264",
      sourceRotationDegrees: 0,
    },
    frames: {
      count: 640,
      items: Array.from({ length: 640 }, (_, ordinal) => ({
        ordinal,
        timestampSeconds: ordinal / 10,
        reference: `${mediaId}_${String(ordinal).padStart(4, "0")}`,
      })),
    },
    preRoll: { count: 40 },
    active: { count: 600 },
    rawPreRollSha256: preRollSha256,
  };
}

function geometry(frameIndex: number): GeometryFixture {
  return {
    frameIndex,
    valid: true,
    homography: [1, 0, 0, 0, 1, 0, 0, 0, 1],
    inverse: [1, 0, 0, 0, 1, 0, 0, 0, 1],
    inlierCount: 8,
    medianReprojectionError: 0,
    maxReprojectionError: 0,
    wallEdgeError: 0,
    orientationValid: true,
    wallSideValid: true,
    anchorPoints: {
      "a-top-left": { x: 0, y: 0 },
      "a-top-right": { x: 1, y: 0 },
      "a-bottom-right": { x: 1, y: 1 },
      "a-bottom-left": { x: 0, y: 1 },
      "b-top-left": { x: 2, y: 0 },
      "b-top-right": { x: 3, y: 0 },
      "b-bottom-right": { x: 3, y: 1 },
      "b-bottom-left": { x: 2, y: 1 },
    },
  };
}

function invalidGeometry(frameIndex: number): GeometryFixture {
  return {
    frameIndex,
    valid: false,
    homography: null,
    inverse: null,
    inlierCount: 0,
    medianReprojectionError: null,
    maxReprojectionError: null,
    wallEdgeError: null,
    orientationValid: false,
    wallSideValid: false,
    anchorPoints: null,
  };
}
