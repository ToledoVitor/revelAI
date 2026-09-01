import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
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
import { LocalRetentionObjectStore } from "./local-retention-object-store.js";
import {
  createLocalMediaStorage,
  resolveLocalMediaStorageReadinessProbe,
} from "./local-media-storage.js";

const MEDIA_ID = "11111111-1111-4111-8111-111111111111";
const validMp4 = Buffer.from([
  0, 0, 0, 16, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 1, 2, 3, 4,
]);
const probe: MediaProbe = {
  container: "mp4",
  durationSeconds: 64,
  displayWidth: 1280,
  displayHeight: 720,
  nominalFps: 30,
  codec: "h264",
  sourceRotationDegrees: 0,
};
const retention = {
  schedule: async () => ({ kind: "created" as const }),
  acknowledge: async () => undefined,
};
const retentionInput = {
  repository: retention,
  attemptId: "22222222-2222-4222-8222-222222222222",
  createdAt: "2030-01-15T12:00:00.000Z",
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

  it("creates and removes an opaque restrictive readiness sentinel", async () => {
    const root = await temporaryRoot(directories);
    const storage = createLocalMediaStorage({
      root,
      ids: { next: () => MEDIA_ID },
      prober: { probe: async () => probe },
    });
    const readiness = resolveLocalMediaStorageReadinessProbe(storage);

    if (!readiness)
      throw new Error("Expected a factory-issued readiness probe");
    await expect(readiness.probe()).resolves.toBeUndefined();
    expect(await readdir(join(root, "temporary"))).toEqual([]);
    expect((await lstat(join(root, "temporary"))).mode & 0o777).toBe(0o700);
  });

  it("writes only an opaque 0600 final after streaming, sniffing, and probing", async () => {
    const root = await temporaryRoot(directories);
    const storage = createLocalMediaStorage({
      root,
      ids: { next: () => MEDIA_ID },
      prober: { probe: async () => probe },
    });

    const stored = await storage.store({
      source: chunks(validMp4, 3),
      maxBytes: validMp4.length,
      retention: retentionInput,
    });

    expect(stored).toMatchObject({
      id: MEDIA_ID,
      bytes: validMp4.length,
      contentType: "video/mp4",
      probe,
    });
    expect(
      await readFile(join(root, "originals", MEDIA_ID, "payload")),
    ).toEqual(validMp4);
    expect((await lstat(root)).mode & 0o777).toBe(0o700);
    expect((await lstat(join(root, "originals"))).mode & 0o777).toBe(0o700);
    expect(
      (await lstat(join(root, "originals", MEDIA_ID, "payload"))).mode & 0o777,
    ).toBe(0o600);
    expect(await storage.delete(MEDIA_ID)).toBeUndefined();
    await expect(
      readFile(join(root, "originals", MEDIA_ID, "payload")),
    ).rejects.toThrow();
  });

  it("accepts exact stream limit and removes all temporary bytes on first byte over", async () => {
    const root = await temporaryRoot(directories);
    const storage = createLocalMediaStorage({
      root,
      ids: { next: () => MEDIA_ID },
      prober: { probe: async () => probe },
    });
    await storage.store({
      source: chunks(validMp4),
      maxBytes: validMp4.length,
      retention: retentionInput,
    });
    await storage.delete(MEDIA_ID);

    await expect(
      storage.store({
        source: chunks(Buffer.concat([validMp4, Buffer.from([9])]), 2),
        maxBytes: validMp4.length,
        retention: retentionInput,
      }),
    ).rejects.toThrow(new MediaPipelineError("media_too_large"));
    expect(await readdir(join(root, "temporary"))).toEqual([]);
    expect(await readdir(join(root, "originals"))).toEqual([]);
  });

  it("never overwrites a pre-existing opaque target or follows a symlink", async () => {
    const root = await temporaryRoot(directories);
    const originalDirectory = join(root, "originals");
    await writeFile(join(root, ".keep"), "");
    const storage = createLocalMediaStorage({
      root,
      ids: { next: () => MEDIA_ID },
      prober: { probe: async () => probe },
    });
    await storage.initialize();
    await mkdir(join(originalDirectory, MEDIA_ID), { mode: 0o700 });
    await writeFile(join(originalDirectory, MEDIA_ID, "payload"), "existing", {
      mode: 0o600,
    });

    await expect(
      storage.store({
        source: chunks(validMp4),
        maxBytes: validMp4.length,
        retention: retentionInput,
      }),
    ).rejects.toThrow(new MediaPipelineError("media_probe_failed"));
    expect(
      await readFile(join(originalDirectory, MEDIA_ID, "payload"), "utf8"),
    ).toBe("existing");

    await rm(join(originalDirectory, MEDIA_ID), { recursive: true });
    await symlink(join(root, "outside"), join(originalDirectory, MEDIA_ID));
    await expect(
      storage.store({
        source: chunks(validMp4),
        maxBytes: validMp4.length,
        retention: retentionInput,
      }),
    ).rejects.toThrow(new MediaPipelineError("media_probe_failed"));
    expect(await readdir(join(root, "temporary"))).toEqual([]);
  });

  it("writes a durable temporary fact immediately after O_EXCL creation and a restart scavenger removes its orphan", async () => {
    const root = await temporaryRoot(directories);
    const facts: RetentionRecord[] = [];
    const acknowledged: string[] = [];
    const retention = {
      schedule: async (fact: Omit<RetentionRecord, "cleanupRequestedAt">) => {
        facts.push({ ...fact, cleanupRequestedAt: null });
        return { kind: "created" as const };
      },
      acknowledge: async (fact: RetentionRecord) => {
        acknowledged.push(fact.id);
      },
    };
    const storage = createLocalMediaStorage({
      root,
      ids: { next: () => MEDIA_ID },
      prober: { probe: async () => probe },
    });
    await storage.createUploadSession({
      maxBytes: validMp4.length,
      retention: {
        repository: retention,
        attemptId: "22222222-2222-4222-8222-222222222222",
        createdAt: "2030-01-15T12:00:00.000Z",
      },
    });
    expect(facts).toEqual([
      {
        id: MEDIA_ID,
        attemptId: "22222222-2222-4222-8222-222222222222",
        kind: "temporary",
        deleteAt: "2030-01-15T13:00:00.000Z",
        cleanupRequestedAt: null,
      },
    ]);
    expect(await readdir(join(root, "temporary"))).toEqual([
      `${MEDIA_ID}.uploading`,
    ]);
    await expect(storage.discoverReservedOrphans(1)).resolves.toEqual([
      { id: MEDIA_ID, kind: "temporary" },
    ]);

    const scavenger = new RetentionScavenger({
      repository: {
        listDue: async () => facts,
        acknowledge: async (record) => {
          await retention.acknowledge(record);
          facts.splice(0, facts.length);
        },
      },
      objects: new LocalRetentionObjectStore({ storage }),
      maxBatchSize: 1,
      log: { event: () => undefined },
    });
    await scavenger.run("2030-01-15T13:00:00.000Z");
    expect(await readdir(join(root, "temporary"))).toEqual([]);
    expect(acknowledged).toEqual([MEDIA_ID]);
  });

  it("keeps the transition fact through final publication and recovers an ambiguous after-rename publisher failure", async () => {
    const root = await temporaryRoot(directories);
    const facts: RetentionRecord[] = [];
    const acknowledged: string[] = [];
    const retention = {
      schedule: async (fact: Omit<RetentionRecord, "cleanupRequestedAt">) => {
        facts.push({ ...fact, cleanupRequestedAt: null });
        return { kind: "created" as const };
      },
      acknowledge: async (fact: RetentionRecord) => {
        acknowledged.push(fact.id);
      },
    };
    const storage = createLocalMediaStorage({
      root,
      ids: { next: () => MEDIA_ID },
      prober: { probe: async () => probe },
      publisher: {
        publish: async ({
          temporaryPath,
          finalDirectory,
          payloadPath,
          ownerToken,
        }) => {
          await mkdir(finalDirectory, { mode: 0o700 });
          await writeFile(join(finalDirectory, ".owner"), ownerToken);
          await rename(temporaryPath, payloadPath);
          throw new Error("after rename");
        },
      },
    });
    const session = await storage.createUploadSession({
      maxBytes: validMp4.length,
      retention: {
        repository: retention,
        attemptId: "22222222-2222-4222-8222-222222222222",
        createdAt: "2030-01-15T12:00:00.000Z",
      },
    });
    await session.write(validMp4);
    await expect(session.commit()).rejects.toThrow(
      new MediaPipelineError("media_probe_failed"),
    );
    expect(await readdir(join(root, "temporary"))).toEqual([]);
    expect(await readdir(join(root, "originals"))).toEqual([]);
    expect(acknowledged).toEqual([MEDIA_ID]);
    expect(facts).toHaveLength(1);
  });

  it("does not create a temporary when durable transition scheduling fails", async () => {
    const root = await temporaryRoot(directories);
    const storage = createLocalMediaStorage({
      root,
      ids: { next: () => MEDIA_ID },
      prober: { probe: async () => probe },
    });
    await expect(
      storage.createUploadSession({
        maxBytes: validMp4.length,
        retention: {
          repository: {
            schedule: async () => Promise.reject(new Error("sqlite reject")),
            acknowledge: async () => undefined,
          },
          attemptId: "22222222-2222-4222-8222-222222222222",
          createdAt: "2030-01-15T12:00:00.000Z",
        },
      }),
    ).rejects.toThrow(new MediaPipelineError("media_probe_failed"));
    expect(await readdir(join(root, "temporary"))).toEqual([]);
  });

  it("never removes another same-id session's exclusive temporary on collision", async () => {
    const root = await temporaryRoot(directories);
    const storage = createLocalMediaStorage({
      root,
      ids: { next: () => MEDIA_ID },
      prober: { probe: async () => probe },
    });
    const first = await storage.createUploadSession({
      maxBytes: validMp4.length,
      retention: retentionInput,
    });
    await expect(
      storage.createUploadSession({
        maxBytes: validMp4.length,
        retention: retentionInput,
      }),
    ).rejects.toThrow(new MediaPipelineError("media_probe_failed"));
    expect(await readdir(join(root, "temporary"))).toEqual([
      `${MEDIA_ID}.uploading`,
    ]);
    await first.write(validMp4);
    await expect(first.commit()).resolves.toMatchObject({ id: MEDIA_ID });
  });

  it("keeps the transition fact when an ambiguous publisher cannot prove final ownership", async () => {
    const root = await temporaryRoot(directories);
    const facts: RetentionRecord[] = [];
    const acknowledged: string[] = [];
    const trackedRetention = {
      schedule: async (fact: Omit<RetentionRecord, "cleanupRequestedAt">) => {
        facts.push({ ...fact, cleanupRequestedAt: null });
        return { kind: "created" as const };
      },
      acknowledge: async (fact: RetentionRecord) => {
        acknowledged.push(fact.id);
      },
    };
    const storage = createLocalMediaStorage({
      root,
      ids: { next: () => MEDIA_ID },
      prober: { probe: async () => probe },
      publisher: {
        publish: async ({ temporaryPath, finalDirectory, payloadPath }) => {
          await mkdir(finalDirectory, { mode: 0o700 });
          await rename(temporaryPath, payloadPath);
          throw new Error("after rename without ownership receipt");
        },
      },
    });
    const session = await storage.createUploadSession({
      maxBytes: validMp4.length,
      retention: {
        repository: trackedRetention,
        attemptId: "22222222-2222-4222-8222-222222222222",
        createdAt: "2030-01-15T12:00:00.000Z",
      },
    });
    await session.write(validMp4);
    await expect(session.commit()).rejects.toThrow("media_probe_failed");
    await expect(
      readFile(join(root, "originals", MEDIA_ID, "payload")),
    ).resolves.toEqual(validMp4);
    expect(acknowledged).toEqual([]);
    expect(facts).toHaveLength(1);
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
