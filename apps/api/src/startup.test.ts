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

    expect(events).toEqual(["listen", "worker", "storage", "server"]);
    expect(warnings).toEqual([
      {
        id: "unauthenticated_mvp_public_bind",
        message:
          "Unauthenticated MVP mode is enabled for a non-loopback bind; do not use this configuration as a production security boundary.",
      },
    ]);
    expect(JSON.stringify(warnings)).not.toMatch(/0\.0\.0\.0|key|path/i);
  });
});
