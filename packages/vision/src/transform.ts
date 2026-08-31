import type { SourceFrame } from "./types.js";

export type LetterboxTransform = Readonly<{
  sourceWidth: number;
  sourceHeight: number;
  inferenceWidth: 1280;
  inferenceHeight: 720;
  scale: number;
  scaledWidth: number;
  scaledHeight: number;
  padLeft: number;
  padTop: number;
}>;

export type Point = Readonly<{ x: number; y: number }>;

export function roundHalfUp(value: number): number {
  if (!Number.isFinite(value)) throw new Error("non-finite transform value");
  return Math.floor(value + 0.5);
}

export function createLetterboxTransform(
  frame: Pick<SourceFrame, "sourceWidth" | "sourceHeight">,
): LetterboxTransform {
  const scale = Math.min(1280 / frame.sourceWidth, 720 / frame.sourceHeight);
  const scaledWidth = roundHalfUp(frame.sourceWidth * scale);
  const scaledHeight = roundHalfUp(frame.sourceHeight * scale);
  return Object.freeze({
    sourceWidth: frame.sourceWidth,
    sourceHeight: frame.sourceHeight,
    inferenceWidth: 1280,
    inferenceHeight: 720,
    scale,
    scaledWidth,
    scaledHeight,
    padLeft: Math.floor((1280 - scaledWidth) / 2),
    padTop: Math.floor((720 - scaledHeight) / 2),
  });
}

export function inverseInferencePoint(
  point: Point,
  transform: LetterboxTransform,
): Point {
  const minX = transform.padLeft;
  const maxX = transform.padLeft + transform.scaledWidth;
  const minY = transform.padTop;
  const maxY = transform.padTop + transform.scaledHeight;
  if (
    point.x < minX - 1 ||
    point.x > maxX + 1 ||
    point.y < minY - 1 ||
    point.y > maxY + 1
  )
    throw new Error("inference point outside letterbox content");
  return Object.freeze({
    x: clamp(
      (point.x - transform.padLeft) / transform.scale,
      0,
      transform.sourceWidth,
    ),
    y: clamp(
      (point.y - transform.padTop) / transform.scale,
      0,
      transform.sourceHeight,
    ),
  });
}

export function forwardSourcePoint(
  point: Point,
  transform: LetterboxTransform,
): Point {
  return Object.freeze({
    x: point.x * transform.scale + transform.padLeft,
    y: point.y * transform.scale + transform.padTop,
  });
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
