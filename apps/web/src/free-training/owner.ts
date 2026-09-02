export const freeTrainingOwnerStorageKey = "revelai.free-training.owner.v1";
export const freeTrainingCreateIntentStorageKey =
  "revelai.free-training.create-intent.v1";

type FreeTrainingOwner = Readonly<{ attemptId: string }>;
export type FreeTrainingCreateIntent = Readonly<{ idempotencyKey: string }>;

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function readRaw(key: string): string | null | undefined {
  try {
    return window.sessionStorage.getItem(key);
  } catch {
    return undefined;
  }
}

function readJson(key: string): unknown {
  const value = readRaw(key);
  if (!value) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function writeJson(key: string, value: unknown): boolean {
  try {
    const serialized = JSON.stringify(value);
    window.sessionStorage.setItem(key, serialized);
    return readRaw(key) === serialized;
  } catch {
    return false;
  }
}

function clear(key: string): boolean {
  try {
    window.sessionStorage.removeItem(key);
    return readRaw(key) === null;
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

export function persistFreeTrainingOwner(attemptId: string): boolean {
  return writeJson(freeTrainingOwnerStorageKey, { attemptId });
}

export function clearFreeTrainingOwner(): boolean {
  return clear(freeTrainingOwnerStorageKey);
}

export function readFreeTrainingCreateIntent():
  | FreeTrainingCreateIntent
  | undefined {
  const value = readJson(freeTrainingCreateIntentStorageKey);
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

/** Creates once per logical Free owner; retries and reloads keep this UUID. */
export function beginFreeTrainingCreateIntent(): FreeTrainingCreateIntent {
  const existing = readFreeTrainingCreateIntent();
  if (existing) return existing;
  const intent = { idempotencyKey: newUuid() };
  if (!writeJson(freeTrainingCreateIntentStorageKey, intent))
    throw new FreeTrainingSessionStorageError();
  return intent;
}

export function clearFreeTrainingCreateIntent(): boolean {
  return clear(freeTrainingCreateIntentStorageKey);
}

export function clearFreeTrainingOwnershipForAttempt(
  attemptId: string,
): boolean {
  if (readFreeTrainingOwner()?.attemptId !== attemptId) return false;
  return clearFreeTrainingOwner() && clearFreeTrainingCreateIntent();
}
