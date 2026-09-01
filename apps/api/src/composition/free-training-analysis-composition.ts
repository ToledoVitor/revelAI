import type { VisionBatchScheduler, VisionProvider } from "@revelai/vision";
import {
  resolveFactoryIssuedC5MediaPipelinePort,
  type C5MediaPipeline,
} from "../media/media-pipeline.js";
import type { AnalysisQueue } from "../queue/analysis-queue.js";
import type { ResolvedAnalysisQueuePort } from "../queue/analysis-queue-port.js";
import { resolveFactoryIssuedAnalysisQueuePort } from "../queue/in-memory-analysis-queue.js";
import {
  resolveProductionSQLiteAttemptProcessingPort,
  type SQLiteAttemptRepository,
} from "../repositories/sqlite-attempt-repository.js";
import {
  createFreeTrainingRuntime,
  type FreeTrainingRuntimeHandle,
} from "../services/free-training-runtime.js";
import type { FreeTrainingForbiddenPorts } from "../services/free-training-analysis.js";
import {
  createFactoryIssuedMediaUploadService,
  createProductionAttemptApi,
  createProductionAttemptApiFromResolvedQueue,
} from "./sqlite-media-upload-composition.js";

export type FreeTrainingProductionOptions = Readonly<{
  provider: VisionProvider;
  scheduler?: VisionBatchScheduler;
  clock?: Readonly<{ now(): string }>;
  forbiddenPorts?: FreeTrainingForbiddenPorts;
}>;

/**
 * Sole production join for C4 claims, C5 durable bytes, and the Free Vision
 * branch. It deliberately returns no repository/storage adapter to C8 HTTP.
 */
export function createFactoryIssuedFreeTrainingRuntime(
  input: Readonly<{
    repository: SQLiteAttemptRepository;
    queue: AnalysisQueue;
    mediaPipeline: C5MediaPipeline;
    options: FreeTrainingProductionOptions;
  }>,
): FreeTrainingRuntimeHandle {
  const repository = input.repository;
  const rawQueue = input.queue;
  const mediaPipeline = input.mediaPipeline;
  const rawOptions = input.options;
  const provider = rawOptions.provider;
  const scheduler = rawOptions.scheduler;
  const clock = rawOptions.clock;
  const forbiddenPorts = rawOptions.forbiddenPorts;
  const snapshot = Object.freeze({
    repository,
    queue: rawQueue,
    mediaPipeline,
    options: Object.freeze({ provider, scheduler, clock, forbiddenPorts }),
  });
  const queue = resolveRequiredAnalysisQueuePort(snapshot.queue);
  return createFactoryIssuedFreeTrainingRuntimeFromResolvedQueue({
    repository: snapshot.repository,
    queue,
    mediaPipeline: snapshot.mediaPipeline,
    options: snapshot.options,
  });
}

export function createFactoryIssuedFreeTrainingRuntimeFromResolvedQueue(
  input: Readonly<{
    repository: SQLiteAttemptRepository;
    queue: ResolvedAnalysisQueuePort;
    mediaPipeline: C5MediaPipeline;
    options: FreeTrainingProductionOptions;
  }>,
): FreeTrainingRuntimeHandle {
  const repository = input.repository;
  const mediaPipeline = input.mediaPipeline;
  const rawOptions = input.options;
  const provider = rawOptions.provider;
  const scheduler = rawOptions.scheduler;
  const clock = rawOptions.clock;
  const forbiddenPorts = rawOptions.forbiddenPorts;
  const snapshot = Object.freeze({
    repository,
    queue: input.queue,
    mediaPipeline,
    options: Object.freeze({ provider, scheduler, clock, forbiddenPorts }),
  });
  assertFactoryIssuedFreeTrainingComposition(snapshot);
  const processing = resolveProductionSQLiteAttemptProcessingPort(
    snapshot.repository,
  );
  const c5 = resolveFactoryIssuedC5MediaPipelinePort(snapshot.mediaPipeline);
  if (!processing || !c5)
    throw new Error("Free Training requires factory-issued C4/C5 composition.");

  const getProcessingContext = processing.processing.getProcessingContext;
  const reconstruct = c5.reconstructDurableProcessingContext;
  const readFrame = c5.readFrame;
  return createFreeTrainingRuntime({
    queue: snapshot.queue,
    repository: processing.processing,
    analysis: {
      getProcessingContext: async (claim) => {
        if (!processing.isCurrent())
          throw new Error("Free Training composition is no longer current.");
        return getProcessingContext(claim);
      },
      reconstruct: async (request) => {
        if (!processing.isCurrent())
          throw new Error("Free Training composition is no longer current.");
        return reconstruct(request);
      },
      frames: Object.freeze({ readFrame }),
      provider: snapshot.options.provider,
      scheduler: snapshot.options.scheduler,
      clock: snapshot.options.clock ?? { now: () => new Date().toISOString() },
    },
    forbiddenPorts: snapshot.options.forbiddenPorts,
  });
}

