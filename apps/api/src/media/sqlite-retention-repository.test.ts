import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FailureMessageByCode } from "@revelai/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  openSqliteDatabase,
  type SqliteDatabase,
} from "../database/sqlite-database.js";
import { SQLiteAttemptRepository } from "../repositories/sqlite-attempt-repository.js";
import {
  createStoredMediaAttachment,
  type MediaUploadContext,
  type StoredMediaAttachment,
} from "../repositories/attempt-repository.js";
import {} from "./extraction-manifest.js";
import { QueueUnavailableError } from "../queue/analysis-queue.js";
import { AttemptService } from "../services/attempt-service.js";
import { RetentionScavenger } from "./retention-scavenger.js";
import { LocalMediaStorage } from "../storage/local-media-storage.js";
import { LocalRetentionObjectStore } from "../storage/local-retention-object-store.js";
import { SQLiteRetentionRepository } from "./sqlite-retention-repository.js";
import { MediaPipeline } from "./media-pipeline.js";
import { createExtractionManifest } from "./extraction-manifest.js";

const ATHLETE = "11111111-1111-4111-8111-111111111111";
const ATTEMPT = "22222222-2222-4222-8222-222222222222";
const MEDIA = "33333333-3333-4333-8333-333333333333";
let c5: TestPipelineIssuer;

