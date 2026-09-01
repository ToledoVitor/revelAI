import {
  QueueUnavailableError,
  type AnalysisJob,
  type AnalysisJobDelivery,
  type AnalysisQueue,
} from "./analysis-queue.js";
import type { ResolvedAnalysisQueuePort } from "./analysis-queue-port.js";

export type QueueScheduler = Readonly<{
  schedule(task: () => Promise<void>): void;
}>;

type QueueOptions = Readonly<{
  available?: () => boolean | Promise<boolean>;
  /** Lets a local host reject one delivery before it becomes visible. */
  beforeEnqueue?: (job: AnalysisJob) => void | Promise<void>;
  scheduler?: QueueScheduler;
}>;

type QueueState = {
  readonly available: () => boolean | Promise<boolean>;
  readonly beforeEnqueue: (job: AnalysisJob) => void | Promise<void>;
  readonly pending: AnalysisJob[];
  readonly subscribers: Set<
    Readonly<{
      deliver: AnalysisJobDelivery;
      mode: "free" | "verified" | undefined;
    }>
  >;
  drainScheduled: boolean;
  closed: boolean;
};

const microtaskScheduler: QueueScheduler = {
  schedule(task) {
    queueMicrotask(() => {
      void task();
    });
  },
};

const factoryIssuedAnalysisQueuePorts = new WeakMap<
  object,
  ResolvedAnalysisQueuePort
>();
const factoryIssuedAnalysisQueueHosts = new WeakMap<object, object>();

/** Resolves only the closure port issued for one exact production queue. */
export function resolveFactoryIssuedAnalysisQueuePort(
  value: unknown,
): ResolvedAnalysisQueuePort | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  return factoryIssuedAnalysisQueuePorts.get(value);
}

/** Confirms an opaque port belongs to this exact original queue host. */
export function isFactoryIssuedAnalysisQueuePortForHost(
  port: unknown,
  host: unknown,
): port is ResolvedAnalysisQueuePort {
  return (
    typeof port === "object" &&
    port !== null &&
    typeof host === "object" &&
    host !== null &&
    factoryIssuedAnalysisQueueHosts.get(port) === host
  );
}

/**
 * Development-only, single-process at-least-once identifier queue. It never
 * deduplicates jobs or owns attempt lifecycle state. Its factory-issued port
 * closes over state, so later public method mutation cannot redirect a live
 * production composition.
 */
export class InMemoryAnalysisQueue implements AnalysisQueue {
  readonly #port: ResolvedAnalysisQueuePort;
  readonly #close: () => void;

  public constructor(options: QueueOptions = {}) {
    if (new.target !== InMemoryAnalysisQueue)
      throw new Error("In-memory analysis queues cannot be subclassed.");
    const scheduler = options.scheduler ?? microtaskScheduler;
    const schedule = scheduler.schedule;
    const state: QueueState = {
      available: options.available ?? (() => true),
      beforeEnqueue: options.beforeEnqueue ?? (() => undefined),
      pending: [],
      subscribers: new Set(),
      drainScheduled: false,
      closed: false,
    };
    const isAvailable = async (): Promise<boolean> =>
      !state.closed && (await state.available());
    const scheduleDrain = (): void => {
      if (state.drainScheduled || state.pending.length === 0) return;
      state.drainScheduled = true;
      schedule.call(scheduler, async () => {
        state.drainScheduled = false;
        await drain();
      });
    };
    const drain = async (): Promise<void> => {
      while (await isAvailable()) {
        if (state.pending.length === 0 || state.subscribers.size === 0) return;
        const jobIndex = state.pending.findIndex((job) =>
          [...state.subscribers].some((subscription) =>
            acceptsDelivery(subscription, job),
          ),
        );
        if (jobIndex < 0) return;
        const job = state.pending.splice(jobIndex, 1)[0]!;
        const subscription = [...state.subscribers].find((candidate) =>
          acceptsDelivery(candidate, job),
        );
        if (!subscription) {
          state.pending.splice(jobIndex, 0, job);
          return;
        }

        try {
          await subscription.deliver(job);
        } catch {
          state.pending.unshift(job);
          scheduleDrain();
          return;
        }
      }
    };
    const enqueue = async (job: AnalysisJob): Promise<void> => {
      if (!(await isAvailable())) throw new QueueUnavailableError();
      const accepted = Object.freeze({ ...job });
      await state.beforeEnqueue(accepted);
      state.pending.push(accepted);
      scheduleDrain();
    };
    const subscribe = (
      deliver: AnalysisJobDelivery,
      options?: Readonly<{ mode: "free" | "verified" }>,
    ): (() => void) => {
      if (state.closed) throw new QueueUnavailableError();
      const subscription = Object.freeze({ deliver, mode: options?.mode });
      state.subscribers.add(subscription);
      scheduleDrain();
      return () => {
        state.subscribers.delete(subscription);
      };
    };
    this.#close = () => {
      state.closed = true;
      state.subscribers.clear();
    };
    this.#port = Object.freeze({
      isAvailable,
      enqueue,
      subscribe,
    }) as ResolvedAnalysisQueuePort;
    factoryIssuedAnalysisQueuePorts.set(this, this.#port);
    factoryIssuedAnalysisQueueHosts.set(this.#port, this);
  }

  public isAvailable(): Promise<boolean> {
    return this.#port.isAvailable();
  }

  public enqueue(job: AnalysisJob): Promise<void> {
    return this.#port.enqueue(job);
  }

  public subscribe(
    deliver: AnalysisJobDelivery,
    options?: Readonly<{ mode: "free" | "verified" }>,
  ): () => void {
    return this.#port.subscribe(deliver, options);
  }

  public close(): void {
    this.#close();
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
