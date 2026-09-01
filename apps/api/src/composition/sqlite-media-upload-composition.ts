import {
  resolveFactoryIssuedC5MediaPipelinePort,
  type C5MediaPipeline,
} from "../media/media-pipeline.js";
import {
  resolveProductionSQLiteRetentionUploadPort,
  type SQLiteRetentionRepository,
} from "../media/sqlite-retention-repository.js";
import type { AnalysisQueue } from "../queue/analysis-queue.js";
import type { ResolvedAnalysisQueuePort } from "../queue/analysis-queue-port.js";
import {
  isFactoryIssuedAnalysisQueuePortForHost,
  resolveFactoryIssuedAnalysisQueuePort,
} from "../queue/in-memory-analysis-queue.js";
import {
  resolveProductionSQLiteAttemptUploadPort,
  type SQLiteAttemptRepository,
} from "../repositories/sqlite-attempt-repository.js";
import {
  createMediaUploadService,
  type BoundMediaUploadService,
} from "../services/media-upload-service.js";
import { createInternallyComposedAttemptApi } from "../http/attempt-api.js";

type ProductionAttemptApiInput = Readonly<
  Omit<
    Parameters<typeof createInternallyComposedAttemptApi>[0],
    "repository" | "queue"
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
    "repository" | "queue"
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
