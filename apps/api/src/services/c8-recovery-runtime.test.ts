import { describe, expect, it } from "vitest";
import { createC8RecoveryRuntime } from "./media-attachment-recovery.js";

describe("C8 recovery runtime", () => {
  it("starts bounded delivery redelivery immediately and schedules later runs through the production composition factory", async () => {
    const scheduled: Array<() => void> = [];
    const jobs: unknown[] = [];
    const acknowledgements: unknown[] = [];
    let cancelled = false;
    const runtime = createC8RecoveryRuntime({
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
        enqueue: async (job: unknown) => void jobs.push(job),
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
    await runtime.stop();
    expect(cancelled).toBe(true);
  });

  it("suppresses overlapping bounded runs until the leased delivery pass settles", async () => {
    const scheduled: Array<() => void> = [];
    let claims = 0;
    let unblock: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const runtime = createC8RecoveryRuntime({
      repository: {
        claimMediaDeliveryRedelivery: async () => {
          claims += 1;
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
      scheduler: {
        everyHour: (task) => {
          scheduled.push(task);
          return { timer: 1 };
        },
        cancel: () => undefined,
      },
      maxBatchSize: 1,
    });

    await nextTurn();
    scheduled[0]!();
    expect(claims).toBe(1);
    unblock!();
    await runtime.drain();
    await runtime.stop();
  });

  it("auto-starts once, rejects raced callbacks after stop, and drains in-flight recovery before shutdown", async () => {
    const scheduled: Array<() => void> = [];
    let cancelled = 0;
    let claims = 0;
    let unblock: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const runtime = createC8RecoveryRuntime({
      repository: {
        claimMediaDeliveryRedelivery: async () => {
          claims += 1;
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
      scheduler: {
        everyHour: (task) => {
          scheduled.push(task);
          return { timer: 1 };
        },
        cancel: () => {
          cancelled += 1;
        },
      },
      maxBatchSize: 1,
      now: () => "2030-01-15T12:00:00.000Z",
    });

    await nextTurn();
    expect(scheduled).toHaveLength(1);
    const stopping = runtime.stop();
    scheduled[0]!();
    unblock!();
    await stopping;
    await runtime.stop();

    expect(cancelled).toBe(1);
    expect(claims).toBe(1);
  });

  it("coalesces repeated production composition for one repository into one auto-started schedule", async () => {
    const scheduled: Array<() => void> = [];
    const repository = {
      claimMediaDeliveryRedelivery: async () => [],
      acknowledgeMediaDeliveryRedelivery: async () => undefined,
      releaseMediaDeliveryRedelivery: async () => undefined,
      claimMediaAttachmentRecovery: async () => [],
      rollbackMediaAttachment: async () => undefined,
      acknowledgeMediaAttachmentCleanup: async () => undefined,
      releaseMediaAttachmentRecovery: async () => undefined,
    };
    const input = {
      repository,
      queue: { enqueue: async () => undefined },
      cleaner: { cleanup: async () => undefined },
      log: { event: () => undefined },
      scheduler: {
        everyHour: (task: () => void) => {
          scheduled.push(task);
          return { timer: scheduled.length };
        },
        cancel: () => undefined,
      },
      maxBatchSize: 1,
    };
    const first = createC8RecoveryRuntime(input);
    const second = createC8RecoveryRuntime(input);

    expect(second).toBe(first);
    expect(scheduled).toHaveLength(1);
    await first.stop();
  });

  it("does not retain a failed startup and creates a fresh schedule after the caller drains stop", async () => {
    const scheduled: Array<() => void> = [];
    let unblock: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const repository = {
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
    };
    const common = {
      repository,
      queue: { enqueue: async () => undefined },
      cleaner: { cleanup: async () => undefined },
      log: { event: () => undefined },
      maxBatchSize: 1,
    };

    expect(() =>
      createC8RecoveryRuntime({
        ...common,
        scheduler: {
          everyHour: () => {
            throw new Error("scheduler unavailable");
          },
          cancel: () => undefined,
        },
      }),
    ).toThrow("scheduler unavailable");

    const first = createC8RecoveryRuntime({
      ...common,
      scheduler: {
        everyHour: (task) => {
          scheduled.push(task);
          return { timer: scheduled.length };
        },
        cancel: () => undefined,
      },
    });
    expect(scheduled).toHaveLength(1);

    const stopping = first.stop();
    expect(
      createC8RecoveryRuntime({
        ...common,
        scheduler: {
          everyHour: (task) => {
            scheduled.push(task);
            return { timer: scheduled.length };
          },
          cancel: () => undefined,
        },
      }),
    ).toBe(first);

    unblock!();
    await stopping;

    const restarted = createC8RecoveryRuntime({
      ...common,
      scheduler: {
        everyHour: (task) => {
          scheduled.push(task);
          return { timer: scheduled.length };
        },
        cancel: () => undefined,
      },
    });
    expect(restarted).not.toBe(first);
    expect(scheduled).toHaveLength(2);
    await restarted.stop();
  });
});

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
