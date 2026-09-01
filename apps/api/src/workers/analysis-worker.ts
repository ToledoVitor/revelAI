import { FailureMessageByCode } from "@revelai/contracts";
import type { AnalysisJob, AnalysisQueue } from "../queue/analysis-queue.js";
import type {
  DeadLetterProcessingClaimOutcome,
  FinalizeTerminalResultOutcome,
  FinalizeTerminalResultInput,
  ProcessingFailureRecordOutcome,
  ProcessingClaim,
  TerminalCandidate,
} from "../repositories/attempt-repository.js";

export type ProcessingRepository = Readonly<{
  claimProcessing(job: AnalysisJob): Promise<ProcessingClaim | null>;
  releaseProcessingClaim(
    input: Readonly<{
      attemptId: string;
      leaseId: string;
      generation: number;
    }>,
  ): Promise<boolean>;
  recordProcessingFailure(
    input: Readonly<{
      attemptId: string;
      leaseId: string;
      generation: number;
    }>,
  ): Promise<ProcessingFailureRecordOutcome>;
  deadLetterProcessingClaim(
    input: Readonly<{
      attemptId: string;
      leaseId: string;
      generation: number;
    }>,
  ): Promise<DeadLetterProcessingClaimOutcome>;
  finalizeTerminalResult(
    input: FinalizeTerminalResultInput,
  ): Promise<FinalizeTerminalResultOutcome>;
}>;

export type AnalysisProcessor = (
  input: Readonly<{
    job: AnalysisJob;
    claim: ProcessingClaim;
  }>,
) => Promise<TerminalCandidate>;

/** A processor can classify a known failure as a terminal candidate. */
export class ExpectedProcessingFailure extends Error {
  public constructor(public readonly candidate: TerminalCandidate) {
    super("Expected processing failure");
    this.name = "ExpectedProcessingFailure";
  }
}

/**
 * Explicit processor-only retry signal. Adapters must use this solely for a
 * provider or scheduler transport/deadline failure; all other processor and
 * C4 errors terminalize as an internal failure without touching retry state.
 */
export class RetryableProcessingFailure extends Error {
  public constructor(message = "Retryable processing failure") {
    super(message);
    this.name = "RetryableProcessingFailure";
  }
}

export type UnexpectedRetryPolicy = Readonly<{
  maxAttempts: number;
  delayMilliseconds: number;
  terminalCandidate(
    input: Readonly<{
      job: AnalysisJob;
      claim: ProcessingClaim;
      retryAttempt: number;
      error: unknown;
    }>,
  ): TerminalCandidate;
}>;

export type RetryWaiter = Readonly<{
  wait(delayMilliseconds: number): Promise<void>;
}>;

const defaultUnexpectedRetryPolicy: UnexpectedRetryPolicy = Object.freeze({
  maxAttempts: 3,
  delayMilliseconds: 0,
  terminalCandidate: ({ job, claim }) => ({
    state: "failed",
    attemptId: job.attemptId,
    mode: claim.mode,
    code: "analysis_internal_error",
    message: FailureMessageByCode.analysis_internal_error,
    retryable: false,
  }),
});

const timerRetryWaiter: RetryWaiter = Object.freeze({
  wait: async (delayMilliseconds) => {
    await new Promise<void>((resolve) =>
      setTimeout(resolve, delayMilliseconds),
    );
  },
});

/** Queue consumer that delegates all reservation and terminal idempotence to the repository. */
export class AnalysisWorker {
  private readonly queue: AnalysisQueue;
  private readonly repository: ProcessingRepository;
  private readonly process: AnalysisProcessor;
  private readonly mode: ProcessingClaim["mode"] | undefined;
  private readonly unexpectedRetryPolicy: UnexpectedRetryPolicy;
  private readonly retryWaiter: RetryWaiter;
  private started = false;
  private stopping = false;
  private stoppingPromise: Promise<void> | undefined;
  private unsubscribe: (() => void) | undefined;
  private readonly inFlight = new Set<Promise<void>>();

