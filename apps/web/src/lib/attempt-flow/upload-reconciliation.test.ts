import { describe, expect, it } from "vitest";
import {
  isAmbiguousUploadError,
  isOutcomeForAttempt,
  resolveUploadReconciliation,
} from "./upload-reconciliation";

describe("neutral attempt upload reconciliation", () => {
  it("correlates the result kind with its expected mode", () => {
    const freePending = {
      state: "pending" as const,
      attemptId: "attempt-free",
      mode: "free" as const,
      status: "uploaded" as const,
    };

    expect(isOutcomeForAttempt(freePending, "attempt-free", "free")).toBe(true);
    expect(
      resolveUploadReconciliation(freePending, "attempt-free", "verified"),
    ).toEqual({ kind: "mismatch", preserveMedia: true });
  });

  it("routes only abort, duplicate, and transport uncertainty to reconciliation", () => {
    const options = {
      isAbort: (error: unknown) => error === "abort",
      isRouteError: (error: unknown) => error === "route",
      hasRouteErrorCode: (error: unknown, code: string) => error === code,
    };

    expect(isAmbiguousUploadError("abort", options)).toBe(true);
    expect(isAmbiguousUploadError("duplicate_media_upload", options)).toBe(
      true,
    );
    expect(isAmbiguousUploadError("transport", options)).toBe(true);
    expect(isAmbiguousUploadError("route", options)).toBe(false);
  });
});
