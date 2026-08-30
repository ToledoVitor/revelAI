import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalMediaStorage } from "../storage/local-media-storage.js";
import { LocalFrameExtraction } from "../storage/local-frame-extraction.js";
import { MediaPipeline } from "./media-pipeline.js";
import { MediaPipelineError } from "./probe.js";
import type { ExtractionManifest } from "./extraction-manifest.js";

const mediaId = "11111111-1111-4111-8111-111111111111";
const frameBatchId = "33333333-3333-4333-8333-333333333333";
const bytes = Buffer.from([
  0, 0, 0, 16, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 1, 2, 3, 4,
]);
const retention = {
  repository: {
    schedule: async () => ({ kind: "created" as const }),
    acknowledge: async () => undefined,
  },
  attemptId: "22222222-2222-4222-8222-222222222222",
  generation: 1,
  uploadedAt: "2030-01-15T12:00:00.000Z",
};
const extractor = { extract: async () => ({}) as ExtractionManifest };

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
    const storage = new LocalMediaStorage({
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
    });
    const pipeline = new MediaPipeline({
      storage,
      extractor: new LocalFrameExtraction({
        root,
        ids: { next: () => frameBatchId },
        runner: {
          run: async (command) => {
            const timeline = Array.from(
              { length: 37 },
              (_, index) => index / 12,
            );
            await Promise.all(
              timeline.map((timestamp, index) =>
                writeFile(
                  `${command.outputDirectory}/decoded-${String(index).padStart(6, "0")}.jpg`,
                  jpeg(index),
                  { mode: 0o600 },
                ),
              ),
            );
            return rawEvidence(timeline, []);
          },
        },
        retention: { schedule: async () => ({ kind: "created" as const }) },
      }),
    });
    await expect(
      pipeline.accept({
        mode: "free",
        source: chunks(bytes),
        maxBytes: bytes.length,
        retention,
      }),
    ).resolves.toMatchObject({
      id: mediaId,
      contentType: "video/mp4",
      manifest: { mode: "free" },
    });
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
      extractor,
    });
    await expect(
      pipeline.accept({
        mode: "verified",
        source: chunks(bytes),
        maxBytes: bytes.length,
        retention,
      }),
    ).rejects.toThrow(new MediaPipelineError("media_requirements_not_met"));
    expect(await readdir(join(root, "originals"))).toEqual([]);
    expect(await readdir(join(root, "temporary"))).toEqual([]);
  });

  it("does not publish a probe-valid verified upload when authoritative extraction rejects", async () => {
    const root = await mkdtemp(join(tmpdir(), "revelai-c5-pipeline-"));
    roots.push(root);
    const pipeline = new MediaPipeline({
      storage: new LocalMediaStorage({
        root,
        ids: { next: () => mediaId },
        prober: {
          probe: async () => ({
            container: "mp4",
            durationSeconds: 64,
            displayWidth: 1280,
            displayHeight: 720,
            nominalFps: 30,
            codec: "h264",
            sourceRotationDegrees: 0,
          }),
        },
      }),
      extractor: {
        extract: async () => {
          throw new MediaPipelineError("media_requirements_not_met");
        },
      },
    });

    await expect(
      pipeline.accept({
        mode: "verified",
        source: chunks(bytes),
        maxBytes: bytes.length,
        retention,
      }),
    ).rejects.toThrow(new MediaPipelineError("media_requirements_not_met"));
    expect(await readdir(join(root, "originals"))).toEqual([]);
  });
});

async function* chunks(value: Uint8Array): AsyncIterable<Uint8Array> {
  yield value;
}

function jpeg(index: number): Uint8Array {
  return Uint8Array.of(0xff, 0xd8, 0xff, 0xe0, index % 256, 0xff, 0xd9);
}

function rawEvidence(
  timestamps: readonly number[],
  scenes: readonly number[],
): Readonly<{
  exitCode: number;
  termination: "completed";
  stdout: string;
  stderr: string;
}> {
  return {
    exitCode: 0,
    termination: "completed",
    stdout: scenes
      .flatMap((timestamp, index) => [
        `frame:${index} pts:${Math.round(timestamp * 1000)} pts_time:${timestamp.toFixed(6)}`,
        "lavfi.scene_score=0.1",
      ])
      .join("\n"),
    stderr: timestamps
      .map(
        (timestamp, index) =>
          `[Parsed_showinfo_0] n: ${index} pts: ${Math.round(timestamp * 1000)} pts_time:${timestamp.toFixed(6)}`,
      )
      .join("\n"),
  };
}
