import type { FastifyInstance } from "fastify";
import {
  RouteErrorMessageByCode,
  RouteErrorRetryabilityByCode,
  RouteErrorSchema,
  RouteErrorStatusByCode,
} from "@revelai/contracts";
import { apiRoute, registerApiRoute, sendApiRouteResponse } from "./openapi.js";

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
  const runtime = new ReadinessRuntime();
  app.addHook("onClose", async () => runtime.close());
  const healthRoute = apiRoute("getHealth");
  const readinessRoute = apiRoute("getReadiness");
  registerApiRoute(app, healthRoute, async (_request, reply) =>
    sendApiRouteResponse(reply, healthRoute, 200, { status: "ok" }),
  );
  registerApiRoute(app, readinessRoute, async (_request, reply) => {
    try {
      const queueAvailable = await runReadinessProbes(input, runtime);
      if (!queueAvailable) throw new Error("queue unavailable");
      return sendApiRouteResponse(reply, readinessRoute, 200, {
        status: "ready",
      });
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
  runtime: ReadinessRuntime,
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
  runtime.track(controller, settled);

  try {
    const first = await Promise.race([
      settled.then(() => "settled" as const),
      deadline,
    ]);
    if (first === "deadline") throw new Error("readiness timeout");
    const results = await settled;
    if (results.some((result) => result.status === "rejected"))
      throw new Error("readiness probe failed");
    return results[2].status === "fulfilled" && results[2].value === true;
  } finally {
    clock.clearTimeout(timeout);
  }
}

class ReadinessRuntime {
  readonly #inFlight = new Set<
    Readonly<{ controller: AbortController; settled: Promise<void> }>
  >();
  #closePromise: Promise<void> | undefined;
  #closed = false;

  public track(
    controller: AbortController,
    settled: Promise<PromiseSettledResult<unknown>[]>,
  ): void {
    if (this.#closed) {
      controller.abort(new Error("readiness runtime closed"));
      return;
    }
    const entry = Object.freeze({
      controller,
      settled: settled.then(() => undefined),
    });
    this.#inFlight.add(entry);
    void entry.settled.then(() => this.#inFlight.delete(entry));
  }

  public close(): Promise<void> {
    return (this.#closePromise ??= this.closeTrackedProbes());
  }

  private async closeTrackedProbes(): Promise<void> {
    this.#closed = true;
    const inFlight = [...this.#inFlight];
    for (const entry of inFlight)
      entry.controller.abort(new Error("readiness runtime closed"));
    await Promise.all(inFlight.map((entry) => entry.settled));
  }
}
