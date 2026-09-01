import {
  resolveFactoryIssuedC5MediaPipelinePort,
  type C5MediaPipeline,
} from "../media/media-pipeline.js";
import {
  resolveProductionSQLiteRetentionUploadPort,
  type SQLiteRetentionRepository,
} from "../media/sqlite-retention-repository.js";
import type { RetentionLog } from "../media/retention-scavenger.js";
import type { AnalysisQueue } from "../queue/analysis-queue.js";
import type { ResolvedAnalysisQueuePort } from "../queue/analysis-queue-port.js";
import {
  isFactoryIssuedAnalysisQueuePortForHost,
  resolveFactoryIssuedAnalysisQueuePort,
} from "../queue/in-memory-analysis-queue.js";
import {
  resolveProductionSQLiteAttemptUploadPort,
  resolveProductionSQLiteAttemptProcessingPort,
  type SQLiteAttemptRepository,
} from "../repositories/sqlite-attempt-repository.js";
import {
  createMediaUploadService,
  type BoundMediaUploadService,
} from "../services/media-upload-service.js";
import {
  createC8RetentionRuntime,
  type RetentionRuntimeFactory,
} from "../services/retention-runtime.js";
import { createInternallyComposedAttemptApi } from "../http/attempt-api.js";

type ProductionAttemptApiInput = Readonly<
  Omit<
    Parameters<typeof createInternallyComposedAttemptApi>[0],
    "repository" | "queue" | "leaderboard" | "tombstone" | "retentionRuntime"
  > & {
    repository: SQLiteAttemptRepository;
    retention: SQLiteRetentionRepository;
    mediaPipeline: C5MediaPipeline;
    queue: AnalysisQueue;
  }
>;
type ResolvedProductionAttemptApiInput = Readonly<
  Omit<
    Parameters<typeof createInternallyComposedAttemptApi>[0],
    "repository" | "queue" | "leaderboard" | "tombstone" | "retentionRuntime"
  > & {
    repository: SQLiteAttemptRepository;
    retention: SQLiteRetentionRepository;
    mediaPipeline: C5MediaPipeline;
    queue: ResolvedAnalysisQueuePort;
    queueHost: AnalysisQueue;
  }
>;

/**
 * The outer production composition root joins exact C4/C5 SQLite facades,
 * then supplies only captured closure ports to the storage-neutral service.
 */
export function createFactoryIssuedMediaUploadService(
  input: Readonly<{
    repository: SQLiteAttemptRepository;
    retention: SQLiteRetentionRepository;
    queue: Pick<AnalysisQueue, "isAvailable" | "enqueue">;
    mediaPipeline: C5MediaPipeline;
  }>,
): BoundMediaUploadService {
  const repository = input.repository;
  const retention = input.retention;
  const queue = input.queue;
  const pipeline = input.mediaPipeline;
  const snapshot = Object.freeze({ repository, retention, queue, pipeline });
  const attempt = resolveProductionSQLiteAttemptUploadPort(snapshot.repository);
  const retentionPort = resolveProductionSQLiteRetentionUploadPort(
    snapshot.retention,
  );
  const c5 = resolveFactoryIssuedC5MediaPipelinePort(snapshot.pipeline);
  const queuePort = resolveFactoryIssuedAnalysisQueuePort(snapshot.queue);
  if (
    !attempt ||
    !retentionPort ||
    !c5 ||
    !queuePort ||
    attempt.token !== retentionPort.token ||
    !attempt.isCurrent() ||
    !retentionPort.isCurrent()
  )
    throw new Error("C8 requires a factory-issued media upload composition.");
  if (c5.handoffVerifier !== attempt.handoffVerifier)
    throw new Error("C8 media upload pipeline does not match C4 authority.");

  const service = createMediaUploadService({
    requireCurrent: () => {
      if (!attempt.isCurrent() || !retentionPort.isCurrent())
        throw new Error(
          "C8 requires a factory-issued media upload composition.",
        );
    },
    prepareMediaUpload: (request) => attempt.prepareMediaUpload(request),
    queue: Object.freeze({
      isAvailable: queuePort.isAvailable,
      enqueue: queuePort.enqueue,
    }),
    attachment: attempt.attachment,
    acceptMultipart: c5.acceptMultipart,
    retention: Object.freeze({
      schedule: retentionPort.schedule,
      acknowledge: retentionPort.acknowledge,
    }),
  });
  const host = Object.freeze({
    repository: snapshot.repository,
    queue: snapshot.queue,
  });
  return Object.freeze({
    forHost: (candidate) =>
      candidate.repository === host.repository && candidate.queue === host.queue
        ? service
        : undefined,
  });
}

