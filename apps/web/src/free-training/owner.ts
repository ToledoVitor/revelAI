export const freeTrainingOwnerStorageKey = "revelai.free-training.owner.v1";
export const freeTrainingCreateIntentStorageKey =
  "revelai.free-training.create-intent.v1";

type FreeTrainingOwner = Readonly<{ attemptId: string }>;
export type FreeTrainingCreateIntent = Readonly<{ idempotencyKey: string }>;

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
    // Session durability is unavailable in restricted browser storage.
  }
}

function clear(key: string) {
  try {
    window.sessionStorage.removeItem(key);
  } catch {
    // Session durability is unavailable in restricted browser storage.
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
  writeJson(freeTrainingCreateIntentStorageKey, intent);
  return intent;
}

export function clearFreeTrainingCreateIntent() {
  clear(freeTrainingCreateIntentStorageKey);
}

export function clearFreeTrainingOwnershipForAttempt(attemptId: string) {
  if (readFreeTrainingOwner()?.attemptId !== attemptId) return;
  clearFreeTrainingOwner();
  clearFreeTrainingCreateIntent();
}
