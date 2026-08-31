import { createDemoVisionProvider, type VisionProvider } from "@revelai/vision";
import { describe, expect, it } from "vitest";
import {
  attestVerifiedExtractionContinuity,
  createExtractionManifest,
} from "../media/extraction-manifest.js";
import { assembleVerifiedObservation } from "./observation-assembler.js";
import {
  evaluateVerifiedIntegrity,
  scoreVerifiedCandidate,
  serializeIntegrityDecision,
  temporaryIntegrityDecision,
} from "./integrity-evaluator.js";

const attemptId = "11111111-1111-4111-8111-111111111111";
const mediaId = "22222222-2222-4222-8222-222222222222";
const sessionId = "33333333-3333-4333-8333-333333333333";
const nonce = "c".repeat(43);
const mediaSha256 = "a".repeat(64);

describe("verified integrity evaluator", () => {
  it("creates a score-capable opaque candidate only from C5 to C6 evidence", async () => {
    const input = await validInput();
    const decision = evaluateVerifiedIntegrity(input);

    expect(decision.kind).toBe("integrity-valid");
    if (decision.kind !== "integrity-valid") return;
    expect(scoreVerifiedCandidate(decision.candidate)).toMatchObject({
      ruleVersion: "wall-pass-v1-score-1",
    });
    expect(JSON.stringify(serializeIntegrityDecision(decision))).not.toMatch(
      /sha|nonce|frame|confidence|drift|media/i,
    );
  });

  it("rejects detached structural evidence even when its fields are complete", async () => {
    const input = await validInput();
    expect(
      evaluateVerifiedIntegrity({
        ...input,
        evidence: structuredClone(input.evidence),
      }),
    ).toMatchObject({
      kind: "integrity-invalid",
      code: "calibration_not_verified",
    });
  });

  it("rejects a replayed manifest even when its serialized fields are identical", async () => {
    const input = await validInput();
    expect(
      evaluateVerifiedIntegrity({
        ...input,
        manifest: structuredClone(input.manifest),
      }),
    ).toMatchObject({
      kind: "integrity-invalid",
      code: "video_not_continuous",
    });
  });

  it("accepts C6 geometry with seven RANSAC inliers rather than requiring eight", async () => {
    const demo = createDemoVisionProvider();
    const sevenInlierProvider: VisionProvider = Object.freeze({
      ...demo,
      async analyzeVerified(request, signal, deadline) {
        const observation = await demo.analyzeVerified(
          request,
          signal,
          deadline,
        );
        return Object.freeze({
          ...observation,
          fiducialCorners: observation.fiducialCorners.map((corner, index) =>
            index === 0 ? { ...corner, x: corner.x + 100 } : corner,
          ),
        });
      },
    });
    const input = await validInput(sevenInlierProvider);

    expect(evaluateVerifiedIntegrity(input)).toMatchObject({
      kind: "integrity-valid",
    });
  });

  it.each([
    [3, "calibration_not_verified"],
    [4, "integrity-valid"],
    [5, "integrity-valid"],
    [7, "integrity-valid"],
    [8, "integrity-valid"],
  ] as const)(
    "enforces the C6 %i-inlier boundary",
    async (inlierCount, expected) => {
      const input = await validInput(fixtureProvider({ inlierCount }));
      const decision = evaluateVerifiedIntegrity(input);
      expect(
        decision.kind === "integrity-valid" ? decision.kind : decision.code,
      ).toBe(expected);
    },
  );

  it.each([
    [0.799, "calibration_not_verified"],
    [0.8, "integrity-valid"],
    [0.801, "integrity-valid"],
  ] as const)(
    "enforces calibration confidence %f from C6",
    async (confidence, expected) => {
      const decision = evaluateVerifiedIntegrity(
        await validInput(
          fixtureProvider({ calibrationConfidence: confidence }),
        ),
      );
      expect(
        decision.kind === "integrity-valid" ? decision.kind : decision.code,
      ).toBe(expected);
    },
  );

  it.each([
    [0.64, 0],
    [0.65, 119],
    [0.66, 119],
  ] as const)(
    "keeps the C6 foot confidence %f boundary in canonical scoring",
    async (confidence, opportunities) => {
      const decision = evaluateVerifiedIntegrity(
        await validInput(fixtureProvider({ footConfidence: confidence })),
      );
      expect(decision.kind).toBe("integrity-valid");
      if (decision.kind !== "integrity-valid") return;
      expect(scoreVerifiedCandidate(decision.candidate).opportunities).toBe(
        opportunities,
      );
    },
  );

  it.each([
    ["31 pre-roll frames", { missingPreRoll: 9 }, "calibration_not_verified"],
    ["32 pre-roll frames", { missingPreRoll: 8 }, "integrity-valid"],
    ["33 pre-roll frames", { missingPreRoll: 7 }, "integrity-valid"],
    [
      "575 stable active frames",
      { missingStable: 25 },
      "calibration_not_verified",
    ],
    ["576 stable active frames", { missingStable: 24 }, "integrity-valid"],
    ["577 stable active frames", { missingStable: 23 }, "integrity-valid"],
    ["three unstable frames", { unstableRun: 3 }, "integrity-valid"],
    ["four unstable frames", { unstableRun: 4 }, "calibration_not_verified"],
    ["five unstable frames", { unstableRun: 5 }, "calibration_not_verified"],
    [
      "479 usable track frames",
      { missingTracks: 118 },
      "tracking_insufficient",
    ],
    ["480 usable track frames", { missingTracks: 117 }, "integrity-valid"],
    ["481 usable track frames", { missingTracks: 116 }, "integrity-valid"],
  ] as const)(
    "enforces %s from actual C5 to C6 evidence",
    async (_, fault, expected) => {
      const decision = evaluateVerifiedIntegrity(
        await validInput(fixtureProvider(fault)),
      );
      expect(
        decision.kind === "integrity-valid" ? decision.kind : decision.code,
      ).toBe(expected);
    },
  );

  it("gives C5 probe/continuity binding failures precedence", async () => {
    const input = await validInput();
    const portrait = {
      ...input.manifest,
      probe: {
        ...input.manifest.probe,
        displayWidth: 720,
        displayHeight: 1280,
      },
      display: { ...input.manifest.display, width: 720, height: 1280 },
    };
    expect(
      evaluateVerifiedIntegrity({ ...input, manifest: portrait }),
    ).toMatchObject({ code: "video_not_continuous" });
  });

  it("preserves temporary analysis failures as retryable without a candidate", () => {
    expect(temporaryIntegrityDecision()).toEqual({
      kind: "analysis-temporary-unavailable",
      code: "analysis_temporary_unavailable",
      message: "A análise está indisponível temporariamente.",
      retryable: true,
    });
  });
});

