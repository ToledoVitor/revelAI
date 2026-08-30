import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalMediaStorage } from "../storage/local-media-storage.js";
import { MediaPipeline } from "./media-pipeline.js";
import { MediaPipelineError } from "./probe.js";

const mediaId = "11111111-1111-4111-8111-111111111111";
const bytes = Buffer.from([
  0, 0, 0, 16, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 1, 2, 3, 4,
]);

describe("MediaPipeline", () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  it("keeps Free eligibility independent from verified-only timeline checks", async () => {
    const root = await mkdtemp(join(tmpdir(), "revelai-c5-pipeline-"));
    roots.push(root);
    const pipeline = new MediaPipeline({
      storage: new LocalMediaStorage({
        root,
        ids: { next: () => mediaId },
        prober: {
          probe: async () => ({
            container: "mp4",
            durationSeconds: 3,
            displayWidth: 480,
            displayHeight: 853,
            nominalFps: 12,
            codec: "h264",
            sourceRotationDegrees: 0,
          }),
        },
      }),
    });
    await expect(
      pipeline.accept({
        mode: "free",
        source: chunks(bytes),
        maxBytes: bytes.length,
      }),
    ).resolves.toMatchObject({ id: mediaId, contentType: "video/mp4" });
  });

  it("rejects verified ineligible media before an original becomes visible", async () => {
    const root = await mkdtemp(join(tmpdir(), "revelai-c5-pipeline-"));
    roots.push(root);
    const pipeline = new MediaPipeline({
      storage: new LocalMediaStorage({
        root,
        ids: { next: () => mediaId },
        prober: {
          probe: async () => ({
            container: "mp4",
            durationSeconds: 3,
            displayWidth: 480,
            displayHeight: 853,
            nominalFps: 12,
            codec: "h264",
            sourceRotationDegrees: 0,
          }),
        },
      }),
    });
    await expect(
      pipeline.accept({
        mode: "verified",
        source: chunks(bytes),
        maxBytes: bytes.length,
        timestamps: [],
      }),
    ).rejects.toThrow(new MediaPipelineError("media_requirements_not_met"));
    expect(await readdir(join(root, "originals"))).toEqual([]);
    expect(await readdir(join(root, "temporary"))).toEqual([]);
  });
});

async function* chunks(value: Uint8Array): AsyncIterable<Uint8Array> {
  yield value;
}
