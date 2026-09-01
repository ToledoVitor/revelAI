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
import { emitTestDiagnostic } from "../internal/test-diagnostics.js";
import {
  createFreeTrainingAnalysisProcessor,
  type FreeTrainingAnalysisDependencies,
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
  }>,
): FreeTrainingRuntimeHandle {
  const worker = new AnalysisWorker({
    queue: input.queue,
    repository: guardFreeTerminalPersistence(input.repository),
    process: createFreeTrainingAnalysisProcessor(input.analysis),
    mode: "free",
    unexpectedRetryPolicy: input.retryPolicy ?? defaultRetryPolicy,
    retryWaiter: input.retryWaiter,
  });
  const unsubscribe = worker.start();
  return Object.freeze({ stop: unsubscribe });
}

function guardFreeTerminalPersistence(
  repository: ProcessingRepository,
): ProcessingRepository {
  const finalizeTerminalResult = repository.finalizeTerminalResult;
  return Object.freeze({
    ...repository,
    finalizeTerminalResult: async (input) => {
      assertFreeTerminalCandidate(input.candidate, repository);
      emitTestDiagnostic(repository, { kind: "free-terminal-persistence" });
      const finalization = await finalizeTerminalResult(input);
      assertFreeFinalization(finalization, repository);
      return finalization;
    },
  });
}

function assertFreeTerminalCandidate(
  candidate: TerminalCandidate,
  diagnosticTarget: object,
): void {
  if (candidate.state === "valid" && candidate.result.kind === "free-insight")
    return;
  if (candidate.state !== "valid" && candidate.mode === "free") return;
  if (
    candidate.state === "valid" &&
    candidate.result.kind === "verified-result" &&
    candidate.result.competitiveStatus === "ranked"
  ) {
    emitTestDiagnostic(diagnosticTarget, {
      kind: "free-forbidden-ranked-finalization",
    });
    throw new Error("Free processing cannot finalize a ranked result.");
  }
  if (candidate.state === "valid") {
    emitTestDiagnostic(diagnosticTarget, {
      kind: "free-forbidden-integrity-scoring",
    });
    throw new Error("Free processing cannot access integrity or scoring.");
  }
  if (candidate.mode === "verified") {
    emitTestDiagnostic(diagnosticTarget, {
      kind: "free-forbidden-policy-lookup",
    });
    throw new Error("Free processing cannot access competitive policy.");
  }
  emitTestDiagnostic(diagnosticTarget, {
    kind: "free-forbidden-leaderboard",
  });
  throw new Error("Free processing cannot write a leaderboard entry.");
}

function assertFreeFinalization(
  finalization: FinalizeTerminalResultOutcome,
  diagnosticTarget: object,
): void {
  if (finalization.kind === "lost-claim" || finalization.kind === "tombstoned")
    return;
  const outcome = finalization.finalized.outcome;
  if (
    (outcome.state === "valid" && outcome.result.kind === "free-insight") ||
    (outcome.state === "failed" && outcome.mode === "free")
  )
    return;
  emitTestDiagnostic(diagnosticTarget, {
    kind: "free-forbidden-finalization",
  });
  throw new Error("Free processing cannot retain a non-Free terminal result.");
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
