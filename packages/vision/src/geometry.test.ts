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
      x1: -200 + offsetX,
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

  it("uses each active H_t for mapping and excludes camera-bumped frames", () => {
    const preRoll = Array.from({ length: 40 }, (_, index) => frame(index));
    const active = frame(40, 20);
    const evidence = assembleVerifiedEvidence({
      batch: {
        attemptId: "11111111-1111-4111-8111-111111111111",
        kind: "verified-wall-pass",
        provenance: {
          kind: "demo",
          fixtureId: "wall-pass-balanced-v1",
          providerVersion: "demo-observations-v1",
        },
        frames: [...preRoll, active],
      },
      binding: {
        attemptId: "11111111-1111-4111-8111-111111111111",
        generation: 1,
        mediaId: "22222222-2222-4222-8222-222222222222",
        mediaSha256: "a".repeat(64),
        rawPreRollSha256: "b".repeat(64),
      },
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
      binding: {
        attemptId: "11111111-1111-4111-8111-111111111111",
        generation: 1,
        mediaId: "22222222-2222-4222-8222-222222222222",
        mediaSha256: "a".repeat(64),
        rawPreRollSha256: "b".repeat(64),
      },
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
});

function ballFrame(index: number, ballY: number): WallPassFrameObservation {
  const observation = frame(index);
  return {
    ...observation,
    ball: {
      xMin: 500,
      yMin: ballY - 15,
      xMax: 530,
      yMax: ballY,
      confidence: 0.9,
    },
    feet: [],
  };
}
