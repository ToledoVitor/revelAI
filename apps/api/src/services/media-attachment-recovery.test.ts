import { describe, expect, it } from "vitest";
import {
  MediaAttachmentRecoveryExecutor,
  MediaDeliveryRedeliveryExecutor,
} from "./media-attachment-recovery.js";

const claim = Object.freeze({
  attemptId: "11111111-1111-4111-8111-111111111111",
  generation: 2,
  mediaId: "22222222-2222-4222-8222-222222222222",
  frameBatchId: "33333333-3333-4333-8333-333333333333",
  state: "cleanup-recoverable" as const,
  requiresRollback: true,
  leaseId: "44444444-4444-4444-8444-444444444444",
});

describe("MediaAttachmentRecoveryExecutor", () => {
  it("leases, detaches, cleans opaque resources, and acknowledges in order", async () => {
    const calls: string[] = [];
    const executor = new MediaAttachmentRecoveryExecutor(
      {
        claimMediaAttachmentRecovery: async () => {
          calls.push("claim");
          return [claim];
        },
        rollbackMediaAttachment: async () => void calls.push("rollback"),
        acknowledgeMediaAttachmentCleanup: async () => void calls.push("ack"),
        releaseMediaAttachmentRecovery: async () => void calls.push("release"),
      },
      { cleanup: async () => void calls.push("cleanup") },
      { event: () => calls.push("log") },
    );

    await expect(
      executor.run({ now: "2030-01-15T12:00:00.000Z", limit: 4 }),
    ).resolves.toBe(1);
    expect(calls).toEqual(["claim", "rollback", "cleanup", "ack", "release"]);
  });

  it("never cleans when exact rollback fails and leaves the durable item retriable", async () => {
    const calls: string[] = [];
    const executor = new MediaAttachmentRecoveryExecutor(
      {
        claimMediaAttachmentRecovery: async () => [claim],
        rollbackMediaAttachment: async () => {
          calls.push("rollback");
          throw new Error("private sqlite detail");
        },
        acknowledgeMediaAttachmentCleanup: async () => void calls.push("ack"),
        releaseMediaAttachmentRecovery: async () => void calls.push("release"),
      },
      { cleanup: async () => void calls.push("cleanup") },
      { event: () => calls.push("log") },
    );

    await expect(
      executor.run({ now: "2030-01-15T12:00:00.000Z", limit: 1 }),
    ).resolves.toBe(0);
    expect(calls).toEqual(["rollback", "log", "release"]);
  });
});

describe("MediaDeliveryRedeliveryExecutor", () => {
  it("preserves the durable Free mode when a recovery executor re-enqueues a job", async () => {
    const delivered: unknown[] = [];
    const executor = new MediaDeliveryRedeliveryExecutor(
      {
        claimMediaDeliveryRedelivery: async () => [
          { ...claim, mode: "free" as const, state: "queued" as const },
        ],
        acknowledgeMediaDeliveryRedelivery: async () => undefined,
        releaseMediaDeliveryRedelivery: async () => undefined,
      },
      { enqueue: async (job) => void delivered.push(job) },
      { event: () => undefined },
    );

    await expect(
      executor.run({ now: "2030-01-15T12:00:00.000Z", limit: 1 }),
    ).resolves.toBe(1);
    expect(delivered).toEqual([
      {
        attemptId: claim.attemptId,
        generation: claim.generation,
        mode: "free",
      },
    ]);
  });

  it("releases a failed leased delivery for at-least-once retry without exposing queue detail", async () => {
    const calls: string[] = [];
    const executor = new MediaDeliveryRedeliveryExecutor(
      {
        claimMediaDeliveryRedelivery: async () => [
          {
            ...claim,
            state: "pending-delivery" as const,
          },
        ],
        acknowledgeMediaDeliveryRedelivery: async () => void calls.push("ack"),
        releaseMediaDeliveryRedelivery: async () => void calls.push("release"),
      },
      {
        enqueue: async () => {
          calls.push("enqueue");
          throw new Error("queue host is private");
        },
      },
      {
        event: (entry) => {
          calls.push(
            `${entry.category}:${"attempt" in entry ? entry.attempt : ""}`,
          );
        },
      },
    );

    await expect(
      executor.run({ now: "2030-01-15T12:00:00.000Z", limit: 1 }),
    ).resolves.toBe(0);
    expect(calls).toEqual([
      "enqueue",
      "media_delivery_redelivery_failed:11111111",
      "release",
    ]);
  });
});
