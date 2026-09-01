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
      try {
        candidate = await this.process({ job, claim });
      } catch (error) {
        if (error instanceof ExpectedProcessingFailure)
          candidate = error.candidate;
        else throw error;
      }
      const finalization = await this.repository.finalizeTerminalResult({
        attemptId: job.attemptId,
        leaseId: claim.leaseId,
        generation: claim.generation,
        candidate,
      });
      if (!acknowledges(finalization)) {
        await this.releaseForRetry(job, claim);
        throw new LostProcessingClaimError();
      }
    } catch (error) {
      if (error instanceof LostProcessingClaimError) throw error;
      await this.recover(job, claim, error);
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
      // Recovery accounting is diagnostic state, never authority to strand an
      // active lease. Prefer safe release; if that write is also rejected,
      // make one bounded terminal attempt rather than acknowledge an orphan.
      try {
        await this.repository.releaseProcessingClaim({
          attemptId: job.attemptId,
          leaseId: claim.leaseId,
          generation: claim.generation,
        });
        // A fulfilled queue callback is an ACK. Preserve at-least-once
        // delivery after safely releasing the lease so the attempt is not
        // left uploaded and unqueued.
        throw error;
      } catch {
        const deadLetter = await this.repository.deadLetterProcessingClaim({
          attemptId: job.attemptId,
          leaseId: claim.leaseId,
          generation: claim.generation,
        });
        if (deadLetter.kind === "lost-claim") throw error;
        return;
      }
    }
    if (recovery.kind === "tombstoned") return;
    if (recovery.kind === "lost-claim") {
      await this.retryWaiter.wait(this.unexpectedRetryPolicy.delayMilliseconds);
      throw error;
    }
    if (recovery.retryAttempt >= this.unexpectedRetryPolicy.maxAttempts) {
      try {
        const candidate = this.unexpectedRetryPolicy.terminalCandidate({
          job,
          claim,
          retryAttempt: recovery.retryAttempt,
          error,
        });
        const finalization = await this.repository.finalizeTerminalResult({
          attemptId: job.attemptId,
          leaseId: claim.leaseId,
          generation: claim.generation,
          candidate,
        });
        if (!acknowledges(finalization)) {
          await this.releaseForRetry(job, claim);
          throw new LostProcessingClaimError();
        }
        return;
      } catch (terminalizationError) {
        if (terminalizationError instanceof LostProcessingClaimError)
          throw terminalizationError;
        const deadLetter = await this.repository.deadLetterProcessingClaim({
          attemptId: job.attemptId,
          leaseId: claim.leaseId,
          generation: claim.generation,
        });
        if (deadLetter.kind === "lost-claim") {
          await this.retryWaiter.wait(
            this.unexpectedRetryPolicy.delayMilliseconds,
          );
          throw terminalizationError;
        }
        return;
      }
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
