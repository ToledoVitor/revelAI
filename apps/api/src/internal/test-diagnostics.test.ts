import { describe, expect, it } from "vitest";
import {
  emitTestDiagnostic,
  registerTestDiagnostic,
} from "./test-diagnostics.js";

describe("test diagnostic registrations", () => {
  it("keeps a replacement registration when stale cleanup runs first", () => {
    const target = {};
    const events: string[] = [];
    const first = registerTestDiagnostic(target, {
      onEvent: () => events.push("first"),
    });
    const replacement = registerTestDiagnostic(target, {
      onEvent: () => events.push("replacement"),
    });

    first();
    emitTestDiagnostic(target, { kind: "policy-lookup" });

    expect(events).toEqual(["replacement"]);
    replacement();
  });

  it("does not observe events after the current registration is cleaned up", () => {
    const target = {};
    const events: string[] = [];
    const cleanup = registerTestDiagnostic(target, {
      onEvent: () => events.push("observed"),
    });

    cleanup();
    emitTestDiagnostic(target, { kind: "policy-lookup" });

    expect(events).toEqual([]);
  });
});
