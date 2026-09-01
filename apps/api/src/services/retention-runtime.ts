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

/** Inert owner reservation used by the paired C8 startup supervisor. */
export interface C8RetentionRuntimePreparation
  extends C8RetentionRuntimeHandle {
  register(scheduler: HourlyScheduler): void;
  activate(now: string): void;
  abortStartup(): void;
}

/**
 * HTTP receives only this narrow lifecycle factory from the outer production
 * composition. It cannot obtain the retention database or C5 storage port.
 */
export interface RetentionRuntimeFactory {
  prepare(
    input: Readonly<{
      maxBatchSize: number;
      now: () => string;
    }>,
  ): C8RetentionRuntimePreparation;
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
  const runtime = prepareC8RetentionRuntime(input);
  try {
    runtime.register(input.scheduler);
    runtime.activate(input.now());
    return runtime;
  } catch (error) {
    runtime.abortStartup();
    throw error;
  }
}

/** Reserve retention ownership without calling C4, C5, or a scheduler. */
export function prepareC8RetentionRuntime(
  input: Readonly<{
    owner: object;
    repository: RetentionRepository;
    objects: RetentionObjectStore;
    log: RetentionLog;
    scheduler?: HourlyScheduler;
    maxBatchSize: number;
    now?: () => string;
  }>,
): C8RetentionRuntimePreparation {
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
  return runtime;
}

class C8RetentionRuntime implements C8RetentionRuntimePreparation {
  private readonly scavenger: RetentionScavenger;
  private scheduler: HourlyScheduler | undefined;
  private readonly log: RetentionLog;
  private readonly now: () => string;
  private readonly onStopped: () => void;
  private activated = false;
  private schedulerRegistered = false;
  private timerRegistered = false;
  private stopped = false;
  private ownerReleased = false;
  private scheduledHandle: unknown;
  private inFlight: Promise<void> | undefined;
  private stopping: Promise<void> | undefined;

  public constructor(
    input: Readonly<{
      repository: RetentionRepository;
      objects: RetentionObjectStore;
      log: RetentionLog;
      scheduler?: HourlyScheduler;
      maxBatchSize: number;
      now?: () => string;
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
    this.now = input.now ?? (() => new Date().toISOString());
    this.onStopped = input.onStopped;
  }

  /** Register an inert timer; callbacks remain gated until activation. */
  public register(scheduler: HourlyScheduler): void {
    if (this.stopped || this.timerRegistered) return;
    this.scheduler = scheduler;
    this.scheduledHandle = scheduler.everyHour(() => {
      if (this.stopped || !this.schedulerRegistered) return;
      try {
        this.startRun(this.now());
      } catch {
        this.logRunFailure();
      }
    });
    this.timerRegistered = true;
  }

  /** Starts the immediate pass only after both paired timers are registered. */
  public activate(now: string): void {
    if (this.stopped || this.activated) return;
    this.activated = true;
    this.schedulerRegistered = true;
    this.startRun(now);
  }

  /** Synchronous rollback for failed paired startup before any pass begins. */
  public abortStartup(): void {
    if (this.activated) {
      void this.stop();
      return;
    }
    this.stopped = true;
    this.schedulerRegistered = false;
    this.cancelScheduled();
    this.releaseOwner();
  }

  public stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopped = true;
    this.schedulerRegistered = false;
    this.cancelScheduled();
    this.stopping = this.drain()
      .catch(() => this.logRunFailure())
      .then(() => {
        this.releaseOwner();
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

  private cancelScheduled(): void {
    if (!this.timerRegistered) return;
    this.timerRegistered = false;
    const handle = this.scheduledHandle;
    this.scheduledHandle = undefined;
    try {
      this.scheduler?.cancel(handle);
    } catch {
      this.logRunFailure();
    }
  }

  private releaseOwner(): void {
    if (this.ownerReleased) return;
    this.ownerReleased = true;
    try {
      this.onStopped();
    } catch {
      this.logRunFailure();
    }
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
