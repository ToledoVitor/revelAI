import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  openSqliteDatabase,
  type SqliteDatabase,
} from "../database/sqlite-database.js";
import { SQLiteAttemptRepository } from "../repositories/sqlite-attempt-repository.js";
import { RetentionScavenger } from "./retention-scavenger.js";
import { LocalMediaStorage } from "../storage/local-media-storage.js";
import { LocalRetentionObjectStore } from "../storage/local-retention-object-store.js";
import { SQLiteRetentionRepository } from "./sqlite-retention-repository.js";

const ATHLETE = "11111111-1111-4111-8111-111111111111";
const ATTEMPT = "22222222-2222-4222-8222-222222222222";
const MEDIA = "33333333-3333-4333-8333-333333333333";

describe("SQLiteRetentionRepository", () => {
  let directory: string;
  let database: SqliteDatabase;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "revelai-c5-retention-"));
    database = openSqliteDatabase(join(directory, "api.sqlite"));
    const repository = new SQLiteAttemptRepository({
      database,
      clock: { now: () => "2030-01-15T12:00:00.000Z" },
      ids: { next: () => "44444444-4444-4444-8444-444444444444" },
    });
    await repository.createAttempt({
      id: ATTEMPT,
      athleteId: ATHLETE,
      input: { mode: "free" },
    });
    await repository.attachValidatedMedia({
      attemptId: ATTEMPT,
      athleteId: ATHLETE,
      media: {
        id: MEDIA,
        contentType: "video/mp4",
        bytes: 1,
        deleteAt: "2030-01-16T11:00:00.000Z",
      },
    });
  });

  afterEach(async () => {
    database.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("orders and acknowledges original, frame, temporary, and observation records after physical cleanup", async () => {
    const repository = new SQLiteRetentionRepository({ database });
    await repository.schedule({
      id: "55555555-5555-4555-8555-555555555555",
      attemptId: ATTEMPT,
      kind: "frame",
      deleteAt: "2030-01-16T10:00:00.000Z",
    });
    await repository.schedule({
      id: "66666666-6666-4666-8666-666666666666",
      attemptId: ATTEMPT,
      kind: "temporary",
      deleteAt: "2030-01-16T10:30:00.000Z",
    });
    await repository.schedule({
      id: "77777777-7777-4777-8777-777777777777",
      attemptId: ATTEMPT,
      kind: "observation",
      deleteAt: "2030-01-16T10:45:00.000Z",
    });

    const due = await repository.listDue({
      now: "2030-01-16T11:00:00.000Z",
      limit: 10,
    });
    expect(due.map((record) => [record.kind, record.id])).toEqual([
      ["frame", "55555555-5555-4555-8555-555555555555"],
      ["temporary", "66666666-6666-4666-8666-666666666666"],
      ["observation", "77777777-7777-4777-8777-777777777777"],
      ["original", MEDIA],
    ]);
    for (const record of due) await repository.acknowledge(record);
    await expect(
      repository.listDue({ now: "2030-01-16T11:00:00.000Z", limit: 10 }),
    ).resolves.toEqual([]);
  });

  it("makes terminal cleanup due immediately without leaking metadata", async () => {
    const repository = new SQLiteRetentionRepository({ database });
    await repository.requestAttemptCleanup({
      attemptId: ATTEMPT,
      requestedAt: "2030-01-15T12:00:00.000Z",
    });
    await expect(
      repository.listDue({ now: "2030-01-15T12:00:00.000Z", limit: 1 }),
    ).resolves.toEqual([
      {
        id: MEDIA,
        attemptId: ATTEMPT,
        kind: "original",
        deleteAt: "2030-01-16T11:00:00.000Z",
        cleanupRequestedAt: "2030-01-15T12:00:00.000Z",
      },
    ]);
  });

  it("deletes the canonical observation in the same transaction before acknowledging its fact", async () => {
    const observation = "88888888-8888-4888-8888-888888888888";
    database.raw
      .prepare(
        "INSERT INTO canonical_observations (id, attempt_id, payload_json, delete_at, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        observation,
        ATTEMPT,
        "{}",
        "2030-01-16T10:00:00.000Z",
        "2030-01-15T12:00:00.000Z",
      );
    const repository = new SQLiteRetentionRepository({ database });
    await repository.schedule({
      id: observation,
      attemptId: ATTEMPT,
      kind: "observation",
      deleteAt: "2030-01-16T10:00:00.000Z",
    });
    const scavenger = new RetentionScavenger({
      repository,
      objects: {
        delete: async () => {
          expect(
            database.raw
              .prepare(
                "SELECT COUNT(*) AS count FROM canonical_observations WHERE id = ?",
              )
              .get(observation),
          ).toEqual({ count: 1 });
        },
      },
      maxBatchSize: 1,
      log: { event: () => undefined },
    });
    await scavenger.run("2030-01-16T11:00:00.000Z");
    expect(
      database.raw
        .prepare(
          "SELECT COUNT(*) AS count FROM canonical_observations WHERE id = ?",
        )
        .get(observation),
    ).toEqual({ count: 0 });
    await expect(
      repository.listDue({ now: "2030-01-16T11:00:00.000Z", limit: 10 }),
    ).resolves.toEqual([
      expect.objectContaining({ kind: "original", id: MEDIA }),
    ]);
  });

  it("persists a transition fact before upload creation and reopens to delete an unattached published original", async () => {
    const transientMedia = "99999999-9999-4999-8999-999999999999";
    const retention = new SQLiteRetentionRepository({ database });
    const storage = new LocalMediaStorage({
      root: join(directory, "media"),
      ids: { next: () => transientMedia },
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
    const session = await storage.createUploadSession({
      maxBytes: 16,
      retention: {
        repository: retention,
        attemptId: ATTEMPT,
        createdAt: "2030-01-15T12:00:00.000Z",
      },
    });
    await session.write(
      Buffer.from([
        0, 0, 0, 16, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 1, 2, 3, 4,
      ]),
    );
    await session.commit();
    await expect(
      readFile(join(directory, "media", "originals", transientMedia)),
    ).resolves.toHaveLength(16);
    database.close();
    database = openSqliteDatabase(join(directory, "api.sqlite"));
    const reopened = new SQLiteRetentionRepository({ database });
    const reopenedStorage = new LocalMediaStorage({
      root: join(directory, "media"),
      ids: { next: () => transientMedia },
      prober: {
        probe: async () => {
          throw new Error("unused");
        },
      },
    });
    const scavenger = new RetentionScavenger({
      repository: reopened,
      objects: new LocalRetentionObjectStore({ storage: reopenedStorage }),
      maxBatchSize: 10,
      log: { event: () => undefined },
    });
    await scavenger.run("2040-01-01T00:00:00.000Z");
    await expect(
      readFile(join(directory, "media", "originals", transientMedia)),
    ).rejects.toThrow();
    await expect(
      reopened.listDue({ now: "2040-01-01T00:00:00.000Z", limit: 10 }),
    ).resolves.not.toContainEqual(
      expect.objectContaining({ id: transientMedia }),
    );
  });
});