async function validInput(
  provider: VisionProvider = createDemoVisionProvider(),
) {
  const manifest = createExtractionManifest({
    attemptId,
    generation: 1,
    mediaId,
    mediaSha256,
    mode: "verified",
    probe: {
      container: "mp4",
      durationSeconds: 64,
      displayWidth: 1280,
      displayHeight: 720,
      nominalFps: 30,
      codec: "h264",
      sourceRotationDegrees: 0,
    },
    frames: Array.from({ length: 640 }, (_, index) => ({
      timestampSeconds: index / 10,
      reference: `frame_${index}`,
      rawBytes: Uint8Array.of(index % 256),
    })),
  });
  if (manifest.mode !== "verified") throw new Error("fixture must be verified");
  attestVerifiedExtractionContinuity(
    manifest,
    manifest.frames.items.slice(40).map((frame) => ({
      timestampSeconds: frame.timestampSeconds,
      score: 0.1,
    })),
  );
  const evidence = await assembleVerifiedObservation({
    manifest,
    provider,
    calibrationSessionId: sessionId,
    calibrationNonce: nonce,
    frames: {
      async readFrame(reference) {
        return Uint8Array.of(Number(reference.replace("frame_", "")) % 256);
      },
    },
  });
  return {
    expected: {
      attemptId,
      generation: 1,
      challenge: { id: "wall-pass" as const, version: 1 as const },
      calibrationSessionId: sessionId,
      calibrationNonce: nonce,
      mediaId,
      mediaSha256,
      rawPreRollSha256: manifest.rawPreRollSha256,
    },
    manifest,
    evidence,
  };
}

