import { createHash } from "node:crypto";
import { decode, encode } from "jpeg-js";
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

/**
 * The only byte representation which may be sent to a Workflow.  The
 * transform is carried with the bytes instead of being recalculated later so
 * inverse mapping cannot accidentally use metadata for a different frame.
 */
export type EncodedInferenceFrame = Readonly<{
  jpeg: Uint8Array;
  sha256: string;
  transform: LetterboxTransform;
}>;

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

/**
 * C5 supplies JPEGs in display orientation (FFmpeg has already applied video
 * rotation). Decode that exact display image, then own the 1280x720 resize and
 * letterbox in one bounded operation. The encoded output is decoded again
 * before it can cross the provider boundary.
 */
export function encodeInferenceFrame(
  frame: SourceFrame,
  signal?: AbortSignal,
): EncodedInferenceFrame {
  throwIfAborted(signal);
  let decoded: DecodedJpeg;
  try {
    decoded = decode(frame.jpeg, {
      useTArray: true,
      formatAsRGBA: true,
      tolerantDecoding: false,
      maxResolutionInMP: 32,
      maxMemoryUsageInMB: 128,
    });
  } catch {
    throw new Error("source JPEG is not decodable");
  }
  if (
    decoded.width !== frame.sourceWidth ||
    decoded.height !== frame.sourceHeight ||
    decoded.data.byteLength !== decoded.width * decoded.height * 4
  )
    throw new Error("source JPEG does not match display dimensions");
  const transform = createLetterboxTransform(frame);
  const rgba = new Uint8Array(1280 * 720 * 4);
  // JPEG does not preserve alpha; opaque black is the explicit pad colour.
  for (let offset = 3; offset < rgba.length; offset += 4) rgba[offset] = 255;
  for (let targetY = 0; targetY < transform.scaledHeight; targetY += 1) {
    throwIfAborted(signal);
    const sourceY = Math.min(
      decoded.height - 1,
      Math.floor((targetY * decoded.height) / transform.scaledHeight),
    );
    for (let targetX = 0; targetX < transform.scaledWidth; targetX += 1) {
      const sourceX = Math.min(
        decoded.width - 1,
        Math.floor((targetX * decoded.width) / transform.scaledWidth),
      );
      const sourceOffset = (sourceY * decoded.width + sourceX) * 4;
      const targetOffset =
        ((targetY + transform.padTop) * 1280 + targetX + transform.padLeft) * 4;
      rgba[targetOffset] = decoded.data[sourceOffset]!;
      rgba[targetOffset + 1] = decoded.data[sourceOffset + 1]!;
      rgba[targetOffset + 2] = decoded.data[sourceOffset + 2]!;
    }
  }
  throwIfAborted(signal);
  let jpeg: Uint8Array;
  try {
    jpeg = new Uint8Array(
      encode({ data: rgba, width: 1280, height: 720 }, 90).data,
    );
  } catch {
    throw new Error("could not encode inference JPEG");
  }
  assertInferenceJpeg(jpeg);
  return Object.freeze({
    jpeg,
    sha256: createHash("sha256").update(jpeg).digest("hex"),
    transform,
  });
}

/** A bounded decoder verification for both the owned encoder and injected seam. */
export function assertInferenceJpeg(bytes: Uint8Array): void {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0)
    throw new Error("missing inference JPEG");
  let decoded: DecodedJpeg;
  try {
    decoded = decode(bytes, {
      useTArray: true,
      formatAsRGBA: true,
      tolerantDecoding: false,
      maxResolutionInMP: 2,
      maxMemoryUsageInMB: 64,
    });
  } catch {
    throw new Error("inference JPEG is not decodable");
  }
  if (decoded.width !== 1280 || decoded.height !== 720)
    throw new Error("inference JPEG must be 1280x720");
}

export function sameLetterboxTransform(
  left: LetterboxTransform,
  right: LetterboxTransform,
): boolean {
  return (
    left.sourceWidth === right.sourceWidth &&
    left.sourceHeight === right.sourceHeight &&
    left.inferenceWidth === right.inferenceWidth &&
    left.inferenceHeight === right.inferenceHeight &&
    left.scale === right.scale &&
    left.scaledWidth === right.scaledWidth &&
    left.scaledHeight === right.scaledHeight &&
    left.padLeft === right.padLeft &&
    left.padTop === right.padTop
  );
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error("inference transform aborted");
}

type DecodedJpeg = Readonly<{
  width: number;
  height: number;
  data: Uint8Array;
}>;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
