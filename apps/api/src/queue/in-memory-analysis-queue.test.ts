import { describe, expect, it } from "vitest";
import {
  InMemoryAnalysisQueue,
  resolveFactoryIssuedAnalysisQueuePort,
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

    await queue.enqueue({ attemptId: "attempt-1", generation: 1 });
    await queue.enqueue({ attemptId: "attempt-2", generation: 1 });
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

    await queue.enqueue({ attemptId: "attempt-1", generation: 1 });
    await scheduler.runNext();
    await scheduler.runNext();

    expect(deliveries).toBe(2);
  });

  it("does not attach new jobs when availability is false", async () => {
    const queue = new InMemoryAnalysisQueue({ available: () => false });

    await expect(queue.isAvailable()).resolves.toBe(false);
    await expect(
      queue.enqueue({ attemptId: "attempt-1", generation: 1 }),
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

    await queue.enqueue({ attemptId: "attempt-1", generation: 1 });
    await scheduler.runAll();

    expect(received).toEqual([]);
  });

  it("hands a legacy untagged delivery to one scoped worker for authoritative routing", async () => {
    const scheduler = new ManualScheduler();
    const queue = new InMemoryAnalysisQueue({ scheduler });
    const received: Array<Readonly<{ attemptId: string; mode?: string }>> = [];
    const unsubscribe = queue.subscribe(
      async (job) => {
        received.push(job);
      },
      { mode: "free" },
    );

    await queue.enqueue({ attemptId: "attempt-legacy", generation: 1 });
    await scheduler.runAll();
    unsubscribe();

    expect(received).toEqual([{ attemptId: "attempt-legacy", generation: 1 }]);
  });

  it("keeps captured queue operations independent from post-issuance method mutation", async () => {
    const scheduler = new ManualScheduler();
    const queue = new InMemoryAnalysisQueue({ scheduler });
    const isAvailable = queue.isAvailable.bind(queue);
    const enqueue = queue.enqueue.bind(queue);
    const subscribe = queue.subscribe.bind(queue);
    const received: string[] = [];

    Object.assign(queue as object, {
      isAvailable: async () => false,
      enqueue: async () => {
        throw new Error("mutated enqueue");
      },
      subscribe: () => {
        throw new Error("mutated subscribe");
      },
      scheduleDrain: () => undefined,
      drain: async () => undefined,
    });
    Object.setPrototypeOf(
      queue,
      Object.freeze({
        isAvailable: async () => false,
        enqueue: async () => {
          throw new Error("mutated enqueue prototype");
        },
        subscribe: () => {
          throw new Error("mutated subscribe prototype");
        },
        scheduleDrain: () => undefined,
        drain: async () => undefined,
      }),
    );

    expect(await isAvailable()).toBe(true);
    const unsubscribe = subscribe(async (job) => {
      received.push(job.attemptId);
    });
    await enqueue({ attemptId: "attempt-sealed", generation: 1 });
    await scheduler.runAll();
    unsubscribe();

    expect(received).toEqual(["attempt-sealed"]);
  });

  it("keeps issued scheduling independent from nested scheduler method mutation", async () => {
    const scheduler = new ManualScheduler();
    const queue = new InMemoryAnalysisQueue({ scheduler });
    const received: string[] = [];
    const unsubscribe = queue.subscribe(async (job) => {
      received.push(job.attemptId);
    });

    Object.assign(scheduler as object, {
      schedule: () => {
        throw new Error("mutated scheduler");
      },
    });

    await queue.enqueue({ attemptId: "attempt-nested", generation: 1 });
    await scheduler.runAll();
    unsubscribe();

    expect(received).toEqual(["attempt-nested"]);
  });

  it("resolves a queue port only for its exact non-subclassable factory instance", () => {
    const queue = new InMemoryAnalysisQueue();
    const proxy = new Proxy(queue, {});
    const clone = Object.assign({}, queue);
    class DerivedQueue extends InMemoryAnalysisQueue {}

    expect(resolveFactoryIssuedAnalysisQueuePort(queue)).toBeDefined();
    expect(resolveFactoryIssuedAnalysisQueuePort(proxy)).toBeUndefined();
    expect(resolveFactoryIssuedAnalysisQueuePort(clone)).toBeUndefined();
    expect(() => new DerivedQueue()).toThrow("cannot be subclassed");
  });
});
