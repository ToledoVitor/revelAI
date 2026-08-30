import { describe, expect, it } from "vitest";
import {
  InMemoryAnalysisQueue,
  type QueueScheduler,
} from "../queue/in-memory-analysis-queue.js";
import {
  AnalysisWorker,
  ExpectedProcessingFailure,
} from "./analysis-worker.js";
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
        return { leaseId: "lease-a", generation: 1, mode: "free" as const };
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
        claimProcessing: async () => ({
          leaseId: "lease-a",
          generation: 1,
          mode: "free",
        }),
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

  it("finalizes a classified processor failure without redelivery", async () => {
    const scheduler = new ManualScheduler();
    const queue = new InMemoryAnalysisQueue({ scheduler });
    let released = 0;
    let finalized = 0;
    const worker = new AnalysisWorker({
      queue,
      repository: {
        claimProcessing: async () => ({
          leaseId: "lease-a",
          generation: 1,
          mode: "free",
        }),
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
        throw new ExpectedProcessingFailure(outcome);
      },
    });
    const stop = worker.start();

    await queue.enqueue({ attemptId: "attempt-a", generation: 1 });
    await scheduler.runAll();
    stop();

    expect({ released, finalized, scheduled: scheduler.tasks.length }).toEqual({
      released: 0,
      finalized: 1,
      scheduled: 0,
    });
  });

  it("bounds permanent unexpected failures with yielded retries and one terminal failure", async () => {
    const scheduler = new ManualScheduler();
    const queue = new InMemoryAnalysisQueue({ scheduler });
    let processCalls = 0;
    let releases = 0;
    const finalized: TerminalCandidate[] = [];
    const backoffAttempts: number[] = [];
    const worker = new AnalysisWorker({
      queue,
      repository: {
        claimProcessing: async () => ({
          leaseId: `lease-${processCalls}`,
          generation: 1,
          mode: "free",
        }),
        releaseProcessingClaim: async () => {
          releases += 1;
          return true;
        },
        finalizeTerminalResult: async (input) => {
          finalized.push(input.candidate);
          return null;
        },
      },
      process: async () => {
        processCalls += 1;
        throw new Error("permanent processor error");
      },
      unexpectedRetryPolicy: {
        maxAttempts: 3,
        wait: async (attempt) => {
          backoffAttempts.push(attempt);
        },
        terminalCandidate: ({ job, claim }) => ({
          state: "failed",
          attemptId: job.attemptId,
          mode: claim.mode,
          code: "analysis_internal_error",
          message: "A análise não pôde ser concluída.",
          retryable: false,
        }),
      },
    });
    const stop = worker.start();

    await queue.enqueue({ attemptId: "attempt-a", generation: 1 });
    await scheduler.runAll();
    stop();

    expect({
      processCalls,
      releases,
      backoffAttempts,
      scheduled: scheduler.tasks.length,
    }).toEqual({
      processCalls: 3,
      releases: 2,
      backoffAttempts: [1, 2],
      scheduled: 0,
    });
    expect(finalized).toEqual([
      {
        state: "failed",
        attemptId: "attempt-a",
        mode: "free",
        code: "analysis_internal_error",
        message: "A análise não pôde ser concluída.",
        retryable: false,
      },
    ]);
  });
});
