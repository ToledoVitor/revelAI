import type { MediaUploadAccepted } from "@revelai/contracts";
import type {
  C5MediaPipeline,
  MediaPipelineMultipartAcceptanceInput,
} from "../media/media-pipeline.js";
import type { MultipartIntake } from "../media/multipart-intake.js";
import type { AnalysisQueue } from "../queue/analysis-queue.js";
import { QueueUnavailableError } from "../queue/analysis-queue.js";
import type { MediaUploadContext } from "../repositories/attempt-repository.js";
import {
  AttemptService,
  type AttachmentRepository,
} from "./attempt-service.js";

/** Transport-facing operation pair. Only composition can make it API-usable. */
export type MediaUploadService = Readonly<{
  preflight(
    input: Readonly<{ attemptId: string; athleteId: string }>,
  ): Promise<MediaUploadContext>;
  accept(
    input: Readonly<{
      context: MediaUploadContext;
      multipart: Omit<MultipartIntake, "createStage">;
    }>,
  ): Promise<MediaUploadAccepted>;
}>;

/** Closure ports captured by the production composition before HTTP sees them. */
export type MediaUploadServiceDependencies = Readonly<{
  requireCurrent(): void;
  prepareMediaUpload(
    input: Readonly<{ attemptId: string; athleteId: string }>,
  ): Promise<MediaUploadContext>;
  queue: Readonly<{
    isAvailable(): Promise<boolean>;
    enqueue: Pick<AnalysisQueue, "enqueue">["enqueue"];
  }>;
  attachment: AttachmentRepository;
  acceptMultipart(
    input: MediaPipelineMultipartAcceptanceInput,
  ): ReturnType<C5MediaPipeline["acceptMultipart"]>;
  retention: MediaPipelineMultipartAcceptanceInput["retention"]["repository"];
}>;

/** Explicit failure when an HTTP host lacks its sealed C5 composition. */
export class MediaUploadServiceUnavailableError extends Error {}

/**
 * Builds a frozen closure use-case from already-sealed narrow ports. This
 * module deliberately has no persistence-adapter knowledge; it owns the full preflight,
 * C5 accept, C4 attach/queue, and public accepted projection.
 */
export function createMediaUploadService(
  dependencies: MediaUploadServiceDependencies,
): MediaUploadService {
  const requireCurrent = dependencies.requireCurrent;
  const prepareMediaUpload = dependencies.prepareMediaUpload;
  const isAvailable = dependencies.queue.isAvailable;
  const enqueue = dependencies.queue.enqueue;
  const acceptMultipart = dependencies.acceptMultipart;
  const retention = dependencies.retention;
  const attachment = new AttemptService({
    repository: dependencies.attachment,
    queue: Object.freeze({ isAvailable, enqueue }),
  });

  return Object.freeze({
    preflight: async (input) => {
      requireCurrent();
      const context = await prepareMediaUpload(input);
      if (!(await available(isAvailable))) throw new QueueUnavailableError();
      return context;
    },
    accept: async ({ context, multipart }) => {
      requireCurrent();
      const accepted = await acceptMultipart({
        mode: context.mode,
        multipart,
        retention: {
          repository: retention,
          attemptId: context.attemptId,
          generation: context.generation,
          uploadedAt: context.uploadedAt,
          authority: context,
        },
      });
      await attachment.attachAcceptedMedia({ accepted });
      return acceptedProjection(context);
    },
  });
}

/** An unavailable route shares the same transport shape without C4/C5 work. */
export function createUnavailableMediaUploadService(): MediaUploadService {
  const unavailable = async (): Promise<never> => {
    throw new MediaUploadServiceUnavailableError();
  };
  return Object.freeze({ preflight: unavailable, accept: unavailable });
}

async function available(
  isAvailable: () => Promise<boolean>,
): Promise<boolean> {
  try {
    return await isAvailable();
  } catch {
    return false;
  }
}

function acceptedProjection(context: MediaUploadContext): MediaUploadAccepted {
  return Object.freeze({
    kind: "media-upload-accepted" as const,
    attemptId: context.attemptId,
    mode: context.mode,
    acceptedStatus: "uploaded" as const,
    outcome: Object.freeze({
      state: "pending" as const,
      attemptId: context.attemptId,
      mode: context.mode,
      status: "uploaded" as const,
    }),
  });
}
