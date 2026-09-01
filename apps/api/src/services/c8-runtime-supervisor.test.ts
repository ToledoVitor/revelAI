import { describe, expect, it } from "vitest";
import { startC8RuntimeSupervisor } from "./c8-runtime-supervisor.js";
import { prepareC8RecoveryRuntime } from "./media-attachment-recovery.js";
import { prepareC8RetentionRuntime } from "./retention-runtime.js";

describe("C8 runtime supervisor", () => {
  it("cancels an accepted first timer and synchronously releases both inert owners when the second registration throws", async () => {
    const events: string[] = [];
    const retentionOwner = {};
    let recoveryClaims = 0;
    let retentionQueries = 0;
    let queueCalls = 0;
    let cleanerCalls = 0;
    let objectDeletes = 0;
    let clockReads = 0;
    const recoveryRepositoryPort = recoveryRepository(() => {
      recoveryClaims += 1;
    });
    const prepare = () => ({
      recovery: prepareC8RecoveryRuntime({
        repository: recoveryRepositoryPort,
        queue: { enqueue: async () => void (queueCalls += 1) },
        cleaner: { cleanup: async () => void (cleanerCalls += 1) },
        log: { event: () => undefined },
        maxBatchSize: 1,
        now: () => "2030-01-15T12:00:00.000Z",
      }),
      retention: prepareC8RetentionRuntime({
        owner: retentionOwner,
        repository: {
          listDue: async () => {
            retentionQueries += 1;
            return [];
          },
          acknowledge: async () => undefined,
        },
        objects: { delete: async () => void (objectDeletes += 1) },
        log: { event: () => undefined },
        maxBatchSize: 1,
        now: () => "2030-01-15T12:00:00.000Z",
      }),
    });
    const first = prepareC8RecoveryRuntime({
      repository: recoveryRepositoryPort,
      queue: { enqueue: async () => void (queueCalls += 1) },
      cleaner: { cleanup: async () => void (cleanerCalls += 1) },
      log: { event: () => undefined },
      maxBatchSize: 1,
      now: () => "2030-01-15T12:00:00.000Z",
    });
    const firstRetention = prepareC8RetentionRuntime({
      owner: retentionOwner,
      repository: {
        listDue: async () => {
          retentionQueries += 1;
          return [];
        },
        acknowledge: async () => undefined,
      },
      objects: { delete: async () => void (objectDeletes += 1) },
      log: { event: () => undefined },
      maxBatchSize: 1,
      now: () => "2030-01-15T12:00:00.000Z",
    });
    const acceptedHandle = Object.freeze({ timer: "recovery" });

    expect(() =>
      startC8RuntimeSupervisor({
        recovery: first,
        retention: firstRetention,
        scheduler: {
          everyHour: (task) => {
            events.push("register");
            if (events.length === 1) {
              task();
              return acceptedHandle;
            }
            throw new Error("retention scheduler unavailable");
          },
          cancel: (handle) => {
            expect(handle).toBe(acceptedHandle);
            events.push("cancel");
          },
        },
        now: () => {
          clockReads += 1;
          return "2030-01-15T12:00:00.000Z";
        },
      }),
    ).toThrow("retention scheduler unavailable");

    expect(events).toEqual(["register", "register", "cancel"]);
    expect({
      recoveryClaims,
      retentionQueries,
      queueCalls,
      cleanerCalls,
      objectDeletes,
      clockReads,
    }).toEqual({
      recoveryClaims: 0,
      retentionQueries: 0,
      queueCalls: 0,
      cleanerCalls: 0,
      objectDeletes: 0,
      clockReads: 0,
    });

    const reopened = prepare();
    const scheduled: Array<() => void> = [];
    const runtime = startC8RuntimeSupervisor({
      recovery: reopened.recovery,
      retention: reopened.retention,
      scheduler: {
        everyHour: (task) => {
          scheduled.push(task);
          return task;
        },
        cancel: () => undefined,
      },
      now: () => {
        clockReads += 1;
        return "2030-01-15T12:00:00.000Z";
      },
    });
    await runtime.drain();
    expect(scheduled).toHaveLength(2);
    expect(clockReads).toBe(1);
    expect(recoveryClaims).toBe(1);
    expect(retentionQueries).toBe(1);
    await runtime.stop();
  });

  it("releases both reservations when the first timer registration throws", () => {
    const repository = recoveryRepository(() => undefined);
    const owner = {};
    const recovery = prepareC8RecoveryRuntime({
      repository,
      queue: { enqueue: async () => undefined },
      cleaner: { cleanup: async () => undefined },
      log: { event: () => undefined },
      maxBatchSize: 1,
    });
    const retention = prepareC8RetentionRuntime({
      owner,
      repository: {
        listDue: async () => [],
        acknowledge: async () => undefined,
      },
      objects: { delete: async () => undefined },
      log: { event: () => undefined },
      maxBatchSize: 1,
    });

    expect(() =>
      startC8RuntimeSupervisor({
        recovery,
        retention,
        scheduler: {
          everyHour: () => {
            throw new Error("first registration unavailable");
          },
          cancel: () => undefined,
        },
        now: () => "2030-01-15T12:00:00.000Z",
      }),
    ).toThrow("first registration unavailable");

    let reopenedRecovery:
      | ReturnType<typeof prepareC8RecoveryRuntime>
      | undefined;
    expect(() => {
      reopenedRecovery = prepareC8RecoveryRuntime({
        repository,
        queue: { enqueue: async () => undefined },
        cleaner: { cleanup: async () => undefined },
        log: { event: () => undefined },
        maxBatchSize: 1,
      });
    }).not.toThrow();
    let reopenedRetention:
      | ReturnType<typeof prepareC8RetentionRuntime>
      | undefined;
    expect(() => {
      reopenedRetention = prepareC8RetentionRuntime({
        owner,
        repository: {
          listDue: async () => [],
          acknowledge: async () => undefined,
        },
        objects: { delete: async () => undefined },
        log: { event: () => undefined },
        maxBatchSize: 1,
      });
    }).not.toThrow();
    reopenedRecovery!.abortStartup();
    reopenedRetention!.abortStartup();
  });
});

function recoveryRepository(onClaim: () => void) {
  return {
    claimMediaDeliveryRedelivery: async () => {
      onClaim();
      return [];
    },
    acknowledgeMediaDeliveryRedelivery: async () => undefined,
    releaseMediaDeliveryRedelivery: async () => undefined,
    claimMediaAttachmentRecovery: async () => [],
    rollbackMediaAttachment: async () => undefined,
    acknowledgeMediaAttachmentCleanup: async () => undefined,
    releaseMediaAttachmentRecovery: async () => undefined,
  };
}
