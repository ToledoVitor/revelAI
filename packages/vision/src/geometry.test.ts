import { describe, expect, it } from "vitest";
import {
  estimateFrameGeometry,
  project,
  selectReferenceGeometry,
  WORLD_CORNERS,
} from "./geometry.js";
import { assembleVerifiedEvidence } from "./verified-evidence.js";
import type { WallPassFrameObservation } from "./types.js";

const ids = Object.keys(WORLD_CORNERS) as Array<keyof typeof WORLD_CORNERS>;
const binding = {
  attemptId: "11111111-1111-4111-8111-111111111111",
  generation: 1,
  mediaId: "22222222-2222-4222-8222-222222222222",
  mediaSha256: "a".repeat(64),
  rawPreRollSha256: "b".repeat(64),
  calibrationSessionId: "33333333-3333-4333-8333-333333333333",
  calibrationNonce: "c".repeat(43),
};

function frame(index: number, offsetX = 0): WallPassFrameObservation {
  return {
    kind: "verified-wall-pass",
    frameIndex: index,
    timestampMs: index * 100,
    sourceWidth: 1280,
    sourceHeight: 720,
    athlete: { xMin: 400, yMin: 100, xMax: 800, yMax: 650, confidence: 0.9 },
    ball: { xMin: 500, yMin: 500, xMax: 530, yMax: 530, confidence: 0.9 },
    feet: [
      { side: "left", x: 500, y: 530, confidence: 0.9 },
      { side: "right", x: 550, y: 530, confidence: 0.9 },
    ],
    fiducialCorners: ids.map((id) => ({
      id,
      x: (WORLD_CORNERS[id].x + 3) * 100 + offsetX,
      y: WORLD_CORNERS[id].y * 100,
      confidence: 0.9,
    })),
    wallFloorEdge: {
      x1: offsetX,
      y1: 0,
      x2: 800 + offsetX,
      y2: 0,
      confidence: 0.9,
    },
  };
}

