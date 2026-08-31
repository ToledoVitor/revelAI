import { VisionProviderError } from "./providers.js";

export type SchedulerClock = Readonly<{
  now(): number;
  sleep(milliseconds: number, signal?: AbortSignal): Promise<void>;
}>;

export const systemSchedulerClock: SchedulerClock = Object.freeze({
  now: () => Date.now(),
  sleep: (milliseconds, signal) =>
    new Promise((resolve, reject) => {
      const timeout = setTimeout(resolve, milliseconds);
      signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timeout);
          reject(new Error("aborted"));
        },
        { once: true },
      );
    }),
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
  ): Promise<readonly Result[]> {
    const startedAt = this.clock.now();
    const controller = new AbortController();
    const results: Result[] = new Array(items.length);
    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (!controller.signal.aborted) {
        const index = cursor;
        cursor += 1;
        if (index >= items.length) return;
        results[index] = await this.dispatchWithRetry(
          items[index]!,
          dispatch,
          startedAt,
          controller,
        );
      }
    };
    try {
      await Promise.all(
        Array.from({ length: Math.min(this.maxInFlight, items.length) }, () =>
          worker(),
        ),
      );
      return Object.freeze(results);
    } catch (error) {
      controller.abort();
      if (error instanceof VisionProviderError) throw error;
      throw new VisionProviderError("provider_temporary_unavailable");
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
      const requestController = new AbortController();
      const relayAbort = () => requestController.abort();
      batchController.signal.addEventListener("abort", relayAbort, {
        once: true,
      });
      try {
        const result = await this.withTimeout(
          dispatch(item, requestController.signal),
          requestController,
          startedAt,
        );
        return result;
      } catch (error) {
        if (!isRetryable(error) || attempt === this.retryDelaysMs.length)
          throw normalizeFailure(error);
        await this.clock.sleep(
          this.retryDelaysMs[attempt]!,
          batchController.signal,
        );
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
