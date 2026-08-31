import { describe, expect, it } from "vitest";
import { C8RecoveryRuntime } from "./media-attachment-recovery.js";

describe("C8 recovery runtime", () => {
  it("starts bounded delivery redelivery immediately and schedules later runs through the production composition factory", async () => {
    const module = (await import("./media-attachment-recovery.js")) as Record<
      string,
      unknown
    >;
    const createRuntime = module.createC8RecoveryRuntime;

    expect(typeof createRuntime).toBe("function");
    if (typeof createRuntime !== "function") return;

    const scheduled: Array<() => void> = [];
    const jobs: unknown[] = [];
    const acknowledgements: unknown[] = [];
    let cancelled = false;
    const runtime = createRuntime({
      repository: {
        claimMediaDeliveryRedelivery: async () => [
          {
            attemptId: "11111111-1111-4111-8111-111111111111",
            generation: 3,
            mediaId: "22222222-2222-4222-8222-222222222222",
            frameBatchId: "33333333-3333-4333-8333-333333333333",
            state: "pending-delivery",
            requiresRollback: true,
            leaseId: "44444444-4444-4444-8444-444444444444",
          },
        ],
        acknowledgeMediaDeliveryRedelivery: async (claim: unknown) =>
          void acknowledgements.push(claim),
        releaseMediaDeliveryRedelivery: async () => undefined,
        claimMediaAttachmentRecovery: async () => [],
        rollbackMediaAttachment: async () => undefined,
        acknowledgeMediaAttachmentCleanup: async () => undefined,
        releaseMediaAttachmentRecovery: async () => undefined,
      },
      queue: {
        isAvailable: async () => true,
        enqueue: async (job: unknown) => void jobs.push(job),
        subscribe: () => () => undefined,
      },
      cleaner: { cleanup: async () => undefined },
      log: { event: () => undefined },
      scheduler: {
        everyHour: (task: () => void) => {
          scheduled.push(task);
          return { timer: 1 };
        },
        cancel: () => {
          cancelled = true;
        },
      },
      maxBatchSize: 1,
      now: () => "2030-01-15T12:00:00.000Z",
    });

    const stop = runtime.start();
    await nextTurn();
    expect(jobs).toEqual([
      {
        attemptId: "11111111-1111-4111-8111-111111111111",
        generation: 3,
      },
    ]);
    expect(acknowledgements).toEqual([
      {
        attemptId: "11111111-1111-4111-8111-111111111111",
        generation: 3,
        leaseId: "44444444-4444-4444-8444-444444444444",
      },
    ]);
    expect(scheduled).toHaveLength(1);
    expect(() => scheduled[0]!()).not.toThrow();
    stop();
    expect(cancelled).toBe(true);
  });

  it("suppresses overlapping bounded runs until the leased delivery pass settles", async () => {
    let unblock: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const runtime = new C8RecoveryRuntime({
      repository: {
        claimMediaDeliveryRedelivery: async () => {
          await blocked;
          return [];
        },
        acknowledgeMediaDeliveryRedelivery: async () => undefined,
        releaseMediaDeliveryRedelivery: async () => undefined,
        claimMediaAttachmentRecovery: async () => [],
        rollbackMediaAttachment: async () => undefined,
        acknowledgeMediaAttachmentCleanup: async () => undefined,
        releaseMediaAttachmentRecovery: async () => undefined,
      },
      queue: { enqueue: async () => undefined },
      cleaner: { cleanup: async () => undefined },
      log: { event: () => undefined },
      maxBatchSize: 1,
    });

    const first = runtime.run("2030-01-15T12:00:00.000Z");
    await expect(runtime.run("2030-01-15T12:00:00.000Z")).resolves.toEqual({
      kind: "skipped-overlap",
    });
    unblock!();
    await expect(first).resolves.toEqual({
      kind: "completed",
      redelivered: 0,
      cleaned: 0,
    });
  });
});

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