describe("verified geometry", () => {
  it("projects source points through current homography and picks a lowest-index medoid tie", () => {
    const first = estimateFrameGeometry(frame(4));
    const second = estimateFrameGeometry(frame(5));
    expect(first.valid).toBe(true);
    const projected = project(first.homography!, { x: 500, y: 300 });
    expect(projected.x).toBeCloseTo(2, 8);
    expect(projected.y).toBeCloseTo(3, 8);
    const selected = selectReferenceGeometry([second, first]);
    expect(selected?.reference.frameIndex).toBe(4);
  });

  it("uses deterministic RANSAC inliers and reports reprojection error in source pixels", () => {
    const observation = frame(6);
    observation.fiducialCorners[0] = {
      ...observation.fiducialCorners[0]!,
      x: observation.fiducialCorners[0]!.x + 100,
    };
    const geometry = estimateFrameGeometry(observation);
    expect(geometry.valid).toBe(true);
    expect(geometry.inlierCount).toBe(7);
    expect(geometry.maxReprojectionError).toBeLessThan(0.01);
    expect(project(geometry.homography!, { x: 500, y: 300 })).toMatchObject({
      x: expect.closeTo(2, 5),
      y: expect.closeTo(3, 5),
    });
  });

  it("accepts four distributed non-collinear inliers but emits the orientation facts", () => {
    const observation = frame(7);
    observation.fiducialCorners = observation.fiducialCorners.filter((corner) =>
      ["a-top-left", "a-bottom-right", "b-top-left", "b-bottom-right"].includes(
        corner.id,
      ),
    );
    const geometry = estimateFrameGeometry(observation);
    expect(geometry).toMatchObject({
      valid: true,
      inlierCount: 4,
      orientationValid: true,
      wallSideValid: true,
    });
  });

  it("rejects a mirrored projected board and a board on the wrong wall side", () => {
    const mirrored = frame(8);
    mirrored.fiducialCorners = mirrored.fiducialCorners.map((corner) => ({
      ...corner,
      y: 720 - corner.y,
    }));
    mirrored.wallFloorEdge = { ...mirrored.wallFloorEdge!, y1: 720, y2: 720 };
    expect(estimateFrameGeometry(mirrored)).toMatchObject({
      valid: false,
      orientationValid: false,
      wallSideValid: false,
    });

    const wrongSide = frame(9);
    wrongSide.wallFloorEdge = {
      ...wrongSide.wallFloorEdge!,
      y1: 719,
      y2: 719,
    };
    expect(estimateFrameGeometry(wrongSide)).toMatchObject({
      valid: false,
      orientationValid: true,
      wallSideValid: false,
    });
  });

  it("uses each active H_t for mapping and excludes camera-bumped frames", () => {
    const preRoll = Array.from({ length: 40 }, (_, index) => frame(index));
    const active = Array.from({ length: 600 }, (_, offset) =>
      offset === 0 ? frame(40, 20) : noTrackFrame(40 + offset),
    );
    const evidence = assembleVerifiedEvidence({
      batch: {
        attemptId: "11111111-1111-4111-8111-111111111111",
        kind: "verified-wall-pass",
        provenance: {
          kind: "demo",
          fixtureId: "wall-pass-balanced-v1",
          providerVersion: "demo-observations-v1",
        },
        frames: [...preRoll, ...active],
      },
      binding,
    });
    expect(evidence.selectedReferenceFrameIndex).toBe(0);
    expect(evidence.active[0]).toMatchObject({
      stable: false,
      mappedBall: null,
    });
    expect(evidence.longestUnstableRun).toBe(1);
  });

  it("derives continuous two-frame contacts, a wall reversal, and one complete pass", () => {
    const preRoll = Array.from({ length: 40 }, (_, index) => frame(index));
    const active = [
      frame(40),
      frame(41),
      ballFrame(42, 100),
      ballFrame(43, 10),
      ballFrame(44, 40),
      frame(45),
      frame(46),
      ...Array.from({ length: 593 }, (_, index) => noTrackFrame(47 + index)),
    ];
    const evidence = assembleVerifiedEvidence({
      batch: {
        attemptId: "11111111-1111-4111-8111-111111111111",
        kind: "verified-wall-pass",
        provenance: {
          kind: "demo",
          fixtureId: "wall-pass-balanced-v1",
          providerVersion: "demo-observations-v1",
        },
        frames: [...preRoll, ...active],
      },
      binding,
    });
    expect(evidence.contacts).toHaveLength(2);
    expect(evidence.wallImpacts).toHaveLength(1);
    expect(evidence.passEvidence).toEqual([
      expect.objectContaining({
        kind: "complete",
        side: "left",
        startedAtMs: 4000,
        wallImpactAtMs: 4300,
        completedAtMs: 4500,
      }),
    ]);
  });

  it("rejects a batch unless it is the exact ordered 40+600 verified timeline", () => {
    const frames = Array.from({ length: 640 }, (_, index) => frame(index));
    frames[41] = { ...frames[41]!, timestampMs: 4000 };
    expect(() =>
      assembleVerifiedEvidence({
        batch: {
          attemptId: binding.attemptId,
          kind: "verified-wall-pass",
          provenance: {
            kind: "demo",
            fixtureId: "wall-pass-balanced-v1",
            providerVersion: "demo-observations-v1",
          },
          frames,
        },
        binding,
      }),
    ).toThrow("invalid verified 40+600 timeline");
  });

  it("never completes a pass across a marker-loss ball-track gap", () => {
    const preRoll = Array.from({ length: 40 }, (_, index) => frame(index));
    const active = [
      frame(40),
      frame(41),
      ballFrame(42, 100),
      ballFrame(43, 10),
      ballFrame(44, 40),
      noTrackFrame(45),
      noTrackFrame(46),
      noTrackFrame(47),
      noTrackFrame(48),
      frame(49),
      frame(50),
      ...Array.from({ length: 589 }, (_, index) => noTrackFrame(51 + index)),
    ];
    const evidence = assembleVerifiedEvidence({
      batch: {
        attemptId: binding.attemptId,
        kind: "verified-wall-pass",
        provenance: {
          kind: "demo",
          fixtureId: "wall-pass-balanced-v1",
          providerVersion: "demo-observations-v1",
        },
        frames: [...preRoll, ...active],
      },
      binding,
    });
    expect(evidence.passEvidence).not.toContainEqual(
      expect.objectContaining({ kind: "complete" }),
    );
    expect(evidence.passEvidence).toContainEqual(
      expect.objectContaining({ kind: "missed", startedAtMs: 4000 }),
    );
  });
});

function ballFrame(index: number, ballY: number): WallPassFrameObservation {
  const observation = frame(index);
  return {
    ...observation,
    ball: {
      xMin: 500,
      yMin: Math.max(0, ballY - 15),
      xMax: 530,
      yMax: ballY,
      confidence: 0.9,
    },
    feet: [],
  };
}

function noTrackFrame(index: number): WallPassFrameObservation {
  const observation = frame(index);
  return { ...observation, ball: undefined, feet: [] };
}
