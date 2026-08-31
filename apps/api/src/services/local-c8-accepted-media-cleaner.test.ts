import {
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
import { openSqliteDatabase } from "../database/sqlite-database.js";
import { createC5PipelineTestSupport } from "../media/c5-pipeline-test-support.js";
import { createStoredMediaAttachment } from "../repositories/attempt-repository.js";
import { SQLiteAttemptRepository } from "../repositories/sqlite-attempt-repository.js";
import { createLocalMediaStorage } from "../storage/local-media-storage.js";
import { createLocalC8AcceptedMediaCleaner } from "./local-c8-accepted-media-cleaner.js";
import { MediaAttachmentRecoveryExecutor } from "./media-attachment-recovery.js";

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

  it("refuses a read-only repository before any storage capability can be used for cleanup", () => {
    const database = openSqliteDatabase(":memory:");
    const storage = createLocalMediaStorage({
      root: "/not-used-before-c4-ownership-check",
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
    const readOnly = SQLiteAttemptRepository.forReadOnlyTest({
      database,
      clock: { now: () => "2030-01-15T12:00:00.000Z" },
      ids: { next: () => "11111111-1111-4111-8111-111111111111" },
    });

    expect(() =>
      createLocalC8AcceptedMediaCleaner({ storage, repository: readOnly }),
    ).toThrow("C8 cleaner requires a C4 repository capability.");
    database.close();
  });

  it("rejects a structural count-positive database before cleanup and leaves storage untouched", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "revelai-c8-cleaner-forged-db-"),
    );
    directories.push(directory);
    const mediaId = "22222222-2222-4222-8222-222222222222";
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
    await writeFile(payload, "must survive forged database rejection");
    const countPositiveDatabase = {
      raw: {
        exec: () => undefined,
        prepare: () => ({
          all: () => [],
          get: () => ({ originals: 1, frames: 1 }),
          run: () => ({ changes: 1 }),
        }),
      },
      close: () => undefined,
      reopen: () => countPositiveDatabase,
    };
    const c5 = createC5PipelineTestSupport({ root: join(directory, "c5") });

    expect(
      () =>
        new SQLiteAttemptRepository({
          database: countPositiveDatabase as never,
          clock: { now: () => "2030-01-15T12:00:00.000Z" },
          ids: { next: () => "11111111-1111-4111-8111-111111111111" },
          handoffVerifier: c5.handoffVerifier,
        }),
    ).toThrow("factory-issued SQLite database capability");
    expect(() =>
      createLocalC8AcceptedMediaCleaner({
        storage,
        repository: countPositiveDatabase as never,
      }),
    ).toThrow("C8 cleaner requires a C4 repository capability.");
    await expect(readFile(payload, "utf8")).resolves.toBe(
      "must survive forged database rejection",
    );
  });

  it("does not let pre-construction raw or prototype mutations forge cleanup ownership", async () => {
    for (const mutatePrepare of [
      (raw: { prepare: (sql: string) => unknown }) => {
        const hadOwnPrepare = Object.hasOwn(raw, "prepare");
        const originalPrepare = raw.prepare;
        raw.prepare = forgedPrepare(raw, originalPrepare);
        return () => {
          if (hadOwnPrepare) raw.prepare = originalPrepare;
          else Reflect.deleteProperty(raw, "prepare");
        };
      },
      (raw: { prepare: (sql: string) => unknown }) => {
        const prototype = Object.getPrototypeOf(raw) as {
          prepare: (sql: string) => unknown;
        };
        const originalPrepare = prototype.prepare;
        prototype.prepare = forgedPrepare(raw, originalPrepare);
        return () => {
          prototype.prepare = originalPrepare;
        };
      },
    ]) {
      const directory = await mkdtemp(
        join(tmpdir(), "revelai-c8-cleaner-raw-mutation-"),
      );
      directories.push(directory);
      const database = openSqliteDatabase(join(directory, "api.sqlite"));
      const mediaId = "22222222-2222-4222-8222-222222222222";
      const frameBatchId = "33333333-3333-4333-8333-333333333333";
      const c5 = createC5PipelineTestSupport({
        root: join(directory, "media"),
      });
      await c5.storage.initialize();
      const original = join(
        directory,
        "media",
        "originals",
        mediaId,
        "payload",
      );
      const frame = join(
        directory,
        "media",
        "frames",
        frameBatchId,
        "frame.jpg",
      );
      await mkdir(join(directory, "media", "originals", mediaId));
      await mkdir(join(directory, "media", "frames", frameBatchId));
      await Promise.all([
        writeFile(original, "must survive raw mutation"),
        writeFile(frame, "must survive raw mutation"),
      ]);
      const raw = database.raw as unknown as {
        prepare: (sql: string) => unknown;
      };
      const restorePrepare = mutatePrepare(raw);
      let repository: SQLiteAttemptRepository;
      try {
        repository = new SQLiteAttemptRepository({
          database,
          clock: { now: () => "2030-01-15T12:00:00.000Z" },
          ids: { next: () => "11111111-1111-4111-8111-111111111111" },
          handoffVerifier: c5.handoffVerifier,
        });
      } finally {
        restorePrepare();
      }

      try {
        const cleaner = createLocalC8AcceptedMediaCleaner({
          storage: c5.storage,
          repository: repository!,
        });
        await expect(
          cleaner.cleanup({
            attemptId: "44444444-4444-4444-8444-444444444444",
            mediaId,
            frameBatchId,
          }),
        ).rejects.toThrow("C8 cleaner ownership mismatch.");
        await expect(readFile(original, "utf8")).resolves.toBe(
          "must survive raw mutation",
        );
        await expect(readFile(frame, "utf8")).resolves.toBe(
          "must survive raw mutation",
        );
      } finally {
        database.close();
      }
    }
  });

  it("binds cleanup ownership to the factory-issued repository rather than a mutable instance method", async () => {
    const directory = await mkdtemp(join(tmpdir(), "revelai-c8-cleaner-"));
    directories.push(directory);
    const database = openSqliteDatabase(join(directory, "api.sqlite"));
    const c5 = createC5PipelineTestSupport({ root: join(directory, "c5") });
    const repository = new SQLiteAttemptRepository({
      database,
      clock: { now: () => "2030-01-15T12:00:00.000Z" },
      ids: { next: () => "11111111-1111-4111-8111-111111111111" },
      handoffVerifier: c5.handoffVerifier,
    });
    const otherDatabase = openSqliteDatabase(join(directory, "other.sqlite"));
    const otherRepository = new SQLiteAttemptRepository({
      database: otherDatabase,
      clock: { now: () => "2030-01-15T12:00:00.000Z" },
      ids: { next: () => "11111111-1111-4111-8111-111111111111" },
      handoffVerifier: c5.handoffVerifier,
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

  it("cleans the exact SQLite-owned C5 original and frame batch, then resolves the durable recovery fact", async () => {
    const directory = await mkdtemp(join(tmpdir(), "revelai-c8-cleaner-real-"));
    directories.push(directory);
    const database = openSqliteDatabase(join(directory, "api.sqlite"));
    const now = "2030-01-15T12:00:00.000Z";
    const attemptId = "11111111-1111-4111-8111-111111111111";
    const athleteId = "22222222-2222-4222-8222-222222222222";
    const mediaId = "33333333-3333-4333-8333-333333333333";
    const c5 = createC5PipelineTestSupport({ root: join(directory, "media") });
    const repository = new SQLiteAttemptRepository({
      database,
      clock: { now: () => now },
      ids: {
        next: () => "44444444-4444-4444-8444-444444444444",
      },
      handoffVerifier: c5.handoffVerifier,
    });
    await repository.createAttempt({
      id: attemptId,
      athleteId,
      input: { mode: "free" },
    });
    const context = await repository.prepareMediaUpload({
      attemptId,
      athleteId,
    });
    const accepted = await c5.accept(
      context,
      createStoredMediaAttachment({
        id: mediaId,
        contentType: "video/mp4",
        bytes: 16,
        uploadedAt: context.uploadedAt,
        deleteAt: "2030-01-16T11:00:00.000Z",
        transition: {
          kind: "upload-transition",
          resourceId: mediaId,
          deleteAt: "2030-01-15T13:00:00.000Z",
        },
      }),
    );
    database.raw
      .prepare(
        "INSERT INTO retention_cleanup_records (resource_id, attempt_id, resource_kind, delete_at, created_at) VALUES (?, ?, 'temporary', ?, ?)",
      )
      .run(
        mediaId,
        attemptId,
        accepted.storedMedia.transition.deleteAt,
        context.uploadedAt,
      );
    const job = await repository.attachPreparedMedia({ accepted });
    const frameBatchId = accepted.processingContext.receipt.frameBatchId;
    database.raw
      .prepare(
        "INSERT INTO retention_cleanup_records (resource_id, attempt_id, resource_kind, delete_at, created_at) VALUES (?, ?, 'frame', ?, ?)",
      )
      .run(frameBatchId, attemptId, accepted.storedMedia.deleteAt, now);
    await repository.beginMediaAttachmentRecovery({
      attemptId,
      generation: job.generation,
      mediaId,
      frameBatchId,
    });
    const executor = new MediaAttachmentRecoveryExecutor(
      repository,
      createLocalC8AcceptedMediaCleaner({ storage: c5.storage, repository }),
      { event: () => undefined },
    );

    await expect(executor.run({ now, limit: 1 })).resolves.toBe(1);
    await expect(
      readdir(join(directory, "media", "originals")),
    ).resolves.toEqual([]);
    await expect(readdir(join(directory, "media", "frames"))).resolves.toEqual(
      [],
    );
    await expect(
      repository.getMediaDeliveryRecovery(job),
    ).resolves.toMatchObject({ state: "resolved" });
    database.close();
  });
});

function forgedPrepare(
  raw: { prepare: (sql: string) => unknown },
  originalPrepare: (sql: string) => unknown,
): (sql: string) => unknown {
  return (sql) => {
    if (sql.includes("media_retention_records"))
      return Object.freeze({ get: () => ({ originals: 1, frames: 1 }) });
    return originalPrepare.call(raw, sql);
  };
}
