import type { VisionBatchScheduler, VisionProvider } from "@revelai/vision";
import {
  resolveFactoryIssuedC5MediaPipelinePort,
  type C5MediaPipeline,
} from "../media/media-pipeline.js";
import type { AnalysisQueue } from "../queue/analysis-queue.js";
import type { ResolvedAnalysisQueuePort } from "../queue/analysis-queue-port.js";
import { resolveFactoryIssuedAnalysisQueuePort } from "../queue/in-memory-analysis-queue.js";
import type { CompetitivePolicyLookup } from "../processing/competitive-policy.js";
import {
  resolveProductionSQLiteAttemptProcessingPort,
  type SQLiteAttemptRepository,
} from "../repositories/sqlite-attempt-repository.js";
import { resolveRankedCandidatePolicyFinalization } from "../repositories/attempt-repository.js";
import {
  issueRankedPolicyFinalization,
  resolveProductionSQLiteCompetitivePolicyLookupPort,
  type SQLiteCompetitivePolicyRepository,
} from "../repositories/sqlite-competitive-policy-repository.js";
import {
  createVerifiedTrainingRuntime,
  type VerifiedTrainingRuntimeHandle,
} from "../services/verified-training-runtime.js";

export type VerifiedTrainingProductionOptions = Readonly<{
  provider: VisionProvider;
  scheduler?: VisionBatchScheduler;
  clock?: Readonly<{ now(): string }>;
  policy?: SQLiteCompetitivePolicyRepository;
}>;

const noApprovedCompetitivePolicy: CompetitivePolicyLookup = Object.freeze({
  getActivePolicy: async () => null,
});
/**
 * Sole production join for C4 claims, C5 durable bytes, C6 evidence, and C7
 * policy. C8 HTTP receives no repository, policy, or provider internals.
 */
export function createFactoryIssuedVerifiedTrainingRuntime(
  input: Readonly<{
    repository: SQLiteAttemptRepository;
    queue: AnalysisQueue;
    mediaPipeline: C5MediaPipeline;
    options: VerifiedTrainingProductionOptions;
  }>,
): VerifiedTrainingRuntimeHandle {
  const repository = input.repository;
  const rawQueue = input.queue;
  const mediaPipeline = input.mediaPipeline;
  const rawOptions = input.options;
  const provider = rawOptions.provider;
  const scheduler = rawOptions.scheduler;
  const clock = rawOptions.clock;
  const rawPolicy = rawOptions.policy;
  return createFactoryIssuedVerifiedTrainingRuntimeFromResolvedQueue({
    repository,
    queue: resolveRequiredAnalysisQueuePort(rawQueue),
    mediaPipeline,
    options: Object.freeze({
      provider,
      scheduler,
      clock,
      policy: rawPolicy,
    }),
  });
}

export function createFactoryIssuedVerifiedTrainingRuntimeFromResolvedQueue(
  input: Readonly<{
    repository: SQLiteAttemptRepository;
    queue: ResolvedAnalysisQueuePort;
    mediaPipeline: C5MediaPipeline;
    options: VerifiedTrainingProductionOptions;
  }>,
): VerifiedTrainingRuntimeHandle {
  const repository = input.repository;
  const queue = input.queue;
  const mediaPipeline = input.mediaPipeline;
  const rawOptions = input.options;
  const provider = rawOptions.provider;
  const scheduler = rawOptions.scheduler;
  const clock = rawOptions.clock;
  const policy = rawOptions.policy;
  const snapshot = Object.freeze({
    repository,
    queue,
    mediaPipeline,
    options: Object.freeze({
      provider,
      scheduler,
      clock,
      policy,
    }),
  });
  assertFactoryIssuedVerifiedTrainingComposition({
    repository: snapshot.repository,
    mediaPipeline: snapshot.mediaPipeline,
    policy: snapshot.options.policy,
  });
  const processing = resolveProductionSQLiteAttemptProcessingPort(
    snapshot.repository,
  );
  const c5 = resolveFactoryIssuedC5MediaPipelinePort(snapshot.mediaPipeline);
  const policyPort = snapshot.options.policy
    ? resolveProductionSQLiteCompetitivePolicyLookupPort(
        snapshot.options.policy,
      )
    : undefined;
  if (!processing || !c5)
    throw new Error(
      "Verified Training requires factory-issued C4/C5 composition.",
    );

  const getProcessingContext = processing.processing.getProcessingContext;
  const reconstruct = c5.reconstructDurableProcessingContext;
  const readFrame = c5.readFrame;
  const finalizeTerminalResult = processing.processing.finalizeTerminalResult;
  return createVerifiedTrainingRuntime({
    queue: snapshot.queue,
    repository: Object.freeze({
      ...processing.processing,
      finalizeTerminalResult: (
        input: Parameters<typeof finalizeTerminalResult>[0],
      ) => {
        if (!processing.isCurrent())
          throw new Error(
            "Verified Training composition is no longer current.",
          );
        return finalizeTerminalResult({
          ...input,
          rankedPolicy: resolveRankedCandidatePolicyFinalization(
            input.candidate,
          ),
        });
      },
    }),
    analysis: {
      getProcessingContext: async (claim) => {
        if (!processing.isCurrent())
          throw new Error(
            "Verified Training composition is no longer current.",
          );
        return getProcessingContext(claim);
      },
      reconstruct: async (request) => {
        if (!processing.isCurrent())
          throw new Error(
            "Verified Training composition is no longer current.",
          );
        return reconstruct(request);
      },
      frames: Object.freeze({ readFrame }),
      provider: snapshot.options.provider,
      scheduler: snapshot.options.scheduler,
      policy: policyPort?.lookup ?? noApprovedCompetitivePolicy,
      issueRankedPolicyFinalization: policyPort
        ? (activation) =>
            issueRankedPolicyFinalization(policyPort.finalization, activation)
        : undefined,
      clock: snapshot.options.clock ?? { now: () => new Date().toISOString() },
    },
  });
}

/** Verifies the exact C4/C5/policy host before any queue subscription starts. */
export function assertFactoryIssuedVerifiedTrainingComposition(
  input: Readonly<{
    repository: SQLiteAttemptRepository;
    mediaPipeline: C5MediaPipeline;
    policy?: SQLiteCompetitivePolicyRepository;
  }>,
): void {
  const processing = resolveProductionSQLiteAttemptProcessingPort(
    input.repository,
  );
  const c5 = resolveFactoryIssuedC5MediaPipelinePort(input.mediaPipeline);
  const policyPort = input.policy
    ? resolveProductionSQLiteCompetitivePolicyLookupPort(input.policy)
    : undefined;
  if (
    !processing ||
    !c5 ||
    !processing.isCurrent() ||
    processing.handoffVerifier !== c5.handoffVerifier ||
    (input.policy !== undefined &&
      (!policyPort ||
        !policyPort.isCurrent() ||
        policyPort.token !== processing.token))
  )
    throw new Error(
      "Verified Training requires factory-issued C4/C5 composition.",
    );
}

function resolveRequiredAnalysisQueuePort(
  queue: AnalysisQueue,
): ResolvedAnalysisQueuePort {
  const port = resolveFactoryIssuedAnalysisQueuePort(queue);
  if (!port)
    throw new Error("C8 requires a factory-issued verified analysis queue.");
  return port;
}
