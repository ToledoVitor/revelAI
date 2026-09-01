import { FailureMessageByCode } from "@revelai/contracts";
import type { AnalysisQueue } from "../queue/analysis-queue.js";
import type {
  ProcessingClaim,
  TerminalCandidate,
} from "../repositories/attempt-repository.js";
import {
  AnalysisWorker,
  type ProcessingRepository,
  type RetryWaiter,
  type UnexpectedRetryPolicy,
} from "../workers/analysis-worker.js";
import type { FreeTrainingAnalysisDependencies } from "./free-training-analysis.js";
import { createFreeTrainingAnalysisProcessor } from "./free-training-analysis.js";

export type FreeTrainingRuntimeHandle = Readonly<{
  stop(): Promise<void>;
}>;

const defaultRetryPolicy: UnexpectedRetryPolicy = Object.freeze({
  maxAttempts: 3,
  delayMilliseconds: 0,
  terminalCandidate: ({ job, claim }) => temporaryFailure(job, claim),
});

/**
 * Production runtime for only factory-routed Free jobs. The shared queue keeps
 * other modes pending until their own mode-specific worker is composed.
 */
export function createFreeTrainingRuntime(
  input: Readonly<{
    queue: AnalysisQueue;
    repository: ProcessingRepository;
    analysis: FreeTrainingAnalysisDependencies;
    retryPolicy?: UnexpectedRetryPolicy;
    retryWaiter?: RetryWaiter;
  }>,
): FreeTrainingRuntimeHandle {
  const worker = new AnalysisWorker({
    queue: input.queue,
    repository: input.repository,
    process: createFreeTrainingAnalysisProcessor(input.analysis),
    mode: "free",
    unexpectedRetryPolicy: input.retryPolicy ?? defaultRetryPolicy,
    retryWaiter: input.retryWaiter,
  });
  const unsubscribe = worker.start();
  return Object.freeze({ stop: unsubscribe });
}

function temporaryFailure(
  job: Readonly<{ attemptId: string }>,
  claim: ProcessingClaim,
): TerminalCandidate {
  return Object.freeze({
    state: "failed" as const,
    attemptId: job.attemptId,
    mode: claim.mode,
    code: "analysis_temporary_unavailable" as const,
    message: FailureMessageByCode.analysis_temporary_unavailable,
    retryable: true as const,
  });
}
