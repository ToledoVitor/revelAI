import { afterEach, describe, expect, it, vi } from "vitest";
import {
  beginFreeTrainingCreateIntent,
  clearFreeTrainingCreateIntent,
  clearFreeTrainingOwnershipForAttempt,
  freeTrainingCreateIntentStorageKey,
  freeTrainingOwnerStorageKey,
  persistFreeTrainingOwner,
  readFreeTrainingCreateIntent,
  readFreeTrainingOwner,
} from "./owner";

describe("Free training causal ownership", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    window.sessionStorage.clear();
  });

  it("creates a fresh valid idempotency key when persisted storage is malformed", () => {
    window.sessionStorage.setItem(
      freeTrainingCreateIntentStorageKey,
      JSON.stringify({ idempotencyKey: "not-a-uuid" }),
    );

    const intent = beginFreeTrainingCreateIntent();

    expect(intent.idempotencyKey).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(readFreeTrainingCreateIntent()).toEqual(intent);
  });

  it("clears the owner and causal key only for the matching deleted Attempt", () => {
    persistFreeTrainingOwner("attempt-owned");
    const intent = beginFreeTrainingCreateIntent();

    clearFreeTrainingOwnershipForAttempt("attempt-other");
    expect(readFreeTrainingOwner()).toEqual({ attemptId: "attempt-owned" });
    expect(readFreeTrainingCreateIntent()).toEqual(intent);

    clearFreeTrainingOwnershipForAttempt("attempt-owned");
    expect(readFreeTrainingOwner()).toBeUndefined();
    expect(readFreeTrainingCreateIntent()).toBeUndefined();
    expect(
      window.sessionStorage.getItem(freeTrainingOwnerStorageKey),
    ).toBeNull();
  });

  it.each([
    ["get throws", "getItem"],
    ["get is a noop", "get-noop"],
    ["set throws", "setItem"],
    ["set is a noop", "set-noop"],
  ] as const)(
    "fails closed instead of returning an unconfirmed key when session storage %s",
    (_label, failure) => {
      if (failure === "getItem")
        vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
          throw new DOMException("blocked", "SecurityError");
        });
      if (failure === "get-noop")
        vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => null);
      if (failure === "setItem")
        vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
          throw new DOMException("full", "QuotaExceededError");
        });
      if (failure === "set-noop")
        vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
          // Simulates a browser that silently refuses persistence.
        });

      expect(() => beginFreeTrainingCreateIntent()).toThrow(
        "Free training session storage is unavailable",
      );
    },
  );

  it("reports an unavailable remove so a stale causal key cannot be reused", () => {
    beginFreeTrainingCreateIntent();
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });

    expect(clearFreeTrainingCreateIntent()).toBe(false);
    expect(readFreeTrainingCreateIntent()).toBeDefined();
  });

  it("reports a noop remove so a stale causal key cannot be reused", () => {
    beginFreeTrainingCreateIntent();
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      // Simulates a browser that silently refuses removal.
    });

    expect(clearFreeTrainingCreateIntent()).toBe(false);
    expect(readFreeTrainingCreateIntent()).toBeDefined();
  });
});
