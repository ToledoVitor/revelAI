import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  MediaUploadContext,
  StoredMediaAttachment,
} from "../repositories/attempt-repository.js";
import {
  createLocalFrameExtraction,
  type BoundedFrameProcessRunner,
} from "../storage/local-frame-extraction.js";
import {
  createLocalMediaStorage,
  type LocalMediaStorage,
  type LocalMediaProber,
  type NoReplacePublisher,
  type UploadRetentionRepository,
} from "../storage/local-media-storage.js";
import {
  createMediaPipeline,
  createMediaPipelineCapability,
  type C5MediaPipeline,
} from "./media-pipeline.js";

const sourceBytes = Uint8Array.from([
  0, 0, 0, 16, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 1, 2, 3, 4,
]);

export const C5_TEST_SOURCE_SHA256 = createHash("sha256")
  .update(sourceBytes)
  .digest("hex");

export type C5PipelineTestSupport = Readonly<{
  handoffVerifier: ReturnType<C5MediaPipeline["handoffVerifier"]>;
  storage: LocalMediaStorage;
  pipeline: C5MediaPipeline;
  accept(
    context: MediaUploadContext,
    media: StoredMediaAttachment,
    options?: Readonly<{ retentionRepository?: UploadRetentionRepository }>,
  ): ReturnType<C5MediaPipeline["accept"]>;
}>;

/**
 * C4 fixtures use this one public-seam C5 factory. It injects only the
 * process/probe edges; storage, extraction, receipt publication, and handoff
 * issuance remain the production implementations.
 */
export function createC5PipelineTestSupport(
  input: Readonly<{
    root: string;
    prober?: LocalMediaProber;
    runner?: BoundedFrameProcessRunner;
    publisher?: NoReplacePublisher;
    /** Selects deterministic runner evidence for real multipart route tests. */
    mode?: "free" | "verified";
  }>,
): C5PipelineTestSupport {
  let nextMediaId: string | undefined;
  let directPipelineMediaSequence = 0;
  let currentMode: "free" | "verified" = input.mode ?? "free";
  let frameSequence = 0;
  const storage = createLocalMediaStorage({
    root: input.root,
    ids: {
      next: () => {
        const id =
          nextMediaId ??
          `dddddddd-dddd-4ddd-8ddd-${directPipelineMediaSequence
            .toString(16)
            .padStart(12, "0")}`;
        directPipelineMediaSequence += nextMediaId ? 0 : 1;
        nextMediaId = undefined;
        return id;
      },
    },
    prober: input.prober ?? defaultProber,
    ...(input.publisher ? { publisher: input.publisher } : {}),
  });
  const extraction = createLocalFrameExtraction({
    root: input.root,
    ids: {
      next: () => {
        const id = `eeeeeeee-eeee-4eee-8eee-${frameSequence
          .toString(16)
          .padStart(12, "0")}`;
        frameSequence += 1;
        return id;
      },
    },
    runner: input.runner ?? {
      run: async (command) => {
        const timestamps = Array.from(
          { length: 640 },
          (_, index) => index / 10,
        );
        for (let index = 0; index < timestamps.length; index += 1)
          await writeFile(
            join(
              command.outputDirectory,
              `decoded-${String(index).padStart(6, "0")}.jpg`,
            ),
            fixtureJpeg,
            { mode: 0o600 },
          );
        return Object.freeze({
          exitCode: 0 as const,
          termination: "completed" as const,
          stdout:
            currentMode === "verified"
              ? timestamps
                  .slice(40)
                  .flatMap((timestamp, index) => [
                    `frame:${index} pts:${Math.round(timestamp * 1000)} pts_time:${timestamp.toFixed(6)}`,
                    "lavfi.scene_score=0.1",
                  ])
                  .join("\n")
              : "",
          stderr: timestamps
            .map(
              (timestamp, index) =>
                `[Parsed_showinfo_0] n: ${index} pts: ${Math.round(timestamp * 1000)} pts_time:${timestamp.toFixed(6)}`,
            )
            .join("\n"),
        });
      },
    },
    retention: { schedule: async () => ({ kind: "created" as const }) },
  });
  const pipeline = createMediaPipeline(
    createMediaPipelineCapability({ storage, extraction }),
  );
  return Object.freeze({
    handoffVerifier: pipeline.handoffVerifier(),
    storage,
    pipeline,
    accept: async (context, media, options) => {
      nextMediaId = media.id;
      currentMode = context.mode;
      try {
        return await pipeline.accept({
          mode: context.mode,
          source: source(),
          maxBytes: sourceBytes.byteLength,
          retention: {
            repository:
              options?.retentionRepository ??
              Object.freeze({
                schedule: async () => ({ kind: "created" as const }),
                acknowledge: async () => undefined,
              }),
            attemptId: context.attemptId,
            generation: context.generation,
            uploadedAt: context.uploadedAt,
            authority: context,
          },
        });
      } finally {
        nextMediaId = undefined;
      }
    },
  });
}

const defaultProber: LocalMediaProber = Object.freeze({
  probe: async () =>
    Object.freeze({
      container: "mp4" as const,
      durationSeconds: 64,
      displayWidth: 1280,
      displayHeight: 720,
      nominalFps: 30,
      codec: "h264",
      sourceRotationDegrees: 0 as const,
    }),
});

async function* source(): AsyncIterable<Uint8Array> {
  yield sourceBytes;
}

const fixtureJpeg = Uint8Array.from(
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