  public constructor(
    input: Readonly<{
      queue: AnalysisQueue;
      repository: ProcessingRepository;
      process: AnalysisProcessor;
      mode?: ProcessingClaim["mode"];
      unexpectedRetryPolicy?: UnexpectedRetryPolicy;
      retryWaiter?: RetryWaiter;
    }>,
  ) {
    this.queue = input.queue;
    this.repository = input.repository;
    this.process = input.process;
    this.mode = input.mode;
    this.unexpectedRetryPolicy =
      input.unexpectedRetryPolicy ?? defaultUnexpectedRetryPolicy;
    this.retryWaiter = input.retryWaiter ?? timerRetryWaiter;
    if (
      !Number.isSafeInteger(this.unexpectedRetryPolicy.maxAttempts) ||
      this.unexpectedRetryPolicy.maxAttempts < 1
    )
      throw new Error(
        "Unexpected retry policy maxAttempts must be a positive safe integer.",
      );
    if (
      !Number.isFinite(this.unexpectedRetryPolicy.delayMilliseconds) ||
      this.unexpectedRetryPolicy.delayMilliseconds < 0
    )
      throw new Error(
        "Unexpected retry policy delayMilliseconds must be finite and nonnegative.",
      );
  }

  public start(): () => Promise<void> {
    if (this.started)
      throw new Error("Analysis worker can only be started once.");
    this.started = true;
    this.unsubscribe = this.queue.subscribe(
      async (job) => this.trackDelivery(job),
      this.mode ? Object.freeze({ mode: this.mode }) : undefined,
    );
    return () => this.stop();
  }

  /** Stops intake first, then drains callbacks already holding a C4 lease. */
  private stop(): Promise<void> {
    if (this.stoppingPromise) return this.stoppingPromise;
    this.stopping = true;
    try {
      this.unsubscribe?.();
    } catch {
      // Subscription teardown cannot make an already-issued C4 lease vanish.
      // Continue draining that lease so callers still get deterministic close.
    }
    this.stoppingPromise = this.drainInFlight();
    return this.stoppingPromise;
  }

  private async drainInFlight(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.allSettled([...this.inFlight]);
  }

  private async trackDelivery(job: AnalysisJob): Promise<void> {
    // A rejected callback is deliberately not acknowledged by an at-least-once
    // queue. It remains available for the next runtime owner without touching
    // C4 retry accounting or terminal state.
    if (this.stopping) throw new WorkerStoppingError();
    const delivery = this.deliver(job);
    this.inFlight.add(delivery);
    try {
      await delivery;
    } finally {
      this.inFlight.delete(delivery);
    }
  }

  private async deliver(job: AnalysisJob): Promise<void> {
    const claim = await this.repository.claimProcessing(job);
    if (!claim) return;
    if (this.mode && claim.mode !== this.mode) {
      // Queue mode selects a consumer but is not C4 authority. Correct a
      // malformed/stale delivery before any processor sees the claim, so
      // Free can never terminalize a Verified row.
      const released = await this.repository.releaseProcessingClaim({
        attemptId: job.attemptId,
        leaseId: claim.leaseId,
        generation: claim.generation,
      });
      if (!released) throw new LostProcessingClaimError();
      await this.queue.enqueue(
        Object.freeze({
          attemptId: job.attemptId,
          generation: claim.generation,
          mode: claim.mode,
        }),
      );
      return;
    }
    let candidate: TerminalCandidate;
    try {
      candidate = await this.process({ job, claim });
    } catch (error) {
      if (error instanceof ExpectedProcessingFailure)
        candidate = error.candidate;
      else if (error instanceof RetryableProcessingFailure) {
        await this.recover(job, claim, error);
        return;
      } else {
        await this.finalizeInternalFailure(job, claim);
        return;
      }
    }
    await this.finalizeProcessedCandidate(job, claim, candidate);
  }

