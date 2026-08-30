import {
  chmod,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MediaPipelineError, type MediaProbe } from "../media/probe.js";
import {
  RetentionScavenger,
  type RetentionRecord,
} from "../media/retention-scavenger.js";
import { LocalMediaStorage } from "./local-media-storage.js";
import { LocalRetentionObjectStore } from "./local-retention-object-store.js";
import { LocalFrameExtraction } from "./local-frame-extraction.js";

const attemptId = "11111111-1111-4111-8111-111111111111";
const mediaId = "22222222-2222-4222-8222-222222222222";
const batchId = "33333333-3333-4333-8333-333333333333";
const probe: MediaProbe = {
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

  it("runs bounded FFmpeg against stored media, validates 40/600 evidence, and publishes a private frame set", async () => {
    const root = await setupRoot(roots);
    const calls: unknown[] = [];
    const retention: unknown[] = [];
    const extractor = new LocalFrameExtraction({
      root,
      ids: { next: () => batchId },
      runner: {
        run: async (command) => {
          calls.push(command);
          for (let index = 0; index < 640; index += 1)
            await writeFile(
              join(
                command.outputDirectory,
                `frame-${String(index).padStart(4, "0")}.jpg`,
              ),
              Buffer.from([index % 256]),
              { mode: 0o600 },
            );
          return { exitCode: 0, activeSceneChangeScores: Array(600).fill(0.1) };
        },
      },
      retention: {
        schedule: async (fact) => void retention.push(fact),
      },
    });

    const manifest = await extractor.extract({
      mode: "verified",
      attemptId,
      generation: 1,
      mediaId,
      mediaSha256: "a".repeat(64),
      probe,
      uploadedAt: "2030-01-15T12:00:00.000Z",
    });
    expect(manifest).toMatchObject({
      mode: "verified",
      display: { rotationDegrees: 90 },
      preRoll: { count: 40 },
      active: { count: 600 },
    });
    expect(calls).toEqual([
      expect.objectContaining({
        executable: "ffmpeg",
        timeoutMilliseconds: 30000,
        maxOutputBytes: 33_553_920,
        arguments: expect.arrayContaining([
          "-i",
          join(root, "originals", mediaId),
        ]),
      }),
    ]);
    expect(retention).toEqual([
      {
        id: batchId,
        attemptId,
        kind: "frame",
        deleteAt: "2030-01-16T11:00:00.000Z",
      },
    ]);
    const framePath = join(root, "frames", batchId, "frame-0000.jpg");
    expect(await readFile(framePath)).toEqual(Buffer.from([0]));
    expect((await lstat(framePath)).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(manifest)).not.toContain(root);
  });

  it("cleans staged and published frames when process evidence or publication fails", async () => {
    const root = await setupRoot(roots);
    const extractor = new LocalFrameExtraction({
      root,
      ids: { next: () => batchId },
      runner: {
        run: async (command) => {
          await writeFile(
            join(command.outputDirectory, "frame-0000.jpg"),
            Buffer.from([1]),
          );
          return { exitCode: 0, activeSceneChangeScores: [] };
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
        probe,
        uploadedAt: "2030-01-15T12:00:00.000Z",
      }),
    ).rejects.toThrow(new MediaPipelineError("media_probe_failed"));
    await expect(
      readFile(join(root, "frames", batchId, "frame-0000.jpg")),
    ).rejects.toThrow();
    expect(await readdir(join(root, "temporary"))).toEqual([]);
  });

  it("uses the exact Free first-to-last uniform sample count without verified scene evidence", async () => {
    const root = await setupRoot(roots);
    const calls: unknown[] = [];
    const extractor = new LocalFrameExtraction({
      root,
      ids: { next: () => batchId },
      runner: {
        run: async (command) => {
          calls.push(command);
          for (let index = 0; index < 12; index += 1)
            await writeFile(
              join(
                command.outputDirectory,
                `frame-${String(index).padStart(4, "0")}.jpg`,
              ),
              Buffer.from([index]),
              { mode: 0o600 },
            );
          return { exitCode: 0 };
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
      probe: { ...probe, durationSeconds: 3 },
      uploadedAt: "2030-01-15T12:00:00.000Z",
    });
    expect(manifest.frames.count).toBe(12);
    expect(manifest.frames.items[0]?.timestampSeconds).toBe(0);
    expect(manifest.frames.items.at(-1)?.timestampSeconds).toBe(3);
    expect(calls).toEqual([
      expect.objectContaining({
        arguments: expect.arrayContaining(["-frames:v", "12"]),
      }),
    ]);
    expect(JSON.stringify(calls)).toContain("select='");
  });

  it("on reopen deletes a real published frame set before acknowledging its retention fact", async () => {
    const root = await setupRoot(roots);
    const extractor = new LocalFrameExtraction({
      root,
      ids: { next: () => batchId },
      runner: {
        run: async (command) => {
          for (let index = 0; index < 12; index += 1)
            await writeFile(
              join(
                command.outputDirectory,
                `frame-${String(index).padStart(4, "0")}.jpg`,
              ),
              Buffer.from([index]),
              { mode: 0o600 },
            );
          return { exitCode: 0 };
        },
      },
      retention: { schedule: async () => undefined },
    });
    await extractor.extract({
      mode: "free",
      attemptId,
      generation: 1,
      mediaId,
      mediaSha256: "a".repeat(64),
      probe: { ...probe, durationSeconds: 3 },
      uploadedAt: "2030-01-15T12:00:00.000Z",
    });
    const record: RetentionRecord = {
      id: batchId,
      attemptId,
      kind: "frame",
      deleteAt: "2030-01-16T11:00:00.000Z",
      cleanupRequestedAt: null,
    };
    const reopenedStorage = new LocalMediaStorage({
      root,
      ids: { next: () => mediaId },
      prober: { probe: async () => probe },
    });
    let acknowledged = false;
    const scavenger = new RetentionScavenger({
      repository: {
        listDue: async () => [record],
        acknowledge: async () => {
          await expect(
            readFile(join(root, "frames", batchId, "frame-0000.jpg")),
          ).rejects.toThrow();
          acknowledged = true;
        },
      },
      objects: new LocalRetentionObjectStore({ storage: reopenedStorage }),
      maxBatchSize: 1,
      log: { event: () => undefined },
    });
    await scavenger.run("2030-01-16T11:00:00.000Z");
    expect(acknowledged).toBe(true);
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
