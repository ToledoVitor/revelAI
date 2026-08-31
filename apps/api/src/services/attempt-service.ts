import type { AnalysisJob, AnalysisQueue } from "../queue/analysis-queue.js";
import { QueueUnavailableError } from "../queue/analysis-queue.js";
import type { AcceptedMediaHandoff } from "../media/accepted-media-handoff.js";

/** C8's sole post-C5 attach port; C4 owns every state transition. */
export type AttachmentRepository = Readonly<{
  attachPreparedMedia(
    input: Readonly<{ accepted: AcceptedMediaHandoff }>,
  ): Promise<AnalysisJob>;
  rollbackMediaAttachment(
    input: Readonly<{ attemptId: string; generation: number }>,
  ): Promise<void>;
  beginMediaAttachmentRecovery(
    input: Readonly<{
      attemptId: string;
      generation: number;
      mediaId: string;
      frameBatchId: string;
    }>,
  ): Promise<void>;
  acknowledgeMediaAttachmentCleanup(
    input: Readonly<{ attemptId: string; generation: number; mediaId: string }>,
  ): Promise<void>;
  markMediaDeliveryQueued(
    input: Readonly<{ attemptId: string; generation: number }>,
  ): Promise<void>;
}>;

export interface AttemptServiceLog {
  event(
    event: Readonly<{
      category:
        | "media_attachment_cleanup_failed"
        | "media_attachment_recovery_failed"
        | "media_attachment_delivery_record_failed";
      attempt: string;
      generation: number;
    }>,
  ): void;
}

type AttemptAttachmentQueue = Pick<AnalysisQueue, "isAvailable" | "enqueue">;

/** Coordinates one accepted C5 handoff with identifier-only queue delivery. */
export class AttemptService {
  private readonly repository: AttachmentRepository;
  private readonly queue: AttemptAttachmentQueue;
  private readonly log: AttemptServiceLog | undefined;

  public constructor(
    input: Readonly<{
      repository: AttachmentRepository;
      queue: AttemptAttachmentQueue;
      log?: AttemptServiceLog;
    }>,
  ) {
    this.repository = input.repository;
    this.queue = input.queue;
    this.log = input.log;
  }

  public async attachAcceptedMedia(
    input: Readonly<{ accepted: AcceptedMediaHandoff }>,
  ): Promise<AnalysisJob> {
    let job: AnalysisJob | undefined;
    let queueError = false;
    try {
      try {
        if (!(await this.queue.isAvailable())) queueError = true;
      } catch {
        queueError = true;
      }
      if (queueError) throw new QueueUnavailableError();
      job = await this.repository.attachPreparedMedia({
        accepted: input.accepted,
      });
      await this.queue.enqueue(job);
      // The first write can lose a transient SQLite race after enqueue. Retry
      // the idempotent state transition once before reporting ambiguity.
      const marked = await settle(this.repository.markMediaDeliveryQueued(job));
      if (!marked) {
        const reconciled = await settle(
          this.repository.markMediaDeliveryQueued(job),
        );
        if (!reconciled) {
          this.logDeliveryRecord(input.accepted, job.generation);
          // Enqueue has already succeeded, so deleting this media could race
          // the worker. Leave C4's pending-delivery fact for reconciliation and
          // report the delivery as unavailable rather than returning success.
          throw new QueueDeliveryUncertainError();
        }
      }
      return job;
    } catch (error) {
      if (error instanceof QueueDeliveryUncertainError)
        throw new QueueUnavailableError();
      await this.compensate(input.accepted, job);
      // Queue availability/delivery never leaks storage, database, or driver
      // error details through the public classification.
      if (error instanceof QueueUnavailableError) throw error;
      if (job) throw new QueueUnavailableError();
      throw error;
    }
  }

  private async compensate(
    accepted: AcceptedMediaHandoff,
    job: AnalysisJob | undefined,
  ): Promise<void> {
    const generation = job?.generation ?? accepted.context.generation;
    const recovery = await settle(
      this.repository.beginMediaAttachmentRecovery({
        attemptId: accepted.context.attemptId,
        generation,
        mediaId: accepted.storedMedia.id,
        frameBatchId: accepted.processingContext.receipt.frameBatchId,
      }),
    );
    if (!recovery) this.logRecovery(accepted, generation);

    if (job) {
      const rollback = await settle(
        this.repository.rollbackMediaAttachment({
          attemptId: accepted.context.attemptId,
          generation,
        }),
      );
      if (!rollback) {
        // The durable recovery fact remains claimable. Deleting bytes while
        // C4 still references them would turn a queue failure into corruption.
        this.logRecovery(accepted, generation);
        return;
      }
    }

    const cleanup = await settle(accepted.cleanup.cleanup());
    if (!cleanup) {
      this.logCleanup(accepted, generation);
      return;
    }

    const acknowledged = await settle(
      this.repository.acknowledgeMediaAttachmentCleanup({
        attemptId: accepted.context.attemptId,
        generation,
        mediaId: accepted.storedMedia.id,
      }),
    );
    if (!acknowledged) this.logRecovery(accepted, generation);
  }

  private logCleanup(accepted: AcceptedMediaHandoff, generation: number): void {
    this.logEvent(
      Object.freeze({
        category: "media_attachment_cleanup_failed" as const,
        attempt: redactAttempt(accepted.context.attemptId),
        generation,
      }),
    );
  }

  private logRecovery(
    accepted: AcceptedMediaHandoff,
    generation: number,
  ): void {
    this.logEvent(
      Object.freeze({
        category: "media_attachment_recovery_failed" as const,
        attempt: redactAttempt(accepted.context.attemptId),
        generation,
      }),
    );
  }

  private logDeliveryRecord(
    accepted: AcceptedMediaHandoff,
    generation: number,
  ): void {
    this.logEvent(
      Object.freeze({
        category: "media_attachment_delivery_record_failed" as const,
        attempt: redactAttempt(accepted.context.attemptId),
        generation,
      }),
    );
  }

  private logEvent(event: Parameters<AttemptServiceLog["event"]>[0]): void {
    try {
      this.log?.event(event);
    } catch {
      // Observability must not mask QueueUnavailable or abandon compensation.
    }
  }
}

/** The queue may have accepted the job, so compensation would be unsafe. */
class QueueDeliveryUncertainError extends Error {}

async function settle(operation: Promise<void>): Promise<boolean> {
  try {
    await operation;
    return true;
  } catch {
    return false;
  }
}

function redactAttempt(value: string): string {
  return value.slice(0, 8);
}
