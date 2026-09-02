import { afterEach, describe, expect, it, vi } from "vitest";
import {
  beginFreeTrainingCreateIntent,
  clearFreeTrainingCreateIntent,
  clearFreeTrainingOwnership,
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
    [
      "throws",
      (): string | null => {
        throw new DOMException("blocked", "SecurityError");
      },
    ],
    ["silently reads null", (): string | null => null],
  ] as const)(
    "never treats a matching owner as absent when storage get %s during deletion cleanup",
    (_label, unavailableRead) => {
      const originalGet = Storage.prototype.getItem;
      persistFreeTrainingOwner("attempt-owned");
      const intent = beginFreeTrainingCreateIntent();
      const rawRead = originalGet.bind(window.sessionStorage);
      vi.spyOn(Storage.prototype, "getItem").mockImplementation(
        unavailableRead,
      );

      expect(clearFreeTrainingOwnershipForAttempt("attempt-owned")).toBe(
        "unavailable",
      );
      expect(rawRead(freeTrainingOwnerStorageKey)).toBe(
        JSON.stringify({ attemptId: "attempt-owned" }),
      );
      expect(rawRead(freeTrainingCreateIntentStorageKey)).toBe(
        JSON.stringify(intent),
      );
    },
  );

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

  it.each(["throws", "silently refuses"] as const)(
    "attempts both ownership removals even when the storage probe %s",
    (behavior) => {
      const originalRemove = Storage.prototype.removeItem;
      persistFreeTrainingOwner("attempt-owned");
      beginFreeTrainingCreateIntent();
      const removals: string[] = [];
      vi.spyOn(Storage.prototype, "removeItem").mockImplementation(
        function removeItem(this: Storage, key: string): void {
          removals.push(key);
          if (behavior === "throws")
            throw new DOMException("blocked", "SecurityError");
          return;
        },
      );

      expect(clearFreeTrainingOwnership()).toBe("unavailable");
      expect(removals).toContain(freeTrainingOwnerStorageKey);
      expect(removals).toContain(freeTrainingCreateIntentStorageKey);

      vi.restoreAllMocks();
      expect(clearFreeTrainingOwnership()).toBe("cleared");
      expect(window.sessionStorage).toHaveLength(0);
      expect(originalRemove).toBe(Storage.prototype.removeItem);
    },
  );

  it.each([
    [
      "throws",
      (): string | null => {
        throw new DOMException("blocked", "SecurityError");
      },
    ],
    ["silently reads null", (): string | null => null],
  ] as const)(
    "preserves a response-lost causal key while storage get %s",
    (_label, unavailableRead) => {
      const oldKey = "a3333333-3333-4333-8333-333333333333";
      const originalGet = Storage.prototype.getItem;
      window.sessionStorage.setItem(
        freeTrainingCreateIntentStorageKey,
        JSON.stringify({ idempotencyKey: oldKey }),
      );
      const rawRead = originalGet.bind(window.sessionStorage);
      vi.spyOn(Storage.prototype, "getItem").mockImplementation(
        unavailableRead,
      );

      expect(() => beginFreeTrainingCreateIntent()).toThrow(
        "Free training session storage is unavailable",
      );
      expect(rawRead(freeTrainingCreateIntentStorageKey)).toBe(
        JSON.stringify({ idempotencyKey: oldKey }),
      );

      vi.restoreAllMocks();
      expect(beginFreeTrainingCreateIntent()).toEqual({
        idempotencyKey: oldKey,
      });
    },
  );

  it.each([
    ["owner", [freeTrainingOwnerStorageKey], "throws"],
    ["intent", [freeTrainingCreateIntentStorageKey], "throws"],
    [
      "both facts",
      [freeTrainingOwnerStorageKey, freeTrainingCreateIntentStorageKey],
      "throws",
    ],
    ["owner", [freeTrainingOwnerStorageKey], "silently refuses"],
    ["intent", [freeTrainingCreateIntentStorageKey], "silently refuses"],
    [
      "both facts",
      [freeTrainingOwnerStorageKey, freeTrainingCreateIntentStorageKey],
      "silently refuses",
    ],
  ] as const)(
    "attempts both cleanup removals when %s %s",
    (_name, unavailableKeys, behavior) => {
      const originalRemove = Storage.prototype.removeItem;
      persistFreeTrainingOwner("attempt-owned");
      beginFreeTrainingCreateIntent();
      const removals: string[] = [];
      vi.spyOn(Storage.prototype, "removeItem").mockImplementation(
        function removeItem(this: Storage, key: string): void {
          removals.push(key);
          if ((unavailableKeys as readonly string[]).includes(key)) {
            if (behavior === "throws")
              throw new DOMException("blocked", "SecurityError");
            return;
          }
          return originalRemove.call(this, key);
        },
      );

      expect(clearFreeTrainingOwnershipForAttempt("attempt-owned")).toBe(
        "unavailable",
      );
      expect(removals.slice(-2)).toEqual([
        freeTrainingOwnerStorageKey,
        freeTrainingCreateIntentStorageKey,
      ]);
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
