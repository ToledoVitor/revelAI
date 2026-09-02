import { AttemptListResponseSchema } from "@revelai/contracts";
import { describe, expect, it } from "vitest";
import { recoverFreeTrainingOwner } from "./owner";

const intent = { startedAt: "2026-08-30T12:00:00.000Z" };

function freeAttempt(id: string, createdAt: string) {
  return {
    id,
    mode: "free",
    status: "awaiting-upload",
    createdAt,
    outcome: {
      state: "pending",
      attemptId: id,
      mode: "free",
      status: "awaiting-upload",
    },
  };
}

describe("Free training create-intent recovery", () => {
  it("adopts exactly one parsed Free attempt after the persisted intent", () => {
    const attempts = AttemptListResponseSchema.parse({
      items: [freeAttempt("attempt-recovered", "2026-08-30T12:00:01.000Z")],
      nextCursor: null,
    });

    expect(recoverFreeTrainingOwner(attempts, intent)).toMatchObject({
      kind: "owner",
      attempt: { id: "attempt-recovered", mode: "free" },
    });
  });

  it("does not adopt stale or ambiguous Free records", () => {
    const stale = AttemptListResponseSchema.parse({
      items: [freeAttempt("attempt-stale", "2026-08-30T11:59:59.000Z")],
      nextCursor: null,
    });
    const ambiguous = AttemptListResponseSchema.parse({
      items: [
        freeAttempt("attempt-newer", "2026-08-30T12:00:02.000Z"),
        freeAttempt("attempt-other", "2026-08-30T12:00:01.000Z"),
      ],
      nextCursor: null,
    });

    expect(recoverFreeTrainingOwner(stale, intent)).toEqual({ kind: "none" });
    expect(recoverFreeTrainingOwner(ambiguous, intent)).toEqual({
      kind: "ambiguous",
    });
  });
});
