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
    const scheduler = new VisionBatchScheduler({
      clock: {
        now: () => 0,
        sleep: async (milliseconds) => {
          sleeps.push(milliseconds);
        },
        schedule: () => () => undefined,
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
    expect(sleeps.filter((milliseconds) => milliseconds === 8000)).toHaveLength(
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
    let calls = 0;
    const scheduler = new VisionBatchScheduler({
      clock: {
        now: () => 0,
        sleep: async (milliseconds) => {
          sleeps.push(milliseconds);
        },
        schedule: () => () => undefined,
      },
    });
    await expect(
      scheduler.run(["frame"], async (_item, signal) => {
        calls += 1;
        return new Promise<string>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("timeout")), {
            once: true,
          });
        });
      }),
    ).rejects.toMatchObject({ code: "provider_temporary_unavailable" });
    expect(calls).toBe(3);
    expect(sleeps.filter((milliseconds) => milliseconds === 8000)).toHaveLength(
      3,
    );
    expect(sleeps.filter((milliseconds) => milliseconds !== 8000)).toEqual([
      250, 1000,
    ]);
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
    let deadlineMs: number | undefined;
    let triggerDeadline: (() => void) | undefined;
    let cancelled = 0;
    const scheduler = new VisionBatchScheduler({
      clock: {
        now: () => 0,
        sleep: async () => undefined,
        schedule: (milliseconds, callback) => {
          deadlineMs = milliseconds;
          triggerDeadline = callback;
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
    expect(deadlineMs).toBe(180_000);
    triggerDeadline?.();
    await expect(running).rejects.toMatchObject({
      code: "provider_temporary_unavailable",
    });
    expect(cancelled).toBe(1);
  });
});
