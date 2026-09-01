/**
 * Test-only diagnostics are intentionally absent from every production
 * composition input and package entry point. A WeakMap keeps them attached to
 * already-created internal objects, so their absence is a synchronous,
 * callback-free production path.
 */
export type TestDiagnosticEvent =
  | Readonly<{ kind: "c4-calibration" }>
  | Readonly<{ kind: "c4-ranked-finalization" }>
  | Readonly<{ kind: "c4-leaderboard-write" }>
  | Readonly<{ kind: "free-terminal-persistence" }>
  | Readonly<{ kind: "free-forbidden-calibration" }>
  | Readonly<{ kind: "free-forbidden-integrity-scoring" }>
  | Readonly<{ kind: "free-forbidden-policy-lookup" }>
  | Readonly<{ kind: "free-forbidden-ranked-finalization" }>
  | Readonly<{ kind: "free-forbidden-leaderboard" }>
  | Readonly<{ kind: "free-forbidden-finalization" }>
  | Readonly<{ kind: "policy-lookup" }>
  | Readonly<{ kind: "verified-integrity-scoring" }>;

export type TestDiagnostic = Readonly<{
  onEvent?(event: TestDiagnosticEvent): unknown;
  beforeC4TransactionEntry?(
    input: Readonly<{
      operation: "finalize" | "tombstone";
      attemptId: string;
    }>,
  ): unknown;
}>;

const diagnostics = new WeakMap<object, TestDiagnostic>();

/** Test support registers against internal instances, never production input. */
export function registerTestDiagnostic(
  target: object,
  diagnostic: TestDiagnostic,
): () => void {
  diagnostics.set(target, diagnostic);
  return () => {
    if (diagnostics.get(target) === diagnostic) diagnostics.delete(target);
  };
}

/** Diagnostic failures are deliberately unable to affect product behavior. */
export function emitTestDiagnostic(
  target: object,
  event: TestDiagnosticEvent,
): void {
  const callback = diagnostics.get(target)?.onEvent;
  if (!callback) return;
  try {
    const result = callback(event);
    if (isThenable(result)) void Promise.resolve(result).catch(ignore);
  } catch {
    // A test observer is not application authority.
  }
}

/**
 * Returns undefined when no barrier is registered so callers do not await and
 * therefore preserve synchronous transaction entry in normal production use.
 */
export function beforeC4TransactionEntry(
  target: object,
  input: Readonly<{
    operation: "finalize" | "tombstone";
    attemptId: string;
  }>,
): Promise<void> | undefined {
  const callback = diagnostics.get(target)?.beforeC4TransactionEntry;
  if (!callback) return undefined;
  try {
    const result = callback(input);
    return isThenable(result)
      ? Promise.resolve(result).then(ignore, ignore)
      : undefined;
  } catch {
    return undefined;
  }
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    "then" in value &&
    typeof value.then === "function"
  );
}

function ignore(): void {
  // Test diagnostics must never become operational failures.
}
