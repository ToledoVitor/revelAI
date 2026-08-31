import { describe, expect, it } from "vitest";
import { assembleFreeInsight } from "./free-insight.js";
import { VisionProviderError } from "./providers.js";

const attemptId = "11111111-1111-4111-8111-111111111111";
const now = "2030-01-15T12:00:00.000Z";

function frame(index: number, timestampMs: number, x: number, ball = true) {
  return {
    kind: "free-training" as const,
    frameIndex: index,
    timestampMs,
    sourceWidth: 1000,
    sourceHeight: 1000,
    athlete: { xMin: x, yMin: 100, xMax: x + 100, yMax: 400, confidence: 0.55 },
    ...(ball
      ? {
          ball: {
            xMin: 500,
            yMin: 500,
            xMax: 550,
            yMax: 550,
            confidence: 0.55,
          },
        }
      : {}),
  };
}

describe("assembleFreeInsight", () => {
  it("uses unrounded threshold equality, half-up values, and tip order", () => {
    const insight = assembleFreeInsight({
      batch: {
        attemptId,
        kind: "free-training",
        provenance: {
          kind: "demo",
          fixtureId: "free-well-framed-active-v1",
          providerVersion: "demo-observations-v1",
        },
        frames: [
          frame(0, 0, 0, false),
          frame(1, 1000, 22, false),
          frame(2, 2000, 44, true),
          frame(3, 3000, 66, true),
        ],
      },
      generatedAt: now,
    });
    expect(insight.observations).toEqual([
      {
        kind: "athlete-visibility",
        unit: "percent",
        value: 100,
        range: "consistent",
      },
      { kind: "ball-visibility", unit: "percent", value: 50, range: "partial" },
      { kind: "movement-activity", unit: "percent", value: 100, range: "high" },
    ]);
    expect(insight.tips).toEqual([
      "Boa cobertura para uma análise aproximada.",
    ]);
  });

  it("fails retryably for an accepted athlete pair with zero delta", () => {
    expect(() =>
      assembleFreeInsight({
        batch: {
          attemptId,
          kind: "free-training",
          provenance: {
            kind: "demo",
            fixtureId: "free-well-framed-active-v1",
            providerVersion: "demo-observations-v1",
          },
          frames: [frame(0, 0, 0), frame(1, 0, 20)],
        },
        generatedAt: now,
      }),
    ).toThrow(new VisionProviderError("provider_temporary_unavailable"));
  });

  it("counts an exactly 0.015 unrounded movement rate as active", () => {
    const exactRateFrames = [
      {
        ...frame(0, 0, 0),
        sourceWidth: 3,
        sourceHeight: 4,
      },
      {
        ...frame(1, 1000, 0.075),
        sourceWidth: 3,
        sourceHeight: 4,
      },
    ];
    const insight = assembleFreeInsight({
      batch: {
        attemptId,
        kind: "free-training",
        provenance: {
          kind: "demo",
          fixtureId: "free-well-framed-active-v1",
          providerVersion: "demo-observations-v1",
        },
        frames: exactRateFrames,
      },
      generatedAt: now,
    });
    expect(insight.observations[2]).toMatchObject({
      value: 100,
      range: "high",
    });
  });
});
