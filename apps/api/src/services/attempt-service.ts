import type { AnalysisJob, AnalysisQueue } from "../queue/analysis-queue.js";
import { QueueUnavailableError } from "../queue/analysis-queue.js";
import type { StoredMedia } from "../repositories/attempt-repository.js";

export type AttachmentRepository = Readonly<{
  attachValidatedMedia(
    input: Readonly<{
      attemptId: string;
      athleteId: string;
      media: StoredMedia;
    }>,
  ): Promise<AnalysisJob>;
  rollbackMediaAttachment(
    input: Readonly<{
      attemptId: string;
      athleteId: string;
      mediaId: string;
      generation: number;
    }>,
  ): Promise<void>;
}>;

/** Coordinates durable attachment with identifier delivery; queue never rolls state back. */
export class AttemptService {
  private readonly repository: AttachmentRepository;
  private readonly queue: AnalysisQueue;

  public constructor(
    input: Readonly<{ repository: AttachmentRepository; queue: AnalysisQueue }>,
  ) {
    this.repository = input.repository;
    this.queue = input.queue;
  }

  public async attachValidatedMedia(
    input: Readonly<{
      attemptId: string;
      athleteId: string;
      media: StoredMedia;
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
        athleteId: input.athleteId,
        mediaId: input.media.id,
        generation: job.generation,
      });
      if (error instanceof QueueUnavailableError) throw error;
      throw new QueueUnavailableError();
    }
  }
}
