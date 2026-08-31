import type {
  MediaAttachmentRecoveryClaim,
  MediaDeliveryRedeliveryClaim,
  MediaDeliveryRecovery,
} from "../repositories/attempt-repository.js";
import type { AnalysisQueue } from "../queue/analysis-queue.js";

/** C5 receives only opaque identifiers; this port cannot reveal a path. */
export interface OpaqueAcceptedMediaCleaner {
  cleanup(
    input: Readonly<{
      attemptId: string;
      mediaId: string;
      frameBatchId: string;
    }>,
  ): Promise<void>;
}

export interface MediaAttachmentRecoveryRepository {
  claimMediaAttachmentRecovery(
    input: Readonly<{ now: string; limit: number }>,
  ): Promise<readonly MediaAttachmentRecoveryClaim[]>;
  rollbackMediaAttachment(
    input: Readonly<{ attemptId: string; generation: number }>,
  ): Promise<void>;
  acknowledgeMediaAttachmentCleanup(
    input: Readonly<{ attemptId: string; generation: number; mediaId: string }>,
  ): Promise<void>;
  releaseMediaAttachmentRecovery(
    input: Readonly<{ attemptId: string; generation: number; leaseId: string }>,
  ): Promise<void>;
}

export interface MediaAttachmentRecoveryLog {
  event(
    input:
      | Readonly<{
          category:
            | "media_attachment_recovery_failed"
            | "media_delivery_redelivery_failed"
            | "media_delivery_recovery_run_failed";
          attempt: string;
          generation: number;
        }>
      | Readonly<{ category: "media_delivery_recovery_run_failed" }>,
  ): void;
}

export interface MediaDeliveryRedeliveryRepository {
  claimMediaDeliveryRedelivery(
    input: Readonly<{ now: string; limit: number }>,
  ): Promise<readonly MediaDeliveryRedeliveryClaim[]>;
  acknowledgeMediaDeliveryRedelivery(
    input: Readonly<{ attemptId: string; generation: number; leaseId: string }>,
  ): Promise<void>;
  releaseMediaDeliveryRedelivery(
    input: Readonly<{ attemptId: string; generation: number; leaseId: string }>,
  ): Promise<void>;
}

export interface HourlyRecoveryScheduler {
  everyHour(task: () => void): unknown;
  cancel(handle: unknown): void;
}

/** App shutdown boundary for the auto-started C8 recovery composition. */
export interface C8RecoveryRuntimeHandle {
  stop(): Promise<void>;
  drain(): Promise<void>;
}

/** One app composition owns one scheduler for one C4 repository instance. */
const productionRuntimeByRepository = new WeakMap<object, C8RecoveryRuntime>();

/**
 * Bounded durable compensation executor. C4 owns state transitions and C5
 * owns byte deletion; a failure keeps the leased journal item retriable.
 */
export class MediaAttachmentRecoveryExecutor {
  public constructor(
    private readonly repository: MediaAttachmentRecoveryRepository,
    private readonly cleaner: OpaqueAcceptedMediaCleaner,
    private readonly log: MediaAttachmentRecoveryLog,
  ) {}

  public async run(
    input: Readonly<{ now: string; limit: number }>,
  ): Promise<number> {
    const claims = await this.repository.claimMediaAttachmentRecovery(input);
    let completed = 0;
    for (const claim of claims) {
      if (await this.reconcile(claim)) completed += 1;
    }
    return completed;
  }

  private async reconcile(
    claim: MediaAttachmentRecoveryClaim,
  ): Promise<boolean> {
    try {
      if (claim.requiresRollback)
        await this.repository.rollbackMediaAttachment({
          attemptId: claim.attemptId,
          generation: claim.generation,
        });
      await this.cleaner.cleanup({
        attemptId: claim.attemptId,
        mediaId: claim.mediaId,
        frameBatchId: claim.frameBatchId,
      });
      await this.repository.acknowledgeMediaAttachmentCleanup({
        attemptId: claim.attemptId,
        generation: claim.generation,
        mediaId: claim.mediaId,
      });
      return true;
    } catch {
      this.logFailure(claim);
      return false;
    } finally {
      await this.repository
        .releaseMediaAttachmentRecovery({
          attemptId: claim.attemptId,
          generation: claim.generation,
          leaseId: claim.leaseId,
        })
        .catch(() => this.logFailure(claim));
    }
  }