describe("SQLiteRetentionRepository", () => {
  let directory: string;
  let database: SqliteDatabase;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "revelai-c5-retention-"));
    database = openSqliteDatabase(join(directory, "api.sqlite"));
    c5 = createTestPipelineIssuer();
    const repository = new SQLiteAttemptRepository({
      database,
      clock: { now: () => "2030-01-15T12:00:00.000Z" },
      ids: { next: () => "44444444-4444-4444-8444-444444444444" },
      handoffVerifier: c5.handoffVerifier,
    });
    await repository.createAttempt({
      id: ATTEMPT,
      athleteId: ATHLETE,
      input: { mode: "free" },
    });
    await new SQLiteRetentionRepository({ database }).schedule({
      id: MEDIA,
      attemptId: ATTEMPT,
      kind: "temporary",
      deleteAt: "2030-01-15T13:00:00.000Z",
    });
    await attachStoredMedia(
      repository,
      ATTEMPT,
      ATHLETE,
      createStoredMediaAttachment({
        id: MEDIA,
        contentType: "video/mp4",
        bytes: 1,
        uploadedAt: "2030-01-15T12:00:00.000Z",
        deleteAt: "2030-01-16T11:00:00.000Z",
        transition: {
          kind: "upload-transition",
          resourceId: MEDIA,
          deleteAt: "2030-01-15T13:00:00.000Z",
        },
      }),
    );
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

  it("reports created, idempotent ownership, and incompatible retention collisions", async () => {
    const repository = new SQLiteRetentionRepository({ database });
    const fact = {
      id: "55555555-5555-4555-8555-555555555555",
      attemptId: ATTEMPT,
      kind: "frame" as const,
      deleteAt: "2030-01-16T10:00:00.000Z",
    };
    await expect(repository.schedule(fact)).resolves.toEqual({
      kind: "created",
    });
    await expect(repository.schedule(fact)).resolves.toEqual({
      kind: "existing-owned",
    });
    await expect(
      repository.schedule({
        ...fact,
        attemptId: "99999999-9999-4999-8999-999999999999",
      }),
    ).resolves.toEqual({ kind: "conflict" });
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

  it("atomically installs original retention and acknowledges the owned upload transition", async () => {
    const secondAttempt = "99999999-9999-4999-8999-999999999999";
    const secondMedia = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const attempts = new SQLiteAttemptRepository({
      database,
      clock: { now: () => "2030-01-15T12:00:00.000Z" },
      ids: { next: () => "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
      handoffVerifier: c5.handoffVerifier,
    });
    await attempts.createAttempt({
      id: secondAttempt,
      athleteId: ATHLETE,
      input: { mode: "free" },
    });
    const retention = new SQLiteRetentionRepository({ database });
    await retention.schedule({
      id: secondMedia,
      attemptId: secondAttempt,
      kind: "temporary",
      deleteAt: "2030-01-15T13:00:00.000Z",
    });

    // The transition survives a real process boundary immediately before the
    // attachment transaction; the next reopen observes only original retention.
    database.close();
    database = openSqliteDatabase(join(directory, "api.sqlite"));
    const reopenedAttempts = new SQLiteAttemptRepository({
      database,
      clock: { now: () => "2030-01-15T12:00:00.000Z" },
      ids: { next: () => "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
      handoffVerifier: c5.handoffVerifier,
    });
    await attachStoredMedia(
      reopenedAttempts,
      secondAttempt,
      ATHLETE,
      createStoredMediaAttachment({
        id: secondMedia,
        contentType: "video/mp4",
        bytes: 1,
        uploadedAt: "2030-01-15T12:00:00.000Z",
        deleteAt: "2030-01-16T11:00:00.000Z",
        transition: {
          kind: "upload-transition",
          resourceId: secondMedia,
          deleteAt: "2030-01-15T13:00:00.000Z",
        },
      }),
    );

    database.close();
    database = openSqliteDatabase(join(directory, "api.sqlite"));
    const afterAttach = new SQLiteRetentionRepository({ database });
    await expect(
      afterAttach.listDue({ now: "2030-01-15T13:00:00.000Z", limit: 10 }),
    ).resolves.not.toContainEqual(
      expect.objectContaining({ id: secondMedia, kind: "temporary" }),
    );
    await expect(
      afterAttach.listDue({ now: "2030-01-16T11:00:00.000Z", limit: 10 }),
    ).resolves.toContainEqual(
      expect.objectContaining({ id: secondMedia, kind: "original" }),
    );
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
      readFile(
        join(directory, "media", "originals", transientMedia, "payload"),
      ),
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
      readFile(
        join(directory, "media", "originals", transientMedia, "payload"),
      ),
    ).rejects.toThrow();
    await expect(
      reopened.listDue({ now: "2040-01-01T00:00:00.000Z", limit: 10 }),
    ).resolves.not.toContainEqual(
      expect.objectContaining({ id: transientMedia }),
    );
  });

  it("keeps published bytes covered by original retention when queue enqueue rolls attachment back", async () => {
    const rolledBackAttempt = "99999999-9999-4999-8999-999999999999";
    const rolledBackMedia = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const uploadedAt = "2030-01-15T12:00:00.000Z";
    const attempts = new SQLiteAttemptRepository({
      database,
      clock: { now: () => uploadedAt },
      ids: { next: () => "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
      handoffVerifier: c5.handoffVerifier,
    });
    await attempts.createAttempt({
      id: rolledBackAttempt,
      athleteId: ATHLETE,
      input: { mode: "free" },
    });
    const retention = new SQLiteRetentionRepository({ database });
    const storage = new LocalMediaStorage({
      root: join(directory, "queue-rollback-media"),
      ids: { next: () => rolledBackMedia },
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
    const payload = Buffer.from([
      0, 0, 0, 16, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 1, 2, 3, 4,
    ]);
    const stored = await storage.store({
      source: chunks(payload),
      maxBytes: payload.length,
      retention: {
        repository: retention,
        attemptId: rolledBackAttempt,
        createdAt: uploadedAt,
      },
    });
    const service = new AttemptService({
      repository: attempts,
      queue: {
        isAvailable: async () => true,
        enqueue: async () => {
          throw new QueueUnavailableError();
        },
        subscribe: () => () => undefined,
      },
    });

    const rollbackContext = await attempts.prepareMediaUpload({
      attemptId: rolledBackAttempt,
      athleteId: ATHLETE,
    });
    const rollbackMedia = createStoredMediaAttachment({
      id: stored.id,
      contentType: stored.contentType,
      bytes: stored.bytes,
      uploadedAt,
      deleteAt: "2030-01-16T11:00:00.000Z",
      transition: {
        kind: "upload-transition",
        resourceId: stored.id,
        deleteAt: "2030-01-15T13:00:00.000Z",
      },
    });
    await expect(
      service.attachAcceptedMedia({
        accepted: await c5.accept(
          rollbackContext,
          rollbackMedia,
          async () => storage.delete(stored.id),
          stored.sha256,
        ),
      }),
    ).rejects.toBeInstanceOf(QueueUnavailableError);
    await expect(
      attempts.getAttempt({ attemptId: rolledBackAttempt, athleteId: ATHLETE }),
    ).resolves.toMatchObject({ status: "awaiting-upload", media: null });
    await expect(
      readFile(
        join(
          directory,
          "queue-rollback-media",
          "originals",
          rolledBackMedia,
          "payload",
        ),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });

    database.close();
    database = openSqliteDatabase(join(directory, "api.sqlite"));
    const reopenedRetention = new SQLiteRetentionRepository({ database });
    const due = await reopenedRetention.listDue({
      now: "2040-01-01T00:00:00.000Z",
      limit: 10,
    });
    expect(due).toContainEqual(
      expect.objectContaining({
        id: rolledBackMedia,
        attemptId: rolledBackAttempt,
        kind: "original",
        deleteAt: "2030-01-16T11:00:00.000Z",
      }),
    );
    expect(due).not.toContainEqual(
      expect.objectContaining({ id: rolledBackMedia, kind: "temporary" }),
    );
    const reopenedStorage = new LocalMediaStorage({
      root: join(directory, "queue-rollback-media"),
      ids: { next: () => rolledBackMedia },
      prober: {
        probe: async () => {
          throw new Error("unused");
        },
      },
    });
    const scavenger = new RetentionScavenger({
      repository: reopenedRetention,
      objects: new LocalRetentionObjectStore({ storage: reopenedStorage }),
      maxBatchSize: 10,
      log: { event: () => undefined },
    });
    await scavenger.run("2040-01-01T00:00:00.000Z");
    await expect(
      readFile(
        join(
          directory,
          "queue-rollback-media",
          "originals",
          rolledBackMedia,
          "payload",
        ),
      ),
    ).rejects.toThrow();
    await expect(
      reopenedRetention.listDue({ now: "2040-01-01T00:00:00.000Z", limit: 10 }),
    ).resolves.not.toContainEqual(
      expect.objectContaining({ id: rolledBackMedia }),
    );
  });

  it("passes only pipeline.storedMedia through SQLite, queue, reopen, rollback, and a new generation", async () => {
    const uploadAttempt = "99999999-9999-4999-8999-999999999999";
    const firstMedia = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const rejectedMedia = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const retryMedia = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const uploadedAt = "2030-01-15T12:00:00.000Z";
    const payload = Buffer.from([
      0, 0, 0, 16, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 1, 2, 3, 4,
    ]);
    const ids = [firstMedia, rejectedMedia, retryMedia];
    const storage = new LocalMediaStorage({
      root: join(directory, "pipeline-service-media"),
      ids: {
        next: () => {
          const id = ids.shift();
          if (!id) throw new Error("test IDs exhausted");
          return id;
        },
      },
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
    const retention = new SQLiteRetentionRepository({ database });
    const pipeline = new MediaPipeline({
      storage,
      extractor: {
        extract: async (input) => {
          const manifest = createExtractionManifest({
            attemptId: input.attemptId,
            generation: input.generation,
            mediaId: input.mediaId,
            mediaSha256: input.mediaSha256,
            mode: input.mode,
            probe: input.probe,
            frames: Array.from({ length: 12 }, (_, ordinal) => ({
              timestampSeconds: (input.probe.durationSeconds * ordinal) / 11,
              reference: `${input.mediaId}_${String(ordinal).padStart(4, "0")}`,
              rawBytes: Uint8Array.of(ordinal),
            })),
          });
          return manifest;
        },
        durableReceiptFor: (manifest) => ({
          frameBatchId: "55555555-5555-4555-8555-555555555555",
          mediaId: manifest.mediaId,
          sha256: "b".repeat(64),
        }),
      },
    });
    const attempts = new SQLiteAttemptRepository({
      database,
      clock: { now: () => uploadedAt },
      ids: { next: () => "dddddddd-dddd-4ddd-8ddd-dddddddddddd" },
      handoffVerifier: pipeline.handoffVerifier(),
    });
    await attempts.createAttempt({
      id: uploadAttempt,
      athleteId: ATHLETE,
      input: { mode: "free" },
    });
    const accept = async (generation: number) =>
      pipeline.accept({
        mode: "free",
        source: chunks(payload),
        maxBytes: payload.length,
        retention: {
          repository: retention,
          attemptId: uploadAttempt,
          generation,
          uploadedAt,
          authority: await attempts.prepareMediaUpload({
            attemptId: uploadAttempt,
            athleteId: ATHLETE,
          }),
        },
      });

    const accepted = await accept(1);
    expect(Object.keys(accepted).sort()).toEqual([
      "cleanup",
      "context",
      "manifest",
      "probe",
      "processingContext",
      "sha256",
      "sourceSha256",
      "storedMedia",
    ]);
    expect(JSON.stringify(accepted)).not.toContain("transitionResourceId");
    const queued: Array<Readonly<{ attemptId: string; generation: number }>> =
      [];
    const service = new AttemptService({
      repository: attempts,
      queue: {
        isAvailable: async () => true,
        enqueue: async (job) => void queued.push(job),
        subscribe: () => () => undefined,
      },
    });
    await service.attachAcceptedMedia({ accepted });
    await expect(
      attempts.getAttempt({ attemptId: uploadAttempt, athleteId: ATHLETE }),
    ).resolves.toMatchObject({
      status: "uploaded",
      media: accepted.storedMedia,
    });

    database.close();
    database = openSqliteDatabase(join(directory, "api.sqlite"));
    const reopened = new SQLiteAttemptRepository({
      database,
      clock: { now: () => uploadedAt },
      ids: { next: () => "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" },
      handoffVerifier: pipeline.handoffVerifier(),
    });
    const claim = await reopened.claimProcessing(queued[0]!);
    expect(claim).not.toBeNull();
    await expect(
      reopened.finalizeTerminalResult({
        attemptId: uploadAttempt,
        leaseId: claim!.leaseId,
        generation: claim!.generation,
        candidate: {
          state: "failed",
          attemptId: uploadAttempt,
          mode: "free",
          code: "analysis_internal_error",
          message: FailureMessageByCode.analysis_internal_error,
          retryable: false,
        },
      }),
    ).resolves.toMatchObject({ kind: "finalized" });

    const retryAttempt = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    await reopened.createAttempt({
      id: retryAttempt,
      athleteId: ATHLETE,
      input: { mode: "free" },
    });
    const rejectPipeline = new MediaPipeline({
      storage,
      extractor: {
        extract: async (input) => {
          const manifest = createExtractionManifest({
            attemptId: input.attemptId,
            generation: input.generation,
            mediaId: input.mediaId,
            mediaSha256: input.mediaSha256,
            mode: input.mode,
            probe: input.probe,
            frames: Array.from({ length: 12 }, (_, ordinal) => ({
              timestampSeconds: (input.probe.durationSeconds * ordinal) / 11,
              reference: `${input.mediaId}_${String(ordinal).padStart(4, "0")}`,
              rawBytes: Uint8Array.of(ordinal),
            })),
          });
          return manifest;
        },
        durableReceiptFor: (manifest) => ({
          frameBatchId: "55555555-5555-4555-8555-555555555555",
          mediaId: manifest.mediaId,
          sha256: "b".repeat(64),
        }),
      },
    });
    const rejected = await rejectPipeline.accept({
      mode: "free",
      source: chunks(payload),
      maxBytes: payload.length,
      retention: {
        repository: new SQLiteRetentionRepository({ database }),
        attemptId: retryAttempt,
        generation: 1,
        uploadedAt,
        authority: await reopened.prepareMediaUpload({
          attemptId: retryAttempt,
          athleteId: ATHLETE,
        }),
      },
    });
    const rejectingAttempts = new SQLiteAttemptRepository({
      database,
      clock: { now: () => uploadedAt },
      ids: { next: () => "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" },
      handoffVerifier: rejectPipeline.handoffVerifier(),
    });
    const failing = new AttemptService({
      repository: rejectingAttempts,
      queue: {
        isAvailable: async () => true,
        enqueue: async () => {
          throw new QueueUnavailableError();
        },
        subscribe: () => () => undefined,
      },
    });
    await expect(
      failing.attachAcceptedMedia({ accepted: rejected }),
    ).rejects.toBeInstanceOf(QueueUnavailableError);

    database.close();
    database = openSqliteDatabase(join(directory, "api.sqlite"));
    const afterRollback = new SQLiteAttemptRepository({
      database,
      clock: { now: () => uploadedAt },
      ids: { next: () => "11111111-1111-4111-8111-111111111111" },
      handoffVerifier: rejectPipeline.handoffVerifier(),
    });
    await expect(
      afterRollback.getAttempt({ attemptId: retryAttempt, athleteId: ATHLETE }),
    ).resolves.toMatchObject({ status: "awaiting-upload", media: null });
    const retry = await rejectPipeline.accept({
      mode: "free",
      source: chunks(payload),
      maxBytes: payload.length,
      retention: {
        repository: new SQLiteRetentionRepository({ database }),
        attemptId: retryAttempt,
        generation: 2,
        uploadedAt,
        authority: await afterRollback.prepareMediaUpload({
          attemptId: retryAttempt,
          athleteId: ATHLETE,
        }),
      },
    });
    const retried = await new AttemptService({
      repository: afterRollback,
      queue: {
        isAvailable: async () => true,
        enqueue: async () => undefined,
        subscribe: () => () => undefined,
      },
    }).attachAcceptedMedia({ accepted: retry });
    expect(retried).toEqual({ attemptId: retryAttempt, generation: 2 });
  });
});

async function attachStoredMedia(
  repository: SQLiteAttemptRepository,
  attemptId: string,
  athleteId: string,
  storedMedia: ReturnType<typeof createStoredMediaAttachment>,
) {
  const context = await repository.prepareMediaUpload({ attemptId, athleteId });
  return repository.attachPreparedMedia({
    accepted: await c5.accept(context, storedMedia),
  });
}

type TestPipelineIssuer = Readonly<{
  handoffVerifier: ReturnType<MediaPipeline["handoffVerifier"]>;
  accept(
    context: MediaUploadContext,
    storedMedia: StoredMediaAttachment,
    cleanup?: () => Promise<void>,
    sourceSha256?: string,
  ): ReturnType<MediaPipeline["accept"]>;
}>;

function storageContext(
  input: Readonly<{
    frameBatchId: string;
    mediaId: string;
    sha256: string;
  }>,
) {
  return Object.freeze({
    kind: "c5-durable-processing-context-v2" as const,
    receipt: Object.freeze({ ...input }),
  });
}

/** A fixture models one composed C5 pipeline and its exact C4 verifier. */
function createTestPipelineIssuer(): TestPipelineIssuer {
  let staged:
    | Readonly<{
        id: string;
        contentType: "video/mp4";
        bytes: number;
        sha256: string;
        probe: never;
        transitionResourceId: string;
      }>
    | undefined;
  let processingContext: ReturnType<typeof storageContext> | undefined;
  const cleanupByMediaId = new Map<string, () => Promise<void>>();
  const pipeline = new MediaPipeline({
    storage: {
      createUploadSession: async () => {
        if (!staged) throw new Error("test stored media is required");
        return {
          write: async () => undefined,
          inspect: async () => staged,
          publish: async () => staged,
          commit: async () => staged,
          abort: async () => undefined,
        };
      },
      delete: async (mediaId: string) => {
        await cleanupByMediaId.get(mediaId)?.();
      },
      deleteFrame: async () => undefined,
    } as never,
    extractor: {
      extract: async (input) => {
        if (!processingContext) throw new Error("test receipt is required");
        if (processingContext.kind !== "c5-durable-processing-context-v2")
          throw new Error("test receipt must be storage-backed");
        const manifest = Object.freeze({
          attemptId: input.attemptId,
          generation: input.generation,
          mediaId: input.mediaId,
          mediaSha256: input.mediaSha256,
          mode: input.mode,
        }) as import("./extraction-manifest.js").ExtractionManifest;
        return manifest;
      },
      durableReceiptFor: () => {
        if (
          !processingContext ||
          processingContext.kind !== "c5-durable-processing-context-v2"
        )
          throw new Error("test receipt is required");
        return processingContext.receipt;
      },
    },
  });
  return Object.freeze({
    handoffVerifier: pipeline.handoffVerifier(),
    accept: async (
      context,
      storedMedia,
      nextCleanup = async () => undefined,
      sourceSha256 = "a".repeat(64),
    ) => {
      staged = {
        id: storedMedia.id,
        contentType: storedMedia.contentType as "video/mp4",
        bytes: storedMedia.bytes,
        sha256: sourceSha256,
        probe: {} as never,
        transitionResourceId: storedMedia.transition.resourceId,
      };
      processingContext = storageContext({
        frameBatchId: "55555555-5555-4555-8555-555555555555",
        mediaId: storedMedia.id,
        sha256: "b".repeat(64),
      });
      cleanupByMediaId.set(storedMedia.id, nextCleanup);
      try {
        return await pipeline.accept({
          mode: context.mode,
          source: chunks(Uint8Array.of(0)),
          maxBytes: 1,
          retention: {
            repository: {
              schedule: async () => ({ kind: "created" as const }),
              acknowledge: async () => undefined,
            },
            attemptId: context.attemptId,
            generation: context.generation,
            uploadedAt: context.uploadedAt,
            authority: context,
          },
        });
      } finally {
        staged = undefined;
        processingContext = undefined;
      }
    },
  });
}

async function* chunks(value: Uint8Array): AsyncIterable<Uint8Array> {
  yield value;
}
