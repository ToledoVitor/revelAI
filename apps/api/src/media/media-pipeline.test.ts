import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalMediaStorage } from "../storage/local-media-storage.js";
import { LocalFrameExtraction } from "../storage/local-frame-extraction.js";
import { RawMultipartByteCounter } from "./multipart-intake.js";
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
    const accepted = await pipeline.accept({
      mode: "free",
      source: chunks(bytes),
      maxBytes: bytes.length,
      retention,
    });
    expect(accepted).toMatchObject({
      storedMedia: {
        id: mediaId,
        contentType: "video/mp4",
      },
      manifest: { mode: "free" },
    });
    expect(await readdir(join(root, "originals"))).toEqual([mediaId]);
    expect(await readdir(join(root, "frames"))).toEqual([frameBatchId]);
    await expect(accepted.cleanup.cleanup()).resolves.toBeUndefined();
    await expect(accepted.cleanup.cleanup()).resolves.toBeUndefined();
    expect(await readdir(join(root, "originals"))).toEqual([]);
    expect(await readdir(join(root, "frames"))).toEqual([]);
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

  it("feeds the sole validated multipart file into the same pipeline session", async () => {
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
    const rawBody = new RawMultipartByteCounter(bytes.length + 64);
    for await (const chunk of rawBody.stream(chunks(bytes))) void chunk;

    await expect(
      pipeline.acceptMultipart({
        mode: "free",
        multipart: {
          parts: parts({
            kind: "file",
            name: "media",
            filename: "training.mp4",
            contentType: "video/mp4",
            body: chunks(bytes),
          }),
          maxUploadBytes: bytes.length,
          maxMultipartBytes: bytes.length + 64,
          rawBody,
        },
        retention,
      }),
    ).resolves.toMatchObject({
      storedMedia: { id: mediaId },
      manifest: { mode: "free" },
    });
    expect(await readdir(join(root, "originals"))).toEqual([mediaId]);
  });
});

async function* chunks(value: Uint8Array): AsyncIterable<Uint8Array> {
  yield value;
}

async function* parts(
  ...values: readonly {
    kind: "file";
    name: string;
    filename: string;
    contentType: string;
    body: AsyncIterable<Uint8Array>;
  }[]
) {
  yield* values;
}

function jpeg(index: number): Uint8Array {
  void index;
  return Uint8Array.from(
    Buffer.from(
      [
        "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIy",
        "MjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVW",
        "V1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAEC",
        "AxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq",
        "8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3+iiigD//2Q==",
      ].join(""),
      "base64",
    ),
  );
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
