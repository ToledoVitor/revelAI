import type { HourlyRecoveryScheduler } from "./media-attachment-recovery.js";

/**
 * A reserved background runtime with a deliberately split lifecycle. It owns
 * no scheduled work until activate(), so two durable consumers can start as a
 * single composition unit.
 */
export interface PreparedC8BackgroundRuntime {
  register(scheduler: HourlyRecoveryScheduler): void;
  activate(now: string): void;
  abortStartup(): void;
  stop(): Promise<void>;
  drain(): Promise<void>;
}

export interface C8RuntimeSupervisorHandle {
  stop(): Promise<void>;
  drain(): Promise<void>;
}

/**
 * Register every timer while its callback remains inert, then run both
 * immediate passes from one authoritative clock snapshot. A registration
 * failure is synchronously reversible: any timer already registered is
 * cancelled exactly once and both owner reservations are released.
 */
export function startC8RuntimeSupervisor(
  input: Readonly<{
    recovery: PreparedC8BackgroundRuntime;
    retention?: PreparedC8BackgroundRuntime;
    scheduler: HourlyRecoveryScheduler;
    now: () => string;
  }>,
): C8RuntimeSupervisorHandle {
  const runtimes = input.retention
    ? [input.recovery, input.retention]
    : [input.recovery];
  try {
    for (const runtime of runtimes) runtime.register(input.scheduler);
    const startedAt = input.now();
    for (const runtime of runtimes) runtime.activate(startedAt);
    return Object.freeze({
      stop: async () => {
        await Promise.all(runtimes.map((runtime) => runtime.stop()));
      },
      drain: async () => {
        await Promise.all(runtimes.map((runtime) => runtime.drain()));
      },
    });
  } catch (error) {
    for (const runtime of [...runtimes].reverse()) runtime.abortStartup();
    throw error;
  }
}
