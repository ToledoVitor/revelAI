import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type MediaProbe } from "../media/probe.js";
import { verifiedExtractionCapability } from "../media/extraction-manifest.js";
import { createLocalFrameExtraction } from "./local-frame-extraction.js";

const attemptId = "11111111-1111-4111-8111-111111111111";
const mediaId = "22222222-2222-4222-8222-222222222222";
const batchId = "33333333-3333-4333-8333-333333333333";
const stagedSourceSha256 = createHash("sha256")
  .update(Uint8Array.of(1, 2, 3))
  .digest("hex");
const frameAuthority = {
  athleteId: "44444444-4444-4444-8444-444444444444",
  calibrationSessionId: null,
  calibrationNonce: null,
};
const verifiedFrameAuthority = {
  athleteId: "44444444-4444-4444-8444-444444444444",
  calibrationSessionId: "55555555-5555-4555-8555-555555555555",
  calibrationNonce: "test-calibration-nonce",
};
const verifiedProbe: MediaProbe = {
  container: "mp4",
  durationSeconds: 64,
  displayWidth: 1280,
  displayHeight: 720,
  nominalFps: 30,
  codec: "h264",
  sourceRotationDegrees: 90,
};
const portableFfmpegIntegrationTimeoutMilliseconds = 15_000;
// Match the production runner's bounded TERM-to-KILL grace; cleanup awaits close.
const testProcessTerminationGraceMilliseconds = 1_000;

type TrackedProcess = Readonly<{
  terminate: () => Promise<void>;
}>;

type ProcessResult = Readonly<{
  exitCode: number;
  stdout: string;
  stderr: string;
}>;

