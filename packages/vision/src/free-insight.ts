import { FreeInsightSchema, type FreeInsight } from "@revelai/contracts";
import { VisionProviderError } from "./providers.js";
import {
  FreeVisionObservationBatchSchema,
  type FreeVisionObservationBatch,
} from "./types.js";

const ATHLETE_CONFIDENCE = 0.55;
const BALL_CONFIDENCE = 0.55;
const MOVEMENT_RATE_THRESHOLD = 0.015;

export function assembleFreeInsight(
  input: Readonly<{
    batch: FreeVisionObservationBatch;
    generatedAt: string;
  }>,
): FreeInsight {
  const batch = parseFreeObservationBatch(input.batch);
  const sampledFrames = batch.frames.length;
  if (sampledFrames === 0)
    throw new VisionProviderError("provider_output_invalid");
  const athleteFrames = batch.frames.filter(
    (frame) => frame.athlete && frame.athlete.confidence >= ATHLETE_CONFIDENCE,
  );
  const ballFrames = batch.frames.filter(
    (frame) => frame.ball && frame.ball.confidence >= BALL_CONFIDENCE,
  );
  const athleteVisibility = percent(athleteFrames.length, sampledFrames);
  const ballVisibility = percent(ballFrames.length, sampledFrames);
  const activePairs = movementPairs(athleteFrames);
  const activeCount = activePairs.filter(
    (pair) => pair.rate >= MOVEMENT_RATE_THRESHOLD,
  ).length;
  const movement =
    activePairs.length === 0 ? 0 : percent(activeCount, activePairs.length);
  const athleteRange = visibilityRange(athleteVisibility);
  const ballRange = visibilityRange(ballVisibility);
  const movementRange =
    movement < 20 ? "low" : movement < 60 ? "moderate" : "high";
  const tips =
    athleteRange === "limited"
      ? ballRange === "limited"
        ? [
            "Mantenha o corpo inteiro visível.",
            "Mantenha a bola visível durante a sequência.",
          ]
        : ["Mantenha o corpo inteiro visível."]
      : ballRange === "limited"
        ? ["Mantenha a bola visível durante a sequência."]
        : movementRange === "low"
          ? ["Grave uma sequência com mais movimento contínuo."]
          : ["Boa cobertura para uma análise aproximada."];
  return FreeInsightSchema.parse({
    kind: "free-insight",
    attemptId: batch.attemptId,
    provenance: batch.provenance,
    approximate: true,
    observations: [
      {
        kind: "athlete-visibility",
        unit: "percent",
        value: athleteVisibility,
        range: athleteRange,
      },
      {
        kind: "ball-visibility",
        unit: "percent",
        value: ballVisibility,
        range: ballRange,
      },
      {
        kind: "movement-activity",
        unit: "percent",
        value: movement,
        range: movementRange,
      },
    ],
    tips,
    generatedAt: input.generatedAt,
  });
}

function parseFreeObservationBatch(
  input: FreeVisionObservationBatch,
): FreeVisionObservationBatch {
  if (containsNonFiniteTimestamp(input))
    throw new VisionProviderError("provider_temporary_unavailable");
  const parsed = FreeVisionObservationBatchSchema.safeParse(input);
  if (parsed.success) return parsed.data;
  if (
    parsed.error.issues.some(
      (issue) => issue.path[issue.path.length - 1] === "timestampMs",
    )
  )
    throw new VisionProviderError("provider_temporary_unavailable");
  throw new VisionProviderError("provider_output_invalid");
}

function containsNonFiniteTimestamp(input: unknown): boolean {
  if (!input || typeof input !== "object") return false;
  const frames = (input as Readonly<{ frames?: unknown }>).frames;
  if (!Array.isArray(frames)) return false;
  return frames.some(
    (frame) =>
      Boolean(frame) &&
      typeof frame === "object" &&
      typeof (frame as Readonly<{ timestampMs?: unknown }>).timestampMs ===
        "number" &&
      !Number.isFinite(
        (frame as Readonly<{ timestampMs: number }>).timestampMs,
      ),
  );
}

function movementPairs(
  frames: readonly FreeVisionObservationBatch["frames"][number][],
): readonly Readonly<{ rate: number }>[] {
  const pairs: Array<Readonly<{ rate: number }>> = [];
  for (let index = 1; index < frames.length; index += 1) {
    const previous = frames[index - 1]!;
    const current = frames[index]!;
    if (!previous.athlete || !current.athlete) continue;
    const deltaSeconds = (current.timestampMs - previous.timestampMs) / 1000;
    if (!Number.isFinite(deltaSeconds) || deltaSeconds <= 0)
      throw new VisionProviderError("provider_temporary_unavailable");
    const dx = centre(current.athlete, "x") - centre(previous.athlete, "x");
    const dy = centre(current.athlete, "y") - centre(previous.athlete, "y");
    const diagonal = Math.hypot(current.sourceWidth, current.sourceHeight);
    if (!Number.isFinite(diagonal) || diagonal <= 0)
      throw new VisionProviderError("provider_output_invalid");
    pairs.push(
      Object.freeze({ rate: Math.hypot(dx, dy) / diagonal / deltaSeconds }),
    );
  }
  return Object.freeze(pairs);
}

function centre(
  box: Readonly<{ xMin: number; yMin: number; xMax: number; yMax: number }>,
  axis: "x" | "y",
): number {
  return axis === "x" ? (box.xMin + box.xMax) / 2 : (box.yMin + box.yMax) / 2;
}

function percent(numerator: number, denominator: number): number {
  return Math.floor((100 * numerator) / denominator + 0.5);
}

function visibilityRange(value: number): "limited" | "partial" | "consistent" {
  return value < 50 ? "limited" : value < 80 ? "partial" : "consistent";
}
