import type { AttemptOutcome } from "@revelai/contracts";
import type { AnalysisJob, AnalysisQueue } from "../queue/analysis-queue.js";
import type {
  FinalizeTerminalResultInput,
  ProcessingClaim,
} from "../repositories/attempt-repository.js";

export type ProcessingRepository = Readonly<{
  claimProcessing(job: AnalysisJob): Promise<ProcessingClaim | null>;
  finalizeTerminalResult(input: FinalizeTerminalResultInput): Promise<unknown>;
}>;

export type AnalysisProcessor = (
  input: Readonly<{
    job: AnalysisJob;
    claim: ProcessingClaim;
  }>,
) => Promise<AttemptOutcome>;

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
      const outcome = await this.process({ job, claim });
      await this.repository.finalizeTerminalResult({
        attemptId: job.attemptId,
        leaseId: claim.leaseId,
        generation: claim.generation,
        outcome,
      });
    });
  }
}
