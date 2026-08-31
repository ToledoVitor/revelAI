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
  it.each([
    {
      label: "partial athlete and limited ball coverage",
      frames: [
        frame(0, 0, 0, false),
        { ...frame(1, 1000, 20, false), athlete: undefined },
      ],
      expected: [50, 0, 0],
      ranges: ["partial", "limited", "low"],
      tips: ["Mantenha a bola visível durante a sequência."],
    },
    {
      label: "half-up 80 percent consistent athlete coverage",
      frames: [
        frame(0, 0, 0),
        frame(1, 1000, 30),
        frame(2, 2000, 60),
        frame(3, 3000, 90),
        { ...frame(4, 4000, 120), athlete: undefined },
      ],
      expected: [80, 100, 100],
      ranges: ["consistent", "consistent", "high"],
      tips: ["Boa cobertura para uma análise aproximada."],
    },
    {
      label: "a 50 percent rounded activity rate remains moderate",
      frames: [frame(0, 0, 0), frame(1, 1000, 10), frame(2, 3000, 70)],
      expected: [100, 100, 50],
      ranges: ["consistent", "consistent", "moderate"],
      tips: ["Boa cobertura para uma análise aproximada."],
    },
    {
      label:
        "low activity selects the movement tip only after visibility passes",
      frames: [frame(0, 0, 0), frame(1, 1000, 10)],
      expected: [100, 100, 0],
      ranges: ["consistent", "consistent", "low"],
      tips: ["Grave uma sequência com mais movimento contínuo."],
    },
  ])(
    "uses exact Free ranges and tip fallback: $label",
    ({ frames, expected, ranges, tips }) => {
      const insight = assembleFreeInsight({
        batch: {
          attemptId,
          kind: "free-training",
          provenance: {
            kind: "demo",
            fixtureId: "free-well-framed-active-v1",
            providerVersion: "demo-observations-v1",
          },
          frames,
        },
        generatedAt: now,
      });
      expect(
        insight.observations.map((observation) => observation.value),
      ).toEqual(expected);
      expect(
        insight.observations.map((observation) => observation.range),
      ).toEqual(ranges);
      expect(insight.tips).toEqual(tips);
    },
  );

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

  it.each([Number.NaN, Number.POSITIVE_INFINITY])(
    "normalizes a non-finite timestamp Zod failure (%s) to the retryable provider error",
    (timestampMs) => {
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
            frames: [frame(0, 0, 0), frame(1, timestampMs, 20)],
          },
          generatedAt: now,
        }),
      ).toThrow(new VisionProviderError("provider_temporary_unavailable"));
    },
  );

  it("counts an exactly 0.015 unrounded movement rate as active", () => {
    const exactRateFrames = [
      {
        ...frame(0, 0, 0, true),
        sourceWidth: 3,
        sourceHeight: 4,
        athlete: {
          xMin: 0,
          yMin: 0,
          xMax: 0.1,
          yMax: 1,
          confidence: 0.55,
        },
        ball: { xMin: 1, yMin: 1, xMax: 1.1, yMax: 1.1, confidence: 0.55 },
      },
      {
        ...frame(1, 1000, 0.075, true),
        sourceWidth: 3,
        sourceHeight: 4,
        athlete: {
          xMin: 0.075,
          yMin: 0,
          xMax: 0.175,
          yMax: 1,
          confidence: 0.55,
        },
        ball: { xMin: 1, yMin: 1, xMax: 1.1, yMax: 1.1, confidence: 0.55 },
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