/**
 * Official Free vertical-slice root. It starts the mode-scoped worker next to
 * the existing C8 recovery/app owner and closes it with that app; Verified
 * deliveries remain pending for their separate future composition.
 */
export function createProductionFreeTrainingAttemptApi(
  input: Readonly<
    Parameters<typeof createProductionAttemptApi>[0] & {
      queue: AnalysisQueue;
      freeTraining: FreeTrainingProductionOptions;
    }
  >,
) {
  const snapshot = snapshotFreeTrainingApiInput(input);
  // Resolve every C4/C5/queue/retention join before Fastify starts recovery.
  // An accessor cannot therefore split the HTTP host from the Free worker.
  void createFactoryIssuedMediaUploadService({
    repository: snapshot.repository,
    retention: snapshot.retention,
    queue: snapshot.queueHost,
    mediaPipeline: snapshot.mediaPipeline,
  });
  assertFactoryIssuedFreeTrainingComposition({
    repository: snapshot.repository,
    mediaPipeline: snapshot.mediaPipeline,
  });
  const app = createProductionAttemptApiFromResolvedQueue({
    repository: snapshot.repository,
    retention: snapshot.retention,
    queue: snapshot.queue,
    queueHost: snapshot.queueHost,
    mediaPipeline: snapshot.mediaPipeline,
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
  try {
    const runtime = createFactoryIssuedFreeTrainingRuntimeFromResolvedQueue({
      repository: snapshot.repository,
      queue: snapshot.queue,
      mediaPipeline: snapshot.mediaPipeline,
      options: snapshot.freeTraining,
    });
    app.addHook("onClose", async () => {
      await runtime.stop();
    });
    return app;
  } catch (error) {
    void app.close().catch(() => undefined);
    throw error;
  }
}

function snapshotFreeTrainingApiInput(
  input: Readonly<
    Parameters<typeof createProductionAttemptApi>[0] & {
      queue: AnalysisQueue;
      freeTraining: FreeTrainingProductionOptions;
    }
  >,
) {
  const repository = input.repository;
  const retention = input.retention;
  const rawQueue = input.queue;
  const mediaPipeline = input.mediaPipeline;
  const cleaner = input.cleaner;
  const maxUploadBytes = input.maxUploadBytes;
  const scheduler = input.scheduler;
  const recoveryBatchLimit = input.recoveryBatchLimit;
  const clock = input.clock;
  const ids = input.ids;
  const nonce = input.nonce;
  const log = input.log;
  const retentionLog = input.retentionLog;
  const rawFreeTraining = input.freeTraining;
  const provider = rawFreeTraining.provider;
  const visionScheduler = rawFreeTraining.scheduler;
  const visionClock = rawFreeTraining.clock;
  const forbiddenPorts = rawFreeTraining.forbiddenPorts;
  return Object.freeze({
    repository,
    retention,
    queueHost: rawQueue,
    queue: resolveRequiredAnalysisQueuePort(rawQueue),
    mediaPipeline,
    cleaner,
    maxUploadBytes,
    scheduler,
    recoveryBatchLimit,
    clock,
    ids,
    nonce,
    log,
    retentionLog,
    freeTraining: Object.freeze({
      provider,
      scheduler: visionScheduler,
      clock: visionClock,
      forbiddenPorts,
    }),
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

export function assertFactoryIssuedFreeTrainingComposition(
  input: Readonly<{
    repository: SQLiteAttemptRepository;
    mediaPipeline: C5MediaPipeline;
  }>,
): void {
  const processing = resolveProductionSQLiteAttemptProcessingPort(
    input.repository,
  );
  const c5 = resolveFactoryIssuedC5MediaPipelinePort(input.mediaPipeline);
  if (
    !processing ||
    !c5 ||
    !processing.isCurrent() ||
    processing.handoffVerifier !== c5.handoffVerifier
  )
    throw new Error("Free Training requires factory-issued C4/C5 composition.");
}
