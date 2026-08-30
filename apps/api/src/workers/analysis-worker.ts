import { FailureMessageByCode } from "@revelai/contracts";
import type { AnalysisJob, AnalysisQueue } from "../queue/analysis-queue.js";
import type {
  FinalizeTerminalResultInput,
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
  finalizeTerminalResult(input: FinalizeTerminalResultInput): Promise<unknown>;
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
  private readonly unexpectedRetryPolicy: UnexpectedRetryPolicy;
  private readonly retryWaiter: RetryWaiter;
  private readonly retryAttempts = new Map<string, number>();

  public constructor(
    input: Readonly<{
      queue: AnalysisQueue;
      repository: ProcessingRepository;
      process: AnalysisProcessor;
      unexpectedRetryPolicy?: UnexpectedRetryPolicy;
      retryWaiter?: RetryWaiter;
    }>,
  ) {
    this.queue = input.queue;
    this.repository = input.repository;
    this.process = input.process;
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

  public start(): () => void {
    return this.queue.subscribe(async (job) => {
      const claim = await this.repository.claimProcessing(job);
      if (!claim) return;
      let candidate: TerminalCandidate;
      try {
        try {
          candidate = await this.process({ job, claim });
        } catch (error) {
          if (error instanceof ExpectedProcessingFailure)
            candidate = error.candidate;
          else throw error;
        }
        await this.repository.finalizeTerminalResult({
          attemptId: job.attemptId,
          leaseId: claim.leaseId,
          generation: claim.generation,
          candidate,
        });
        this.retryAttempts.delete(retryKey(job));
      } catch (error) {
        await this.recover(job, claim, error);
      }
    });
  }

  private async recover(
    job: AnalysisJob,
    claim: ProcessingClaim,
    error: unknown,
  ): Promise<void> {
    const key = retryKey(job);
    const retryAttempt = (this.retryAttempts.get(key) ?? 0) + 1;
    this.retryAttempts.set(key, retryAttempt);
    if (retryAttempt >= this.unexpectedRetryPolicy.maxAttempts) {
      try {
        await this.repository.finalizeTerminalResult({
          attemptId: job.attemptId,
          leaseId: claim.leaseId,
          generation: claim.generation,
          candidate: this.unexpectedRetryPolicy.terminalCandidate({
            job,
            claim,
            retryAttempt,
            error,
          }),
        });
        this.retryAttempts.delete(key);
        return;
      } catch (terminalizationError) {
        await this.releaseForRetry(job, claim);
        throw terminalizationError;
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

function retryKey(job: AnalysisJob): string {
  return `${job.attemptId}:${job.generation}`;
}
