import { describe, expect, it } from "vitest";
import type { RetentionRecord } from "../media/retention-scavenger.js";
import { createC8RetentionRuntime } from "./retention-runtime.js";

const RECORD: RetentionRecord = Object.freeze({
  id: "22222222-2222-4222-8222-222222222222",
  attemptId: "11111111-1111-4111-8111-111111111111",
  kind: "original",
  deleteAt: "2030-01-15T12:00:00.000Z",
  cleanupRequestedAt: "2030-01-15T12:00:00.000Z",
});

describe("C8 retention runtime", () => {
  it("starts a bounded cleanup immediately, schedules independent later runs, and acknowledges only after C5 deletion", async () => {
    const scheduled: Array<() => void> = [];
    const deleted: RetentionRecord[] = [];
    const acknowledged: RetentionRecord[] = [];
    const records = [RECORD];
    const runtime = createC8RetentionRuntime({
      owner: {},
      repository: {
        listDue: async () => Object.freeze([...records]),
        acknowledge: async (record) => {
          acknowledged.push(record);
          records.splice(records.indexOf(record), 1);
        },
      },
      objects: { delete: async (record) => void deleted.push(record) },
      log: { event: () => undefined },
      scheduler: {
        everyHour: (task) => {
          scheduled.push(task);
          return task;
        },
        cancel: () => undefined,
      },
      maxBatchSize: 1,
      now: () => "2030-01-15T12:00:00.000Z",
    });

    await runtime.drain();
    expect(deleted).toEqual([RECORD]);
    expect(acknowledged).toEqual([RECORD]);
    expect(scheduled).toHaveLength(1);

    scheduled[0]!();
    await runtime.drain();
    expect(deleted).toEqual([RECORD]);
    await runtime.stop();
  });

  it("suppresses timer overlap and cancels before draining without post-close writes", async () => {
    const scheduled: Array<() => void> = [];
    let calls = 0;
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let cancelled = 0;
    const runtime = createC8RetentionRuntime({
      owner: {},
      repository: {
        listDue: async () => {
          calls += 1;
          await blocked;
          return [];
        },
        acknowledge: async () => undefined,
      },
      objects: { delete: async () => undefined },
      log: { event: () => undefined },
      scheduler: {
        everyHour: (task) => {
          scheduled.push(task);
          return task;
        },
        cancel: () => {
          cancelled += 1;
        },
      },
      maxBatchSize: 1,
      now: () => "2030-01-15T12:00:00.000Z",
    });

    await nextTurn();
    scheduled[0]!();
    expect(calls).toBe(1);
    const stopping = runtime.stop();
    scheduled[0]!();
    expect(calls).toBe(1);
    release!();
    await stopping;
    expect(cancelled).toBe(1);
  });

  it("keeps a failed physical deletion due, logs only redacted identifiers, and retries it on the next hour", async () => {
    const scheduled: Array<() => void> = [];
    const events: unknown[] = [];
    const records = [RECORD];
    let deletes = 0;
    const runtime = createC8RetentionRuntime({
      owner: {},
      repository: {
        listDue: async () => Object.freeze([...records]),
        acknowledge: async (record) => {
          records.splice(records.indexOf(record), 1);
        },
      },
      objects: {
        delete: async () => {
          deletes += 1;
          if (deletes === 1) throw new Error("local path must not leak");
        },
      },
      log: { event: (event) => void events.push(event) },
      scheduler: {
        everyHour: (task) => {
          scheduled.push(task);
          return task;
        },
        cancel: () => undefined,
      },
      maxBatchSize: 1,
      now: () => "2030-01-15T12:00:00.000Z",
    });

    await runtime.drain();
    expect(records).toEqual([RECORD]);
    expect(events).toEqual([
      {
        category: "retention_cleanup_failed",
        attempt: "11111111",
        resource: "22222222",
      },
    ]);
    expect(JSON.stringify(events)).not.toContain("local path");

    scheduled[0]!();
    await runtime.drain();
    expect(deletes).toBe(2);
    expect(records).toEqual([]);
    await runtime.stop();
  });

  it("rejects a second owner, releases it only after drain, and does not retain a synchronous scheduler failure", async () => {
    const owner = {};
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const repository = {
      listDue: async () => {
        await blocked;
        return [];
      },
      acknowledge: async () => undefined,
    };
    const common = {
      owner,
      repository,
      objects: { delete: async () => undefined },
      log: { event: () => undefined },
      maxBatchSize: 1,
      now: () => "2030-01-15T12:00:00.000Z",
    };
    const scheduler = {
      everyHour: () => ({ timer: 1 }),
      cancel: () => undefined,
    };
    const first = createC8RetentionRuntime({ ...common, scheduler });
    expect(() => createC8RetentionRuntime({ ...common, scheduler })).toThrow(
      "Retention runtime already has an active owner.",
    );
    const stopping = first.stop();
    expect(() => createC8RetentionRuntime({ ...common, scheduler })).toThrow(
      "Retention runtime already has an active owner.",
    );
    release!();
    await stopping;
    const reopened = createC8RetentionRuntime({ ...common, scheduler });
    await reopened.stop();

    let claims = 0;
    expect(() =>
      createC8RetentionRuntime({
        ...common,
        owner: {},
        repository: {
          listDue: async () => {
            claims += 1;
            return [];
          },
          acknowledge: async () => undefined,
        },
        scheduler: {
          everyHour: () => {
            throw new Error("scheduler unavailable");
          },
          cancel: () => undefined,
        },
      }),
    ).toThrow("scheduler unavailable");
    expect(claims).toBe(0);
  });
});

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
