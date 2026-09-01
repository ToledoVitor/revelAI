import type { VisionBatchScheduler, VisionProvider } from "@revelai/vision";
import {
  resolveFactoryIssuedC5MediaPipelinePort,
  type C5MediaPipeline,
} from "../media/media-pipeline.js";
import type { AnalysisQueue } from "../queue/analysis-queue.js";
import { resolveFactoryIssuedAnalysisQueuePort } from "../queue/in-memory-analysis-queue.js";
import {
  resolveProductionSQLiteAttemptProcessingPort,
  type SQLiteAttemptRepository,
} from "../repositories/sqlite-attempt-repository.js";
import {
  createFreeTrainingRuntime,
  type FreeTrainingRuntimeHandle,
} from "../services/free-training-runtime.js";
import {
  createFactoryIssuedMediaUploadService,
  createProductionAttemptApi,
} from "./sqlite-media-upload-composition.js";

export type FreeTrainingProductionOptions = Readonly<{
  provider: VisionProvider;
  scheduler?: VisionBatchScheduler;
  clock?: Readonly<{ now(): string }>;
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
  const snapshot = Object.freeze({
    repository,
    queue: resolveRequiredAnalysisQueuePort(rawQueue),
    mediaPipeline,
    options: Object.freeze({ provider, scheduler, clock }),
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
    queue: snapshot.queue,
    mediaPipeline: snapshot.mediaPipeline,
  });
  assertFactoryIssuedFreeTrainingComposition({
    repository: snapshot.repository,
    mediaPipeline: snapshot.mediaPipeline,
  });
  const app = createProductionAttemptApi({
    repository: snapshot.repository,
    retention: snapshot.retention,
    queue: snapshot.queue,
    mediaPipeline: snapshot.mediaPipeline,
    cleaner: snapshot.cleaner,
    maxUploadBytes: snapshot.maxUploadBytes,
    scheduler: snapshot.scheduler,
    recoveryBatchLimit: snapshot.recoveryBatchLimit,
    clock: snapshot.clock,
    ids: snapshot.ids,
    nonce: snapshot.nonce,
    log: snapshot.log,
  });
  try {
    const runtime = createFactoryIssuedFreeTrainingRuntime({
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
  const rawFreeTraining = input.freeTraining;
  const provider = rawFreeTraining.provider;
  const visionScheduler = rawFreeTraining.scheduler;
  const visionClock = rawFreeTraining.clock;
  return Object.freeze({
    repository,
    retention,
    queue: rawQueue,
    mediaPipeline,
    cleaner,
    maxUploadBytes,
    scheduler,
    recoveryBatchLimit,
    clock,
    ids,
    nonce,
    log,
    freeTraining: Object.freeze({
      provider,
      scheduler: visionScheduler,
      clock: visionClock,
    }),
  });
}

function resolveRequiredAnalysisQueuePort(queue: AnalysisQueue): AnalysisQueue {
  const port = resolveFactoryIssuedAnalysisQueuePort(queue);
  if (!port)
    throw new Error("C8 requires a factory-issued media upload composition.");
  return port;
}

function assertFactoryIssuedFreeTrainingComposition(
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
