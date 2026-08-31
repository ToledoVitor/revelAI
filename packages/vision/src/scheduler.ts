import { VisionProviderError } from "./providers.js";

export type SchedulerClock = Readonly<{
  now(): number;
  sleep(milliseconds: number, signal?: AbortSignal): Promise<void>;
  schedule(milliseconds: number, callback: () => void): () => void;
}>;

export const systemSchedulerClock: SchedulerClock = Object.freeze({
  now: () => Date.now(),
  sleep: (milliseconds, signal) =>
    new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error("aborted"));
        return;
      }
      const settle = (callback: () => void) => {
        signal?.removeEventListener("abort", abort);
        callback();
      };
      const timeout = setTimeout(() => settle(resolve), milliseconds);
      const abort = () => {
        clearTimeout(timeout);
        settle(() => reject(new Error("aborted")));
      };
      signal?.addEventListener("abort", abort, { once: true });
    }),
  schedule: (milliseconds, callback) => {
    const timeout = setTimeout(callback, milliseconds);
    return () => clearTimeout(timeout);
  },
});

export type BatchSchedulerOptions = Readonly<{
  clock?: SchedulerClock;
  maxInFlight?: 4;
  requestTimeoutMs?: 8000;
  batchDeadlineMs?: 180_000;
  retryDelaysMs?: readonly [250, 1000];
}>;

export class VisionBatchScheduler {
  private readonly clock: SchedulerClock;
  private readonly maxInFlight: number;
  private readonly requestTimeoutMs: number;
  private readonly batchDeadlineMs: number;
  private readonly retryDelaysMs: readonly [250, 1000];

  public constructor(options: BatchSchedulerOptions = {}) {
    this.clock = options.clock ?? systemSchedulerClock;
    this.maxInFlight = options.maxInFlight ?? 4;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 8000;
    this.batchDeadlineMs = options.batchDeadlineMs ?? 180_000;
    this.retryDelaysMs = options.retryDelaysMs ?? [250, 1000];
    if (
      !Number.isSafeInteger(this.maxInFlight) ||
      this.maxInFlight !== 4 ||
      !Number.isSafeInteger(this.requestTimeoutMs) ||
      this.requestTimeoutMs !== 8000 ||
      !Number.isSafeInteger(this.batchDeadlineMs) ||
      this.batchDeadlineMs !== 180_000 ||
      this.retryDelaysMs[0] !== 250 ||
      this.retryDelaysMs[1] !== 1000
    )
      throw new Error("invalid vision scheduler configuration");
  }

  public async run<Item, Result>(
    items: readonly Item[],
    dispatch: (item: Item, signal: AbortSignal) => Promise<Result>,
    externalSignal?: AbortSignal,
  ): Promise<readonly Result[]> {
    const startedAt = this.clock.now();
    const controller = new AbortController();
    const results: Result[] = new Array(items.length);
    let cursor = 0;
    let firstFailure: unknown;
    let hasFailure = false;
    const abortExternal = () => controller.abort();
    if (externalSignal?.aborted) controller.abort();
    else
      externalSignal?.addEventListener("abort", abortExternal, { once: true });
    const cancelDeadline = this.clock.schedule(this.batchDeadlineMs, () =>
      controller.abort(),
    );
    const worker = async (): Promise<void> => {
      while (!controller.signal.aborted) {
        const index = cursor;
        cursor += 1;
        if (index >= items.length) return;
        try {
          results[index] = await this.dispatchWithRetry(
            items[index]!,
            dispatch,
            startedAt,
            controller,
          );
        } catch (error) {
          if (!hasFailure) {
            firstFailure = error;
            hasFailure = true;
          }
          controller.abort();
          return;
        }
      }
    };
    try {
      await Promise.allSettled(
        Array.from({ length: Math.min(this.maxInFlight, items.length) }, () =>
          worker(),
        ),
      );
      if (hasFailure) throw firstFailure;
      if (controller.signal.aborted)
        throw new VisionProviderError("provider_temporary_unavailable");
      return Object.freeze(results);
    } catch (error) {
      controller.abort();
      if (error instanceof VisionProviderError) throw error;
      throw new VisionProviderError("provider_temporary_unavailable");
    } finally {
      cancelDeadline();
      externalSignal?.removeEventListener("abort", abortExternal);
    }
  }

