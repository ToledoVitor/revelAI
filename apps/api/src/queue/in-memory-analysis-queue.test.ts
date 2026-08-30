import { describe, expect, it } from "vitest";
import {
  InMemoryAnalysisQueue,
  type QueueScheduler,
} from "./in-memory-analysis-queue.js";
import { QueueUnavailableError } from "./analysis-queue.js";

class ManualScheduler implements QueueScheduler {
  readonly tasks: Array<() => Promise<void>> = [];

  public schedule(task: () => Promise<void>): void {
    this.tasks.push(task);
  }

  public async runAll(): Promise<void> {
    while (this.tasks.length > 0) {
      await this.tasks.shift()!();
    }
  }

  public async runNext(): Promise<void> {
    const task = this.tasks.shift();
    if (task) await task();
  }
}

describe("InMemoryAnalysisQueue", () => {
  it("delivers queued job identifiers in FIFO order to a later subscriber", async () => {
    const scheduler = new ManualScheduler();
    const queue = new InMemoryAnalysisQueue({ scheduler });
    const received: string[] = [];

    await queue.enqueue({ attemptId: "attempt-1" });
    await queue.enqueue({ attemptId: "attempt-2" });
    const unsubscribe = queue.subscribe(async (job) => {
      received.push(job.attemptId);
    });

    await scheduler.runAll();
    unsubscribe();

    expect(received).toEqual(["attempt-1", "attempt-2"]);
  });

  it("redelivers a failed delivery without deduplicating its identifier", async () => {
    const scheduler = new ManualScheduler();
    const queue = new InMemoryAnalysisQueue({ scheduler });
    let deliveries = 0;
    queue.subscribe(async () => {
      deliveries += 1;
      if (deliveries === 1) throw new Error("temporary worker failure");
    });

    await queue.enqueue({ attemptId: "attempt-1" });
    await scheduler.runNext();
    await scheduler.runNext();

    expect(deliveries).toBe(2);
  });

  it("does not attach new jobs when availability is false", async () => {
    const queue = new InMemoryAnalysisQueue({ available: () => false });

    expect(queue.isAvailable()).toBe(false);
    await expect(
      queue.enqueue({ attemptId: "attempt-1" }),
    ).rejects.toBeInstanceOf(QueueUnavailableError);
  });

  it("stops delivery after its only subscriber unsubscribes", async () => {
    const scheduler = new ManualScheduler();
    const queue = new InMemoryAnalysisQueue({ scheduler });
    const received: string[] = [];
    const unsubscribe = queue.subscribe(async (job) => {
      received.push(job.attemptId);
    });
    unsubscribe();

    await queue.enqueue({ attemptId: "attempt-1" });
    await scheduler.runAll();

    expect(received).toEqual([]);
  });
});