  private logFailure(claim: MediaDeliveryRecovery): void {
    try {
      this.log.event(
        Object.freeze({
          category: "media_attachment_recovery_failed" as const,
          attempt: claim.attemptId.slice(0, 8),
          generation: claim.generation,
        }),
      );
    } catch {
      // A logger cannot break retry safety or create an unhandled rejection.
    }
  }
}

/** Delivers only pending/queued facts; it never deletes media or frames. */
export class MediaDeliveryRedeliveryExecutor {
  public constructor(
    private readonly repository: MediaDeliveryRedeliveryRepository,
    private readonly queue: Pick<AnalysisQueue, "enqueue">,
    private readonly log: MediaAttachmentRecoveryLog,
  ) {}

  public async run(
    input: Readonly<{ now: string; limit: number }>,
  ): Promise<number> {
    const claims = await this.repository.claimMediaDeliveryRedelivery(input);
    let completed = 0;
    for (const claim of claims) {
      if (await this.redeliver(claim)) completed += 1;
    }
    return completed;
  }

  private async redeliver(
    claim: MediaDeliveryRedeliveryClaim,
  ): Promise<boolean> {
    try {
      await this.queue.enqueue(
        Object.freeze({
          attemptId: claim.attemptId,
          generation: claim.generation,
        }),
      );
      await this.repository.acknowledgeMediaDeliveryRedelivery({
        attemptId: claim.attemptId,
        generation: claim.generation,
        leaseId: claim.leaseId,
      });
      return true;
    } catch {
      this.logFailure(claim);
      return false;
    } finally {
      await this.repository
        .releaseMediaDeliveryRedelivery({
          attemptId: claim.attemptId,
          generation: claim.generation,
          leaseId: claim.leaseId,
        })
        .catch(() => this.logFailure(claim));
    }
  }

  private logFailure(claim: MediaDeliveryRedeliveryClaim): void {
    try {
      this.log.event(
        Object.freeze({
          category: "media_delivery_redelivery_failed" as const,
          attempt: claim.attemptId.slice(0, 8),
          generation: claim.generation,
        }),
      );
    } catch {
      // Logging cannot turn an at-least-once delivery into an unhandled error.
    }
  }
}

/**
 * C8's production composition boundary: startup and scheduled recovery are
 * constructed together, so durable delivery facts cannot depend on a caller
 * remembering to invoke a standalone executor.
 */
export function createC8RecoveryRuntime(
  input: Readonly<{
    repository: MediaAttachmentRecoveryRepository &
      MediaDeliveryRedeliveryRepository;
    queue: Pick<AnalysisQueue, "enqueue">;
    cleaner: OpaqueAcceptedMediaCleaner;
    log: MediaAttachmentRecoveryLog;
    scheduler?: HourlyRecoveryScheduler;
    maxBatchSize: number;
    now?: () => string;
  }>,
): C8RecoveryRuntimeHandle {
  const existing = productionRuntimeByRepository.get(input.repository);
  if (existing)
    throw new Error("C8 recovery runtime already has an active owner.");
  const runtime = new C8RecoveryRuntime({
    ...input,
    onStopped: () => {
      if (productionRuntimeByRepository.get(input.repository) === runtime)
        productionRuntimeByRepository.delete(input.repository);
    },
  });
  productionRuntimeByRepository.set(input.repository, runtime);
  try {
    runtime.start();
    return runtime;
  } catch (error) {
    // Starting includes scheduler registration. A synchronous failure must not
    // leave an inert runtime in the WeakMap for a later composition to inherit.
    if (productionRuntimeByRepository.get(input.repository) === runtime)
      productionRuntimeByRepository.delete(input.repository);
    throw error;
  }
}

