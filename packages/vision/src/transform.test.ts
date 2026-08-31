import { createHash } from "node:crypto";
import { decode, encode } from "jpeg-js";
import { describe, expect, it } from "vitest";
import {
  assertInferenceJpeg,
  createLetterboxTransform,
  encodeInferenceFrame,
  forwardSourcePoint,
  inverseInferencePoint,
  roundHalfUp,
} from "./transform.js";
import type { SourceFrame } from "./types.js";

function sourceFrame(width: number, height: number): SourceFrame {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      data[offset] = Math.round((255 * x) / Math.max(1, width - 1));
      data[offset + 1] = Math.round((255 * y) / Math.max(1, height - 1));
      data[offset + 2] = 32;
      data[offset + 3] = 255;
    }
  return {
    index: 0,
    timestampMs: 0,
    sourceWidth: width,
    sourceHeight: height,
    jpeg: new Uint8Array(encode({ width, height, data }, 95).data),
  };
}

describe("inference JPEG transform", () => {
  it("owns a decoder-verified 1280x720 letterbox and immutable matching transform", () => {
    const frame = sourceFrame(1440, 1080);
    const encoded = encodeInferenceFrame(frame);
    expect(encoded.transform).toEqual(createLetterboxTransform(frame));
    expect(Object.isFrozen(encoded.transform)).toBe(true);
    expect(encoded.sha256).toBe(
      createHash("sha256").update(encoded.jpeg).digest("hex"),
    );
    expect(() => assertInferenceJpeg(encoded.jpeg)).not.toThrow();
    const decoded = decode(encoded.jpeg, {
      useTArray: true,
      formatAsRGBA: true,
      tolerantDecoding: false,
    });
    expect([decoded.width, decoded.height]).toEqual([1280, 720]);
    expect(encoded.transform).toMatchObject({
      scale: 2 / 3,
      scaledWidth: 960,
      scaledHeight: 720,
      padLeft: 160,
      padTop: 0,
    });
  });

  it("uses the display-oriented portrait dimensions and round-half-up edges", () => {
    const frame = sourceFrame(721, 1280);
    const transform = createLetterboxTransform(frame);
    expect(transform).toMatchObject({
      scaledWidth: 406,
      scaledHeight: 720,
      padLeft: 437,
      padTop: 0,
    });
    expect(roundHalfUp(405.5625)).toBe(406);
    const encoded = encodeInferenceFrame(frame);
    expect(() => assertInferenceJpeg(encoded.jpeg)).not.toThrow();
    const sourcePoint = { x: 360.5, y: 640 };
    const inferred = forwardSourcePoint(sourcePoint, encoded.transform);
    expect(inverseInferencePoint(inferred, encoded.transform)).toEqual(
      sourcePoint,
    );
  });

  it("rejects a source JPEG whose decoded orientation does not match C5 display dimensions", () => {
    const portrait = sourceFrame(720, 1280);
    const mismatched = { ...portrait, sourceWidth: 1280, sourceHeight: 720 };
    expect(() => encodeInferenceFrame(mismatched)).toThrow(
      "does not match display dimensions",
    );
  });
});
