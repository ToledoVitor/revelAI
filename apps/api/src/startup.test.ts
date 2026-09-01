import { describe, expect, it } from "vitest";
import { startConfiguredApi } from "./startup.js";

describe("configured API startup", () => {
  it("rejects invalid configuration before the server can bind", async () => {
    let binds = 0;

    await expect(
      startConfiguredApi({
        environment: { HOST: "0.0.0.0" },
        server: {
          listen: async () => {
            binds += 1;
          },
          close: async () => undefined,
        },
      }),
    ).rejects.toThrow("ALLOW_UNAUTHENTICATED_PUBLIC=true");

    expect(binds).toBe(0);
  });

  it("writes the explicit public-bind warning without configuration values and closes owned resources", async () => {
    const events: string[] = [];
    const warnings: unknown[] = [];
    const started = await startConfiguredApi({
      environment: {
        HOST: "0.0.0.0",
        ALLOW_UNAUTHENTICATED_PUBLIC: "true",
      },
      server: {
        listen: async () => {
          events.push("listen");
        },
        close: async () => {
          events.push("server");
        },
      },
      resources: [
        {
          close: async () => {
            events.push("worker");
          },
        },
        {
          close: async () => {
            events.push("storage");
          },
        },
      ],
      log: { warning: (warning) => warnings.push(warning) },
    });

    await started.close();

    expect(events).toEqual(["listen", "server", "worker", "storage"]);
    expect(warnings).toEqual([
      {
        id: "unauthenticated_mvp_public_bind",
        message:
          "Unauthenticated MVP mode is enabled for a non-loopback bind; do not use this configuration as a production security boundary.",
      },
    ]);
    expect(JSON.stringify(warnings)).not.toMatch(/0\.0\.0\.0|key|path/i);
  });

  it("rejects a public bind without a persistent warning sink before listening", async () => {
    let listens = 0;

    await expect(
      startConfiguredApi({
        environment: {
          HOST: "0.0.0.0",
          ALLOW_UNAUTHENTICATED_PUBLIC: "true",
        },
        server: {
          listen: async () => {
            listens += 1;
          },
          close: async () => undefined,
        },
      }),
    ).rejects.toThrow("warning sink");

    expect(listens).toBe(0);
  });

  it("rolls back the server and every owned resource when listening fails", async () => {
    const events: string[] = [];

    await expect(
      startConfiguredApi({
        environment: {},
        server: {
          listen: async () => {
            events.push("listen");
            throw new Error("bind failed");
          },
          close: async () => {
            events.push("server");
          },
        },
        resources: [
          { close: async () => void events.push("worker") },
          { close: async () => void events.push("storage") },
        ],
      }),
    ).rejects.toThrow("bind failed");

    expect(events).toEqual(["listen", "server", "worker", "storage"]);
  });

  it("drains admission before resources, attempts every close, and closes once", async () => {
    const events: string[] = [];
    const started = await startConfiguredApi({
      environment: {},
      server: {
        listen: async () => void events.push("listen"),
        close: async () => void events.push("server"),
      },
      resources: [
        {
          close: async () => {
            events.push("worker");
            throw new Error("worker close failed");
          },
        },
        {
          close: async () => {
            events.push("storage");
            throw new Error("storage close failed");
          },
        },
      ],
    });

    await expect(started.close()).rejects.toBeInstanceOf(AggregateError);
    await expect(started.close()).rejects.toBeInstanceOf(AggregateError);

    expect(events).toEqual(["listen", "server", "worker", "storage"]);
  });
});
