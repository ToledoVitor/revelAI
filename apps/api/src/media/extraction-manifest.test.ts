import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createExtractionManifest,
  parseExtractionManifest,
} from "./extraction-manifest.js";

const IDs = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
];
const probe = {
  container: "mp4" as const,
  durationSeconds: 64,
  displayWidth: 1280,
  displayHeight: 720,
  nominalFps: 30,
  codec: "h264",
  sourceRotationDegrees: 0 as const,
};

describe("extraction manifest", () => {
  it("binds verified attempt, generation, media digest, raw pre-roll bytes, and 40/600 partitions", () => {
    const frames = verifiedFrames();
    const manifest = createExtractionManifest({
      attemptId: IDs[0],
      generation: 1,
      mediaId: IDs[1],
      mediaSha256: "a".repeat(64),
      mode: "verified",
      probe,
      frames,
    });

    expect(manifest).toMatchObject({
      kind: "extraction-manifest",
      extractionVersion: "c5-frame-manifest-v1",
      attemptId: IDs[0],
      generation: 1,
      mediaId: IDs[1],
      preRoll: { count: 40 },
      active: { count: 600 },
      rawPreRollSha256: createHash("sha256")
        .update(
          Buffer.concat(
            frames.slice(0, 40).map((frame) => Buffer.from(frame.rawBytes)),
          ),
        )
        .digest("hex"),
    });
    expect(JSON.stringify(manifest)).not.toContain("/");
    expect(
      parseExtractionManifest(JSON.parse(JSON.stringify(manifest))),
    ).toEqual(manifest);
  });

  it("rejects missing, reordered, unopaque, or path-bearing verified frames", () => {
    const base = verifiedFrames();
    for (const frames of [
      base.slice(0, 639),
      [
        ...base.slice(0, 1),
        { ...base[1], timestampSeconds: 0 },
        ...base.slice(2),
      ],
      [
        ...base.slice(0, 1),
        { ...base[1], reference: "/private/frame.jpg" },
        ...base.slice(2),
      ],
    ]) {
      expect(() =>
        createExtractionManifest({
          attemptId: IDs[0],
          generation: 1,
          mediaId: IDs[1],
          mediaSha256: "a".repeat(64),
          mode: "verified",
          probe,
          frames,
        }),
      ).toThrow();
    }
  });

  it("creates Free manifests with exact uniform samples and no verified partitions", () => {
    const duration = 3;
    const frames = Array.from({ length: 12 }, (_, index) => ({
      timestampSeconds: (duration * index) / 11,
      reference: opaqueFrame(index),
      rawBytes: Uint8Array.of(index),
    }));
    const manifest = createExtractionManifest({
      attemptId: IDs[0],
      generation: 1,
      mediaId: IDs[1],
      mediaSha256: "b".repeat(64),
      mode: "free",
      probe: { ...probe, durationSeconds: duration },
      frames,
    });
    expect(manifest).toMatchObject({ mode: "free", frames: { count: 12 } });
    expect("preRoll" in manifest).toBe(false);
    expect("active" in manifest).toBe(false);
  });

  it("strictly rejects persisted manifests with paths or unknown fields", () => {
    expect(() =>
      parseExtractionManifest({
        kind: "extraction-manifest",
        extractionVersion: "c5-frame-manifest-v1",
        mode: "free",
        attemptId: IDs[0],
        generation: 1,
        mediaId: IDs[1],
        mediaSha256: "b".repeat(64),
        display: { width: 1280, height: 720, rotationDegrees: 0 },
        probe,
        frames: {
          count: 1,
          items: [{ ordinal: 0, timestampSeconds: 0, reference: "/tmp/a" }],
        },
        unknown: true,
      }),
    ).toThrow();
  });
});

function verifiedFrames() {
  return Array.from({ length: 640 }, (_, index) => ({
    timestampSeconds: index / 10,
    reference: opaqueFrame(index),
    rawBytes: Uint8Array.of(index % 256),
  }));
}

function opaqueFrame(index: number): string {
  return `frame-${String(index).padStart(4, "0")}`;
}
