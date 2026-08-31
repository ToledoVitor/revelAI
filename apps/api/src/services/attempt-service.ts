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
  recoverMediaAttachment(
    input: Readonly<{ attemptId: string; generation: number }>,
  ): Promise<void>;
}>;

export interface AttemptServiceLog {
  event(
    event: Readonly<{
      category:
        | "media_attachment_cleanup_failed"
        | "media_attachment_recovery_failed";
      attempt: string;
      generation: number;
    }>,
  ): void;
}

/** Coordinates one accepted C5 handoff with identifier-only queue delivery. */
export class AttemptService {
  private readonly repository: AttachmentRepository;
  private readonly queue: AnalysisQueue;
  private readonly log: AttemptServiceLog | undefined;

  public constructor(
    input: Readonly<{
      repository: AttachmentRepository;
      queue: AnalysisQueue;
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
    try {
      if (!(await this.queue.isAvailable())) throw new QueueUnavailableError();
      job = await this.repository.attachPreparedMedia({
        accepted: input.accepted,
      });
      await this.queue.enqueue(job);
      return job;
    } catch (error) {
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
    const cleanup = accepted.cleanup.cleanup();
    if (!job) {
      const [result] = await Promise.allSettled([cleanup]);
      if (result.status === "rejected")
        this.logCleanup(accepted, accepted.context.generation);
      return;
    }
    const [rollbackResult, cleanupResult] = await Promise.allSettled([
      this.repository.rollbackMediaAttachment({
        attemptId: accepted.context.attemptId,
        generation: job.generation,
      }),
      cleanup,
    ]);
    if (cleanupResult.status === "rejected")
      this.logCleanup(accepted, job.generation);
    if (rollbackResult.status === "rejected") {
      const [recovery] = await Promise.allSettled([
        this.repository.recoverMediaAttachment({
          attemptId: accepted.context.attemptId,
          generation: job.generation,
        }),
      ]);
      // A recovery request is deliberately attempted even if C5 deletion
      // failed; it makes the retention fact durable without restoring SQL.
      if (recovery.status === "rejected")
        this.log?.event(
          Object.freeze({
            category: "media_attachment_recovery_failed" as const,
            attempt: redactAttempt(accepted.context.attemptId),
            generation: job.generation,
          }),
        );
    }
  }

  private logCleanup(accepted: AcceptedMediaHandoff, generation: number): void {
    this.log?.event(
      Object.freeze({
        category: "media_attachment_cleanup_failed" as const,
        attempt: redactAttempt(accepted.context.attemptId),
        generation,
      }),
    );
  }
}

function redactAttempt(value: string): string {
  return value.slice(0, 8);
}
