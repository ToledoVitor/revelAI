import { describe, expect, it } from "vitest";
import {
  QueueUnavailableError,
  type AnalysisJob,
  type AnalysisQueue,
} from "../queue/analysis-queue.js";
import type { AcceptedMediaHandoff } from "../media/accepted-media-handoff.js";
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

function accepted(cleanup: () => Promise<void>): AcceptedMediaHandoff {
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
  return Object.freeze({
    context,
    storedMedia,
    sourceSha256: "a".repeat(64),
    processingContext: Object.freeze({
      kind: "c5-durable-processing-context-v2" as const,
      receipt: Object.freeze({
        frameBatchId: "55555555-5555-4555-8555-555555555555",
        mediaId: storedMedia.id,
        sha256: "b".repeat(64),
      }),
    }),
    cleanup: { cleanup },
  });
}

class Store implements AttachmentRepository {
  public calls: string[] = [];
  public failRollback = false;
  public failRecovery = false;
  public failCleanupAck = false;
  public failDeliveryRecord = false;
  public failDeliveryRecordAttempts = 0;

  public async attachPreparedMedia(): Promise<AnalysisJob> {
    this.calls.push("attach");
    return { attemptId: context.attemptId, generation: context.generation };
  }

  public async rollbackMediaAttachment(): Promise<void> {
    this.calls.push("rollback");
    if (this.failRollback) throw new Error("sqlite /private/path");
  }

  public async beginMediaAttachmentRecovery(): Promise<void> {
    this.calls.push("retain-recovery");
    if (this.failRecovery) throw new Error("sqlite /private/path");
  }

  public async acknowledgeMediaAttachmentCleanup(): Promise<void> {
    this.calls.push("ack-cleanup");
    if (this.failCleanupAck) throw new Error("sqlite /private/path");
  }

  public async markMediaDeliveryQueued(): Promise<void> {
    this.calls.push("queued");
    if (this.failDeliveryRecord || this.failDeliveryRecordAttempts > 0) {
      this.failDeliveryRecordAttempts -= 1;
      throw new Error("sqlite /private/path");
    }
  }

  public async getMediaDeliveryRecovery() {
    return null;
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
          store.calls.push("cleanup");
          cleanups += 1;
        }),
      }),
    ).rejects.toBeInstanceOf(QueueUnavailableError);
    expect(store.calls).toEqual(["retain-recovery", "cleanup", "ack-cleanup"]);
    expect(cleanups).toBe(1);
  });

  it("classifies a throwing preflight as unavailable after retaining cleanup recovery", async () => {
    const store = new Store();
    const service = new AttemptService({
      repository: store,
      queue: {
        isAvailable: async () => {
          throw new Error("queue endpoint /private");
        },
        enqueue: async () => undefined,
      },
    });

    await expect(
      service.attachAcceptedMedia({
        accepted: accepted(async () => {
          store.calls.push("cleanup");
        }),
      }),
    ).rejects.toBeInstanceOf(QueueUnavailableError);
    expect(store.calls).toEqual(["retain-recovery", "cleanup", "ack-cleanup"]);
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
          store.calls.push("cleanup");
          cleanups += 1;
        }),
      }),
    ).rejects.toBeInstanceOf(QueueUnavailableError);
    expect(store.calls).toEqual([
      "attach",
      "retain-recovery",
      "rollback",
      "cleanup",
      "ack-cleanup",
    ]);
    expect(cleanups).toBe(1);
  });

  it("does not report success or delete bytes when post-enqueue delivery recording is uncertain", async () => {
    const store = new Store();
    store.failDeliveryRecord = true;
    const events: unknown[] = [];
    const service = new AttemptService({
      repository: store,
      queue: queue({ enqueue: async () => undefined }),
      log: { event: (event) => events.push(event) },
    });

    await expect(
      service.attachAcceptedMedia({
        accepted: accepted(async () => {
          store.calls.push("cleanup");
        }),
      }),
    ).rejects.toBeInstanceOf(QueueUnavailableError);
    expect(store.calls).toEqual(["attach", "queued", "queued"]);
    expect(events).toEqual([
      {
        category: "media_attachment_delivery_record_failed",
        attempt: "33333333",
        generation: 3,
      },
    ]);
  });

  it("reconciles one transient post-enqueue delivery-record failure before returning", async () => {
    const store = new Store();
    store.failDeliveryRecordAttempts = 1;
    const service = new AttemptService({
      repository: store,
      queue: queue({ enqueue: async () => undefined }),
    });

    await expect(
      service.attachAcceptedMedia({
        accepted: accepted(async () => undefined),
      }),
    ).resolves.toEqual({ attemptId: context.attemptId, generation: 3 });
    expect(store.calls).toEqual(["attach", "queued", "queued"]);
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
    expect(store.calls).toEqual(["attach", "retain-recovery", "rollback"]);
    expect(events).toEqual([
      {
        category: "media_attachment_recovery_failed",
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

  it("does not let a throwing logger mask queue unavailability or stop sequential recovery", async () => {
    const store = new Store();
    store.failRollback = true;
    store.failRecovery = true;
    const service = new AttemptService({
      repository: store,
      queue: queue({
        enqueue: async () => {
          throw new QueueUnavailableError();
        },
      }),
      log: {
        event: () => {
          throw new Error("logger /private");
        },
      },
    });

    await expect(
      service.attachAcceptedMedia({
        accepted: accepted(async () => {
          store.calls.push("cleanup");
        }),
      }),
    ).rejects.toBeInstanceOf(QueueUnavailableError);
    expect(store.calls).toEqual(["attach", "retain-recovery", "rollback"]);
  });
});
