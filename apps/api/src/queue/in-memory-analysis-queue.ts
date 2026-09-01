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
  private readonly subscribers = new Set<
    Readonly<{
      deliver: AnalysisJobDelivery;
      mode: "free" | "verified" | undefined;
    }>
  >();
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

  public subscribe(
    deliver: AnalysisJobDelivery,
    options?: Readonly<{ mode: "free" | "verified" }>,
  ): () => void {
    if (this.closed) {
      throw new QueueUnavailableError();
    }

    const subscription = Object.freeze({ deliver, mode: options?.mode });
    this.subscribers.add(subscription);
    this.scheduleDrain();
    return () => {
      this.subscribers.delete(subscription);
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
      const jobIndex = this.pending.findIndex((job) =>
        [...this.subscribers].some((subscription) =>
          acceptsDelivery(subscription, job),
        ),
      );
      if (jobIndex < 0) return;
      const job = this.pending.splice(jobIndex, 1)[0]!;
      const subscription = [...this.subscribers].find((candidate) =>
        acceptsDelivery(candidate, job),
      );
      if (!subscription) {
        this.pending.splice(jobIndex, 0, job);
        return;
      }

      try {
        await subscription.deliver(job);
      } catch {
        this.pending.unshift(job);
        this.scheduleDrain();
        return;
      }
    }
  }
}

function acceptsDelivery(
  subscription: Readonly<{ mode: "free" | "verified" | undefined }>,
  job: AnalysisJob,
): boolean {
  // Older queue payloads have no mode. Deliver one to a scoped worker so its
  // C4 claim can recover the durable mode; a tagged job stays mode-isolated.
  return (
    subscription.mode === undefined ||
    job.mode === undefined ||
    subscription.mode === job.mode
  );
}