/**
 * Binds the only C5 physical-retention capability to the same exact C4 and
 * retention database host. HTTP receives only the start closure, never a
 * storage adapter or a retention repository it could replay against.
 */
export function createFactoryIssuedRetentionRuntimeFactory(
  input: Readonly<{
    repository: SQLiteAttemptRepository;
    retention: SQLiteRetentionRepository;
    mediaPipeline: C5MediaPipeline;
    log?: RetentionLog;
  }>,
): RetentionRuntimeFactory {
  const repository = input.repository;
  const retention = input.retention;
  const pipeline = input.mediaPipeline;
  const log = input.log;
  const snapshot = Object.freeze({ repository, retention, pipeline, log });
  const processing = resolveProductionSQLiteAttemptProcessingPort(
    snapshot.repository,
  );
  const retentionPort = resolveProductionSQLiteRetentionUploadPort(
    snapshot.retention,
  );
  const c5 = resolveFactoryIssuedC5MediaPipelinePort(snapshot.pipeline);
  if (
    !processing ||
    !retentionPort ||
    !c5 ||
    processing.token !== retentionPort.token ||
    processing.handoffVerifier !== c5.handoffVerifier ||
    !processing.isCurrent() ||
    !retentionPort.isCurrent()
  )
    throw new Error("C8 requires a factory-issued retention composition.");

  const listDue = retentionPort.listDue;
  const acknowledge = retentionPort.acknowledge;
  const deleteRetentionRecord = c5.deleteRetentionRecord;
  const retentionLog = snapshot.log ?? silentRetentionLog;
  const requireCurrent = () => {
    if (!processing.isCurrent() || !retentionPort.isCurrent())
      throw new Error("C8 retention composition is no longer current.");
  };
  return Object.freeze({
    start: ({
      scheduler,
      maxBatchSize,
      now,
    }: Parameters<RetentionRuntimeFactory["start"]>[0]) => {
      requireCurrent();
      return createC8RetentionRuntime({
        owner: snapshot.retention,
        repository: Object.freeze({
          listDue: (request: Parameters<typeof listDue>[0]) => {
            requireCurrent();
            return listDue(request);
          },
          acknowledge: (record: Parameters<typeof acknowledge>[0]) => {
            requireCurrent();
            return acknowledge(record);
          },
        }),
        objects: Object.freeze({
          delete: (record: Parameters<typeof deleteRetentionRecord>[0]) => {
            requireCurrent();
            return deleteRetentionRecord(record);
          },
        }),
        log: retentionLog,
        scheduler,
        maxBatchSize,
        now,
      });
    },
  });
}

const silentRetentionLog: RetentionLog = Object.freeze({
  event: () => undefined,
});

/** Official production root: verified adapters compose before HTTP wiring. */
export function createProductionAttemptApi(input: ProductionAttemptApiInput) {
  const snapshot = snapshotProductionAttemptApiInput(input);
  const queue = resolveRequiredAnalysisQueuePort(snapshot.queue);
  return createProductionAttemptApiFromResolvedQueue({
    repository: snapshot.repository,
    retention: snapshot.retention,
    mediaPipeline: snapshot.mediaPipeline,
    queue,
    queueHost: snapshot.queue,
    cleaner: snapshot.cleaner,
    maxUploadBytes: snapshot.maxUploadBytes,
    scheduler: snapshot.scheduler,
    recoveryBatchLimit: snapshot.recoveryBatchLimit,
    clock: snapshot.clock,
    ids: snapshot.ids,
    nonce: snapshot.nonce,
    log: snapshot.log,
    retentionLog: snapshot.retentionLog,
  });
}

/**
 * Outer-composition seam for a caller that already resolved one exact queue
 * port. It validates port-to-host identity before HTTP or recovery can start.
 */
