import type { MediaUploadAccepted } from "@revelai/contracts";
import type { C5MediaPipeline } from "../media/media-pipeline.js";
import { resolveFactoryIssuedSQLiteRetentionRepositoryToken } from "../media/sqlite-retention-repository.js";
import type { UploadRetentionRepository } from "../storage/local-media-storage.js";
import type {
  AttemptRepository,
  MediaUploadContext,
} from "../repositories/attempt-repository.js";
import { resolveFactoryIssuedSQLiteAttemptRepositoryToken } from "../repositories/sqlite-attempt-repository.js";
import {
  QueueUnavailableError,
  type AnalysisQueue,
} from "../queue/analysis-queue.js";
import {
  AttemptService,
  type AttachmentRepository,
} from "../services/attempt-service.js";

type MediaUploadRepository = Pick<AttemptRepository, "prepareMediaUpload"> &
  AttachmentRepository;
type MediaUploadQueue = Pick<AnalysisQueue, "isAvailable" | "enqueue">;

/** Explicit failure when an HTTP host lacks its C5 production composition. */
export class MediaUploadServiceUnavailableError extends Error {}

/**
 * One deep transport-independent C8 operation: it preflights C4 authority,
 * binds the same retention port to C5, and delegates atomic attach/delivery to
 * AttemptService. The HTTP route owns only header/path parsing and status I/O.
 */
export class MediaUploadService {
  private readonly repository: MediaUploadRepository;
  private readonly retention: UploadRetentionRepository;
  private readonly queue: MediaUploadQueue;
  private readonly pipeline: C5MediaPipeline | undefined;
  private readonly attachment: AttemptService;

  public constructor(
    input: Readonly<{
      repository: MediaUploadRepository;
      retention: UploadRetentionRepository;
      queue: MediaUploadQueue;
      mediaPipeline?: C5MediaPipeline;
    }>,
  ) {
    assertMatchedSqliteComposition(input.repository, input.retention);
    this.repository = input.repository;
    this.retention = input.retention;
    this.queue = input.queue;
    this.pipeline = input.mediaPipeline;
    this.attachment = new AttemptService({
      repository: input.repository,
      queue: input.queue,
    });
  }

  public async preflight(
    input: Readonly<{ attemptId: string; athleteId: string }>,
  ): Promise<MediaUploadContext> {
    const context = await this.repository.prepareMediaUpload(input);
    if (!(await available(this.queue))) throw new QueueUnavailableError();
    if (!this.pipeline) throw new MediaUploadServiceUnavailableError();
    return context;
  }

  public async accept(
    input: Readonly<{
      context: MediaUploadContext;
      multipart: Parameters<C5MediaPipeline["acceptMultipart"]>[0]["multipart"];
    }>,
  ): Promise<MediaUploadAccepted> {
    if (!this.pipeline) throw new MediaUploadServiceUnavailableError();
    const accepted = await this.pipeline.acceptMultipart({
      mode: input.context.mode,
      multipart: input.multipart,
      retention: {
        repository: this.retention,
        attemptId: input.context.attemptId,
        generation: input.context.generation,
        uploadedAt: input.context.uploadedAt,
        authority: input.context,
      },
    });
    await this.attachment.attachAcceptedMedia({ accepted });
    return Object.freeze({
      kind: "media-upload-accepted" as const,
      attemptId: input.context.attemptId,
      mode: input.context.mode,
      acceptedStatus: "uploaded" as const,
      outcome: Object.freeze({
        state: "pending" as const,
        attemptId: input.context.attemptId,
        mode: input.context.mode,
        status: "uploaded" as const,
      }),
    });
  }
}

/**
 * C4 and C5 intentionally remain separate repositories. When both are the
 * real SQLite adapters, though, they must originate from one exact factory
 * wrapper so C5 cannot persist cleanup facts beside C4's attachment state.
 */
function assertMatchedSqliteComposition(
  repository: unknown,
  retention: unknown,
): void {
  const attemptToken =
    resolveFactoryIssuedSQLiteAttemptRepositoryToken(repository);
  const retentionToken =
    resolveFactoryIssuedSQLiteRetentionRepositoryToken(retention);
  if (!attemptToken && !retentionToken) return;
  if (!attemptToken || !retentionToken || attemptToken !== retentionToken)
    throw new Error(
      "C8 media upload requires matching factory-issued SQLite repositories.",
    );
}

async function available(queue: MediaUploadQueue): Promise<boolean> {
  try {
    return await queue.isAvailable();
  } catch {
    return false;
  }
}
