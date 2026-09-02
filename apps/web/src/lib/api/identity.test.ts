import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDeviceAthleteId } from "./identity";

const storageKey = "revelai.device-athlete-id";
const athleteId = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

describe("device-local athlete identity", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.stubGlobal("crypto", { randomUUID: () => athleteId });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("generates one UUID and reuses the browser-local value", () => {
    expect(getDeviceAthleteId()).toBe(athleteId);
    expect(window.localStorage.getItem(storageKey)).toBe(athleteId);
    expect(getDeviceAthleteId()).toBe(athleteId);
  });

  it("replaces a malformed persisted value before it can become a request header", () => {
    window.localStorage.setItem(storageKey, "not-a-uuid");

    expect(getDeviceAthleteId()).toBe(athleteId);
    expect(window.localStorage.getItem(storageKey)).toBe(athleteId);
  });
});
