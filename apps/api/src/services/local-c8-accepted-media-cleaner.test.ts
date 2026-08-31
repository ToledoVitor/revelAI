import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openSqliteDatabase } from "../database/sqlite-database.js";
import { SQLiteAttemptRepository } from "../repositories/sqlite-attempt-repository.js";
import { createLocalMediaStorage } from "../storage/local-media-storage.js";
import { createLocalC8AcceptedMediaCleaner } from "./local-c8-accepted-media-cleaner.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("local C8 accepted-media cleaner", () => {
  it("requires C5's factory capability and refuses unowned opaque identifiers before deletion", async () => {
    expect(() =>
      createLocalC8AcceptedMediaCleaner({
        storage: {} as never,
        repository: {} as never,
      }),
    ).toThrow("C8 cleaner requires a C5 local storage capability.");

    const storage = createLocalMediaStorage({
      root: "/not-used-before-ownership-check",
      ids: { next: () => "22222222-2222-4222-8222-222222222222" },
      prober: {
        probe: async () => ({
          container: "mp4" as const,
          durationSeconds: 1,
          displayWidth: 1280,
          displayHeight: 720,
          nominalFps: 30,
          codec: "h264",
          sourceRotationDegrees: 0 as const,
        }),
      },
    });
    expect(() =>
      createLocalC8AcceptedMediaCleaner({
        storage,
        repository: {} as never,
      }),
    ).toThrow("C8 cleaner requires a C4 repository capability.");
  });

  it("binds cleanup ownership to the factory-issued repository rather than a mutable instance method", async () => {
    const directory = await mkdtemp(join(tmpdir(), "revelai-c8-cleaner-"));
    directories.push(directory);
    const database = openSqliteDatabase(join(directory, "api.sqlite"));
    const repository = SQLiteAttemptRepository.forReadOnlyTest({
      database,
      clock: { now: () => "2030-01-15T12:00:00.000Z" },
      ids: { next: () => "11111111-1111-4111-8111-111111111111" },
    });
    const otherDatabase = openSqliteDatabase(join(directory, "other.sqlite"));
    const otherRepository = SQLiteAttemptRepository.forReadOnlyTest({
      database: otherDatabase,
      clock: { now: () => "2030-01-15T12:00:00.000Z" },
      ids: { next: () => "11111111-1111-4111-8111-111111111111" },
    });
    const mediaId = "22222222-2222-4222-8222-222222222222";
    const frameBatchId = "33333333-3333-4333-8333-333333333333";
    const storage = createLocalMediaStorage({
      root: join(directory, "media"),
      ids: { next: () => mediaId },
      prober: {
        probe: async () => ({
          container: "mp4" as const,
          durationSeconds: 1,
          displayWidth: 1280,
          displayHeight: 720,
          nominalFps: 30,
          codec: "h264",
          sourceRotationDegrees: 0 as const,
        }),
      },
    });
    await storage.initialize();
    const payload = join(directory, "media", "originals", mediaId, "payload");
    await mkdir(join(directory, "media", "originals", mediaId));
    await writeFile(payload, "must survive rejected ownership");
    const cleaner = createLocalC8AcceptedMediaCleaner({ storage, repository });

    Object.assign(repository, otherRepository, {
      hasExactAcceptedMediaCleanupOwnership: async () => true,
    });

    await expect(
      cleaner.cleanup({
        attemptId: "44444444-4444-4444-8444-444444444444",
        mediaId,
        frameBatchId,
      }),
    ).rejects.toThrow("C8 cleaner ownership mismatch.");
    await expect(readFile(payload, "utf8")).resolves.toBe(
      "must survive rejected ownership",
    );
    database.close();
    otherDatabase.close();
  });
});
