import { describe, expect, it } from "vitest";
import {
  RetentionScavenger,
  type RetentionRecord,
} from "./retention-scavenger.js";

const original: RetentionRecord = {
  id: "11111111-1111-4111-8111-111111111111",
  attemptId: "22222222-2222-4222-8222-222222222222",
  kind: "original",
  deleteAt: "2030-01-16T11:00:00.000Z",
  cleanupRequestedAt: null,
};

describe("RetentionScavenger", () => {
  it("deletes due physical objects before idempotently acknowledging one bounded batch", async () => {
    const repository = new MemoryRetentionRepository([
      original,
      { ...original, id: "33333333-3333-4333-8333-333333333333" },
    ]);
    const deleted: string[] = [];
    const scavenger = new RetentionScavenger({
      repository,
      objects: { delete: async (record) => void deleted.push(record.id) },
      maxBatchSize: 1,
      log: { event: () => undefined },
    });

    await expect(scavenger.run("2030-01-16T11:00:00.000Z")).resolves.toEqual({
      kind: "completed",
      processed: 1,
    });
    expect(deleted).toEqual([original.id]);
    expect(repository.acknowledged).toEqual([original.id]);
    expect(repository.records).toHaveLength(1);
  });

  it("retries physical-delete failure with redacted-only logging and keeps its record", async () => {
    const repository = new MemoryRetentionRepository([original]);
    const events: unknown[] = [];
    const scavenger = new RetentionScavenger({
      repository,
      objects: {
        delete: async () =>
          Promise.reject(new Error("/private/revelai/secret.mp4")),
      },
      maxBatchSize: 2,
      log: { event: (event) => events.push(event) },
    });

    await scavenger.run("2030-01-16T11:00:00.000Z");
    expect(repository.acknowledged).toEqual([]);
    expect(repository.records).toEqual([original]);
    expect(events).toEqual([
      {
        category: "retention_cleanup_failed",
        attempt: "22222222",
        resource: "11111111",
      },
    ]);
    expect(JSON.stringify(events)).not.toContain("private");
  });

  it("runs immediately, schedules hourly work, prevents overlaps, and shuts down cleanly", async () => {
    const repository = new MemoryRetentionRepository([original]);
    let release!: () => void;
    const deleting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const scheduled: Array<() => void> = [];
    let cleared = false;
    const scavenger = new RetentionScavenger({
      repository,
      objects: { delete: async () => deleting },
      maxBatchSize: 2,
      log: { event: () => undefined },
      scheduler: {
        everyHour: (task) => {
          scheduled.push(task);
          return { id: "hourly" };
        },
        cancel: () => {
          cleared = true;
        },
      },
    });

    const stop = scavenger.start("2030-01-16T11:00:00.000Z");
    expect(scheduled).toHaveLength(1);
    await expect(scavenger.run("2030-01-16T11:00:00.000Z")).resolves.toEqual({
      kind: "skipped-overlap",
    });
    release();
    await Promise.resolve();
    stop();
    expect(cleared).toBe(true);
  });

  it("contains startup and scheduled run rejections in the redacted logger", async () => {
    const scheduled: Array<() => void> = [];
    const events: unknown[] = [];
    const scavenger = new RetentionScavenger({
      repository: {
        listDue: async () =>
          Promise.reject(new Error("/private/revelai/secret.mp4")),
        acknowledge: async () => undefined,
      },
      objects: { delete: async () => undefined },
      maxBatchSize: 1,
      log: { event: (event) => events.push(event) },
      scheduler: {
        everyHour: (task) => {
          scheduled.push(task);
          return { id: "hourly" };
        },
        cancel: () => undefined,
      },
    });

    const stop = scavenger.start("2030-01-16T11:00:00.000Z");
    await nextTurn();
    scheduled[0]!();
    await nextTurn();

    expect(events).toEqual([
      { category: "retention_cleanup_run_failed" },
      { category: "retention_cleanup_run_failed" },
    ]);
    expect(JSON.stringify(events)).not.toContain("private");
    stop();
  });

  it("contains a timer clock failure so a scheduled chain cannot reject", () => {
    const scheduled: Array<() => void> = [];
    const events: unknown[] = [];
    let clockReads = 0;
    const scavenger = new RetentionScavenger({
      repository: new MemoryRetentionRepository([]),
      objects: { delete: async () => undefined },
      maxBatchSize: 1,
      log: { event: (event) => events.push(event) },
      now: () => {
        clockReads += 1;
        if (clockReads > 1) throw new Error("/private/revelai/clock");
        return "2030-01-16T11:00:00.000Z";
      },
      scheduler: {
        everyHour: (task) => {
          scheduled.push(task);
          return { id: "hourly" };
        },
        cancel: () => undefined,
      },
    });

    scavenger.start();
    expect(() => scheduled[0]!()).not.toThrow();
    expect(events).toEqual([{ category: "retention_cleanup_run_failed" }]);
  });
});

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

class MemoryRetentionRepository {
  public records: RetentionRecord[];
  public readonly acknowledged: string[] = [];

  public constructor(records: RetentionRecord[]) {
    this.records = records;
  }

  public async listDue(
    input: Readonly<{ now: string; limit: number }>,
  ): Promise<readonly RetentionRecord[]> {
    return this.records
      .filter(
        (record) =>
          record.cleanupRequestedAt !== null || record.deleteAt <= input.now,
      )
      .slice(0, input.limit);
  }

  public async acknowledge(record: RetentionRecord): Promise<void> {
    this.acknowledged.push(record.id);
    this.records = this.records.filter((item) => item.id !== record.id);
  }
}
