export const freeTrainingOwnerStorageKey = "revelai.free-training.owner.v1";
export const freeTrainingCreateIntentStorageKey =
  "revelai.free-training.create-intent.v1";

type FreeTrainingOwner = Readonly<{ attemptId: string }>;
export type FreeTrainingCreateIntent = Readonly<{ idempotencyKey: string }>;
export type FreeTrainingOwnershipCleanup =
  | "cleared"
  | "not-owned"
  | "unavailable";

type StorageRead =
  | Readonly<{ kind: "available"; value: string | null }>
  | Readonly<{ kind: "unavailable" }>;
type StorageValue<T> =
  | Readonly<{ kind: "available"; value: T | undefined }>
  | Readonly<{ kind: "unavailable" }>;

const storageProbeKey = "revelai.free-training.storage-probe.v1";
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function readRaw(key: string): StorageRead {
  try {
    return { kind: "available", value: window.sessionStorage.getItem(key) };
  } catch {
    return { kind: "unavailable" };
  }
}

function readJson(key: string): StorageValue<unknown> {
  const raw = readRaw(key);
  if (raw.kind === "unavailable") return raw;
  if (!raw.value) return { kind: "available", value: undefined };
  try {
    return { kind: "available", value: JSON.parse(raw.value) };
  } catch {
    return { kind: "available", value: undefined };
  }
}

function writeJson(key: string, value: unknown): boolean {
  try {
    const serialized = JSON.stringify(value);
    window.sessionStorage.setItem(key, serialized);
    const stored = readRaw(key);
    return stored.kind === "available" && stored.value === serialized;
  } catch {
    return false;
  }
}

function clear(key: string): boolean {
  try {
    window.sessionStorage.removeItem(key);
    const stored = readRaw(key);
    return stored.kind === "available" && stored.value === null;
  } catch {
    return false;
  }
}

export class FreeTrainingSessionStorageError extends Error {
  public constructor() {
    super("Free training session storage is unavailable");
  }
}

function newUuid(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return [...bytes]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, "$1-$2-$3-$4-$5");
}

/** Verifies storage without reading, replacing, or clearing either ownership key. */
function hasVerifiedSessionStorage(): boolean {
  const probe = newUuid();
  try {
    window.sessionStorage.setItem(storageProbeKey, probe);
    const stored = readRaw(storageProbeKey);
    if (stored.kind !== "available" || stored.value !== probe) return false;
    window.sessionStorage.removeItem(storageProbeKey);
    const removed = readRaw(storageProbeKey);
    return removed.kind === "available" && removed.value === null;
  } catch {
    return false;
  }
}

function parseOwner(value: unknown): FreeTrainingOwner | undefined {
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

function readOwner(): StorageValue<FreeTrainingOwner> {
  const stored = readJson(freeTrainingOwnerStorageKey);
  if (stored.kind === "unavailable") return stored;
  return { kind: "available", value: parseOwner(stored.value) };
}

export function readFreeTrainingOwner(): FreeTrainingOwner | undefined {
  const owner = readOwner();
  return owner.kind === "available" ? owner.value : undefined;
}

export function persistFreeTrainingOwner(attemptId: string): boolean {
  return writeJson(freeTrainingOwnerStorageKey, { attemptId });
}

export function clearFreeTrainingOwner(): boolean {
  return clear(freeTrainingOwnerStorageKey);
}

function parseCreateIntent(
  value: unknown,
): FreeTrainingCreateIntent | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    !("idempotencyKey" in value) ||
    typeof value.idempotencyKey !== "string" ||
    !uuidPattern.test(value.idempotencyKey)
  )
    return undefined;
  return { idempotencyKey: value.idempotencyKey };
}

function readCreateIntent(): StorageValue<FreeTrainingCreateIntent> {
  const stored = readJson(freeTrainingCreateIntentStorageKey);
  if (stored.kind === "unavailable") return stored;
  return { kind: "available", value: parseCreateIntent(stored.value) };
}

export function readFreeTrainingCreateIntent():
  | FreeTrainingCreateIntent
  | undefined {
  const intent = readCreateIntent();
  return intent.kind === "available" ? intent.value : undefined;
}

/** Creates once per logical Free owner; retries and reloads keep this UUID. */
export function beginFreeTrainingCreateIntent(): FreeTrainingCreateIntent {
  if (!hasVerifiedSessionStorage()) throw new FreeTrainingSessionStorageError();
  const existing = readCreateIntent();
  if (existing.kind === "unavailable")
    throw new FreeTrainingSessionStorageError();
  if (existing.value) return existing.value;
  const intent = { idempotencyKey: newUuid() };
  if (!writeJson(freeTrainingCreateIntentStorageKey, intent))
    throw new FreeTrainingSessionStorageError();
  return intent;
}

export function clearFreeTrainingCreateIntent(): boolean {
  return clear(freeTrainingCreateIntentStorageKey);
}

/** Attempts both removals even when the first one fails. */
export function clearFreeTrainingOwnership(): FreeTrainingOwnershipCleanup {
  if (!hasVerifiedSessionStorage()) return "unavailable";
  const ownerCleared = clearFreeTrainingOwner();
  const intentCleared = clearFreeTrainingCreateIntent();
  return ownerCleared && intentCleared ? "cleared" : "unavailable";
}

export function clearFreeTrainingOwnershipForAttempt(
  attemptId: string,
): FreeTrainingOwnershipCleanup {
  const owner = readOwner();
  if (owner.kind === "unavailable") return "unavailable";
  if (owner.value?.attemptId !== attemptId) return "not-owned";
  return clearFreeTrainingOwnership();
}
