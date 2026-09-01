import {
  resolveFactoryIssuedC5MediaPipelinePort,
  type C5MediaPipeline,
} from "../media/media-pipeline.js";
import {
  resolveProductionSQLiteRetentionUploadPort,
  type SQLiteRetentionRepository,
} from "../media/sqlite-retention-repository.js";
import type { AnalysisQueue } from "../queue/analysis-queue.js";
import { resolveFactoryIssuedAnalysisQueuePort } from "../queue/in-memory-analysis-queue.js";
import {
  resolveProductionSQLiteAttemptUploadPort,
  type SQLiteAttemptRepository,
} from "../repositories/sqlite-attempt-repository.js";
import {
  createMediaUploadService,
  type BoundMediaUploadService,
} from "../services/media-upload-service.js";
import { createInternallyComposedAttemptApi } from "../http/attempt-api.js";

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
  const attempt = resolveProductionSQLiteAttemptUploadPort(repository);
  const retentionPort = resolveProductionSQLiteRetentionUploadPort(retention);
  const c5 = resolveFactoryIssuedC5MediaPipelinePort(pipeline);
  const queuePort = resolveFactoryIssuedAnalysisQueuePort(queue);
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
  const host = Object.freeze({ repository, queue });
  return Object.freeze({
    forHost: (candidate) =>
      candidate.repository === host.repository && candidate.queue === host.queue
        ? service
        : undefined,
  });
}

/** Official production root: verified adapters compose before HTTP wiring. */
export function createProductionAttemptApi(
  input: Readonly<
    Omit<
      Parameters<typeof createInternallyComposedAttemptApi>[0],
      "repository"
    > & {
      repository: SQLiteAttemptRepository;
      retention: SQLiteRetentionRepository;
      mediaPipeline: C5MediaPipeline;
    }
  >,
) {
  const { retention, mediaPipeline, ...api } = input;
  const mediaUpload = createFactoryIssuedMediaUploadService({
    repository: api.repository,
    retention,
    queue: api.queue,
    mediaPipeline,
  });
  return createInternallyComposedAttemptApi(api, mediaUpload);
}
