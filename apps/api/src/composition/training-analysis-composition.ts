import type { AnalysisQueue } from "../queue/analysis-queue.js";
import { resolveFactoryIssuedAnalysisQueuePort } from "../queue/in-memory-analysis-queue.js";
import type { ResolvedAnalysisQueuePort } from "../queue/analysis-queue-port.js";
import {
  createFactoryIssuedMediaUploadService,
  createProductionAttemptApi,
  createProductionAttemptApiFromResolvedQueue,
} from "./sqlite-media-upload-composition.js";
import {
  assertFactoryIssuedFreeTrainingComposition,
  createFactoryIssuedFreeTrainingRuntimeFromResolvedQueue,
  type FreeTrainingProductionOptions,
} from "./free-training-analysis-composition.js";
import {
  assertFactoryIssuedVerifiedTrainingComposition,
  createFactoryIssuedVerifiedTrainingRuntimeFromResolvedQueue,
  type VerifiedTrainingProductionOptions,
} from "./verified-training-analysis-composition.js";
import type { FreeTrainingRuntimeHandle } from "../services/free-training-runtime.js";

export type ProductionTrainingAttemptApiInput = Readonly<
  Parameters<typeof createProductionAttemptApi>[0] & {
    queue: AnalysisQueue;
    freeTraining: FreeTrainingProductionOptions;
    verifiedTraining: VerifiedTrainingProductionOptions;
  }
>;

/**
 * Official dual-mode C8 root. It validates every factory-issued host before
 * recovery or either worker starts, then shares only one resolved queue port.
 */
export function createProductionTrainingAttemptApi(
  input: ProductionTrainingAttemptApiInput,
) {
  const snapshot = snapshotTrainingAttemptApiInput(input);
  // Resolve all ownership joins before Fastify registers recovery or either
  // worker subscribes. Accessor-backed inputs cannot split mode runtimes.
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
  assertFactoryIssuedVerifiedTrainingComposition({
    repository: snapshot.repository,
    mediaPipeline: snapshot.mediaPipeline,
    policy: snapshot.verifiedTraining.policy,
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
  });
  let free: FreeTrainingRuntimeHandle | undefined;
  try {
    free = createFactoryIssuedFreeTrainingRuntimeFromResolvedQueue({
      repository: snapshot.repository,
      queue: snapshot.queue,
      mediaPipeline: snapshot.mediaPipeline,
      options: snapshot.freeTraining,
    });
    const verified =
      createFactoryIssuedVerifiedTrainingRuntimeFromResolvedQueue({
        repository: snapshot.repository,
        queue: snapshot.queue,
        mediaPipeline: snapshot.mediaPipeline,
        options: snapshot.verifiedTraining,
      });
    app.addHook("onClose", async () => {
      // Stop both intakes before allowing either provider callback to finish.
      await Promise.all([free?.stop(), verified.stop()]);
    });
    return app;
  } catch (error) {
    void free?.stop().catch(() => undefined);
    void app.close().catch(() => undefined);
    throw error;
  }
}

function snapshotTrainingAttemptApiInput(
  input: ProductionTrainingAttemptApiInput,
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
  const freeProvider = rawFreeTraining.provider;
  const freeScheduler = rawFreeTraining.scheduler;
  const freeClock = rawFreeTraining.clock;
  const rawVerifiedTraining = input.verifiedTraining;
  const verifiedProvider = rawVerifiedTraining.provider;
  const verifiedScheduler = rawVerifiedTraining.scheduler;
  const verifiedClock = rawVerifiedTraining.clock;
  const verifiedPolicy = rawVerifiedTraining.policy;
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
    freeTraining: Object.freeze({
      provider: freeProvider,
      scheduler: freeScheduler,
      clock: freeClock,
    }),
    verifiedTraining: Object.freeze({
      provider: verifiedProvider,
      scheduler: verifiedScheduler,
      clock: verifiedClock,
      policy: verifiedPolicy,
    }),
  });
}

function resolveRequiredAnalysisQueuePort(
  queue: AnalysisQueue,
): ResolvedAnalysisQueuePort {
  const port = resolveFactoryIssuedAnalysisQueuePort(queue);
  if (!port)
    throw new Error("C8 requires a factory-issued training analysis queue.");
  return port;
}
