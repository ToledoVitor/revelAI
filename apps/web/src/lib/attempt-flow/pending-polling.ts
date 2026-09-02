import { useCallback, useEffect, useRef, useState } from "react";

export type PendingPollDecision<T> =
  | Readonly<{ kind: "pending"; value: T }>
  | Readonly<{ kind: "terminal"; value: T }>;

type PendingPollingInput<T> = Readonly<{
  enabled: boolean;
  attemptId?: string;
  generation: number;
  request(
    attemptId: string,
    options: Readonly<{ signal: AbortSignal }>,
  ): Promise<PendingPollDecision<T>>;
  onDecision(decision: PendingPollDecision<T>): void;
  onError(error: unknown): void;
  isAbort(error: unknown): boolean;
}>;

type ActiveRequest = Readonly<{
  attemptId: string;
  generation: number;
  controller: AbortController;
}>;

export function nextPendingPollBackoff(seconds: number): number {
  return Math.min(Math.max(seconds, 1) * 2, 5);
}

/**
 * Owns the mechanical polling lifecycle shared by both attempt modes: capped
 * backoff, focus/visibility/manual coalescing, and stale request cancellation.
 * Consumers keep mode-specific parsing and terminal rendering at their edge.
 */
export function usePendingAttemptPolling<T>(input: PendingPollingInput<T>) {
  const inputRef = useRef(input);
  inputRef.current = input;
  const activeRequestRef = useRef<ActiveRequest | undefined>(undefined);
  const timeoutRef = useRef<number | undefined>(undefined);
  const [backoffSeconds, setBackoffSeconds] = useState(1);
  const [refreshing, setRefreshing] = useState(false);
  const [cycle, setCycle] = useState(0);

  const stop = useCallback(() => {
    if (timeoutRef.current !== undefined)
      window.clearTimeout(timeoutRef.current);
    timeoutRef.current = undefined;
    const active = activeRequestRef.current;
    activeRequestRef.current = undefined;
    active?.controller.abort();
  }, []);

  const refresh = useCallback(async () => {
    const current = inputRef.current;
    if (!current.enabled || !current.attemptId) return;
    const active = activeRequestRef.current;
    if (
      active &&
      active.generation === current.generation &&
      active.attemptId === current.attemptId
    )
      return;
    const controller = new AbortController();
    const request = {
      attemptId: current.attemptId,
      generation: current.generation,
      controller,
    };
    activeRequestRef.current = request;
    setRefreshing(true);
    try {
      const decision = await current.request(current.attemptId, {
        signal: controller.signal,
      });
      const latest = inputRef.current;
      if (
        controller.signal.aborted ||
        activeRequestRef.current !== request ||
        latest.generation !== request.generation ||
        latest.attemptId !== request.attemptId ||
        !latest.enabled
      )
        return;
      latest.onDecision(decision);
      if (decision.kind === "pending")
        setBackoffSeconds((value) => nextPendingPollBackoff(value));
    } catch (error) {
      const latest = inputRef.current;
      if (
        !controller.signal.aborted &&
        activeRequestRef.current === request &&
        latest.generation === request.generation &&
        latest.attemptId === request.attemptId &&
        latest.enabled &&
        !latest.isAbort(error)
      )
        latest.onError(error);
    } finally {
      if (activeRequestRef.current === request)
        activeRequestRef.current = undefined;
      const latest = inputRef.current;
      if (
        latest.generation === request.generation &&
        latest.attemptId === request.attemptId
      )
        setRefreshing(false);
      if (
        !controller.signal.aborted &&
        latest.enabled &&
        latest.generation === request.generation &&
        latest.attemptId === request.attemptId
      )
        setCycle((value) => value + 1);
    }
  }, []);

  useEffect(() => {
    if (!input.enabled || !input.attemptId) {
      stop();
      setBackoffSeconds((value) => (value === 1 ? value : 1));
      return;
    }
    const delay = Math.min(backoffSeconds, 5) * 1_000;
    timeoutRef.current = window.setTimeout(() => void refresh(), delay);
    const onFocus = () => void refresh();
    const onVisibility = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      if (timeoutRef.current !== undefined)
        window.clearTimeout(timeoutRef.current);
      timeoutRef.current = undefined;
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
      const active = activeRequestRef.current;
      activeRequestRef.current = undefined;
      active?.controller.abort();
    };
  }, [
    backoffSeconds,
    cycle,
    input.attemptId,
    input.enabled,
    input.generation,
    refresh,
    stop,
  ]);

  return { backoffSeconds, refreshing, refresh, stop };
}
