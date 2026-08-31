import { describe, expect, it } from "vitest";
import {
  QueueUnavailableError,
  type AnalysisJob,
  type AnalysisQueue,
} from "../queue/analysis-queue.js";
import { createAcceptedMediaHandoff } from "../media/accepted-media-handoff.js";
import { createStorageBackedDurableProcessingContext } from "../media/extraction-manifest.js";
import { createStoredMediaAttachment } from "../repositories/attempt-repository.js";
import {
  AttemptService,
  type AttachmentRepository,
} from "./attempt-service.js";

const context = {
  attemptId: "33333333-3333-4333-8333-333333333333",
  athleteId: "11111111-1111-4111-8111-111111111111",
  mode: "free" as const,
  generation: 3,
  uploadedAt: "2030-01-15T13:00:00.000Z",
  verified: null,
};

function accepted(cleanup: () => Promise<void>) {
  const storedMedia = createStoredMediaAttachment({
    id: "44444444-4444-4444-8444-444444444444",
    contentType: "video/mp4",
    bytes: 10,
    uploadedAt: context.uploadedAt,
    deleteAt: "2030-01-16T12:00:00.000Z",
    transition: {
      kind: "upload-transition",
      resourceId: "44444444-4444-4444-8444-444444444444",
      deleteAt: "2030-01-15T14:00:00.000Z",
    },
  });
  return createAcceptedMediaHandoff({
    context,
    storedMedia,
    sourceSha256: "a".repeat(64),
    processingContext: createStorageBackedDurableProcessingContext({
      frameBatchId: "55555555-5555-4555-8555-555555555555",
      mediaId: storedMedia.id,
      sha256: "b".repeat(64),
    }),
    cleanup: { cleanup },
  });
}

class Store implements AttachmentRepository {
  public calls: string[] = [];
  public failRollback = false;
  public failRecovery = false;

  public async attachPreparedMedia(): Promise<AnalysisJob> {
    this.calls.push("attach");
    return { attemptId: context.attemptId, generation: context.generation };
  }

  public async rollbackMediaAttachment(): Promise<void> {
    this.calls.push("rollback");
    if (this.failRollback) throw new Error("sqlite /private/path");
  }

  public async recoverMediaAttachment(): Promise<void> {
    this.calls.push("recover");
    if (this.failRecovery) throw new Error("sqlite /private/path");
  }
}

function queue(input: {
  available?: boolean;
  enqueue?: () => Promise<void>;
}): AnalysisQueue {
  return {
    isAvailable: async () => input.available ?? true,
    enqueue: input.enqueue ?? (async () => undefined),
    subscribe: () => () => undefined,
  };
}

describe("AttemptService", () => {
  it("cleans accepted media when queue preflight is unavailable", async () => {
    const store = new Store();
    let cleanups = 0;
    const service = new AttemptService({
      repository: store,
      queue: queue({ available: false }),
    });

    await expect(
      service.attachAcceptedMedia({
        accepted: accepted(async () => {
          cleanups += 1;
        }),
      }),
    ).rejects.toBeInstanceOf(QueueUnavailableError);
    expect(store.calls).toEqual([]);
    expect(cleanups).toBe(1);
  });

  it("rolls back the exact generation and cleans on enqueue failure", async () => {
    const store = new Store();
    let cleanups = 0;
    const service = new AttemptService({
      repository: store,
      queue: queue({
        enqueue: async () => {
          throw new QueueUnavailableError();
        },
      }),
    });

    await expect(
      service.attachAcceptedMedia({
        accepted: accepted(async () => {
          cleanups += 1;
        }),
      }),
    ).rejects.toBeInstanceOf(QueueUnavailableError);
    expect(store.calls).toEqual(["attach", "rollback"]);
    expect(cleanups).toBe(1);
  });

  it("attempts recovery even when rollback and cleanup both fail, with redacted events", async () => {
    const store = new Store();
    store.failRollback = true;
    store.failRecovery = true;
    const events: unknown[] = [];
    const service = new AttemptService({
      repository: store,
      queue: queue({
        enqueue: async () => {
          throw new QueueUnavailableError();
        },
      }),
      log: { event: (event) => events.push(event) },
    });

    await expect(
      service.attachAcceptedMedia({
        accepted: accepted(async () => {
          throw new Error("/private/original.mp4");
        }),
      }),
    ).rejects.toBeInstanceOf(QueueUnavailableError);
    expect(store.calls).toEqual(["attach", "rollback", "recover"]);
    expect(events).toEqual([
      {
        category: "media_attachment_cleanup_failed",
        attempt: "33333333",
        generation: 3,
      },
      {
        category: "media_attachment_recovery_failed",
        attempt: "33333333",
        generation: 3,
      },
    ]);
  });
});