describe("LocalFrameExtraction", () => {
  const roots: string[] = [];
  const trackedProcesses = new Set<TrackedProcess>();
  afterEach(async () => {
    await terminateTrackedProcesses(trackedProcesses);
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  it("uses process-parsed decoded timestamps and scene records before publishing an opaque readable set", async () => {
    const root = await setupRoot(roots);
    const calls: unknown[] = [];
    const extractor = createLocalFrameExtraction({
      root,
      ids: { next: () => batchId },
      runner: {
        run: async (command) => {
          calls.push(command);
          await writeDecoded(command.outputDirectory, verifiedTimeline());
          return completedEvidence(verifiedTimeline(), verifiedScenes());
        },
      },
      retention: { schedule: async () => ({ kind: "created" as const }) },
    });
    const manifest = await extractor.extract({
      mode: "verified",
      attemptId,
      generation: 1,
      mediaId,
      mediaSha256: stagedSourceSha256,
      probe: verifiedProbe,
      uploadedAt: "2030-01-15T12:00:00.000Z",
      source: "staged",
      authority: verifiedFrameAuthority,
    });
    expect(manifest.frames.items[1]?.timestampSeconds).toBeCloseTo(0.1, 4);
    expect(manifest).toMatchObject({
      preRoll: { count: 40 },
      active: { count: 600 },
    });
    if (manifest.mode !== "verified") throw new Error("wrong fixture mode");
    expect(() => verifiedExtractionCapability(manifest)).not.toThrow();
    await expect(
      extractor.readFrame(manifest.frames.items[0]!.reference),
    ).resolves.toEqual(jpeg(0));
    expect(JSON.stringify(calls)).toContain("showinfo");
    expect(JSON.stringify(calls)).toContain("scene");
  });

  it("materializes zero-based image2 output and retains a bounded complete Verified showinfo stream", async () => {
    const root = await setupRoot(roots);
    const extractor = createLocalFrameExtraction({
      root,
      ids: { next: () => batchId },
      runner: {
        run: async (command) => {
          expect(command.arguments).toContain("-start_number");
          expect(command.arguments).toContain("0");
          expect(command.maxStderrBytes).toBe(640 * 512 + 16 * 1024);
          await writeDecodedFromCommand(command, verifiedTimeline());
          return completedEvidence(
            verifiedTimeline(),
            verifiedScenes(),
            " side_data: ".concat("x".repeat(360)),
          );
        },
      },
      retention: { schedule: async () => ({ kind: "created" as const }) },
    });

    await expect(
      extractor.extract({
        mode: "verified",
        attemptId,
        generation: 1,
        mediaId,
        mediaSha256: stagedSourceSha256,
        probe: verifiedProbe,
        uploadedAt: "2030-01-15T12:00:00.000Z",
        source: "staged",
        authority: verifiedFrameAuthority,
      }),
    ).resolves.toMatchObject({
      frames: { count: 640 },
      preRoll: { count: 40 },
      active: { count: 600 },
    });
  });

  it("owns a comment-free baseline JPEG FFmpeg output contract", async () => {
    const root = await setupRoot(roots);
    let command:
      | Readonly<{
          arguments: readonly string[];
          outputDirectory: string;
        }>
      | undefined;
    const extractor = createLocalFrameExtraction({
      root,
      ids: { next: () => batchId },
      runner: {
        run: async (received) => {
          command = received;
          const timeline = Array.from({ length: 37 }, (_, index) => index / 12);
          await writeDecoded(received.outputDirectory, timeline);
          return completedEvidence(timeline, []);
        },
      },
      retention: { schedule: async () => ({ kind: "created" as const }) },
    });

    await expect(
      extractor.extract({
        mode: "free",
        attemptId,
        generation: 1,
        mediaId,
        mediaSha256: stagedSourceSha256,
        probe: { ...verifiedProbe, durationSeconds: 3 },
        uploadedAt: "2030-01-15T12:00:00.000Z",
        source: "staged",
        authority: frameAuthority,
      }),
    ).resolves.toMatchObject({ frames: { count: 12 } });

    expect(command).toBeDefined();
    const outputPattern = join(command!.outputDirectory, "decoded-%06d.jpg");
    const outputPatternIndex = command!.arguments.indexOf(outputPattern);
    expect(outputPatternIndex).toBeGreaterThan(0);
    expect(
      command!.arguments.slice(outputPatternIndex - 5, outputPatternIndex),
    ).toEqual(["-c:v", "mjpeg", "-pix_fmt", "yuvj420p", "-bitexact"]);
  });

  it("does not treat an inventory-only executable as a portable extraction capability", async () => {
    const root = await setupRoot(roots);
    const executable = join(root, "inventory-only-ffmpeg");
    await writeFile(
      executable,
      [
        `#!${process.execPath}`,
        "const arguments_ = process.argv.slice(2);",
        'if (arguments_.includes("-version")) process.exit(0);',
        'if (arguments_.includes("-filters")) {',
        '  process.stdout.write("... fps\\n... metadata\\n... select\\n... showinfo\\n... split\\n");',
        "  process.exit(0);",
        "}",
        'if (arguments_.includes("-encoders")) {',
        '  process.stdout.write("V..... mjpeg\\nV..... mpeg4\\n");',
        "  process.exit(0);",
        "}",
        "process.exitCode = 1;",
      ].join("\n"),
      { mode: 0o700 },
    );
    await chmod(executable, 0o700);

    await expect(
      ffmpegHasPortableExtractionCapability(executable),
    ).resolves.toBe(false);
  });

  it("waits for a tracked subprocess before removing its owned root", async () => {
    const root = await setupRoot(roots);
    const processes = new Set<TrackedProcess>();
    const completed = runProcess(
      process.execPath,
      ["-e", "setTimeout(() => process.exit(0), 1_000)"],
      processes,
    );

    expect(processes.size).toBe(1);
    await terminateTrackedProcesses(processes);
    expect(processes.size).toBe(0);
    await expect(completed).resolves.toMatchObject({ exitCode: 1 });
    await expect(
      rm(root, { recursive: true, force: true }),
    ).resolves.toBeUndefined();
  });

  it("rejects a claimed source digest before it can issue a durable receipt", async () => {
    const root = await setupRoot(roots);
    const extractor = createLocalFrameExtraction({
      root,
      ids: { next: () => batchId },
      runner: {
        run: async () => {
          throw new Error("source digest must be checked before extraction");
        },
      },
      retention: { schedule: async () => ({ kind: "created" as const }) },
    });

    await expect(
      extractor.extract({
        mode: "free",
        attemptId,
        generation: 1,
        mediaId,
        mediaSha256: "a".repeat(64),
        probe: { ...verifiedProbe, durationSeconds: 3 },
        uploadedAt: "2030-01-15T12:00:00.000Z",
        source: "staged",
        authority: frameAuthority,
      }),
    ).rejects.toThrow("media_probe_failed");
  });

  it("rejects marker-only JPEG output before exposing a frame reference", async () => {
    const root = await setupRoot(roots);
    const extractor = createLocalFrameExtraction({
      root,
      ids: { next: () => batchId },
      runner: {
        run: async (command) => {
          const timeline = Array.from({ length: 37 }, (_, index) => index / 12);
          await writeDecoded(
            command.outputDirectory,
            timeline,
            markerOnlyJpeg(),
          );
          return completedEvidence(timeline, []);
        },
      },
      retention: { schedule: async () => ({ kind: "created" as const }) },
    });

    await expect(
      extractor.extract({
        mode: "free",
        attemptId,
        generation: 1,
        mediaId,
        mediaSha256: stagedSourceSha256,
        probe: { ...verifiedProbe, durationSeconds: 3 },
        uploadedAt: "2030-01-15T12:00:00.000Z",
        source: "staged",
        authority: verifiedFrameAuthority,
      }),
    ).rejects.toThrow("media_probe_failed");
  });

  it("rejects semantically invalid baseline JPEGs through extraction before publication", async () => {
    const timeline = Array.from({ length: 37 }, (_, index) => index / 12);
    for (const kind of [
      "dqt",
      "dqt-zero",
      "dht",
      "dht-symbol",
      "dht-oversubscribed",
      "sof",
      "sof-precision",
      "sof-progressive",
      "sos",
      "sos-baseline",
      "unsupported-dac",
      "unsupported-dnl",
      "unsupported-sof2",
      "restart-without-dri",
      "bad-stuffing",
      "sampling-aggregate",
      "truncated",
    ] as const) {
      const root = await setupRoot(roots);
      const extractor = createLocalFrameExtraction({
        root,
        ids: { next: () => batchId },
        runner: {
          run: async (command) => {
            await writeDecoded(
              command.outputDirectory,
              timeline,
              malformedJpeg(kind),
            );
            return completedEvidence(timeline, []);
          },
        },
        retention: { schedule: async () => ({ kind: "created" as const }) },
      });
      await expect(
        extractor.extract({
          mode: "free",
          attemptId,
          generation: 1,
          mediaId,
          mediaSha256: stagedSourceSha256,
          probe: { ...verifiedProbe, durationSeconds: 3 },
          uploadedAt: "2030-01-15T12:00:00.000Z",
          source: "staged",
          authority: frameAuthority,
        }),
      ).rejects.toThrow("media_probe_failed");
      await expect(
        readFile(join(root, "frames", batchId, ".complete")),
      ).rejects.toThrow();
    }
  });

  it("makes opaque reads re-validate structural JPEG evidence", async () => {
    const root = await setupRoot(roots);
    const timeline = Array.from({ length: 37 }, (_, index) => index / 12);
    const extractor = createLocalFrameExtraction({
      root,
      ids: { next: () => batchId },
      runner: {
        run: async (command) => {
          await writeDecoded(command.outputDirectory, timeline);
          return completedEvidence(timeline, []);
        },
      },
      retention: { schedule: async () => ({ kind: "created" as const }) },
    });
    const manifest = await extractor.extract({
      mode: "free",
      attemptId,
      generation: 1,
      mediaId,
      mediaSha256: stagedSourceSha256,
      probe: { ...verifiedProbe, durationSeconds: 3 },
      uploadedAt: "2030-01-15T12:00:00.000Z",
      source: "staged",
      authority: frameAuthority,
    });
    await writeFile(
      join(root, "frames", batchId, "frame-0000.jpg"),
      malformedJpeg("sos"),
      { mode: 0o600 },
    );
    await expect(
      extractor.readFrame(manifest.frames.items[0]!.reference),
    ).rejects.toThrow("media_probe_failed");
  });

  it("re-validates semantic baseline JPEG failures through opaque frame reads", async () => {
    const root = await setupRoot(roots);
    const timeline = Array.from({ length: 37 }, (_, index) => index / 12);
    const extractor = createLocalFrameExtraction({
      root,
      ids: { next: () => batchId },
      runner: {
        run: async (command) => {
          await writeDecoded(command.outputDirectory, timeline);
          return completedEvidence(timeline, []);
        },
      },
      retention: { schedule: async () => ({ kind: "created" as const }) },
    });
    const manifest = await extractor.extract({
      mode: "free",
      attemptId,
      generation: 1,
      mediaId,
      mediaSha256: stagedSourceSha256,
      probe: { ...verifiedProbe, durationSeconds: 3 },
      uploadedAt: "2030-01-15T12:00:00.000Z",
      source: "staged",
      authority: frameAuthority,
    });

    for (const kind of [
      "dqt-zero",
      "dht-symbol",
      "dht-oversubscribed",
      "sof-precision",
      "sof-progressive",
      "sos-baseline",
      "unsupported-dac",
      "unsupported-dnl",
      "unsupported-sof2",
      "restart-without-dri",
      "bad-stuffing",
      "sampling-aggregate",
    ] as const) {
      await writeFile(
        join(root, "frames", batchId, "frame-0000.jpg"),
        malformedJpeg(kind),
        { mode: 0o600 },
      );
      await expect(
        extractor.readFrame(manifest.frames.items[0]!.reference),
      ).rejects.toThrow("media_probe_failed");
    }
  });

  it("selects cardinality-exact Free samples from real 12/24/30fps decoded timelines", async () => {
    for (const fps of [12, 24, 30]) {
      const root = await setupRoot(roots);
      const decoded = Array.from(
        { length: fps * 3 + 1 },
        (_, index) => index / fps,
      );
      const extractor = createLocalFrameExtraction({
        root,
        ids: { next: () => batchId },
        runner: {
          run: async (command) => {
            await writeDecoded(command.outputDirectory, decoded);
            return completedEvidence(decoded, []);
          },
        },
        retention: { schedule: async () => ({ kind: "created" as const }) },
      });
      const manifest = await extractor.extract({
        mode: "free",
        attemptId,
        generation: 1,
        mediaId,
        mediaSha256: stagedSourceSha256,
        probe: { ...verifiedProbe, durationSeconds: 3 },
        uploadedAt: "2030-01-15T12:00:00.000Z",
        source: "staged",
        authority: frameAuthority,
      });
      expect(manifest.frames.count).toBe(12);
      expect(manifest.frames.items[0]?.timestampSeconds).toBe(0);
      expect(manifest.frames.items.at(-1)?.timestampSeconds).toBe(3);
    }
  });

  it("rejects missing, discontinuous, or oversized process evidence before any frame set is visible", async () => {
    const root = await setupRoot(roots);
    const extractor = createLocalFrameExtraction({
      root,
      ids: { next: () => batchId },
      runner: {
        run: async (command) => {
          await writeDecoded(command.outputDirectory, verifiedTimeline());
          return completedEvidence(
            verifiedTimeline().map((value, index) =>
              index === 41 ? value + 1 : value,
            ),
            verifiedScenes(),
          );
        },
      },
      retention: { schedule: async () => ({ kind: "created" as const }) },
    });
    await expect(
      extractor.extract({
        mode: "verified",
        attemptId,
        generation: 1,
        mediaId,
        mediaSha256: stagedSourceSha256,
        probe: verifiedProbe,
        uploadedAt: "2030-01-15T12:00:00.000Z",
        source: "staged",
        authority: frameAuthority,
      }),
    ).rejects.toThrow("media_probe_failed");
    await expect(
      readFile(join(root, "frames", batchId, ".complete")),
    ).rejects.toThrow();
  });

  it("binds each verified active scene score to its selected decoded timestamp", async () => {
    const root = await setupRoot(roots);
    const extractor = createLocalFrameExtraction({
      root,
      ids: { next: () => batchId },
      runner: {
        run: async (command) => {
          await writeDecoded(command.outputDirectory, verifiedTimeline());
          return completedEvidence(
            verifiedTimeline(),
            Array.from({ length: 600 }, (_, index) => 4 + index / 20_000),
          );
        },
      },
      retention: { schedule: async () => ({ kind: "created" as const }) },
    });
    await expect(
      extractor.extract({
        mode: "verified",
        attemptId,
        generation: 1,
        mediaId,
        mediaSha256: stagedSourceSha256,
        probe: verifiedProbe,
        uploadedAt: "2030-01-15T12:00:00.000Z",
        source: "staged",
        authority: frameAuthority,
      }),
    ).rejects.toThrow("media_probe_failed");
  });

  it("does not remove a pre-existing completed frame set after an exclusive publication collision", async () => {
    const root = await setupRoot(roots);
    const existing = join(root, "frames", batchId);
    await mkdir(existing, { mode: 0o700 });
    await writeFile(join(existing, ".complete"), "v1", { mode: 0o600 });
    const extractor = createLocalFrameExtraction({
      root,
      ids: { next: () => batchId },
      runner: {
        run: async (command) => {
          const timeline = Array.from({ length: 37 }, (_, index) => index / 12);
          await writeDecoded(command.outputDirectory, timeline);
          return completedEvidence(timeline, []);
        },
      },
      retention: { schedule: async () => ({ kind: "created" as const }) },
    });
    await expect(
      extractor.extract({
        mode: "free",
        attemptId,
        generation: 1,
        mediaId,
        mediaSha256: stagedSourceSha256,
        probe: { ...verifiedProbe, durationSeconds: 3 },
        uploadedAt: "2030-01-15T12:00:00.000Z",
        source: "staged",
        authority: frameAuthority,
      }),
    ).rejects.toThrow("media_probe_failed");
    await expect(readFile(join(existing, ".complete"), "utf8")).resolves.toBe(
      "v1",
    );
  });

  it("rejects fabricated NDJSON because the runner contract carries raw FFmpeg output", async () => {
    const root = await setupRoot(roots);
    const extractor = createLocalFrameExtraction({
      root,
      ids: { next: () => batchId },
      runner: {
        run: async (command) => {
          const timeline = Array.from({ length: 37 }, (_, index) => index / 12);
          await writeDecoded(command.outputDirectory, timeline);
          return {
            exitCode: 0,
            termination: "completed" as const,
            stdout: JSON.stringify({
              kind: "decoded",
              index: 0,
              timestampSeconds: 0,
            }),
            stderr: rawShowinfo(timeline),
          };
        },
      },
      retention: { schedule: async () => ({ kind: "created" as const }) },
    });
    await expect(
      extractor.extract({
        mode: "free",
        attemptId,
        generation: 1,
        mediaId,
        mediaSha256: stagedSourceSha256,
        probe: { ...verifiedProbe, durationSeconds: 3 },
        uploadedAt: "2030-01-15T12:00:00.000Z",
        source: "staged",
        authority: frameAuthority,
      }),
    ).rejects.toThrow("media_probe_failed");
  });

  it(
    "smokes the owned argv against an explicit portable FFmpeg extraction capability",
    async (context) => {
      if (
        !(await ffmpegHasPortableExtractionCapability(
          "ffmpeg",
          trackedProcesses,
        ))
      )
        return context.skip();
      const root = await setupRoot(roots);
      const staged = join(root, "temporary", `${mediaId}.uploading`);
      const generated = await runProcess(
        "ffmpeg",
        [
          "-nostdin",
          "-y",
          "-f",
          "lavfi",
          "-i",
          "color=c=black:s=1280x720:r=10:d=64",
          "-c:v",
          "mpeg4",
          "-pix_fmt",
          "yuv420p",
          "-f",
          "mp4",
          staged,
        ],
        trackedProcesses,
      );
      expect(generated.exitCode).toBe(0);
      const generatedSourceSha256 = createHash("sha256")
        .update(await readFile(staged))
        .digest("hex");
      const extractor = createLocalFrameExtraction({
        root,
        ids: { next: () => batchId },
        runner: {
          run: async (command) => {
            const result = await runProcess(
              command.executable,
              command.arguments,
              trackedProcesses,
            );
            return {
              exitCode: result.exitCode,
              termination: "completed" as const,
              stdout: result.stdout,
              stderr: result.stderr,
            };
          },
        },
        retention: { schedule: async () => ({ kind: "created" as const }) },
      });

      await expect(
        extractor.extract({
          mode: "verified",
          attemptId,
          generation: 1,
          mediaId,
          mediaSha256: generatedSourceSha256,
          probe: { ...verifiedProbe, sourceRotationDegrees: 0 },
          uploadedAt: "2030-01-15T12:00:00.000Z",
          source: "staged",
          authority: verifiedFrameAuthority,
        }),
      ).resolves.toMatchObject({
        frames: { count: 640 },
        preRoll: { count: 40 },
        active: { count: 600 },
      });
      expect(
        (await readFile(join(root, "frames", batchId, "frame-0000.jpg")))
          .length,
      ).toBeGreaterThan(0);
      expect(
        (await readFile(join(root, "frames", batchId, "frame-0639.jpg")))
          .length,
      ).toBeGreaterThan(0);
    },
    portableFfmpegIntegrationTimeoutMilliseconds,
  );
});

async function setupRoot(roots: string[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "revelai-c5-frames-"));
  roots.push(root);
  await Promise.all(
    ["frames", "temporary"].map((name) =>
      mkdir(join(root, name), { mode: 0o700 }),
    ),
  );
  await writeFile(
    join(root, "temporary", `${mediaId}.uploading`),
    Buffer.from([1, 2, 3]),
    {
      mode: 0o600,
    },
  );
  await chmod(join(root, "temporary", `${mediaId}.uploading`), 0o600);
  return root;
}

function verifiedTimeline(): number[] {
  return Array.from({ length: 640 }, (_, index) => index / 10);
}

function verifiedScenes(): number[] {
  return Array.from({ length: 600 }, (_, index) => 4 + index / 10);
}

async function writeDecoded(
  directory: string,
  timestamps: readonly number[],
  bytes = jpeg(0),
): Promise<void> {
  for (let index = 0; index < timestamps.length; index += 1)
    await writeFile(
      join(directory, `decoded-${String(index).padStart(6, "0")}.jpg`),
      bytes.length === 0 ? jpeg(index) : bytes,
      { mode: 0o600 },
    );
}

async function writeDecodedFromCommand(
  command: Readonly<{ arguments: readonly string[]; outputDirectory: string }>,
  timestamps: readonly number[],
): Promise<void> {
  const start = command.arguments.indexOf("-start_number");
  const startNumber = Number(command.arguments[start + 1]);
  for (let index = 0; index < timestamps.length; index += 1)
    await writeFile(
      join(
        command.outputDirectory,
        `decoded-${String(startNumber + index).padStart(6, "0")}.jpg`,
      ),
      jpeg(index),
      { mode: 0o600 },
    );
}

function jpeg(index: number): Uint8Array {
  if (index !== -1) return validBaselineJpeg();
  return Uint8Array.from(
    Buffer.from(
      "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3+iiigD//2Q==",
      "base64",
    ),
  );
}

/** A complete, decoder-valid baseline SOF0 fixture generated by libjpeg. */
function validBaselineJpeg(): Uint8Array {
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

function completedEvidence(
  timestamps: readonly number[],
  sceneTimestamps: readonly number[],
  showinfoSuffix = "",
): Readonly<{
  exitCode: number;
  termination: "completed";
  stdout: string;
  stderr: string;
}> {
  return {
    exitCode: 0,
    termination: "completed",
    stdout: sceneTimestamps
      .flatMap((timestampSeconds, index) => [
        `frame:${index} pts:${Math.round(timestampSeconds * 1000)} pts_time:${timestampSeconds.toFixed(6)}`,
        "lavfi.scene_score=0.1",
      ])
      .join("\n"),
    stderr: rawShowinfo(timestamps, showinfoSuffix),
  };
}

function rawShowinfo(timestamps: readonly number[], suffix = ""): string {
  return timestamps
    .map(
      (timestampSeconds, index) =>
        `[Parsed_showinfo_0] n: ${index} pts: ${Math.round(timestampSeconds * 1000)} pts_time:${timestampSeconds.toFixed(6)}${suffix}`,
    )
    .join("\n");
}

function markerOnlyJpeg(): Uint8Array {
  return Uint8Array.of(0xff, 0xd8, 0xff, 0xd9);
}

function malformedJpeg(
  kind:
    | "dqt"
    | "dqt-zero"
    | "dht"
    | "dht-symbol"
    | "dht-oversubscribed"
    | "sof"
    | "sof-precision"
    | "sof-progressive"
    | "sos"
    | "sos-baseline"
    | "unsupported-dac"
    | "unsupported-dnl"
    | "unsupported-sof2"
    | "restart-without-dri"
    | "bad-stuffing"
    | "sampling-aggregate"
    | "truncated",
): Uint8Array {
  const output = Uint8Array.from(jpeg(0));
  if (kind === "truncated") return output.slice(0, -3);
  if (kind === "unsupported-dac")
    return insertBeforeSos(output, Uint8Array.of(0xff, 0xcc, 0x00, 0x02));
  if (kind === "unsupported-dnl")
    return insertBeforeSos(output, Uint8Array.of(0xff, 0xdc, 0x00, 0x02));
  if (kind === "unsupported-sof2")
    return insertBeforeSos(
      output,
      Uint8Array.of(0xff, 0xc2, 0x00, 0x08, 8, 0, 1, 0, 1, 1),
    );
  if (kind === "restart-without-dri")
    return insertBeforeEoi(output, Uint8Array.of(0xff, 0xd0));
  if (kind === "bad-stuffing")
    return insertBeforeEoi(output, Uint8Array.of(0xff, 0xff, 0x00));
  let cursor = 2;
  let huffmanTableIndex = 0;
  while (cursor + 4 <= output.length) {
    if (output[cursor] !== 0xff) throw new Error("fixture marker missing");
    while (output[cursor] === 0xff) cursor += 1;
    const marker = output[cursor++]!;
    const length = (output[cursor]! << 8) | output[cursor + 1]!;
    const start = cursor + 2;
    if (kind === "dqt" && marker === 0xdb) {
      output[start] = 0xff;
      return output;
    }
    if (kind === "dqt-zero" && marker === 0xdb) {
      output[start + 1] = 0;
      return output;
    }
    if (kind === "dht" && marker === 0xc4) {
      output[start + 1] = 0x02;
      return output;
    }
    if (kind === "dht-symbol" && marker === 0xc4) {
      output[start + 17] = 0xff;
      return output;
    }
    if (marker === 0xc4) {
      huffmanTableIndex += 1;
      if (kind === "dht-oversubscribed" && huffmanTableIndex === 2) {
        const bits = start + 1;
        // Preserve this table's symbol count while making three 1-bit codes.
        for (let index = 0; index < 16; index += 1) output[bits + index] = 0;
        output[bits] = 3;
        output[bits + 15] = 159;
        return output;
      }
    }
    if (kind === "sof" && marker === 0xc0) {
      output[start + 5] = 0x02;
      return output;
    }
    if (kind === "sof-precision" && marker === 0xc0) {
      output[start] = 12;
      return output;
    }
    if (kind === "sof-progressive" && marker === 0xc0) {
      output[cursor - 1] = 0xc2;
      return output;
    }
    if (kind === "sampling-aggregate" && marker === 0xc0) {
      output[start + 7] = 0x44;
      return output;
    }
    if (kind === "sos" && marker === 0xda) {
      output[start + 2] = 0x22;
      return output;
    }
    if (kind === "sos-baseline" && marker === 0xda) {
      output[start + 5] = 62;
      return output;
    }
    cursor += length;
  }
  throw new Error(`fixture ${kind} marker missing`);
}

function insertBeforeSos(bytes: Uint8Array, insert: Uint8Array): Uint8Array {
  for (let index = 2; index + 1 < bytes.length; index += 1)
    if (bytes[index] === 0xff && bytes[index + 1] === 0xda)
      return Uint8Array.from([
        ...bytes.slice(0, index),
        ...insert,
        ...bytes.slice(index),
      ]);
  throw new Error("fixture SOS marker missing");
}

function insertBeforeEoi(bytes: Uint8Array, insert: Uint8Array): Uint8Array {
  return Uint8Array.from([
    ...bytes.slice(0, -2),
    ...insert,
    ...bytes.slice(-2),
  ]);
}

/** Skip only when a real invocation cannot execute the complete owned pipeline. */
async function ffmpegHasPortableExtractionCapability(
  executable = "ffmpeg",
  trackedProcesses?: Set<TrackedProcess>,
): Promise<boolean> {
  const root = await mkdtemp(join(tmpdir(), "revelai-ffmpeg-capability-"));
  const source = join(root, "source.mp4");
  const outputPattern = join(root, "frame-%06d.jpg");
  try {
    const generated = await runProcess(
      executable,
      [
        "-nostdin",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "color=c=black:s=16x16:r=10:d=1",
        "-c:v",
        "mpeg4",
        "-pix_fmt",
        "yuv420p",
        "-f",
        "mp4",
        source,
      ],
      trackedProcesses,
    );
    if (generated.exitCode !== 0) return false;
    const extracted = await runProcess(
      executable,
      [
        "-nostdin",
        "-v",
        "info",
        "-i",
        source,
        "-filter_complex",
        "[0:v]fps=10,split=2[decoded][active];[decoded]showinfo[frames];[active]select='gte(t,0)*lt(t,1)*gte(scene,0)',metadata=print:file=-[scene]",
        "-map",
        "[frames]",
        "-vsync",
        "0",
        "-start_number",
        "0",
        "-y",
        "-c:v",
        "mjpeg",
        "-pix_fmt",
        "yuvj420p",
        "-bitexact",
        outputPattern,
        "-map",
        "[scene]",
        "-f",
        "null",
        "-",
      ],
      trackedProcesses,
    );
    if (extracted.exitCode !== 0) return false;
    return (await readFile(join(root, "frame-000000.jpg"))).length > 0;
  } catch {
    return false;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function runProcess(
  executable: string,
  arguments_: readonly string[],
  trackedProcesses?: Set<TrackedProcess>,
): Promise<ProcessResult> {
  const child = spawn(executable, arguments_, {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let forceKill: ReturnType<typeof setTimeout> | undefined;
  let finished = false;
  let terminating = false;
  let resolveClosed: () => void;
  let resolveCompleted: (result: ProcessResult) => void;
  let rejectCompleted: (error: Error) => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  const completed = new Promise<ProcessResult>((resolve, reject) => {
    resolveCompleted = resolve;
    rejectCompleted = reject;
  });
  const tracked: TrackedProcess = Object.freeze({
    terminate: async () => {
      if (!finished && !terminating) {
        terminating = true;
        child.kill("SIGTERM");
        forceKill = setTimeout(() => {
          if (!finished) child.kill("SIGKILL");
        }, testProcessTerminationGraceMilliseconds);
        forceKill.unref();
      }
      await closed;
    },
  });
  const finish = (settle: () => void): void => {
    if (finished) return;
    finished = true;
    if (forceKill) clearTimeout(forceKill);
    trackedProcesses?.delete(tracked);
    resolveClosed();
    settle();
  };

  trackedProcesses?.add(tracked);
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  child.once("error", (error: Error) => {
    finish(() => rejectCompleted(error));
  });
  child.once("close", (code) => {
    finish(() => {
      resolveCompleted(
        Object.freeze({
          exitCode: code ?? 1,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
        }),
      );
    });
  });
  return completed;
}

async function terminateTrackedProcesses(
  processes: Set<TrackedProcess>,
): Promise<void> {
  await Promise.all([...processes].map((process) => process.terminate()));
}
