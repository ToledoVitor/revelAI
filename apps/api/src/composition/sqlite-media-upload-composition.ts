import {
  resolveFactoryIssuedC5MediaPipelinePort,
  type C5MediaPipeline,
} from "../media/media-pipeline.js";
import {
  resolveProductionSQLiteRetentionUploadPort,
  type SQLiteRetentionRepository,
} from "../media/sqlite-retention-repository.js";
import type { AnalysisQueue } from "../queue/analysis-queue.js";
import {
  resolveProductionSQLiteAttemptUploadPort,
  type SQLiteAttemptRepository,
} from "../repositories/sqlite-attempt-repository.js";
import { createMediaUploadService } from "../services/media-upload-service.js";
import {
  issueMediaUploadCapability,
  type MediaUploadCapability,
} from "./media-upload-capability.js";

/**
 * The only production issuer for HTTP media upload capability. It joins exact
 * C4/C5 SQLite facades, the C4-bound C5 verifier, and a captured queue. The
 * storage-agnostic service owns all use-case orchestration.
 */
export function createProductionMediaUploadCapability(
  input: Readonly<{
    repository: SQLiteAttemptRepository;
    retention: SQLiteRetentionRepository;
    queue: Pick<AnalysisQueue, "isAvailable" | "enqueue">;
    mediaPipeline: C5MediaPipeline;
  }>,
): MediaUploadCapability {
  const repository = input.repository;
  const retention = input.retention;
  const queue = input.queue;
  const pipeline = input.mediaPipeline;
  const attempt = resolveProductionSQLiteAttemptUploadPort(repository);
  const retentionPort = resolveProductionSQLiteRetentionUploadPort(retention);
  const c5 = resolveFactoryIssuedC5MediaPipelinePort(pipeline);
  if (
    !attempt ||
    !retentionPort ||
    !c5 ||
    attempt.token !== retentionPort.token ||
    !attempt.isCurrent() ||
    !retentionPort.isCurrent()
  )
    throw new Error("C8 requires a factory-issued media upload composition.");

  if (c5.handoffVerifier !== attempt.handoffVerifier)
    throw new Error("C8 media upload pipeline does not match C4 authority.");
  const isAvailable = queue.isAvailable;
  const enqueue = queue.enqueue;
  const service = createMediaUploadService({
    requireCurrent: () => {
      if (!attempt.isCurrent() || !retentionPort.isCurrent())
        throw new Error(
          "C8 requires a factory-issued media upload composition.",
        );
    },
    prepareMediaUpload: (request) => attempt.prepareMediaUpload(request),
    queue: Object.freeze({
      isAvailable: () => isAvailable.call(queue),
      enqueue: (job) => enqueue.call(queue, job),
    }),
    attachment: attempt.attachment,
    acceptMultipart: c5.acceptMultipart,
    retention: Object.freeze({
      schedule: retentionPort.schedule,
      acknowledge: retentionPort.acknowledge,
    }),
  });
  return issueMediaUploadCapability(service, { repository, queue });
}
