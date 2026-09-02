import { describe, expect, it } from "vitest";
import { resolveUploadReconciliation } from "./upload-reconciliation";

const attemptId = "attempt-w4-1";

describe("upload reconciliation", () => {
  it.each([
    [
      "awaiting-upload",
      {
        state: "pending",
        attemptId,
        mode: "verified",
        status: "awaiting-upload",
      },
      { kind: "capture", preserveMedia: true },
    ],
    [
      "uploaded",
      {
        state: "pending",
        attemptId,
        mode: "verified",
        status: "uploaded",
      },
      { kind: "pending", preserveMedia: false },
    ],
    [
      "processing",
      {
        state: "pending",
        attemptId,
        mode: "verified",
        status: "processing",
      },
      { kind: "pending", preserveMedia: false },
    ],
    [
      "terminal",
      {
        state: "failed",
        attemptId,
        mode: "verified",
        code: "analysis_internal_error",
        message: "A análise não pôde ser concluída.",
        retryable: false,
      },
      { kind: "terminal", preserveMedia: false },
    ],
  ] as const)(
    "maps authoritative %s state without inferring upload ownership",
    (_name, outcome, expected) => {
      expect(resolveUploadReconciliation(outcome, attemptId)).toMatchObject(
        expected,
      );
    },
  );

  it("fails closed and preserves media for a different verified attempt", () => {
    expect(
      resolveUploadReconciliation(
        {
          state: "pending",
          attemptId: "attempt-other",
          mode: "verified",
          status: "uploaded",
        },
        attemptId,
      ),
    ).toEqual({ kind: "mismatch", preserveMedia: true });
  });
});
