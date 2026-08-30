import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type MediaProbe } from "../media/probe.js";
import { LocalFrameExtraction } from "./local-frame-extraction.js";

const attemptId = "11111111-1111-4111-8111-111111111111";
const mediaId = "22222222-2222-4222-8222-222222222222";
const batchId = "33333333-3333-4333-8333-333333333333";
const verifiedProbe: MediaProbe = {
  container: "mp4",
  durationSeconds: 64,
  displayWidth: 1280,
  displayHeight: 720,
  nominalFps: 30,
  codec: "h264",
  sourceRotationDegrees: 90,
};

describe("LocalFrameExtraction", () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  it("uses process-parsed decoded timestamps and scene records before publishing an opaque readable set", async () => {
    const root = await setupRoot(roots);
    const calls: unknown[] = [];
    const extractor = new LocalFrameExtraction({
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
      mediaSha256: "a".repeat(64),
      probe: verifiedProbe,
      uploadedAt: "2030-01-15T12:00:00.000Z",
      source: "staged",
    });
    expect(manifest.frames.items[1]?.timestampSeconds).toBeCloseTo(0.1, 4);
    expect(manifest).toMatchObject({
      preRoll: { count: 40 },
      active: { count: 600 },
    });
    await expect(
      extractor.readFrame(manifest.frames.items[0]!.reference),
    ).resolves.toEqual(jpeg(0));
    expect(JSON.stringify(calls)).toContain("showinfo");
    expect(JSON.stringify(calls)).toContain("scene");
  });

  it("selects cardinality-exact Free samples from real 12/24/30fps decoded timelines", async () => {
    for (const fps of [12, 24, 30]) {
      const root = await setupRoot(roots);
      const decoded = Array.from(
        { length: fps * 3 + 1 },
        (_, index) => index / fps,
      );
      const extractor = new LocalFrameExtraction({
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
        mediaSha256: "a".repeat(64),
        probe: { ...verifiedProbe, durationSeconds: 3 },
        uploadedAt: "2030-01-15T12:00:00.000Z",
        source: "staged",
      });
      expect(manifest.frames.count).toBe(12);
      expect(manifest.frames.items[0]?.timestampSeconds).toBe(0);
      expect(manifest.frames.items.at(-1)?.timestampSeconds).toBe(3);
    }
  });

  it("rejects missing, discontinuous, or oversized process evidence before any frame set is visible", async () => {
    const root = await setupRoot(roots);
    const extractor = new LocalFrameExtraction({
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
        mediaSha256: "a".repeat(64),
        probe: verifiedProbe,
        uploadedAt: "2030-01-15T12:00:00.000Z",
        source: "staged",
      }),
    ).rejects.toThrow("media_probe_failed");
    await expect(
      readFile(join(root, "frames", batchId, ".complete")),
    ).rejects.toThrow();
  });

  it("binds each verified active scene score to its selected decoded timestamp", async () => {
    const root = await setupRoot(roots);
    const extractor = new LocalFrameExtraction({
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
        mediaSha256: "a".repeat(64),
        probe: verifiedProbe,
        uploadedAt: "2030-01-15T12:00:00.000Z",
        source: "staged",
      }),
    ).rejects.toThrow("media_probe_failed");
  });

  it("does not remove a pre-existing completed frame set after an exclusive publication collision", async () => {
    const root = await setupRoot(roots);
    const existing = join(root, "frames", batchId);
    await mkdir(existing, { mode: 0o700 });
    await writeFile(join(existing, ".complete"), "v1", { mode: 0o600 });
    const extractor = new LocalFrameExtraction({
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
        mediaSha256: "a".repeat(64),
        probe: { ...verifiedProbe, durationSeconds: 3 },
        uploadedAt: "2030-01-15T12:00:00.000Z",
        source: "staged",
      }),
    ).rejects.toThrow("media_probe_failed");
    await expect(readFile(join(existing, ".complete"), "utf8")).resolves.toBe(
      "v1",
    );
  });

  it("rejects fabricated NDJSON because the runner contract carries raw FFmpeg output", async () => {
    const root = await setupRoot(roots);
    const extractor = new LocalFrameExtraction({
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
        mediaSha256: "a".repeat(64),
        probe: { ...verifiedProbe, durationSeconds: 3 },
        uploadedAt: "2030-01-15T12:00:00.000Z",
        source: "staged",
      }),
    ).rejects.toThrow("media_probe_failed");
  });
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
): Promise<void> {
  for (let index = 0; index < timestamps.length; index += 1)
    await writeFile(
      join(directory, `decoded-${String(index).padStart(6, "0")}.jpg`),
      jpeg(index),
      { mode: 0o600 },
    );
}

function jpeg(index: number): Uint8Array {
  return Uint8Array.of(0xff, 0xd8, 0xff, 0xe0, index % 256, 0xff, 0xd9);
}

function completedEvidence(
  timestamps: readonly number[],
  sceneTimestamps: readonly number[],
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
    stderr: rawShowinfo(timestamps),
  };
}

function rawShowinfo(timestamps: readonly number[]): string {
  return timestamps
    .map(
      (timestampSeconds, index) =>
        `[Parsed_showinfo_0] n: ${index} pts: ${Math.round(timestampSeconds * 1000)} pts_time:${timestampSeconds.toFixed(6)}`,
    )
    .join("\n");
}
