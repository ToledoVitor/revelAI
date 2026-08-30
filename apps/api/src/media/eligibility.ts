import type { MediaProbe } from "./probe.js";

export type MediaMode = "free" | "verified";

export type EligibilityInput = Readonly<{
  mode: MediaMode;
  probe: MediaProbe;
  timestamps?: readonly number[];
  activeSceneChangeScores?: readonly number[];
}>;

export type MediaEligibility =
  | Readonly<{ kind: "eligible"; sampleCount: number }>
  | Readonly<{ kind: "ineligible" }>;

export function evaluateMediaEligibility(
  input: EligibilityInput,
): MediaEligibility {
  return input.mode === "verified"
    ? evaluateVerified(input)
    : evaluateFree(input.probe);
}

export function freeSampleTimestamps(
  durationSeconds: number,
): readonly number[] {
  const count = Math.min(180, Math.max(12, Math.ceil(durationSeconds * 2)));
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return [];
  return Object.freeze(
    Array.from(
      { length: count },
      (_, index) => (durationSeconds * index) / (count - 1),
    ),
  );
}

function evaluateVerified(input: EligibilityInput): MediaEligibility {
  const { probe } = input;
  const aspect = probe.displayWidth / probe.displayHeight;
  if (
    probe.durationSeconds < 64 ||
    probe.durationSeconds > 65 ||
    probe.displayWidth < 1280 ||
    probe.displayHeight < 720 ||
    probe.displayWidth <= probe.displayHeight ||
    aspect < 1.3 ||
    aspect > 2 ||
    probe.nominalFps < 24 ||
    !isVerifiedTimeline(input.timestamps) ||
    (input.activeSceneChangeScores ?? []).some(
      (score) => !Number.isFinite(score) || score >= 0.42,
    )
  )
    return Object.freeze({ kind: "ineligible" });
  return Object.freeze({ kind: "eligible", sampleCount: 640 });
}

function evaluateFree(probe: MediaProbe): MediaEligibility {
  if (
    probe.durationSeconds < 3 ||
    probe.durationSeconds > 180 ||
    Math.min(probe.displayWidth, probe.displayHeight) < 480 ||
    probe.nominalFps < 12
  )
    return Object.freeze({ kind: "ineligible" });
  return Object.freeze({
    kind: "eligible",
    sampleCount: freeSampleTimestamps(probe.durationSeconds).length,
  });
}

function isVerifiedTimeline(
  timestamps: readonly number[] | undefined,
): boolean {
  if (!timestamps || timestamps.length !== 640) return false;
  let previous = -Infinity;
  for (let index = 0; index < timestamps.length; index += 1) {
    const timestamp = timestamps[index];
    if (!Number.isFinite(timestamp) || timestamp <= previous) return false;
    if (
      index < 40
        ? timestamp < 0 || timestamp >= 4
        : timestamp < 4 || timestamp >= 64
    )
      return false;
    if (index > 0 && timestamp - previous > 0.25) return false;
    previous = timestamp;
  }
  return true;
}
