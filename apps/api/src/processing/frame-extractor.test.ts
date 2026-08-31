import { describe, expect, it } from "vitest";
import {
  attestVerifiedExtractionContinuity,
  createExtractionManifest,
} from "../media/extraction-manifest.js";
import { extractionManifestToVisionRequests } from "./frame-extractor.js";

const probe = {
  container: "mp4" as const,
  durationSeconds: 3,
  displayWidth: 480,
  displayHeight: 853,
  nominalFps: 12,
  codec: "h264",
  sourceRotationDegrees: 90 as const,
};

describe("extractionManifestToVisionRequests", () => {
  it("reads C5 frame bytes through opaque references without exposing storage layout", async () => {
    const manifest = createExtractionManifest({
      attemptId: "11111111-1111-4111-8111-111111111111",
      generation: 1,
      mediaId: "22222222-2222-4222-8222-222222222222",
      mediaSha256: "a".repeat(64),
      mode: "free",
      probe,
      frames: Array.from({ length: 12 }, (_, index) => ({
        timestampSeconds: (index * 3) / 11,
        reference: `33333333-3333-4333-8333-333333333333_${String(index).padStart(4, "0")}`,
        rawBytes: Uint8Array.of(1),
      })),
    });
    const requests = await extractionManifestToVisionRequests({
      manifest,
      frames: { readFrame: async () => Uint8Array.of(0xff, 0xd8, 0xff, 0xd9) },
    });
    expect(requests[0]).toMatchObject({
      kind: "free-training",
      frame: {
        sourceWidth: 480,
        sourceHeight: 853,
        jpeg: Uint8Array.of(0xff, 0xd8, 0xff, 0xd9),
      },
    });
    expect(JSON.stringify(requests)).not.toContain("frames/");
  });

  it("rejects a frame reader whose bytes do not match C5's verified extraction", async () => {
    const manifest = createExtractionManifest({
      attemptId: "11111111-1111-4111-8111-111111111111",
      generation: 1,
      mediaId: "22222222-2222-4222-8222-222222222222",
      mediaSha256: "a".repeat(64),
      mode: "verified",
      probe: {
        container: "mp4",
        durationSeconds: 64,
        displayWidth: 1280,
        displayHeight: 720,
        nominalFps: 30,
        codec: "h264",
        sourceRotationDegrees: 0,
      },
      frames: Array.from({ length: 640 }, (_, index) => ({
        timestampSeconds: index / 10,
        reference: `frame_${index}`,
        rawBytes: Uint8Array.of(index % 256),
      })),
    });
    if (manifest.mode !== "verified")
      throw new Error("fixture must be verified");

    await expect(
      extractionManifestToVisionRequests({
        manifest,
        frames: { readFrame: async () => Uint8Array.of(0xff) },
      }),
    ).rejects.toThrow("verified continuity evidence required");

    attestVerifiedExtractionContinuity(
      manifest,
      manifest.frames.items.slice(40).map((frame) => ({
        timestampSeconds: frame.timestampSeconds,
        score: 0.1,
      })),
    );

    await expect(
      extractionManifestToVisionRequests({
        manifest,
        frames: { readFrame: async () => Uint8Array.of(0xff) },
      }),
    ).rejects.toThrow("verified extraction frame mismatch");
  });
});
