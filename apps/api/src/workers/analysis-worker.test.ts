import { describe, expect, it } from "vitest";
import {
  InMemoryAnalysisQueue,
  type QueueScheduler,
} from "../queue/in-memory-analysis-queue.js";
import { AnalysisWorker } from "./analysis-worker.js";
import type { TerminalCandidate } from "../repositories/attempt-repository.js";

class ManualScheduler implements QueueScheduler {
  readonly tasks: Array<() => Promise<void>> = [];
  public schedule(task: () => Promise<void>): void {
    this.tasks.push(task);
  }
  public async runAll(): Promise<void> {
    while (this.tasks.length > 0) await this.tasks.shift()!();
  }
}

const outcome: TerminalCandidate = {
  state: "failed",
  attemptId: "attempt-a",
  mode: "free",
  code: "analysis_temporary_unavailable",
  message: "A análise está indisponível temporariamente.",
  retryable: true,
};

describe("AnalysisWorker", () => {
  it("claims before processing and finalizes once despite duplicate queue delivery", async () => {
    const scheduler = new ManualScheduler();
    const queue = new InMemoryAnalysisQueue({ scheduler });
    const finalized: Array<
      Readonly<{ attemptId: string; generation: number }>
    > = [];
    let claimed = false;
    const repository = {
      claimProcessing: async () => {
        if (claimed) return null;
        claimed = true;
        return { leaseId: "lease-a", generation: 1 };
      },
      releaseProcessingClaim: async () => true,
      finalizeTerminalResult: async (
        input: Readonly<{ attemptId: string; generation: number }>,
      ) => {
        finalized.push(input);
        return null;
      },
    };
    const worker = new AnalysisWorker({
      queue,
      repository,
      process: async () => outcome,
    });
    const stop = worker.start();

    await queue.enqueue({ attemptId: "attempt-a", generation: 1 });
    await queue.enqueue({ attemptId: "attempt-a", generation: 1 });
    await scheduler.runAll();
    stop();

    expect(finalized).toMatchObject([
      { attemptId: "attempt-a", generation: 1 },
    ]);
  });

  it("releases a failed lease and leaves delivery unacknowledged for one terminal redelivery", async () => {
    const scheduler = new ManualScheduler();
    const queue = new InMemoryAnalysisQueue({ scheduler });
    let processCalls = 0;
    let released = 0;
    let finalized = 0;
    const worker = new AnalysisWorker({
      queue,
      repository: {
        claimProcessing: async () => ({ leaseId: "lease-a", generation: 1 }),
        releaseProcessingClaim: async () => {
          released += 1;
          return true;
        },
        finalizeTerminalResult: async () => {
          finalized += 1;
          return null;
        },
      },
      process: async () => {
        processCalls += 1;
        if (processCalls === 1) throw new Error("processor unavailable");
        return outcome;
      },
    });
    const stop = worker.start();

    await queue.enqueue({ attemptId: "attempt-a", generation: 1 });
    await scheduler.runAll();
    stop();

    expect({ processCalls, released, finalized }).toEqual({
      processCalls: 2,
      released: 1,
      finalized: 1,
    });
  });
});
