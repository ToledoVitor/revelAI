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
  wait(retryAttempt: number): Promise<void>;
  terminalCandidate(
    input: Readonly<{
      job: AnalysisJob;
      claim: ProcessingClaim;
      retryAttempt: number;
      error: unknown;
    }>,
  ): TerminalCandidate;
}>;

const defaultUnexpectedRetryPolicy: UnexpectedRetryPolicy = Object.freeze({
  maxAttempts: 3,
  wait: async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  },
  terminalCandidate: ({ job, claim }) => ({
    state: "failed",
    attemptId: job.attemptId,
    mode: claim.mode,
    code: "analysis_internal_error",
    message: FailureMessageByCode.analysis_internal_error,
    retryable: false,
  }),
});

/** Queue consumer that delegates all reservation and terminal idempotence to the repository. */
export class AnalysisWorker {
  private readonly queue: AnalysisQueue;
  private readonly repository: ProcessingRepository;
  private readonly process: AnalysisProcessor;
  private readonly unexpectedRetryPolicy: UnexpectedRetryPolicy;
  private readonly retryAttempts = new Map<string, number>();

  public constructor(
    input: Readonly<{
      queue: AnalysisQueue;
      repository: ProcessingRepository;
      process: AnalysisProcessor;
      unexpectedRetryPolicy?: UnexpectedRetryPolicy;
    }>,
  ) {
    this.queue = input.queue;
    this.repository = input.repository;
    this.process = input.process;
    this.unexpectedRetryPolicy =
      input.unexpectedRetryPolicy ?? defaultUnexpectedRetryPolicy;
    if (this.unexpectedRetryPolicy.maxAttempts < 1)
      throw new Error(
        "Unexpected retry policy must allow at least one attempt.",
      );
  }

  public start(): () => void {
    return this.queue.subscribe(async (job) => {
      const claim = await this.repository.claimProcessing(job);
      if (!claim) return;
      try {
        const candidate = await this.process({ job, claim });
        await this.repository.finalizeTerminalResult({
          attemptId: job.attemptId,
          leaseId: claim.leaseId,
          generation: claim.generation,
          candidate,
        });
        this.retryAttempts.delete(retryKey(job));
      } catch (error) {
        if (error instanceof ExpectedProcessingFailure) {
          await this.repository.finalizeTerminalResult({
            attemptId: job.attemptId,
            leaseId: claim.leaseId,
            generation: claim.generation,
            candidate: error.candidate,
          });
          this.retryAttempts.delete(retryKey(job));
          return;
        }
        const retryAttempt = (this.retryAttempts.get(retryKey(job)) ?? 0) + 1;
        if (retryAttempt >= this.unexpectedRetryPolicy.maxAttempts) {
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
          this.retryAttempts.delete(retryKey(job));
          return;
        }
        this.retryAttempts.set(retryKey(job), retryAttempt);
        await this.repository.releaseProcessingClaim({
          attemptId: job.attemptId,
          leaseId: claim.leaseId,
          generation: claim.generation,
        });
        await this.unexpectedRetryPolicy.wait(retryAttempt);
        throw error;
      }
    });
  }
}

function retryKey(job: AnalysisJob): string {
  return `${job.attemptId}:${job.generation}`;
}
