import { describe, expect, it } from "vitest";
import {
  canonicalObservationDeleteAt,
  originalOrFrameDeleteAt,
  temporaryDeleteAt,
} from "./retention-deadlines.js";

describe("retention deadlines", () => {
  it("uses exact UTC deadlines for original/frame, temporary, and canonical observations", () => {
    expect(originalOrFrameDeleteAt("2030-01-15T12:00:00.000Z")).toBe(
      "2030-01-16T11:00:00.000Z",
    );
    expect(temporaryDeleteAt("2030-01-15T12:00:00.000Z")).toBe(
      "2030-01-15T13:00:00.000Z",
    );
    expect(canonicalObservationDeleteAt("2030-01-15T12:00:00.000Z")).toBe(
      "2030-02-14T12:00:00.000Z",
    );
  });

  it("rejects malformed values instead of silently shifting a retention deadline", () => {
    expect(() => originalOrFrameDeleteAt("2030-01-15T12:00:00Z")).toThrow();
    expect(() => temporaryDeleteAt("not-a-date")).toThrow();
  });
});
