import Fastify from "fastify";
import { RouteErrorSchema } from "@revelai/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { registerOperabilityRoutes } from "./operability-routes.js";

const apps: Array<ReturnType<typeof Fastify>> = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("operability routes", () => {
  it("reports process liveness without consulting a readiness dependency", async () => {
    let dependencyCalls = 0;
    const app = Fastify();
    apps.push(app);
    registerOperabilityRoutes(app, {
      readiness: {
        database: async () => {
          dependencyCalls += 1;
        },
        storage: async () => {
          dependencyCalls += 1;
        },
        queue: async () => {
          dependencyCalls += 1;
          return true;
        },
      },
    });

    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
    expect(dependencyCalls).toBe(0);
  });

  it("reports ready when the database, storage, and queue probes all pass", async () => {
    const app = Fastify();
    apps.push(app);
    registerOperabilityRoutes(app, {
      readiness: {
        database: async () => undefined,
        storage: async () => undefined,
        queue: async () => true,
      },
    });

    const response = await app.inject({ method: "GET", url: "/ready" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ready" });
  });

  it.each([
    ["database", "database"],
    ["storage", "storage"],
    ["queue", "queue"],
  ] as const)(
    "returns the safe typed error when the %s probe fails",
    async (_label, probe) => {
      const app = Fastify();
      apps.push(app);
      registerOperabilityRoutes(app, {
        readiness: {
          database: async () => {
            if (probe === "database")
              throw new Error(
                "SELECT 1 /private/db Authorization: Bearer redaction-sentinel ROBOFLOW_API_KEY=redaction-sentinel raw-provider-payload media-bytes",
              );
          },
          storage: async () => {
            if (probe === "storage") throw new Error("/private/media/sentinel");
          },
          queue: async () => probe !== "queue",
        },
      });

      const response = await app.inject({ method: "GET", url: "/ready" });

      expect(response.statusCode).toBe(503);
      expect(RouteErrorSchema.parse(response.json())).toEqual({
        code: "service_not_ready",
        message: "O serviço está temporariamente indisponível.",
        retryable: true,
      });
      expect(response.body).not.toMatch(
        /SELECT|private|sentinel|queue|Authorization|ROBOFLOW|payload|media/i,
      );
    },
  );

  it.each(["database", "storage", "queue"] as const)(
    "runs every probe under one deadline and safely fails a timed-out %s dependency",
    async (timedOutProbe) => {
      let expire: (() => void) | undefined;
      let probeStarted: (() => void) | undefined;
      const probeIsRunning = new Promise<void>((resolve) => {
        probeStarted = resolve;
      });
      const calls: string[] = [];
      const waitForever = async (): Promise<void> => {
        probeStarted?.();
        await new Promise<void>(() => undefined);
      };
      const app = Fastify();
      apps.push(app);
      registerOperabilityRoutes(app, {
        readiness: {
          database: async () => {
            calls.push("database");
            if (timedOutProbe === "database") await waitForever();
          },
          storage: async () => {
            calls.push("storage");
            if (timedOutProbe === "storage") await waitForever();
          },
          queue: async () => {
            calls.push("queue");
            if (timedOutProbe === "queue") await waitForever();
            return true;
          },
        },
        deadlineMs: 10,
        clock: {
          setTimeout: (callback) => {
            expire = callback;
            return callback;
          },
          clearTimeout: () => undefined,
        },
      });

      const responsePromise = app.inject({ method: "GET", url: "/ready" });
      await probeIsRunning;
      expect(calls).toEqual(["database", "storage", "queue"]);
      expire?.();
      const response = await responsePromise;

      expect(response.statusCode).toBe(503);
      expect(RouteErrorSchema.parse(response.json()).code).toBe(
        "service_not_ready",
      );
    },
  );

  it("returns one safe error when multiple readiness dependencies fail", async () => {
    const app = Fastify();
    apps.push(app);
    registerOperabilityRoutes(app, {
      readiness: {
        database: async () => {
          throw new Error("database failure");
        },
        storage: async () => {
          throw new Error("storage failure");
        },
        queue: async () => false,
      },
    });

    const response = await app.inject({ method: "GET", url: "/ready" });

    expect(response.statusCode).toBe(503);
    expect(response.body).not.toMatch(/database|storage|queue/i);
  });

  it("recovers when a storage sentinel cleanup failure clears", async () => {
    let cleanupFails = true;
    const app = Fastify();
    apps.push(app);
    registerOperabilityRoutes(app, {
      readiness: {
        database: async () => undefined,
        storage: async () => {
          if (cleanupFails) throw new Error("sentinel cleanup failed");
        },
        queue: async () => true,
      },
    });

    const unavailable = await app.inject({ method: "GET", url: "/ready" });
    cleanupFails = false;
    const recovered = await app.inject({ method: "GET", url: "/ready" });

    expect(unavailable.statusCode).toBe(503);
    expect(recovered.statusCode).toBe(200);
    expect(recovered.json()).toEqual({ status: "ready" });
  });
});
