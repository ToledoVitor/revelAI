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
import {
  createMediaUploadService,
  createUnavailableMediaUploadService,
  type MediaUploadService,
} from "../services/media-upload-service.js";

type IssuedMediaUploadHost = Readonly<{
  repository: object;
  queue: object;
  service: MediaUploadService;
}>;

const productionMediaUploadServices = new WeakMap<
  object,
  IssuedMediaUploadHost
>();

/**
 * The only production issuer for HTTP media upload capability. It joins exact
 * C4/C5 SQLite facades, the C4-bound C5 verifier, and a captured queue. The
 * storage-agnostic service owns all use-case orchestration.
 */
export function createProductionMediaUploadService(
  input: Readonly<{
    repository: SQLiteAttemptRepository;
    retention: SQLiteRetentionRepository;
    queue: Pick<AnalysisQueue, "isAvailable" | "enqueue">;
    mediaPipeline: C5MediaPipeline;
  }>,
): MediaUploadService {
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
  issueMediaUploadService(service, { repository, queue });
  return service;
}

/** Issues a host-bound rejection-only route when C5 is not composed. */
export function createUnavailableProductionMediaUploadService(
  input: Readonly<{ repository: object; queue: object }>,
): MediaUploadService {
  const service = createUnavailableMediaUploadService();
  issueMediaUploadService(service, input);
  return service;
}

/** Only an exact issued capability can be paired with its original API host. */
export function isProductionMediaUploadServiceForHost(
  value: unknown,
  input: Readonly<{ repository: unknown; queue: unknown }>,
): value is MediaUploadService {
  return resolveProductionMediaUploadServiceForHost(value, input) !== undefined;
}

/** Resolves a host-bound service only after the opaque issuer check succeeds. */
export function resolveProductionMediaUploadServiceForHost(
  value: unknown,
  input: Readonly<{ repository: unknown; queue: unknown }>,
): MediaUploadService | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const issued = productionMediaUploadServices.get(value);
  if (
    issued !== undefined &&
    issued.repository === input.repository &&
    issued.queue === input.queue
  )
    return issued.service;
  return undefined;
}

function issueMediaUploadService(
  service: MediaUploadService,
  input: Readonly<{ repository: object; queue: object }>,
): void {
  productionMediaUploadServices.set(
    service,
    Object.freeze({ ...input, service }),
  );
}
