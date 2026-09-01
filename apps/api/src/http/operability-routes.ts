import type { FastifyInstance } from "fastify";
import {
  HealthResponseSchema,
  ReadinessResponseSchema,
  RouteErrorMessageByCode,
  RouteErrorRetryabilityByCode,
  RouteErrorSchema,
  RouteErrorStatusByCode,
} from "@revelai/contracts";
import { apiRoute, fastifyRoutePath } from "./openapi.js";

export type ReadinessProbes = Readonly<{
  database(signal: AbortSignal): Promise<void>;
  storage(signal: AbortSignal): Promise<void>;
  queue(signal: AbortSignal): Promise<boolean>;
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
  app.get(fastifyRoutePath(apiRoute("getHealth")), async (_request, reply) =>
    reply.code(200).send(HealthResponseSchema.parse({ status: "ok" })),
  );
  app.get(
    fastifyRoutePath(apiRoute("getReadiness")),
    async (_request, reply) => {
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
    },
  );
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
  const controller = new AbortController();
  let timeout: unknown;
  const deadline = new Promise<"deadline">((resolve) => {
    timeout = clock.setTimeout(() => {
      controller.abort(new Error("readiness timeout"));
      resolve("deadline");
    }, deadlineMs);
  });
  const probes = [
    Promise.resolve().then(() => input.readiness.database(controller.signal)),
    Promise.resolve().then(() => input.readiness.storage(controller.signal)),
    Promise.resolve().then(() => input.readiness.queue(controller.signal)),
  ];
  const settled = Promise.allSettled(probes);

  try {
    const first = await Promise.race([
      settled.then(() => "settled" as const),
      deadline,
    ]);
    const results = await settled;
    if (first === "deadline") throw new Error("readiness timeout");
    if (results.some((result) => result.status === "rejected"))
      throw new Error("readiness probe failed");
    return results[2].status === "fulfilled" && results[2].value === true;
  } finally {
    clock.clearTimeout(timeout);
  }
}
