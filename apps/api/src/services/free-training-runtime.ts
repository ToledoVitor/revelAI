import { FailureMessageByCode } from "@revelai/contracts";
import type { AnalysisQueue } from "../queue/analysis-queue.js";
import type {
  FinalizeTerminalResultOutcome,
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
  createFreeTrainingAnalysisProcessor,
  defaultFreeTrainingForbiddenPorts,
  type FreeTrainingAnalysisDependencies,
  type FreeTrainingForbiddenPorts,
} from "./free-training-analysis.js";

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
    forbiddenPorts?: FreeTrainingForbiddenPorts;
  }>,
): FreeTrainingRuntimeHandle {
  const forbiddenPorts =
    input.forbiddenPorts ?? defaultFreeTrainingForbiddenPorts;
  const worker = new AnalysisWorker({
    queue: input.queue,
    repository: guardFreeTerminalPersistence(
      input.repository,
      forbiddenPorts,
    ),
    process: createFreeTrainingAnalysisProcessor({
      ...input.analysis,
      forbiddenPorts,
    }),
    mode: "free",
    unexpectedRetryPolicy: input.retryPolicy ?? defaultRetryPolicy,
    retryWaiter: input.retryWaiter,
  });
  const unsubscribe = worker.start();
  return Object.freeze({ stop: unsubscribe });
}

function guardFreeTerminalPersistence(
  repository: ProcessingRepository,
  forbiddenPorts: FreeTrainingForbiddenPorts,
): ProcessingRepository {
  const finalizeTerminalResult = repository.finalizeTerminalResult;
  return Object.freeze({
    ...repository,
    finalizeTerminalResult: async (input) => {
      assertFreeTerminalCandidate(input.candidate, forbiddenPorts);
      forbiddenPorts.allowFreeTerminalPersistence();
      const finalization = await finalizeTerminalResult(input);
      assertFreeFinalization(finalization, forbiddenPorts);
      return finalization;
    },
  });
}

function assertFreeTerminalCandidate(
  candidate: TerminalCandidate,
  forbiddenPorts: FreeTrainingForbiddenPorts,
): void {
  if (candidate.state === "valid" && candidate.result.kind === "free-insight")
    return;
  if (candidate.state !== "valid" && candidate.mode === "free") return;
  if (
    candidate.state === "valid" &&
    candidate.result.kind === "verified-result" &&
    candidate.result.competitiveStatus === "ranked"
  )
    forbiddenPorts.forbidRankedFinalization();
  if (candidate.state === "valid") forbiddenPorts.forbidIntegrityScoring();
  if (candidate.mode === "verified") forbiddenPorts.forbidPolicyLookup();
  forbiddenPorts.forbidLeaderboard();
}

function assertFreeFinalization(
  finalization: FinalizeTerminalResultOutcome,
  forbiddenPorts: FreeTrainingForbiddenPorts,
): void {
  if (finalization.kind === "lost-claim" || finalization.kind === "tombstoned")
    return;
  const outcome = finalization.finalized.outcome;
  if (
    (outcome.state === "valid" && outcome.result.kind === "free-insight") ||
    (outcome.state === "failed" && outcome.mode === "free")
  )
    return;
  forbiddenPorts.forbidLeaderboard();
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