  /**
   * Only explicitly retryable processor failures enter `recover()`: its retry
   * budget represents a provider/scheduler delivery, never a C4 write or
   * invariant fault. A rejected terminal candidate gets one exact internal
   * terminal replacement while the same lease is still authoritative.
   */
  private async finalizeProcessedCandidate(
    job: AnalysisJob,
    claim: ProcessingClaim,
    candidate: TerminalCandidate,
  ): Promise<void> {
    let finalization: FinalizeTerminalResultOutcome;
    try {
      finalization = await this.repository.finalizeTerminalResult({
        attemptId: job.attemptId,
        leaseId: claim.leaseId,
        generation: claim.generation,
        candidate,
      });
    } catch {
      await this.finalizeInternalFailure(job, claim);
      return;
    }
    if (!acknowledges(finalization)) {
      await this.releaseForRetry(job, claim);
      throw new LostProcessingClaimError();
    }
  }

  private async finalizeInternalFailure(
    job: AnalysisJob,
    claim: ProcessingClaim,
  ): Promise<void> {
    const finalization = await this.repository.finalizeTerminalResult({
      attemptId: job.attemptId,
      leaseId: claim.leaseId,
      generation: claim.generation,
      candidate: Object.freeze({
        state: "failed" as const,
        attemptId: job.attemptId,
        mode: claim.mode,
        code: "analysis_internal_error" as const,
        message: FailureMessageByCode.analysis_internal_error,
        retryable: false as const,
      }),
    });
    if (!acknowledges(finalization)) {
      await this.releaseForRetry(job, claim);
      throw new LostProcessingClaimError();
    }
  }

  private async recover(
    job: AnalysisJob,
    claim: ProcessingClaim,
    error: unknown,
  ): Promise<void> {
    let recovery: ProcessingFailureRecordOutcome;
    try {
      recovery = await this.repository.recordProcessingFailure({
        attemptId: job.attemptId,
        leaseId: claim.leaseId,
        generation: claim.generation,
      });
    } catch {
      // Retry accounting is not terminal authority. Replace the provider
      // retry with the exact internal terminal fact; if that persistence is
      // unavailable too, let it reject so the queue keeps this lease's work.
      await this.finalizeInternalFailure(job, claim);
      return;
    }
    if (recovery.kind === "tombstoned") return;
    if (recovery.kind === "lost-claim") {
      await this.retryWaiter.wait(this.unexpectedRetryPolicy.delayMilliseconds);
      throw error;
    }
    if (recovery.retryAttempt >= this.unexpectedRetryPolicy.maxAttempts) {
      let candidate: TerminalCandidate;
      try {
        candidate = this.unexpectedRetryPolicy.terminalCandidate({
          job,
          claim,
          retryAttempt: recovery.retryAttempt,
          error,
        });
      } catch {
        await this.finalizeInternalFailure(job, claim);
        return;
      }
      await this.finalizeProcessedCandidate(job, claim, candidate);
      return;
    }
    await this.releaseForRetry(job, claim);
    throw error;
  }

  private async releaseForRetry(
    job: AnalysisJob,
    claim: ProcessingClaim,
  ): Promise<void> {
    await this.repository.releaseProcessingClaim({
      attemptId: job.attemptId,
      leaseId: claim.leaseId,
      generation: claim.generation,
    });
    await this.retryWaiter.wait(this.unexpectedRetryPolicy.delayMilliseconds);
  }
}

class LostProcessingClaimError extends Error {
  public constructor() {
    super("Processing claim was lost before terminalization.");
    this.name = "LostProcessingClaimError";
  }
}

class WorkerStoppingError extends Error {
  public constructor() {
    super("Analysis worker is stopping.");
    this.name = "WorkerStoppingError";
  }
}

function acknowledges(
  outcome: FinalizeTerminalResultOutcome,
): outcome is Exclude<FinalizeTerminalResultOutcome, { kind: "lost-claim" }> {
  return outcome.kind !== "lost-claim";
}
