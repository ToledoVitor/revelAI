import { describe, expect, it } from "vitest";
import {
  QueueUnavailableError,
  type AnalysisJob,
  type AnalysisQueue,
} from "../queue/analysis-queue.js";
import type { StoredMedia } from "../repositories/attempt-repository.js";
import { AttemptService } from "./attempt-service.js";

const media: StoredMedia = {
  id: "media-a",
  contentType: "video/mp4",
  bytes: 10,
  deleteAt: "2030-01-16T12:00:00.000Z",
} as const;

class AttachmentStore {
  public attached: StoredMedia | null = null;

  public async attachValidatedMedia(
    input: Readonly<{
      media: StoredMedia;
      attemptId: string;
      athleteId: string;
    }>,
  ): Promise<AnalysisJob> {
    this.attached = input.media;
    return { attemptId: input.attemptId, generation: 1 };
  }

  public async rollbackMediaAttachment(): Promise<void> {
    this.attached = null;
  }
}

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
});
