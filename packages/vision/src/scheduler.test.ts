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
    const scheduler = new VisionBatchScheduler({
      clock: {
        now: () => 0,
        sleep: async () => undefined,
      },
    });
    const result = await scheduler.run(["frame"], async () => {
      calls += 1;
      if (calls < 3)
        throw new VisionProviderError("provider_temporary_unavailable");
      return "ok";
    });
    expect(calls).toBe(3);
    expect(result).toEqual(["ok"]);
  });

  it("does not retry permanent output failure", async () => {
    let calls = 0;
    const scheduler = new VisionBatchScheduler({
      clock: { now: () => 0, sleep: async () => undefined },
    });
    await expect(
      scheduler.run(["frame"], async () => {
        calls += 1;
        throw new VisionProviderError("provider_output_invalid");
      }),
    ).rejects.toMatchObject({ code: "provider_output_invalid" });
    expect(calls).toBe(1);
  });
});
