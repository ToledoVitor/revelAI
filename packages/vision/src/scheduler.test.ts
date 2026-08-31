import { describe, expect, it } from "vitest";
import { VisionProviderError } from "./providers.js";
import { VisionBatchScheduler } from "./scheduler.js";

describe("VisionBatchScheduler", () => {
  it("keeps four requests in flight and starts another only after settlement", async () => {
    let inFlight = 0;
    let maximum = 0;
    const scheduler = new VisionBatchScheduler();
    const results = await scheduler.run([0, 1, 2, 3, 4, 5], async (value) => {
      inFlight += 1;
      maximum = Math.max(maximum, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      return value * 2;
    });
    expect(maximum).toBe(4);
    expect(results).toEqual([0, 2, 4, 6, 8, 10]);
  });

  it("keeps the complete 640-frame manifest at four in-flight dispatches", async () => {
    let inFlight = 0;
    let maximum = 0;
    const scheduler = new VisionBatchScheduler();
    const results = await scheduler.run(
      Array.from({ length: 640 }, (_, index) => index),
      async (value) => {
        inFlight += 1;
        maximum = Math.max(maximum, inFlight);
        await Promise.resolve();
        inFlight -= 1;
        return value;
      },
    );
    expect(maximum).toBe(4);
    expect(results).toHaveLength(640);
    expect(results[0]).toBe(0);
    expect(results[639]).toBe(639);
  });

  it("retries temporary provider failures only at the exact bounded count", async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const timers: number[] = [];
    const scheduler = new VisionBatchScheduler({
      clock: {
        now: () => 0,
        sleep: async (milliseconds) => {
          sleeps.push(milliseconds);
        },
        schedule: (milliseconds) => {
          timers.push(milliseconds);
          return () => undefined;
        },
      },
    });
    const result = await scheduler.run(["frame"], async () => {
      calls += 1;
      if (calls < 3)
        throw new VisionProviderError("provider_temporary_unavailable");
      return "ok";
    });
    expect(calls).toBe(3);
    expect(sleeps.filter((milliseconds) => milliseconds !== 8000)).toEqual([
      250, 1000,
    ]);
    expect(timers.filter((milliseconds) => milliseconds === 8000)).toHaveLength(
      3,
    );
    expect(result).toEqual(["ok"]);
  });

  it("does not retry permanent output failure", async () => {
    let calls = 0;
    const scheduler = new VisionBatchScheduler({
      clock: {
        now: () => 0,
        sleep: async () => undefined,
        schedule: () => () => undefined,
      },
    });
    await expect(
      scheduler.run(["frame"], async () => {
        calls += 1;
        throw new VisionProviderError("provider_output_invalid");
      }),
    ).rejects.toMatchObject({ code: "provider_output_invalid" });
    expect(calls).toBe(1);
  });

  it("aborts an 8-second request timeout and applies only the two exact retries", async () => {
    const sleeps: number[] = [];
    const requestTimeouts: Array<() => void> = [];
    let calls = 0;
    const scheduler = new VisionBatchScheduler({
      clock: {
        now: () => 0,
        sleep: async (milliseconds) => {
          sleeps.push(milliseconds);
        },
        schedule: (milliseconds, callback) => {
          if (milliseconds === 8000) requestTimeouts.push(callback);
          return () => undefined;
        },
      },
    });
    await expect(
      scheduler.run(["frame"], async (_item, signal) => {
        calls += 1;
        queueMicrotask(() => requestTimeouts.at(-1)?.());
        return new Promise<string>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("timeout")), {
            once: true,
          });
        });
      }),
    ).rejects.toMatchObject({ code: "provider_temporary_unavailable" });
    expect(calls).toBe(3);
    expect(sleeps).toEqual([250, 1000]);
  });

  it("arms the eight-second boundary before synchronous dispatch work begins", async () => {
    let now = 0;
    const scheduler = new VisionBatchScheduler({
      clock: {
        now: () => now,
        sleep: async () => undefined,
        schedule: () => () => undefined,
      },
    });
    await expect(
      scheduler.run(["frame"], () => {
        now += 8001;
        return Promise.resolve("late");
      }),
    ).rejects.toMatchObject({ code: "provider_temporary_unavailable" });
  });

  it("uses one external cancellation boundary, settles workers, and never dispatches queued frames", async () => {
    const controller = new AbortController();
    let started = 0;
    const scheduler = new VisionBatchScheduler({
      clock: {
        now: () => 0,
        sleep: async () => undefined,
        schedule: () => () => undefined,
      },
    });
    const running = scheduler.run(
      Array.from({ length: 640 }, (_, index) => index),
      async (_item, signal) => {
        started += 1;
        return new Promise<number>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new Error("request aborted")),
            { once: true },
          );
        });
      },
      controller.signal,
    );
    await Promise.resolve();
    controller.abort();
    await expect(running).rejects.toMatchObject({
      code: "provider_temporary_unavailable",
    });
    expect(started).toBe(4);
  });

  it("arms exactly one absolute 180-second deadline for a complete batch", async () => {
    const scheduled: number[] = [];
    let triggerBatchDeadline: (() => void) | undefined;
    let cancelled = 0;
    const scheduler = new VisionBatchScheduler({
      clock: {
        now: () => 0,
        sleep: async () => undefined,
        schedule: (milliseconds, callback) => {
          scheduled.push(milliseconds);
          if (milliseconds === 180_000) triggerBatchDeadline = callback;
          return () => {
            cancelled += 1;
          };
        },
      },
    });
    const running = scheduler.run(
      [0],
      async (_item, signal) =>
        new Promise<number>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new Error("request aborted")),
            { once: true },
          );
        }),
    );
    await Promise.resolve();
    expect(
      scheduled.filter((milliseconds) => milliseconds === 180_000),
    ).toHaveLength(1);
    expect(scheduled).toContain(8000);
    triggerBatchDeadline?.();
    await expect(running).rejects.toMatchObject({
      code: "provider_temporary_unavailable",
    });
    expect(cancelled).toBe(2);
  });
});
