import { describe, expect, it } from "vitest";
import {
  beginFreeTrainingCreateIntent,
  clearFreeTrainingOwnershipForAttempt,
  freeTrainingCreateIntentStorageKey,
  freeTrainingOwnerStorageKey,
  persistFreeTrainingOwner,
  readFreeTrainingCreateIntent,
  readFreeTrainingOwner,
} from "./owner";

describe("Free training causal ownership", () => {
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
});
