import {
  RetentionScavenger,
  type HourlyScheduler,
  type RetentionLog,
  type RetentionObjectStore,
  type RetentionRepository,
} from "../media/retention-scavenger.js";

/** App shutdown boundary for the auto-started retention composition. */
export interface C8RetentionRuntimeHandle {
  stop(): Promise<void>;
  drain(): Promise<void>;
}

/**
 * HTTP receives only this narrow starter from the outer production
 * composition. It cannot obtain the retention database or C5 storage port.
 */
export interface RetentionRuntimeFactory {
  start(
    input: Readonly<{
      scheduler: HourlyScheduler;
      maxBatchSize: number;
      now: () => string;
    }>,
  ): C8RetentionRuntimeHandle;
}

/** One active scheduler owner per exact retention repository instance. */
const runtimeByRetentionRepository = new WeakMap<object, C8RetentionRuntime>();

/**
 * Production lifecycle around RetentionScavenger. Unlike its convenience
 * start() method, this runtime owns immediate work, timer cancellation, and
 * an awaitable drain for Fastify shutdown ordering.
 */
export function createC8RetentionRuntime(
  input: Readonly<{
    owner: object;
    repository: RetentionRepository;
    objects: RetentionObjectStore;
    log: RetentionLog;
    scheduler: HourlyScheduler;
    maxBatchSize: number;
    now: () => string;
  }>,
): C8RetentionRuntimeHandle {
  const existing = runtimeByRetentionRepository.get(input.owner);
  if (existing)
    throw new Error("Retention runtime already has an active owner.");
  const runtime = new C8RetentionRuntime({
    ...input,
    onStopped: () => {
      if (runtimeByRetentionRepository.get(input.owner) === runtime)
        runtimeByRetentionRepository.delete(input.owner);
    },
  });
  runtimeByRetentionRepository.set(input.owner, runtime);
  try {
    runtime.start();
    return runtime;
  } catch (error) {
    if (runtimeByRetentionRepository.get(input.owner) === runtime)
      runtimeByRetentionRepository.delete(input.owner);
    throw error;
  }
}

class C8RetentionRuntime implements C8RetentionRuntimeHandle {
  private readonly scavenger: RetentionScavenger;
  private readonly scheduler: HourlyScheduler;
  private readonly log: RetentionLog;
  private readonly now: () => string;
  private readonly onStopped: () => void;
  private started = false;
  private schedulerRegistered = false;
  private stopped = false;
  private scheduledHandle: unknown;
  private inFlight: Promise<void> | undefined;
  private stopping: Promise<void> | undefined;

  public constructor(
    input: Readonly<{
      repository: RetentionRepository;
      objects: RetentionObjectStore;
      log: RetentionLog;
      scheduler: HourlyScheduler;
      maxBatchSize: number;
      now: () => string;
      onStopped: () => void;
    }>,
  ) {
    this.scavenger = new RetentionScavenger({
      repository: input.repository,
      objects: input.objects,
      maxBatchSize: input.maxBatchSize,
      log: input.log,
    });
    this.scheduler = input.scheduler;
    this.log = input.log;
    this.now = input.now;
    this.onStopped = input.onStopped;
  }

  public start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    try {
      this.scheduledHandle = this.scheduler.everyHour(() => {
        if (this.stopped || !this.schedulerRegistered) return;
        try {
          this.startRun(this.now());
        } catch {
          this.logRunFailure();
        }
      });
      this.schedulerRegistered = true;
      this.startRun(this.now());
    } catch (error) {
      // If registration or the injected clock throws synchronously, prevent
      // a partially started owner from retaining an active timer.
      void this.stop();
      throw error;
    }
  }

  public stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopped = true;
    this.schedulerRegistered = false;
    const handle = this.scheduledHandle;
    this.scheduledHandle = undefined;
    if (handle !== undefined)
      try {
        this.scheduler.cancel(handle);
      } catch {
        this.logRunFailure();
      }
    this.stopping = this.drain()
      .catch(() => this.logRunFailure())
      .then(() => {
        try {
          this.onStopped();
        } catch {
          this.logRunFailure();
        }
      });
    return this.stopping;
  }

  public async drain(): Promise<void> {
    await this.inFlight;
  }

  private startRun(now: string): void {
    if (this.stopped || this.inFlight) return;
    const run = this.runSafely(now);
    this.trackInFlight(run);
  }

  private async runSafely(now: string): Promise<void> {
    try {
      await this.scavenger.run(now);
    } catch {
      this.logRunFailure();
    }
  }

  private trackInFlight(operation: Promise<unknown>): void {
    const tracked = operation
      .then(
        () => undefined,
        () => this.logRunFailure(),
      )
      .then(() => {
        if (this.inFlight === tracked) this.inFlight = undefined;
      });
    this.inFlight = tracked;
  }

  private logRunFailure(): void {
    try {
      this.log.event(
        Object.freeze({ category: "retention_cleanup_run_failed" as const }),
      );
    } catch {
      // A redacted logger cannot create an unhandled timer rejection.
    }
  }
}
