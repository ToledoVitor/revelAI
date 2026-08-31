import { describe, expect, it } from "vitest";
import { assembleFreeInsight } from "./free-insight.js";
import { VisionProviderError } from "./providers.js";
import type { FreeFrameObservation } from "./types.js";

const attemptId = "11111111-1111-4111-8111-111111111111";
const now = "2030-01-15T12:00:00.000Z";

type DemoFreeFrameObservation = Omit<FreeFrameObservation, "inference"> &
  Readonly<{ inference?: never }>;

function frame(
  index: number,
  timestampMs: number,
  x: number,
  ball = true,
): DemoFreeFrameObservation {
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

function insightFor(frames: readonly DemoFreeFrameObservation[]) {
  return assembleFreeInsight({
    batch: {
      attemptId,
      kind: "free-training",
      provenance: {
        kind: "demo",
        fixtureId: "free-well-framed-active-v1",
        providerVersion: "demo-observations-v1",
      },
      frames: [...frames],
    },
    generatedAt: now,
  });
}

function visibilityFrames(
  athletePresent: number,
  ballPresent: number,
  total = 100,
): DemoFreeFrameObservation[] {
  return Array.from({ length: total }, (_, index) => ({
    ...frame(index, index * 1000, 0),
    athlete:
      index < athletePresent
        ? frame(index, index * 1000, 0).athlete
        : undefined,
    ball: index < ballPresent ? frame(index, index * 1000, 0).ball : undefined,
  }));
}

function activityFrames(activePairs: number): DemoFreeFrameObservation[] {
  return Array.from({ length: 101 }, (_, index) => {
    const x = index <= activePairs ? (index % 2) * 22 : (activePairs % 2) * 22;
    return frame(index, index * 1000, x);
  });
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

  it("fails retryably for an accepted athlete pair with a negative finite delta", () => {
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
          frames: [frame(0, 1000, 0), frame(1, 0, 20)],
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

  it.each([
    { confidence: 0.549, expected: 0, label: "below" },
    { confidence: 0.55, expected: 100, label: "at" },
  ])(
    "uses the confidence boundary $label 0.55 without rounding",
    ({ confidence: confidenceValue, expected }) => {
      const frames = [0, 1].map((index) => {
        const source = frame(index, index * 1000, index * 22);
        return {
          ...source,
          athlete: source.athlete && {
            ...source.athlete,
            confidence: confidenceValue,
          },
          ball: source.ball && { ...source.ball, confidence: confidenceValue },
        };
      });
      expect(insightFor(frames).observations.slice(0, 2)).toEqual([
        expect.objectContaining({ value: expected }),
        expect.objectContaining({ value: expected }),
      ]);
    },
  );

  it.each([
    { present: 49, range: "limited" },
    { present: 50, range: "partial" },
    { present: 79, range: "partial" },
    { present: 80, range: "consistent" },
  ] as const)(
    "uses exact visibility boundary $present percent",
    ({ present, range }) => {
      expect(
        insightFor(visibilityFrames(present, present)).observations.slice(0, 2),
      ).toEqual([
        expect.objectContaining({ value: present, range }),
        expect.objectContaining({ value: present, range }),
      ]);
    },
  );

  it.each([
    {
      activePairs: 19,
      range: "low",
      tip: "Grave uma sequência com mais movimento contínuo.",
    },
    {
      activePairs: 20,
      range: "moderate",
      tip: "Boa cobertura para uma análise aproximada.",
    },
    {
      activePairs: 59,
      range: "moderate",
      tip: "Boa cobertura para uma análise aproximada.",
    },
    {
      activePairs: 60,
      range: "high",
      tip: "Boa cobertura para uma análise aproximada.",
    },
  ] as const)(
    "uses exact movement activity boundary $activePairs percent",
    ({ activePairs, range, tip }) => {
      const insight = insightFor(activityFrames(activePairs));
      expect(insight.observations[2]).toMatchObject({
        value: activePairs,
        range,
      });
      expect(insight.tips).toEqual([tip]);
    },
  );

  it("rounds a genuine one-of-forty visibility fraction half up", () => {
    const insight = insightFor(visibilityFrames(1, 1, 40));
    expect(insight.observations.slice(0, 2)).toEqual([
      expect.objectContaining({ value: 3, range: "limited" }),
      expect.objectContaining({ value: 3, range: "limited" }),
    ]);
  });

  it("rounds a genuine one-of-forty activity fraction half up", () => {
    const frames = Array.from({ length: 41 }, (_, index) =>
      frame(index, index * 1000, index === 0 ? 0 : 22),
    );
    expect(insightFor(frames).observations[2]).toMatchObject({
      value: 3,
      range: "low",
    });
  });

  it.each([
    {
      label: "both visibility limits",
      frames: visibilityFrames(49, 49),
      tips: [
        "Mantenha o corpo inteiro visível.",
        "Mantenha a bola visível durante a sequência.",
      ],
    },
    {
      label: "athlete visibility limit only",
      frames: visibilityFrames(49, 100),
      tips: ["Mantenha o corpo inteiro visível."],
    },
    {
      label: "ball visibility limit only",
      frames: visibilityFrames(100, 49),
      tips: ["Mantenha a bola visível durante a sequência."],
    },
    {
      label: "low movement after adequate coverage",
      frames: activityFrames(19),
      tips: ["Grave uma sequência com mais movimento contínuo."],
    },
    {
      label: "coverage fallback after adequate movement",
      frames: activityFrames(20),
      tips: ["Boa cobertura para uma análise aproximada."],
    },
  ])("uses exact tip branch and order for $label", ({ frames, tips }) => {
    expect(insightFor(frames).tips).toEqual(tips);
  });
});
