import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLocalMediaStorage } from "../storage/local-media-storage.js";
import { createLocalFrameExtraction } from "../storage/local-frame-extraction.js";
import { RawMultipartByteCounter } from "./multipart-intake.js";
import {
  createMediaPipeline,
  createMediaPipelineCapability,
} from "./media-pipeline.js";
import { MediaPipelineError } from "./probe.js";
import { isC5AcceptedMediaHandoffVerifier } from "./media-pipeline.js";
import { reconstructDurableProcessingContext } from "./extraction-manifest.js";

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
  authority: {
    attemptId: "22222222-2222-4222-8222-222222222222",
    athleteId: "44444444-4444-4444-8444-444444444444",
    mode: "free" as const,
    generation: 1,
    uploadedAt: "2030-01-15T12:00:00.000Z",
    verified: null,
  },
};

function createPipeline(
  input: Parameters<typeof createMediaPipelineCapability>[0],
) {
  return createMediaPipeline(createMediaPipelineCapability(input));
}

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
    const storage = createLocalMediaStorage({
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
    const extraction = createLocalFrameExtraction({
      root,
      ids: { next: () => frameBatchId },
      runner: {
        run: async (command) => {
          const timeline = Array.from({ length: 37 }, (_, index) => index / 12);
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
    });
    const pipeline = createPipeline({
      storage,
      extraction,
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
    expect(accepted.processingContext).toMatchObject({
      kind: "c5-durable-processing-context-v2",
      receipt: { frameBatchId, mediaId, sha256: expect.any(String) },
    });
    await expect(
      reconstructDurableProcessingContext({
        context: accepted.processingContext,
        frames: extraction,
        receipts: extraction,
        authority: {
          upload: {
            attemptId: retention.authority.attemptId,
            athleteId: retention.authority.athleteId,
            generation: retention.authority.generation,
            mode: retention.authority.mode,
            mediaId,
            sourceSha256: accepted.sha256,
            uploadedAt: retention.uploadedAt,
            calibrationSessionId: null,
            calibrationNonce: null,
          },
        },
      }),
    ).resolves.toMatchObject({ mediaId, mode: "free" });
    await expect(accepted.cleanup.cleanup()).resolves.toBeUndefined();
    await expect(accepted.cleanup.cleanup()).resolves.toBeUndefined();
    expect(await readdir(join(root, "originals"))).toEqual([]);
    expect(await readdir(join(root, "frames"))).toEqual([]);

    const reflectedClone = Object.defineProperties(
      { ...accepted },
      Object.getOwnPropertyDescriptors(accepted),
    );
    const spreadClone = { ...accepted };
    const structuralForge = Object.freeze({
      ...accepted,
      cleanup: { cleanup: async () => undefined },
    });
    const verifier = pipeline.handoffVerifier();
    const separateTopology = createPipeline({ storage, extraction });
    expect(isC5AcceptedMediaHandoffVerifier(verifier)).toBe(true);
    expect(verifier.accepts(accepted)).toBe(true);
    expect(verifier.accepts(reflectedClone)).toBe(false);
    expect(verifier.accepts(spreadClone)).toBe(false);
    expect(verifier.accepts(structuralForge)).toBe(false);
    expect(separateTopology.handoffVerifier().accepts(accepted)).toBe(false);
    await expect(
      import("./accepted-media-handoff.js"),
    ).resolves.not.toHaveProperty("createAcceptedMediaHandoff");
    await expect(import("./extraction-manifest.js")).resolves.not.toMatchObject(
      {
        createStorageExtractionReceipt: expect.anything(),
        createDurableProcessingContext: expect.anything(),
      },
    );
  });

  it("rejects verified ineligible media before an original becomes visible", async () => {
    const root = await mkdtemp(join(tmpdir(), "revelai-c5-pipeline-"));
    roots.push(root);
    const pipeline = createPipeline({
      storage: createLocalMediaStorage({
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
      extraction: createLocalFrameExtraction({
        root,
        ids: { next: () => frameBatchId },
        runner: {
          run: async () => ({
            exitCode: 1,
            termination: "completed" as const,
            stdout: "",
            stderr: "",
          }),
        },
        retention: { schedule: async () => ({ kind: "created" as const }) },
      }),
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

  it("rejects a structural extractor before it can mint a C5 verifier", async () => {
    const root = await mkdtemp(join(tmpdir(), "revelai-c5-pipeline-"));
    roots.push(root);
    expect(() =>
      createMediaPipeline({
        storage: createLocalMediaStorage({
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
        extraction: {
          extract: async () => {
            throw new MediaPipelineError("media_requirements_not_met");
          },
          durableReceiptFor: () => ({
            frameBatchId,
            mediaId,
            sha256: "a".repeat(64),
          }),
        },
      } as never),
    ).toThrow("C5 media pipeline requires a factory capability");
  });

  it("feeds the sole validated multipart file into the same pipeline session", async () => {
    const root = await mkdtemp(join(tmpdir(), "revelai-c5-pipeline-"));
    roots.push(root);
    const storage = createLocalMediaStorage({
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
    const pipeline = createPipeline({
      storage,
      extraction: createLocalFrameExtraction({
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
