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

/** Queue consumer that delegates all reservation and terminal idempotence to the repository. */
export class AnalysisWorker {
  private readonly queue: AnalysisQueue;
  private readonly repository: ProcessingRepository;
  private readonly process: AnalysisProcessor;

  public constructor(
    input: Readonly<{
      queue: AnalysisQueue;
      repository: ProcessingRepository;
      process: AnalysisProcessor;
    }>,
  ) {
    this.queue = input.queue;
    this.repository = input.repository;
    this.process = input.process;
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
      } catch (error) {
        await this.repository.releaseProcessingClaim({
          attemptId: job.attemptId,
          leaseId: claim.leaseId,
          generation: claim.generation,
        });
        throw error;
      }
    });
  }
}
