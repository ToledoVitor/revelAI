import {
  createDemoVisionProvider,
  createRoboflowVisionProvider,
  VisionBatchScheduler,
  type VisionProvider,
} from "@revelai/vision";
import { describe, expect, it } from "vitest";
import {
  attestVerifiedExtractionContinuity,
  createExtractionManifest,
} from "../media/extraction-manifest.js";
import { assembleVerifiedObservation } from "./observation-assembler.js";
import {
  evaluateVerifiedIntegrity,
  isC7AcceptedGeometry,
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

  it.each([
    ["attempt", { attemptId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }],
    ["generation", { generation: 2 }],
    [
      "session",
      { calibrationSessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
    ],
    ["nonce", { calibrationNonce: "d".repeat(43) }],
    ["media", { mediaId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }],
    ["media hash", { mediaSha256: "b".repeat(64) }],
    ["raw pre-roll hash", { rawPreRollSha256: "b".repeat(64) }],
  ] as const)(
    "gives the C5 binding failure precedence for a %s mismatch",
    async (_, expectedPatch) => {
      const input = await validInput();
      expect(
        evaluateVerifiedIntegrity({
          ...input,
          expected: { ...input.expected, ...expectedPatch },
        }),
      ).toMatchObject({ code: "video_not_continuous" });
    },
  );

  it("rejects a structural Roboflow-shaped provider before it can produce C7 evidence", async () => {
    const demo = createDemoVisionProvider();
    const structuralRoboflow: VisionProvider = Object.freeze({
      ...demo,
      verifiedProvenance: Object.freeze({
        kind: "roboflow" as const,
        workspaceId: "revelai-workspace",
        workflowId: "revelai-wall-pass-geometry-v1" as const,
        workflowVersion: "1.0.0" as const,
        modelBundleId: "wall-pass-bundle-v1",
        providerVersion: "roboflow-inference-v1",
      }),
    });

    await expect(validInput(structuralRoboflow)).rejects.toMatchObject({
      code: "provider_output_invalid",
    });
  });

  it("blocks a 640-frame fake scheduler before it can mint a ranked Roboflow candidate", async () => {
    let fetches = 0;
    const provider = createRoboflowVisionProvider({
      config: {
        apiUrl: "http://127.0.0.1:9001",
        workspaceId: "revelai-workspace",
        freeModelBundleId: "free-bundle-v1",
        verifiedModelBundleId: "wall-pass-bundle-v1",
        freeProviderVersion: "roboflow-inference-v1",
        verifiedProviderVersion: "roboflow-inference-v1",
      },
      fetch: async () => {
        fetches += 1;
        throw new Error("the fake scheduler must never reach factory fetch");
      },
    });
    const demo = createDemoVisionProvider();
    const fakeScheduler = {
      async run(
        requests: readonly Parameters<VisionProvider["analyzeVerified"]>[0][],
      ) {
        return Promise.all(
          requests.map(async (request) => ({
            ...(await demo.analyzeVerified(request)),
            inference: {
              sha256: "a".repeat(64),
              transform: {
                sourceWidth: request.frame.sourceWidth,
                sourceHeight: request.frame.sourceHeight,
                inferenceWidth: 1280,
                inferenceHeight: 720,
                scale: 1,
                scaledWidth: 1280,
                scaledHeight: 720,
                padLeft: 0,
                padTop: 0,
              },
            },
          })),
        );
      },
    } as unknown as VisionBatchScheduler;

    await expect(validInput(provider, fakeScheduler)).rejects.toMatchObject({
      code: "provider_output_invalid",
    });
    expect(fetches).toBe(0);
  });

  it("accepts C6 geometry with seven RANSAC inliers rather than requiring eight", async () => {
    const input = await validInput(fixtureProvider({ inlierCount: 7 }));

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

  it("rejects a gradual active H_t drift from actual C5 to C6 evidence", async () => {
    expect(
      evaluateVerifiedIntegrity(
        await validInput(fixtureProvider({ gradualFiducialXDrift: true })),
      ),
    ).toMatchObject({ code: "calibration_not_verified" });
  });

  it.each([
    [5.99, "integrity-valid"],
    [6, "integrity-valid"],
    [6.01, "calibration_not_verified"],
  ] as const)(
    "measures median drift %f through private C5 to C6 evidence",
    async (offset, expected) => {
      const input = await validInput(
        fixtureProvider({ activeFiducialXOffset: offset }),
      );
      const frame = input.evidence.active[0]!;
      expect(frame.anchorMedianDrift).toBeCloseTo(offset, 2);
      expect(frame.anchorMaximumDrift).toBeCloseTo(offset, 2);
      const decision = evaluateVerifiedIntegrity(input);
      expect(
        decision.kind === "integrity-valid" ? decision.kind : decision.code,
      ).toBe(expected);
    },
  );

  it.each([
    [
      "maximum drift below twelve",
      [11.63, 11.63, 11.63, 11.63, 0, 0, 0, 0],
      "integrity-valid",
    ],
    [
      "maximum drift at twelve",
      [11.64, 11.64, 11.64, 11.64, 0, 0, 0, 0],
      "integrity-valid",
    ],
    [
      "maximum drift above twelve",
      [11.65, 11.65, 11.65, 11.65, 0, 0, 0, 0],
      "calibration_not_verified",
    ],
  ] as const)(
    "measures %s through private C5 to C6 evidence",
    async (_, offsets, expected) => {
      const input = await validInput(
        fixtureProvider({ activeFiducialXOffsets: offsets }),
      );
      const frame = input.evidence.active[0]!;
      expect(frame.anchorMedianDrift).not.toBeNull();
      expect(frame.anchorMedianDrift!).toBeLessThanOrEqual(6);
      expect(frame.anchorMaximumDrift).not.toBeNull();
      expect(frame.anchorMaximumDrift!).toBeCloseTo(12, 1);
      const decision = evaluateVerifiedIntegrity(input);
      expect(
        decision.kind === "integrity-valid" ? decision.kind : decision.code,
      ).toBe(expected);
    },
  );

  it.each([
    [
      "median below four and maximum below eight",
      "x",
      [2, -2, 2, -2, 2, -2, 2, -2],
      true,
      "integrity-valid",
    ],
    [
      "median at four",
      "x",
      [4.01, -4.01, 4.01, -4.01, 4.01, -4.01, 4.01, -4.01],
      false,
      "calibration_not_verified",
    ],
    [
      "median above four",
      "x",
      [4.1, -4.1, 4.1, -4.1, 4.1, -4.1, 4.1, -4.1],
      false,
      "calibration_not_verified",
    ],
    [
      "maximum below eight",
      "x",
      [7, -7, 7, -7, 7, -7, 7, -7],
      true,
      "calibration_not_verified",
    ],
    [
      "maximum at eight",
      "y",
      [-6.03, -6.26, 1.6, -6.83, 6.76, 3.38, 1.92, -6.35],
      false,
      "calibration_not_verified",
    ],
  ] as const)(
    "measures C5 to C6 reprojection boundaries: %s",
    async (label, axis, offsets, accepted, expectedDecision) => {
      const input = await validInput(
        fixtureProvider(
          axis === "x"
            ? { activeFiducialXOffsets: offsets }
            : { activeFiducialYOffsets: offsets },
        ),
      );
      const geometry = input.evidence.active[0]!.geometry;
      expect(geometry.medianReprojectionError).not.toBeNull();
      expect(geometry.maxReprojectionError).not.toBeNull();
      expect(geometry.valid).toBe(accepted);
      const decision = evaluateVerifiedIntegrity(input);
      expect(
        decision.kind === "integrity-valid" ? decision.kind : decision.code,
      ).toBe(expectedDecision);
      if (accepted) {
        expect(geometry.medianReprojectionError!).toBeLessThanOrEqual(4);
        expect(geometry.maxReprojectionError!).toBeLessThanOrEqual(8);
      } else
        expect(
          geometry.medianReprojectionError! > 4 ||
            geometry.maxReprojectionError! > 8 ||
            geometry.wallEdgeError! > 8,
        ).toBe(true);
      if (label === "median at four")
        expect(geometry.medianReprojectionError!).toBeCloseTo(4, 1);
      if (label === "median above four")
        expect(geometry.medianReprojectionError!).toBeGreaterThan(4);
      if (label === "maximum at eight")
        expect(geometry.maxReprojectionError!).toBeCloseTo(8, 2);
    },
  );

  it.each([
    [7.99, true],
    [8, true],
    [8.01, false],
  ] as const)(
    "keeps the C7 maximum-reprojection guard at %f as a defense in depth",
    async (maxReprojectionError, accepted) => {
      const input = await validInput();
      const geometry = input.evidence.active[0]!.geometry;
      expect(isC7AcceptedGeometry(geometry)).toBe(true);
      expect(isC7AcceptedGeometry({ ...geometry, maxReprojectionError })).toBe(
        accepted,
      );
    },
  );

  it("rejects actual C5 to C6 evidence with no selectable calibration reference", async () => {
    expect(
      evaluateVerifiedIntegrity(
        await validInput(fixtureProvider({ missingPreRoll: 40 })),
      ),
    ).toMatchObject({ code: "calibration_not_verified" });
  });

  it.each([
    [7, "integrity-valid"],
    [8, "integrity-valid"],
    [9, "calibration_not_verified"],
  ] as const)(
    "enforces the C6 wall-edge error %i boundary from actual evidence",
    async (wallEdgeOffset, expected) => {
      const input = await validInput(fixtureProvider({ wallEdgeOffset }));
      expect(input.evidence.active[0]!.geometry.wallEdgeError).toBeCloseTo(
        wallEdgeOffset,
        1,
      );
      const decision = evaluateVerifiedIntegrity(input);
      expect(
        decision.kind === "integrity-valid" ? decision.kind : decision.code,
      ).toBe(expected);
    },
  );

  it.each([
    [6, "integrity-valid"],
    [7, "calibration_not_verified"],
  ] as const)(
    "enforces active H_t drift %i from actual evidence",
    async (activeFiducialXOffset, expected) => {
      const decision = evaluateVerifiedIntegrity(
        await validInput(fixtureProvider({ activeFiducialXOffset })),
      );
      expect(
        decision.kind === "integrity-valid" ? decision.kind : decision.code,
      ).toBe(expected);
    },
  );

  it.each([
    ["mirrored geometry", { mirroredGeometry: true }],
    ["wrong wall side", { wrongWallSide: true }],
    ["singular geometry", { singularGeometry: true }],
  ] as const)("rejects %s from actual C5 to C6 evidence", async (_, fault) => {
    expect(
      evaluateVerifiedIntegrity(await validInput(fixtureProvider(fault))),
    ).toMatchObject({ code: "calibration_not_verified" });
  });

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

  it("keeps the C5 to C6 to C7 joined graph duplicate, one-to-one, and permitted-reuse invariants", async () => {
    const input = await validInput();
    const decision = evaluateVerifiedIntegrity(input);
    expect(decision.kind).toBe("integrity-valid");
    if (decision.kind !== "integrity-valid") return;

    const canonical = [
      ...input.evidence.canonicalEvents.contacts.map(
        (event) => `contact:${event.timestampMs}:${event.trackId}`,
      ),
      ...input.evidence.canonicalEvents.wallImpacts.map(
        (event) => `wall-impact:${event.timestampMs}:${event.trackId}`,
      ),
    ].sort();
    const graph = input.evidence.eventGraph.map(
      (event) => `${event.kind}:${event.timestampMs}:${event.trackId}`,
    );
    expect(graph).toEqual(
      [...canonical].sort((left, right) => {
        const leftTimestamp = Number(left.split(":")[1]);
        const rightTimestamp = Number(right.split(":")[1]);
        return leftTimestamp - rightTimestamp || left.localeCompare(right);
      }),
    );
    expect(new Set(graph).size).toBe(graph.length);
    expect(
      input.evidence.eventGraph.every(
        (event) =>
          event.frameIndex === event.homographyFrameIndex &&
          event.frameIndex >= 40 &&
          event.frameIndex < 640,
      ),
    ).toBe(true);

    expect(input.evidence.passEvidence).toContainEqual(
      expect.objectContaining({
        kind: "complete",
        startedAtMs: 4000,
        completedAtMs: 4500,
      }),
    );
    expect(input.evidence.passEvidence).toContainEqual(
      expect.objectContaining({
        kind: "complete",
        startedAtMs: 4500,
        completedAtMs: 5000,
      }),
    );
    expect(
      input.evidence.eventGraph.filter(
        (event) => event.kind === "contact" && event.timestampMs === 4500,
      ),
    ).toHaveLength(1);
    expect(
      scoreVerifiedCandidate(decision.candidate).opportunities,
    ).toBeGreaterThan(1);
  });

  it.each([
    ["too-short impact window", "short-window", shortWindowTimeline],
    ["too-long impact window", "long-window", undefined],
    ["marker-loss cross-track return", "cross-track", undefined],
    ["active-end pending return", "active-end", undefined],
  ] as const)(
    "keeps the C5 to C6 to C7 joined graph window/end/cross-track matrix for %s",
    async (_, eventScenario, timestampSeconds) => {
      const input = await validInput(
        fixtureProvider({ eventScenario }),
        undefined,
        timestampSeconds ? { timestampSeconds } : {},
      );
      const decision = evaluateVerifiedIntegrity(input);
      expect(decision.kind).toBe("integrity-valid");
      if (decision.kind !== "integrity-valid") return;

      if (eventScenario !== "active-end") {
        expect(input.evidence.passEvidence).toContainEqual(
          expect.objectContaining({ kind: "missed", startedAtMs: 4000 }),
        );
        expect(input.evidence.passEvidence).not.toContainEqual(
          expect.objectContaining({ kind: "complete", startedAtMs: 4000 }),
        );
      }
      expect(
        scoreVerifiedCandidate(decision.candidate).missedPasses,
      ).toBeGreaterThan(0);
      if (eventScenario === "short-window")
        expect(input.evidence.eventGraph).toContainEqual(
          expect.objectContaining({ kind: "wall-impact", timestampMs: 4020 }),
        );
      if (eventScenario === "long-window")
        expect(input.evidence.eventGraph).toContainEqual(
          expect.objectContaining({ kind: "wall-impact", timestampMs: 6100 }),
        );
      if (eventScenario === "cross-track") {
        const firstContact = input.evidence.eventGraph.find(
          (event) => event.kind === "contact" && event.timestampMs === 4000,
        );
        const laterContacts = input.evidence.eventGraph.filter(
          (event) => event.kind === "contact" && event.timestampMs > 4000,
        );
        expect(firstContact?.trackId).toBe(0);
        expect(laterContacts.some((event) => event.trackId !== 0)).toBe(true);
      }
      if (eventScenario === "active-end")
        expect(input.evidence.passEvidence).toContainEqual(
          expect.objectContaining({
            kind: "missed",
            startedAtMs: 63_500,
            deadlineAtMs: 67_500,
          }),
        );
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

  it("redacts valid, invalid, and temporary serialized/log/error paths and makes equivalent evidence deterministic", async () => {
    const input = await validInput();
    const valid = evaluateVerifiedIntegrity(input);
    const invalid = evaluateVerifiedIntegrity({
      ...input,
      manifest: structuredClone(input.manifest),
    });
    const temporary = temporaryIntegrityDecision();

    for (const decision of [valid, invalid, temporary]) {
      const serialized = JSON.stringify(serializeIntegrityDecision(decision));
      const logPayload = JSON.stringify({
        event: "verified-integrity-decision",
        decision: serializeIntegrityDecision(decision),
      });
      expect(serialized).not.toMatch(
        /sha|nonce|frame|confidence|drift|media|session/i,
      );
      expect(logPayload).not.toMatch(
        /sha|nonce|frame|confidence|drift|media|session/i,
      );
    }

    expect(() =>
      scoreVerifiedCandidate({ kind: "verified-attempt-candidate" }),
    ).toThrowError("invalid verified candidate");
    try {
      scoreVerifiedCandidate({ kind: "verified-attempt-candidate" });
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).not.toMatch(
        /sha|nonce|frame|confidence|drift|media|session/i,
      );
    }

    const replay = evaluateVerifiedIntegrity(input);
    const first = evaluateVerifiedIntegrity(input);
    expect(serializeIntegrityDecision(replay)).toEqual(
      serializeIntegrityDecision(first),
    );
    if (replay.kind !== "integrity-valid" || first.kind !== "integrity-valid")
      throw new Error("fixture must produce two valid candidates");
    expect(scoreVerifiedCandidate(replay.candidate)).toEqual(
      scoreVerifiedCandidate(first.candidate),
    );
  });
});

async function validInput(
  provider: VisionProvider = createDemoVisionProvider(),
  scheduler?: VisionBatchScheduler,
  options: Readonly<{ timestampSeconds?: (index: number) => number }> = {},
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
      timestampSeconds: options.timestampSeconds?.(index) ?? index / 10,
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
    scheduler,
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
  wallEdgeOffset?: number;
  activeFiducialXOffset?: number;
  gradualFiducialXDrift?: boolean;
  activeFiducialXOffsets?: readonly number[];
  activeFiducialYOffsets?: readonly number[];
  eventScenario?: "short-window" | "long-window" | "cross-track" | "active-end";
  mirroredGeometry?: boolean;
  wrongWallSide?: boolean;
  singularGeometry?: boolean;
}>;

function fixtureProvider(fault: FixtureFault): VisionProvider {
  return createDemoVisionProvider({
    free: "free-well-framed-active-v1",
    verified: "wall-pass-balanced-v1",
    verifiedFixtureTransform(observation, request) {
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
      const activeFiducialXOffset =
        activeIndex < 0
          ? 0
          : (fault.activeFiducialXOffset ?? 0) +
            (fault.gradualFiducialXDrift ? activeIndex / 85 : 0);
      const shiftedCorners = observation.fiducialCorners.map((corner, index) =>
        Object.freeze({
          ...corner,
          x:
            corner.x +
            (activeIndex >= 0
              ? (fault.activeFiducialXOffsets?.[index] ?? 0)
              : 0),
          y:
            corner.y +
            (activeIndex >= 0
              ? (fault.activeFiducialYOffsets?.[index] ?? 0)
              : 0),
        }),
      );
      const fiducialCorners = fault.singularGeometry
        ? observation.fiducialCorners.map((corner) =>
            Object.freeze({ ...corner, x: 400, y: 400 }),
          )
        : fault.mirroredGeometry
          ? observation.fiducialCorners.map((corner) =>
              Object.freeze({ ...corner, y: 720 - corner.y }),
            )
          : shiftedCorners.map((corner) =>
              Object.freeze({ ...corner, x: corner.x + activeFiducialXOffset }),
            );
      const wallFloorEdge = observation.wallFloorEdge
        ? fault.mirroredGeometry
          ? Object.freeze({
              ...observation.wallFloorEdge,
              y1: 720,
              y2: 720,
            })
          : fault.wrongWallSide
            ? Object.freeze({
                ...observation.wallFloorEdge,
                y1: 719,
                y2: 719,
              })
            : Object.freeze({
                ...observation.wallFloorEdge,
                x1: observation.wallFloorEdge.x1 + activeFiducialXOffset,
                x2: observation.wallFloorEdge.x2 + activeFiducialXOffset,
                y1: observation.wallFloorEdge.y1 + (fault.wallEdgeOffset ?? 0),
                y2: observation.wallFloorEdge.y2 + (fault.wallEdgeOffset ?? 0),
              })
        : undefined;
      const event = eventScenario(
        observation,
        activeIndex,
        fault.eventScenario,
      );
      return Object.freeze({
        ...observation,
        ...(missingPreRoll || missingStable || unstable
          ? { athlete: undefined }
          : {}),
        ...(missingTrack ? { ball: undefined } : {}),
        ...event,
        ...(fault.inlierCount === undefined
          ? {}
          : {
              fiducialCorners: fixtureCorners(
                Object.freeze({ ...observation, fiducialCorners }),
                fault.inlierCount,
              ),
            }),
        ...(fault.inlierCount === undefined ? { fiducialCorners } : {}),
        ...(wallFloorEdge ? { wallFloorEdge } : {}),
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

function eventScenario(
  observation: Awaited<ReturnType<VisionProvider["analyzeVerified"]>>,
  activeIndex: number,
  scenario: FixtureFault["eventScenario"],
) {
  if (activeIndex < 0 || !scenario) return {};
  if (scenario === "cross-track" && activeIndex >= 3 && activeIndex <= 5)
    return Object.freeze({ ball: undefined, feet: Object.freeze([]) });
  if (scenario === "short-window" && activeIndex >= 2 && activeIndex <= 4)
    return Object.freeze({
      ball: withBallY(observation, activeIndex === 2 ? 10 : 40),
      feet: Object.freeze([]),
    });
  if (scenario === "long-window" && activeIndex >= 2 && activeIndex <= 24)
    return Object.freeze({
      ball: withBallY(observation, activeIndex === 21 ? 10 : 40),
      feet: Object.freeze([]),
    });
  if (scenario === "active-end" && activeIndex === 597)
    return Object.freeze({
      ball: withBallY(observation, 100),
      feet: Object.freeze([]),
    });
  return {};
}

function withBallY(
  observation: Awaited<ReturnType<VisionProvider["analyzeVerified"]>>,
  yMax: number,
) {
  const ball = observation.ball ?? {
    xMin: 500,
    yMin: Math.max(0, yMax - 15),
    xMax: 530,
    yMax,
    confidence: 0.88,
  };
  return Object.freeze({
    ...ball,
    yMin: Math.max(0, yMax - 15),
    yMax,
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

function shortWindowTimeline(index: number): number {
  if (index < 40) return index / 10;
  if (index === 40) return 4;
  if (index === 41) return 4.01;
  if (index === 42) return 4.02;
  return 4.27 + (index - 43) / 10;
}
