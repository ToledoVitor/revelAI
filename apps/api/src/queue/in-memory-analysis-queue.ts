import {
  QueueUnavailableError,
  type AnalysisJob,
  type AnalysisJobDelivery,
  type AnalysisQueue,
} from "./analysis-queue.js";

export type QueueScheduler = Readonly<{
  schedule(task: () => Promise<void>): void;
}>;

type QueueOptions = Readonly<{
  available?: () => boolean | Promise<boolean>;
  scheduler?: QueueScheduler;
}>;

const microtaskScheduler: QueueScheduler = {
  schedule(task) {
    queueMicrotask(() => {
      void task();
    });
  },
};

/**
 * Development-only, single-process at-least-once identifier queue. It never
 * deduplicates jobs or owns attempt lifecycle state.
 */
export class InMemoryAnalysisQueue implements AnalysisQueue {
  private readonly available: () => boolean | Promise<boolean>;
  private readonly scheduler: QueueScheduler;
  private readonly pending: AnalysisJob[] = [];
  private readonly subscribers = new Set<AnalysisJobDelivery>();
  private drainScheduled = false;
  private closed = false;

  public constructor(options: QueueOptions = {}) {
    this.available = options.available ?? (() => true);
    this.scheduler = options.scheduler ?? microtaskScheduler;
  }

  public async isAvailable(): Promise<boolean> {
    return !this.closed && (await this.available());
  }

  public async enqueue(job: AnalysisJob): Promise<void> {
    if (!(await this.isAvailable())) {
      throw new QueueUnavailableError();
    }

    this.pending.push(Object.freeze({ ...job }));
    this.scheduleDrain();
  }

  public subscribe(deliver: AnalysisJobDelivery): () => void {
    if (this.closed) {
      throw new QueueUnavailableError();
    }

    this.subscribers.add(deliver);
    this.scheduleDrain();
    return () => {
      this.subscribers.delete(deliver);
    };
  }

  public close(): void {
    this.closed = true;
    this.subscribers.clear();
  }

  private scheduleDrain(): void {
    if (this.drainScheduled || this.pending.length === 0) {
      return;
    }

    this.drainScheduled = true;
    this.scheduler.schedule(async () => {
      this.drainScheduled = false;
      await this.drain();
    });
  }

  private async drain(): Promise<void> {
    while (await this.isAvailable()) {
      if (this.pending.length === 0 || this.subscribers.size === 0) return;
      const job = this.pending.shift()!;
      const deliver = this.subscribers.values().next().value as
        | AnalysisJobDelivery
        | undefined;

      if (!deliver) {
        this.pending.unshift(job);
        return;
      }

      try {
        await deliver(job);
      } catch {
        this.pending.unshift(job);
        this.scheduleDrain();
        return;
      }
    }
  }
}