class C8RecoveryRuntime implements C8RecoveryRuntimeHandle {
  private readonly delivery: MediaDeliveryRedeliveryExecutor;
  private readonly cleanup: MediaAttachmentRecoveryExecutor;
  private readonly scheduler: HourlyRecoveryScheduler | undefined;
  private readonly log: MediaAttachmentRecoveryLog;
  private readonly maxBatchSize: number;
  private readonly now: () => string;
  private running = false;
  private started = false;
  private schedulerRegistered = false;
  private stopped = false;
  private scheduledHandle: unknown;
  private inFlight: Promise<void> | undefined;
  private stopping: Promise<void> | undefined;
  private readonly onStopped: () => void;

  public constructor(
    input: Readonly<{
      repository: MediaAttachmentRecoveryRepository &
        MediaDeliveryRedeliveryRepository;
      queue: Pick<AnalysisQueue, "enqueue">;
      cleaner: OpaqueAcceptedMediaCleaner;
      log: MediaAttachmentRecoveryLog;
      scheduler?: HourlyRecoveryScheduler;
      maxBatchSize: number;
      now?: () => string;
      onStopped: () => void;
    }>,
  ) {
    if (!Number.isSafeInteger(input.maxBatchSize) || input.maxBatchSize < 1)
      throw new Error(
        "C8 recovery batch size must be a positive safe integer.",
      );
    this.delivery = new MediaDeliveryRedeliveryExecutor(
      input.repository,
      input.queue,
      input.log,
    );
    this.cleanup = new MediaAttachmentRecoveryExecutor(
      input.repository,
      input.cleaner,
      input.log,
    );
    this.scheduler = input.scheduler;
    this.log = input.log;
    this.maxBatchSize = input.maxBatchSize;
    this.now = input.now ?? (() => new Date().toISOString());
    this.onStopped = input.onStopped;
  }

  /** Start exactly once; successful registration is required before caching. */
  public start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    try {
      this.scheduledHandle = this.scheduler?.everyHour(() => {
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
      // Immediate recovery is already contained by runSafely. Begin shutdown
      // without awaiting it so startup still reports the scheduler failure.
      void this.stop();
      throw error;
    }
  }

  /** Shutdown first prevents new callbacks, then drains active recovery. */
  public stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopped = true;
    this.schedulerRegistered = false;
    const handle = this.scheduledHandle;
    this.scheduledHandle = undefined;
    if (handle !== undefined)
      try {
        this.scheduler?.cancel(handle);
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

  /** Exposes an awaitable boundary for dependency teardown ordering. */
  public async drain(): Promise<void> {
    await this.inFlight;
  }

  private run(
    now: string,
  ): Promise<
    | Readonly<{ kind: "completed"; redelivered: number; cleaned: number }>
    | Readonly<{ kind: "skipped-overlap" }>
    | Readonly<{ kind: "skipped-stopped" }>
  > {
    return this.execute(now);
  }

  private async execute(
    now: string,
  ): Promise<
    | Readonly<{ kind: "completed"; redelivered: number; cleaned: number }>
    | Readonly<{ kind: "skipped-overlap" }>
    | Readonly<{ kind: "skipped-stopped" }>
  > {
    if (this.stopped)
      return Object.freeze({ kind: "skipped-stopped" as const });
    if (this.running)
      return Object.freeze({ kind: "skipped-overlap" as const });
    this.running = true;
    try {
      const redelivered = await this.delivery.run({
        now,
        limit: this.maxBatchSize,
      });
      const cleaned = await this.cleanup.run({ now, limit: this.maxBatchSize });
      return Object.freeze({
        kind: "completed" as const,
        redelivered,
        cleaned,
      });
    } finally {
      this.running = false;
    }
  }

  private async runSafely(now: string): Promise<void> {
    try {
      await this.run(now);
    } catch {
      this.logRunFailure();
    }
  }

  private startRun(now: string): void {
    if (this.stopped || this.running || this.inFlight) return;
    const run = this.runSafely(now);
    this.trackInFlight(run);
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
        Object.freeze({
          category: "media_delivery_recovery_run_failed" as const,
        }),
      );
    } catch {
      // Startup/timer chains must never reject because logging failed.
    }
  }
}
