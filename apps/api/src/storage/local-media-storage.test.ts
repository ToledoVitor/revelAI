import {
  lstat,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MediaPipelineError, type MediaProbe } from "../media/probe.js";
import { LocalMediaStorage } from "./local-media-storage.js";

const MEDIA_ID = "11111111-1111-4111-8111-111111111111";
const validMp4 = Buffer.from([
  0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 1, 2,
]);
const probe: MediaProbe = {
  container: "mp4",
  durationSeconds: 64,
  displayWidth: 1280,
  displayHeight: 720,
  nominalFps: 30,
  codec: "h264",
};

describe("LocalMediaStorage", () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      directories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  it("writes only an opaque 0600 final after streaming, sniffing, and probing", async () => {
    const root = await temporaryRoot(directories);
    const storage = new LocalMediaStorage({
      root,
      ids: { next: () => MEDIA_ID },
      prober: { probe: async () => probe },
    });

    const stored = await storage.store({
      source: chunks(validMp4, 3),
      maxBytes: validMp4.length,
    });

    expect(stored).toMatchObject({
      id: MEDIA_ID,
      bytes: validMp4.length,
      contentType: "video/mp4",
      probe,
    });
    expect(await readFile(join(root, "originals", MEDIA_ID))).toEqual(validMp4);
    expect((await lstat(root)).mode & 0o777).toBe(0o700);
    expect((await lstat(join(root, "originals"))).mode & 0o777).toBe(0o700);
    expect((await lstat(join(root, "originals", MEDIA_ID))).mode & 0o777).toBe(
      0o600,
    );
    expect(await storage.delete(MEDIA_ID)).toBeUndefined();
    await expect(readFile(join(root, "originals", MEDIA_ID))).rejects.toThrow();
  });

  it("accepts exact stream limit and removes all temporary bytes on first byte over", async () => {
    const root = await temporaryRoot(directories);
    const storage = new LocalMediaStorage({
      root,
      ids: { next: () => MEDIA_ID },
      prober: { probe: async () => probe },
    });
    await storage.store({
      source: chunks(validMp4),
      maxBytes: validMp4.length,
    });
    await storage.delete(MEDIA_ID);

    await expect(
      storage.store({
        source: chunks(Buffer.concat([validMp4, Buffer.from([9])]), 2),
        maxBytes: validMp4.length,
      }),
    ).rejects.toThrow(new MediaPipelineError("media_too_large"));
    expect(await readdir(join(root, "temporary"))).toEqual([]);
    expect(await readdir(join(root, "originals"))).toEqual([]);
  });

  it("never overwrites a pre-existing opaque target or follows a symlink", async () => {
    const root = await temporaryRoot(directories);
    const originalDirectory = join(root, "originals");
    await writeFile(join(root, ".keep"), "");
    const storage = new LocalMediaStorage({
      root,
      ids: { next: () => MEDIA_ID },
      prober: { probe: async () => probe },
    });
    await storage.initialize();
    await writeFile(join(originalDirectory, MEDIA_ID), "existing", {
      mode: 0o600,
    });

    await expect(
      storage.store({ source: chunks(validMp4), maxBytes: validMp4.length }),
    ).rejects.toThrow(new MediaPipelineError("media_probe_failed"));
    expect(await readFile(join(originalDirectory, MEDIA_ID), "utf8")).toBe(
      "existing",
    );

    await rm(join(originalDirectory, MEDIA_ID));
    await symlink(join(root, "outside"), join(originalDirectory, MEDIA_ID));
    await expect(
      storage.store({ source: chunks(validMp4), maxBytes: validMp4.length }),
    ).rejects.toThrow(new MediaPipelineError("media_probe_failed"));
    expect(await readdir(join(root, "temporary"))).toEqual([]);
  });
});

async function temporaryRoot(directories: string[]): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "revelai-c5-storage-"));
  directories.push(directory);
  return directory;
}

async function* chunks(
  bytes: Uint8Array,
  size = bytes.length,
): AsyncIterable<Uint8Array> {
  for (let offset = 0; offset < bytes.length; offset += size)
    yield bytes.subarray(offset, Math.min(bytes.length, offset + size));
}