export function createProductionAttemptApiFromResolvedQueue(
  input: ResolvedProductionAttemptApiInput,
) {
  const snapshot = snapshotResolvedProductionAttemptApiInput(input);
  if (
    !isFactoryIssuedAnalysisQueuePortForHost(snapshot.queue, snapshot.queueHost)
  )
    throw new Error("C8 requires a factory-issued media upload composition.");
  const processing = resolveProductionSQLiteAttemptProcessingPort(
    snapshot.repository,
  );
  if (!processing || !processing.isCurrent())
    throw new Error("C8 requires a factory-issued leaderboard composition.");
  const mediaUpload = createFactoryIssuedMediaUploadService({
    repository: snapshot.repository,
    retention: snapshot.retention,
    queue: snapshot.queueHost,
    mediaPipeline: snapshot.mediaPipeline,
  });
  const service = mediaUpload.forHost(
    Object.freeze({
      repository: snapshot.repository,
      queue: snapshot.queueHost,
    }),
  );
  if (!service)
    throw new Error("C8 media upload does not match this attempt API host.");
  // Resolve this before HTTP starts either scheduled owner. A malformed,
  // cloned, cross-database, or mutation-stale retention host therefore cannot
  // leave recovery running without its paired retention consumer.
  const retentionRuntime = createFactoryIssuedRetentionRuntimeFactory({
    repository: snapshot.repository,
    retention: snapshot.retention,
    mediaPipeline: snapshot.mediaPipeline,
    log: snapshot.retentionLog,
  });
  const listLiveLeaderboard = processing.processing.listLiveLeaderboard;
  const tombstoneAttempt = processing.processing.tombstoneAttempt;
  return createInternallyComposedAttemptApi(
    Object.freeze({
      repository: snapshot.repository,
      queue: snapshot.queue,
      cleaner: snapshot.cleaner,
      maxUploadBytes: snapshot.maxUploadBytes,
      scheduler: snapshot.scheduler,
      recoveryBatchLimit: snapshot.recoveryBatchLimit,
      clock: snapshot.clock,
      ids: snapshot.ids,
      nonce: snapshot.nonce,
      log: snapshot.log,
      retentionRuntime,
      leaderboard: Object.freeze({
        listLiveLeaderboard: (
          input: Parameters<typeof listLiveLeaderboard>[0],
        ) => {
          if (!processing.isCurrent())
            throw new Error(
              "C8 requires a factory-issued leaderboard composition.",
            );
          return listLiveLeaderboard(input);
        },
      }),
      tombstone: Object.freeze({
        tombstoneAttempt: (input: Parameters<typeof tombstoneAttempt>[0]) => {
          if (!processing.isCurrent())
            throw new Error(
              "C8 requires a factory-issued tombstone composition.",
            );
          return tombstoneAttempt(input);
        },
      }),
    }),
    service,
  );
}

function snapshotProductionAttemptApiInput(
  input: ProductionAttemptApiInput,
): ProductionAttemptApiInput {
  const repository = input.repository;
  const retention = input.retention;
  const mediaPipeline = input.mediaPipeline;
  const queue = input.queue;
  const cleaner = input.cleaner;
  const maxUploadBytes = input.maxUploadBytes;
  const scheduler = input.scheduler;
  const recoveryBatchLimit = input.recoveryBatchLimit;
  const clock = input.clock;
  const ids = input.ids;
  const nonce = input.nonce;
  const log = input.log;
  const retentionLog = input.retentionLog;
  return Object.freeze({
    repository,
    retention,
    mediaPipeline,
    queue,
    cleaner,
    maxUploadBytes,
    scheduler,
    recoveryBatchLimit,
    clock,
    ids,
    nonce,
    log,
    retentionLog,
  });
}

function snapshotResolvedProductionAttemptApiInput(
  input: ResolvedProductionAttemptApiInput,
): ResolvedProductionAttemptApiInput {
  const repository = input.repository;
  const retention = input.retention;
  const mediaPipeline = input.mediaPipeline;
  const queue = input.queue;
  const queueHost = input.queueHost;
  const cleaner = input.cleaner;
  const maxUploadBytes = input.maxUploadBytes;
  const scheduler = input.scheduler;
  const recoveryBatchLimit = input.recoveryBatchLimit;
  const clock = input.clock;
  const ids = input.ids;
  const nonce = input.nonce;
  const log = input.log;
  const retentionLog = input.retentionLog;
  return Object.freeze({
    repository,
    retention,
    mediaPipeline,
    queue,
    queueHost,
    cleaner,
    maxUploadBytes,
    scheduler,
    recoveryBatchLimit,
    clock,
    ids,
    nonce,
    log,
    retentionLog,
  });
}

function resolveRequiredAnalysisQueuePort(
  queue: AnalysisQueue,
): ResolvedAnalysisQueuePort {
  const port = resolveFactoryIssuedAnalysisQueuePort(queue);
  if (!port)
    throw new Error("C8 requires a factory-issued media upload composition.");
  return port;
}
