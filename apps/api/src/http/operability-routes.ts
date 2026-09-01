import type { FastifyInstance } from "fastify";
import {
  HealthResponseSchema,
  ReadinessResponseSchema,
  RouteErrorMessageByCode,
  RouteErrorRetryabilityByCode,
  RouteErrorSchema,
  RouteErrorStatusByCode,
} from "@revelai/contracts";

export type ReadinessProbes = Readonly<{
  database(): Promise<void>;
  storage(): Promise<void>;
  queue(): Promise<boolean>;
}>;

export type ReadinessClock = Readonly<{
  setTimeout(callback: () => void, milliseconds: number): unknown;
  clearTimeout(handle: unknown): void;
}>;

const defaultClock: ReadinessClock = Object.freeze({
  setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
});
const DEFAULT_READINESS_DEADLINE_MS = 1_000;

export function registerOperabilityRoutes(
  app: FastifyInstance,
  input: Readonly<{
    readiness: ReadinessProbes;
    deadlineMs?: number;
    clock?: ReadinessClock;
  }>,
): void {
  app.get("/health", async (_request, reply) =>
    reply.code(200).send(HealthResponseSchema.parse({ status: "ok" })),
  );
  app.get("/ready", async (_request, reply) => {
    try {
      const queueAvailable = await runReadinessProbes(input);
      if (!queueAvailable) throw new Error("queue unavailable");
      return reply
        .code(200)
        .send(ReadinessResponseSchema.parse({ status: "ready" }));
    } catch {
      return reply.code(RouteErrorStatusByCode.service_not_ready).send(
        RouteErrorSchema.parse({
          code: "service_not_ready",
          message: RouteErrorMessageByCode.service_not_ready,
          retryable: RouteErrorRetryabilityByCode.service_not_ready,
        }),
      );
    }
  });
}

async function runReadinessProbes(
  input: Readonly<{
    readiness: ReadinessProbes;
    deadlineMs?: number;
    clock?: ReadinessClock;
  }>,
): Promise<boolean> {
  const clock = input.clock ?? defaultClock;
  const deadlineMs = input.deadlineMs ?? DEFAULT_READINESS_DEADLINE_MS;
  let timeout: unknown;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = clock.setTimeout(
      () => reject(new Error("readiness timeout")),
      deadlineMs,
    );
  });
  const probes = Promise.all([
    Promise.resolve().then(() => input.readiness.database()),
    Promise.resolve().then(() => input.readiness.storage()),
    Promise.resolve().then(() => input.readiness.queue()),
  ]);

  try {
    const results = await Promise.race([probes, deadline]);
    return results[2] === true;
  } finally {
    clock.clearTimeout(timeout);
  }
}