type FixtureFault = Readonly<{
  missingPreRoll?: number;
  missingStable?: number;
  unstableRun?: number;
  missingTracks?: number;
  inlierCount?: 3 | 4 | 5 | 7 | 8;
  calibrationConfidence?: number;
  footConfidence?: number;
}>;

function fixtureProvider(fault: FixtureFault): VisionProvider {
  const demo = createDemoVisionProvider();
  return Object.freeze({
    ...demo,
    async analyzeVerified(request, signal, deadline) {
      const observation = await demo.analyzeVerified(request, signal, deadline);
      const activeIndex = request.frame.index - 40;
      const missingPreRoll = request.frame.index < (fault.missingPreRoll ?? 0);
      const missingStable = isEvenlyRemoved(
        activeIndex,
        fault.missingStable ?? 0,
      );
      const unstable =
        activeIndex >= 0 && activeIndex < (fault.unstableRun ?? 0);
      const missingTrack =
        activeIndex >= 0 && activeIndex < (fault.missingTracks ?? 0);
      return Object.freeze({
        ...observation,
        ...(missingPreRoll || missingStable || unstable
          ? { athlete: undefined }
          : {}),
        ...(missingTrack ? { ball: undefined } : {}),
        ...(fault.inlierCount === undefined
          ? {}
          : {
              fiducialCorners: fixtureCorners(observation, fault.inlierCount),
            }),
        ...(fault.calibrationConfidence === undefined
          ? {}
          : calibrationConfidence(observation, fault.calibrationConfidence)),
        ...(fault.footConfidence === undefined
          ? {}
          : {
              feet: observation.feet.map((foot) =>
                Object.freeze({ ...foot, confidence: fault.footConfidence! }),
              ),
            }),
      });
    },
  });
}

function calibrationConfidence(
  observation: Awaited<ReturnType<VisionProvider["analyzeVerified"]>>,
  confidence: number,
) {
  return Object.freeze({
    athlete: observation.athlete
      ? Object.freeze({ ...observation.athlete, confidence })
      : undefined,
    fiducialCorners: observation.fiducialCorners.map((corner) =>
      Object.freeze({ ...corner, confidence }),
    ),
    wallFloorEdge: observation.wallFloorEdge
      ? Object.freeze({ ...observation.wallFloorEdge, confidence })
      : undefined,
  });
}

function fixtureCorners(
  observation: Awaited<ReturnType<VisionProvider["analyzeVerified"]>>,
  inlierCount: NonNullable<FixtureFault["inlierCount"]>,
) {
  const distributed = [0, 2, 4, 6, 1, 3, 5, 7];
  const retained = new Set(distributed.slice(0, inlierCount));
  return observation.fiducialCorners.map((corner, index) =>
    retained.has(index)
      ? corner
      : Object.freeze({
          ...corner,
          // A uniform displaced group is a non-degenerate RANSAC outlier
          // pattern. It leaves the retained distributed corner set as the
          // only source-consistent geometry candidate.
          x: corner.x + 100,
        }),
  );
}

function isEvenlyRemoved(index: number, count: number): boolean {
  if (index < 0 || index >= 600 || count === 0) return false;
  return (
    Math.floor(((index + 1) * count) / 600) !==
    Math.floor((index * count) / 600)
  );
}
