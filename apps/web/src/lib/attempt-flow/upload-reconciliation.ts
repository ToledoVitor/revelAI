import type { AttemptMode, AttemptOutcome } from "@revelai/contracts";

export type UploadReconciliation =
  | Readonly<{
      kind: "capture";
      outcome: AttemptOutcome;
      preserveMedia: true;
    }>
  | Readonly<{
      kind: "pending";
      outcome: AttemptOutcome;
      preserveMedia: false;
    }>
  | Readonly<{
      kind: "terminal";
      outcome: AttemptOutcome;
      preserveMedia: false;
    }>
  | Readonly<{ kind: "mismatch"; preserveMedia: true }>;

export function isOutcomeForAttempt(
  outcome: AttemptOutcome,
  attemptId: string,
  expectedMode: AttemptMode,
): boolean {
  if (outcome.state === "pending")
    return outcome.mode === expectedMode && outcome.attemptId === attemptId;
  if (outcome.state === "valid")
    return (
      outcome.result.kind ===
        (expectedMode === "free" ? "free-insight" : "verified-result") &&
      outcome.result.attemptId === attemptId
    );
  return outcome.mode === expectedMode && outcome.attemptId === attemptId;
}

export function resolveUploadReconciliation(
  outcome: AttemptOutcome,
  attemptId: string,
  expectedMode: AttemptMode = "verified",
): UploadReconciliation {
  if (!isOutcomeForAttempt(outcome, attemptId, expectedMode))
    return { kind: "mismatch", preserveMedia: true };
  if (outcome.state === "pending") {
    if (outcome.status === "awaiting-upload")
      return { kind: "capture", outcome, preserveMedia: true };
    return { kind: "pending", outcome, preserveMedia: false };
  }
  return { kind: "terminal", outcome, preserveMedia: false };
}

export function isAmbiguousUploadError(
  error: unknown,
  options: Readonly<{
    isAbort(error: unknown): boolean;
    isRouteError(error: unknown): boolean;
    hasRouteErrorCode(error: unknown, code: string): boolean;
  }>,
): boolean {
  return (
    options.hasRouteErrorCode(error, "duplicate_media_upload") ||
    options.isAbort(error) ||
    !options.isRouteError(error)
  );
}