  private async dispatchWithRetry<Item, Result>(
    item: Item,
    dispatch: (item: Item, signal: AbortSignal) => Promise<Result>,
    startedAt: number,
    batchController: AbortController,
  ): Promise<Result> {
    for (let attempt = 0; attempt <= this.retryDelaysMs.length; attempt += 1) {
      this.assertBatchTime(startedAt, batchController);
      if (batchController.signal.aborted)
        throw new VisionProviderError("provider_temporary_unavailable");
      const requestController = new AbortController();
      const relayAbort = () => requestController.abort();
      batchController.signal.addEventListener("abort", relayAbort, {
        once: true,
      });
      try {
        if (batchController.signal.aborted)
          throw new VisionProviderError("provider_temporary_unavailable");
        const result = await this.withTimeout(
          dispatch(item, requestController.signal),
          requestController,
          startedAt,
        );
        return result;
      } catch (error) {
        if (batchController.signal.aborted)
          throw new VisionProviderError("provider_temporary_unavailable");
        if (!isRetryable(error) || attempt === this.retryDelaysMs.length)
          throw normalizeFailure(error);
        const remaining = this.batchDeadlineMs - (this.clock.now() - startedAt);
        if (remaining <= 0)
          throw new VisionProviderError("provider_temporary_unavailable");
        await this.clock.sleep(
          Math.min(this.retryDelaysMs[attempt]!, remaining),
          batchController.signal,
        );
        this.assertBatchTime(startedAt, batchController);
      } finally {
        batchController.signal.removeEventListener("abort", relayAbort);
        requestController.abort();
      }
    }
    throw new VisionProviderError("provider_temporary_unavailable");
  }

  private async withTimeout<Result>(
    task: Promise<Result>,
    controller: AbortController,
    batchStartedAt: number,
  ): Promise<Result> {
    const remainingBatchMs =
      this.batchDeadlineMs - (this.clock.now() - batchStartedAt);
    if (remainingBatchMs <= 0) {
      controller.abort();
      throw new VisionProviderError("provider_temporary_unavailable");
    }
    const timeoutMs = Math.min(this.requestTimeoutMs, remainingBatchMs);
    const timeoutController = new AbortController();
    const timeout = this.clock
      .sleep(timeoutMs, timeoutController.signal)
      .then(() => {
        controller.abort();
        throw new VisionProviderError("provider_temporary_unavailable");
      });
    try {
      return await Promise.race([task, timeout]);
    } finally {
      timeoutController.abort();
      // A cancelled system-clock sleep rejects; retain a sink for that loser so
      // a successfully settled request cannot leave an unhandled rejection.
      void timeout.catch(() => undefined);
    }
  }

  private assertBatchTime(
    startedAt: number,
    controller: AbortController,
  ): void {
    if (this.clock.now() - startedAt >= this.batchDeadlineMs) {
      controller.abort();
      throw new VisionProviderError("provider_temporary_unavailable");
    }
  }
}

export type RetryableHttpError = Readonly<{ status: number }>;

export function isRetryable(error: unknown): boolean {
  if (error instanceof VisionProviderError)
    return error.code === "provider_temporary_unavailable";
  if (isHttpStatus(error))
    return [408, 429, 500, 502, 503, 504].includes(error.status);
  if (error instanceof Error)
    return ["ECONNRESET", "ETIMEDOUT", "ECONNABORTED"].includes(error.name);
  return false;
}

function isHttpStatus(value: unknown): value is RetryableHttpError {
  return (
    typeof value === "object" &&
    value !== null &&
    "status" in value &&
    typeof value.status === "number"
  );
}

function normalizeFailure(error: unknown): VisionProviderError {
  if (error instanceof VisionProviderError) return error;
  return new VisionProviderError(
    isRetryable(error)
      ? "provider_temporary_unavailable"
      : "provider_output_invalid",
  );
}
