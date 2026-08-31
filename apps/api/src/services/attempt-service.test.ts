import { describe, expect, it } from "vitest";
import {
  QueueUnavailableError,
  type AnalysisJob,
  type AnalysisQueue,
} from "../queue/analysis-queue.js";
import {
  createStoredMediaAttachment,
  type MediaUploadContext,
  type StoredMedia,
  type StoredMediaAttachment,
} from "../repositories/attempt-repository.js";
import type { DurableProcessingContext } from "../media/extraction-manifest.js";
import type { AcceptedMediaCleanup } from "../media/media-pipeline.js";
import {
  AttemptService,
  MediaAttachmentCleanupError,
} from "./attempt-service.js";

const storedMedia: StoredMedia = {
  id: "media-a",
  contentType: "video/mp4",
  bytes: 10,
  uploadedAt: "2030-01-15T13:00:00.000Z",
  deleteAt: "2030-01-16T12:00:00.000Z",
  transition: {
    kind: "upload-transition",
    resourceId: "media-a",
    deleteAt: "2030-01-15T14:00:00.000Z",
  },
} as const;
const media = createStoredMediaAttachment(storedMedia);

class AttachmentStore {
  public attached: StoredMediaAttachment | null = null;
  public rollbackInput: unknown = null;
  public preparedInput: unknown = null;

  public async attachValidatedMedia(
    input: Readonly<{
      media: StoredMediaAttachment;
      attemptId: string;
      athleteId: string;
    }>,
  ): Promise<AnalysisJob> {
    this.attached = input.media;
    return { attemptId: input.attemptId, generation: 1 };
  }

  public async rollbackMediaAttachment(input: unknown): Promise<void> {
    this.rollbackInput = input;
    this.attached = null;
    this.preparedInput = null;
  }

  public async attachPreparedMedia(
    input: Readonly<{
      context: MediaUploadContext;
      media: StoredMediaAttachment;
      processingContext: DurableProcessingContext;
    }>,
  ): Promise<AnalysisJob> {
    this.preparedInput = input;
    return {
      attemptId: input.context.attemptId,
      generation: input.context.generation,
    };
  }
}

const preparedUpload: MediaUploadContext = {
  attemptId: "33333333-3333-4333-8333-333333333333",
  athleteId: "11111111-1111-4111-8111-111111111111",
  mode: "free",
  generation: 1,
  uploadedAt: "2030-01-15T13:00:00.000Z",
  verified: null,
};
const preparedMedia = createStoredMediaAttachment({
  ...storedMedia,
  id: "44444444-4444-4444-8444-444444444444",
  transition: {
    ...storedMedia.transition,
    resourceId: "44444444-4444-4444-8444-444444444444",
  },
});
const preparedProcessing: DurableProcessingContext = {
  kind: "c5-durable-processing-context-v1",
  manifest: {
    kind: "extraction-manifest",
    extractionVersion: "c5-frame-manifest-v1",
    mode: "free",
    attemptId: preparedUpload.attemptId,
    generation: 1,
    mediaId: preparedMedia.id,
    mediaSha256: "a".repeat(64),
    display: { width: 480, height: 853, rotationDegrees: 0 },
    probe: {
      container: "mp4",
      durationSeconds: 3,
      displayWidth: 480,
      displayHeight: 853,
      nominalFps: 12,
      codec: "h264",
      sourceRotationDegrees: 0,
    },
    frames: {
      count: 12,
      items: Array.from({ length: 12 }, (_, ordinal) => ({
        ordinal,
        timestampSeconds: (3 * ordinal) / 11,
        reference: `frame-${String(ordinal).padStart(4, "0")}`,
      })),
    },
  },
};

describe("AttemptService", () => {
  it("does not attach media while the separate queue is unavailable", async () => {
    const store = new AttachmentStore();
    const queue: AnalysisQueue = {
      isAvailable: async () => false,
      enqueue: async () => undefined,
      subscribe: () => () => undefined,
    };
    const service = new AttemptService({ repository: store, queue });

    await expect(
      service.attachValidatedMedia({
        attemptId: "attempt-a",
        athleteId: "athlete-a",
        media,
      }),
    ).rejects.toBeInstanceOf(QueueUnavailableError);
    expect(store.attached).toBeNull();
    expect(store.rollbackInput).toBeNull();
  });

  it("rolls an attachment back when the separate queue rejects enqueue", async () => {
    const store = new AttachmentStore();
    const queue: AnalysisQueue = {
      isAvailable: async () => true,
      enqueue: async () => {
        throw new QueueUnavailableError();
      },
      subscribe: () => () => undefined,
    };
    const service = new AttemptService({ repository: store, queue });

    await expect(
      service.attachValidatedMedia({
        attemptId: "attempt-a",
        athleteId: "athlete-a",
        media,
      }),
    ).rejects.toBeInstanceOf(QueueUnavailableError);
    expect(store.attached).toBeNull();
    expect(store.rollbackInput).toEqual({
      attemptId: "attempt-a",
      generation: 1,
    });
  });

  it("preserves an attachment repository failure instead of misreporting it as queue failure", async () => {
    const failure = new Error("duplicate media");
    const repository = {
      attachValidatedMedia: async () => {
        throw failure;
      },
      rollbackMediaAttachment: async () => undefined,
    };
    const queue: AnalysisQueue = {
      isAvailable: async () => true,
      enqueue: async () => undefined,
      subscribe: () => () => undefined,
    };
    const service = new AttemptService({ repository, queue });

    await expect(
      service.attachValidatedMedia({
        attemptId: "attempt-a",
        athleteId: "athlete-a",
        media,
      }),
    ).rejects.toBe(failure);
  });

  it("rolls back the exact prepared attachment before invoking only C5 cleanup", async () => {
    const store = new AttachmentStore();
    const queue: AnalysisQueue = {
      isAvailable: async () => true,
      enqueue: async () => {
        throw new QueueUnavailableError();
      },
      subscribe: () => () => undefined,
    };
    let cleanupCalls = 0;
    const cleanup: AcceptedMediaCleanup = {
      cleanup: async () => {
        cleanupCalls += 1;
      },
    };
    const service = new AttemptService({ repository: store, queue });

    await expect(
      service.attachPreparedMedia({
        context: preparedUpload,
        media: preparedMedia,
        processingContext: preparedProcessing,
        cleanup,
      }),
    ).rejects.toBeInstanceOf(QueueUnavailableError);

    expect(store.rollbackInput).toEqual({
      attemptId: preparedUpload.attemptId,
      generation: preparedUpload.generation,
    });
    expect(store.preparedInput).toBeNull();
    expect(cleanupCalls).toBe(1);
  });

  it("reports a cleanup failure without restoring the rolled-back attachment", async () => {
    const store = new AttachmentStore();
    const queue: AnalysisQueue = {
      isAvailable: async () => true,
      enqueue: async () => {
        throw new QueueUnavailableError();
      },
      subscribe: () => () => undefined,
    };
    const events: unknown[] = [];
    const service = new AttemptService({
      repository: store,
      queue,
      log: { event: (event) => events.push(event) },
    });

    await expect(
      service.attachPreparedMedia({
        context: preparedUpload,
        media: preparedMedia,
        processingContext: preparedProcessing,
        cleanup: {
          cleanup: async () => {
            throw new Error("/private/revelai/media/original.mp4");
          },
        },
      }),
    ).rejects.toBeInstanceOf(MediaAttachmentCleanupError);

    expect(store.preparedInput).toBeNull();
    expect(events).toEqual([
      {
        category: "media_attachment_cleanup_failed",
        attempt: "33333333",
        generation: 1,
      },
    ]);
  });
});
