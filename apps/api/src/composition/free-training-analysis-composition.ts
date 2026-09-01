import type { VisionBatchScheduler, VisionProvider } from "@revelai/vision";
import {
  resolveFactoryIssuedC5MediaPipelinePort,
  type C5MediaPipeline,
} from "../media/media-pipeline.js";
import type { AnalysisQueue } from "../queue/analysis-queue.js";
import {
  resolveProductionSQLiteAttemptProcessingPort,
  type SQLiteAttemptRepository,
} from "../repositories/sqlite-attempt-repository.js";
import {
  createFreeTrainingRuntime,
  type FreeTrainingRuntimeHandle,
} from "../services/free-training-runtime.js";
import { createProductionAttemptApi } from "./sqlite-media-upload-composition.js";

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
  assertFactoryIssuedFreeTrainingComposition(input);
  const processing = resolveProductionSQLiteAttemptProcessingPort(
    input.repository,
  );
  const c5 = resolveFactoryIssuedC5MediaPipelinePort(input.mediaPipeline);
  if (!processing || !c5)
    throw new Error("Free Training requires factory-issued C4/C5 composition.");

  const getProcessingContext = processing.processing.getProcessingContext;
  const reconstruct = c5.reconstructDurableProcessingContext;
  const readFrame = c5.readFrame;
  return createFreeTrainingRuntime({
    queue: input.queue,
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
      provider: input.options.provider,
      scheduler: input.options.scheduler,
      clock: input.options.clock ?? { now: () => new Date().toISOString() },
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
  // Validate immutable C4/C5 topology before createProductionAttemptApi starts
  // its recovery scheduler or creates a Fastify owner.
  assertFactoryIssuedFreeTrainingComposition(input);
  const app = createProductionAttemptApi(input);
  try {
    const runtime = createFactoryIssuedFreeTrainingRuntime({
      repository: input.repository,
      queue: input.queue,
      mediaPipeline: input.mediaPipeline,
      options: input.freeTraining,
    });
    app.addHook("onClose", () => {
      runtime.stop();
    });
    return app;
  } catch (error) {
    void app.close().catch(() => undefined);
    throw error;
  }
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
