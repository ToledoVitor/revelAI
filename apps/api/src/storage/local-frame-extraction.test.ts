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
      retention: { schedule: async () => undefined },
    });
    const manifest = await extractor.extract({
      mode: "verified",
      attemptId,
      generation: 1,
      mediaId,
      mediaSha256: "a".repeat(64),
      probe: verifiedProbe,
      uploadedAt: "2030-01-15T12:00:00.000Z",
    });
    expect(manifest.frames.items[1]?.timestampSeconds).toBeCloseTo(0.1, 4);
    expect(manifest).toMatchObject({
      preRoll: { count: 40 },
      active: { count: 600 },
    });
    await expect(
      extractor.readFrame(manifest.frames.items[0]!.reference),
    ).resolves.toEqual(Uint8Array.of(0));
    expect(JSON.stringify(calls)).toContain("showinfo");
    expect(JSON.stringify(calls)).toContain("revelai-frame-evidence-ndjson-v1");
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
        retention: { schedule: async () => undefined },
      });
      const manifest = await extractor.extract({
        mode: "free",
        attemptId,
        generation: 1,
        mediaId,
        mediaSha256: "a".repeat(64),
        probe: { ...verifiedProbe, durationSeconds: 3 },
        uploadedAt: "2030-01-15T12:00:00.000Z",
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
      retention: { schedule: async () => undefined },
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
      }),
    ).rejects.toThrow("media_probe_failed");
    await expect(
      readFile(join(root, "frames", batchId, ".complete")),
    ).rejects.toThrow();
  });
});

async function setupRoot(roots: string[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "revelai-c5-frames-"));
  roots.push(root);
  await Promise.all(
    ["originals", "frames", "temporary"].map((name) =>
      mkdir(join(root, name), { mode: 0o700 }),
    ),
  );
  await writeFile(join(root, "originals", mediaId), Buffer.from([1, 2, 3]), {
    mode: 0o600,
  });
  await chmod(join(root, "originals", mediaId), 0o600);
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
      Buffer.from([index % 256]),
      { mode: 0o600 },
    );
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
    stdout: [
      ...timestamps.map((timestampSeconds, index) =>
        JSON.stringify({ kind: "decoded", index, timestampSeconds }),
      ),
      ...sceneTimestamps.map((timestampSeconds) =>
        JSON.stringify({ kind: "scene", timestampSeconds, score: 0.1 }),
      ),
    ].join("\n"),
    stderr: "",
  };
}
