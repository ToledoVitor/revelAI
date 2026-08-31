import type { AnalysisJob, AnalysisQueue } from "../queue/analysis-queue.js";
import { QueueUnavailableError } from "../queue/analysis-queue.js";
import type { DurableProcessingContext } from "../media/extraction-manifest.js";
import type { AcceptedMediaCleanup } from "../media/media-pipeline.js";
import type {
  MediaUploadContext,
  StoredMediaAttachment,
} from "../repositories/attempt-repository.js";

export type AttachmentRepository = Readonly<{
  attachValidatedMedia(
    input: Readonly<{
      attemptId: string;
      athleteId: string;
      media: StoredMediaAttachment;
    }>,
  ): Promise<AnalysisJob>;
  rollbackMediaAttachment(
    input: Readonly<{
      attemptId: string;
      generation: number;
    }>,
  ): Promise<void>;
}>;

/** C8's post-C5 attachment seam; C4 remains the source of truth. */
export type PreparedAttachmentRepository = AttachmentRepository &
  Readonly<{
    attachPreparedMedia(
      input: Readonly<{
        context: MediaUploadContext;
        media: StoredMediaAttachment;
        processingContext: DurableProcessingContext;
      }>,
    ): Promise<AnalysisJob>;
  }>;

export interface AttemptServiceLog {
  event(
    event: Readonly<{
      category: "media_attachment_cleanup_failed";
      attempt: string;
      generation: number;
    }>,
  ): void;
}

export class MediaAttachmentCleanupError extends Error {
  public readonly code = "media_attachment_cleanup_failed" as const;

  public constructor() {
    super("media_attachment_cleanup_failed");
    this.name = "MediaAttachmentCleanupError";
  }
}

/** Coordinates durable attachment with identifier delivery; queue never rolls state back. */
export class AttemptService {
  private readonly repository:
    | AttachmentRepository
    | PreparedAttachmentRepository;
  private readonly queue: AnalysisQueue;
  private readonly log: AttemptServiceLog | undefined;

  public constructor(
    input: Readonly<{
      repository: AttachmentRepository | PreparedAttachmentRepository;
      queue: AnalysisQueue;
      log?: AttemptServiceLog;
    }>,
  ) {
    this.repository = input.repository;
    this.queue = input.queue;
    this.log = input.log;
  }

  public async attachValidatedMedia(
    input: Readonly<{
      attemptId: string;
      athleteId: string;
      media: StoredMediaAttachment;
    }>,
  ): Promise<AnalysisJob> {
    if (!(await this.queue.isAvailable())) throw new QueueUnavailableError();
    const job = await this.repository.attachValidatedMedia(input);
    try {
      await this.queue.enqueue(job);
      return job;
    } catch (error) {
      await this.repository.rollbackMediaAttachment({
        attemptId: input.attemptId,
        generation: job.generation,
      });
      if (error instanceof QueueUnavailableError) throw error;
      throw new QueueUnavailableError();
    }
  }

  /**
   * Attaches C5's one accepted media result, then either queues exactly that
   * generation or returns the database to awaiting-upload before C5 deletes
   * the original/frame bytes. The cleanup capability never reveals a path.
   */
  public async attachPreparedMedia(
    input: Readonly<{
      context: MediaUploadContext;
      media: StoredMediaAttachment;
      processingContext: DurableProcessingContext;
      cleanup: AcceptedMediaCleanup;
    }>,
  ): Promise<AnalysisJob> {
    if (!(await this.queue.isAvailable())) throw new QueueUnavailableError();
    const repository = this.preparedRepository();
    const job = await repository.attachPreparedMedia({
      context: input.context,
      media: input.media,
      processingContext: input.processingContext,
    });
    try {
      await this.queue.enqueue(job);
      return job;
    } catch (error) {
      await repository.rollbackMediaAttachment({
        attemptId: input.context.attemptId,
        generation: job.generation,
      });
      try {
        await input.cleanup.cleanup();
      } catch {
        this.log?.event(
          Object.freeze({
            category: "media_attachment_cleanup_failed" as const,
            attempt: redactAttempt(input.context.attemptId),
            generation: job.generation,
          }),
        );
        throw new MediaAttachmentCleanupError();
      }
      if (error instanceof QueueUnavailableError) throw error;
      throw new QueueUnavailableError();
    }
  }

  private preparedRepository(): PreparedAttachmentRepository {
    if (!("attachPreparedMedia" in this.repository))
      throw new Error("Prepared attachment repository is required.");
    return this.repository;
  }
}

function redactAttempt(value: string): string {
  return value.slice(0, 8);
}
