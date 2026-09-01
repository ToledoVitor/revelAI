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
import {
  createVerifiedTrainingAnalysisProcessor,
  type VerifiedTrainingAnalysisDependencies,
} from "./verified-training-analysis.js";

export type VerifiedTrainingRuntimeHandle = Readonly<{
  stop(): Promise<void>;
}>;

const defaultRetryPolicy: UnexpectedRetryPolicy = Object.freeze({
  maxAttempts: 3,
  delayMilliseconds: 0,
  terminalCandidate: ({ job, claim }) => temporaryFailure(job, claim),
});

/** Starts the mode-scoped Verified worker with C4-owned retry/lease semantics. */
export function createVerifiedTrainingRuntime(
  input: Readonly<{
    queue: AnalysisQueue;
    repository: ProcessingRepository;
    analysis: VerifiedTrainingAnalysisDependencies;
    retryPolicy?: UnexpectedRetryPolicy;
    retryWaiter?: RetryWaiter;
  }>,
): VerifiedTrainingRuntimeHandle {
  const worker = new AnalysisWorker({
    queue: input.queue,
    repository: input.repository,
    process: createVerifiedTrainingAnalysisProcessor(input.analysis),
    mode: "verified",
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
