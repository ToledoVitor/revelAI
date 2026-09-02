import type { AttemptListResponse, AttemptSummary } from "@revelai/contracts";
import { isOutcomeForAttempt } from "../lib/attempt-flow/upload-reconciliation";

export const freeTrainingOwnerStorageKey = "revelai.free-training.owner.v1";
export const freeTrainingCreateIntentStorageKey =
  "revelai.free-training.create-intent.v1";

export type FreeTrainingCreateIntent = Readonly<{
  startedAt: string;
}>;

type FreeTrainingOwner = Readonly<{ attemptId: string }>;

function readJson(key: string): unknown {
  try {
    const value = window.sessionStorage.getItem(key);
    return value ? JSON.parse(value) : undefined;
  } catch {
    return undefined;
  }
}

function writeJson(key: string, value: unknown) {
  try {
    window.sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage can be unavailable in a privacy-restricted browser. The route
    // remains safe for the current lifetime, but cannot claim reload recovery.
  }
}

function clear(key: string) {
  try {
    window.sessionStorage.removeItem(key);
  } catch {
    // See writeJson: storage is an enhancement, not a dependency for safety.
  }
}

export function readFreeTrainingOwner(): FreeTrainingOwner | undefined {
  const value = readJson(freeTrainingOwnerStorageKey);
  if (
    typeof value !== "object" ||
    value === null ||
    !("attemptId" in value) ||
    typeof value.attemptId !== "string" ||
    value.attemptId.length === 0
  )
    return undefined;
  return { attemptId: value.attemptId };
}

export function persistFreeTrainingOwner(attemptId: string) {
  writeJson(freeTrainingOwnerStorageKey, { attemptId });
}

export function clearFreeTrainingOwner() {
  clear(freeTrainingOwnerStorageKey);
}

export function readFreeTrainingCreateIntent():
  | FreeTrainingCreateIntent
  | undefined {
  const value = readJson(freeTrainingCreateIntentStorageKey);
  if (
    typeof value !== "object" ||
    value === null ||
    !("startedAt" in value) ||
    typeof value.startedAt !== "string" ||
    !Number.isFinite(Date.parse(value.startedAt))
  )
    return undefined;
  return { startedAt: value.startedAt };
}

export function beginFreeTrainingCreateIntent(): FreeTrainingCreateIntent {
  const intent = { startedAt: new Date().toISOString() };
  writeJson(freeTrainingCreateIntentStorageKey, intent);
  return intent;
}

export function clearFreeTrainingCreateIntent() {
  clear(freeTrainingCreateIntentStorageKey);
}

/**
 * A response-lost create has no server-side idempotency key. Adopt only one
 * parsed Free attempt created after this browser's persisted intent; multiple
 * candidates are deliberately treated as ambiguous rather than guessing.
 */
export function recoverFreeTrainingOwner(
  attempts: AttemptListResponse,
  intent: FreeTrainingCreateIntent,
):
  | Readonly<{ kind: "owner"; attempt: AttemptSummary }>
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "ambiguous" }> {
  const intentTime = Date.parse(intent.startedAt);
  const candidates = attempts.items.filter(
    (attempt) =>
      attempt.mode === "free" &&
      Date.parse(attempt.createdAt) >= intentTime &&
      isOutcomeForAttempt(attempt.outcome, attempt.id, "free"),
  );
  if (candidates.length === 0) return { kind: "none" };
  if (candidates.length > 1) return { kind: "ambiguous" };
  return { kind: "owner", attempt: candidates[0] };
}
