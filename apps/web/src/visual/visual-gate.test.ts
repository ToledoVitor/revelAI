import { describe, expect, it } from "vitest";
import {
  CANONICAL_LINUX_RENDERER,
  DARWIN_ARM64_RENDERER,
  resolveVisualGate,
} from "./visual-gate";

describe("visual gate", () => {
  it("allows structural checks on an otherwise unsupported host", () => {
    expect(
      resolveVisualGate({
        mode: "structural",
        runtime: { platform: "win32", arch: "x64" },
      }),
    ).toEqual({ mode: "structural" });
  });

  it("requires an explicit recognized mode before pixel comparison", () => {
    expect(() =>
      resolveVisualGate({
        runtime: { platform: "linux", arch: "x64" },
      }),
    ).toThrow("Visual gate mode is required");
    expect(() =>
      resolveVisualGate({
        mode: "preview",
        runtime: { platform: "linux", arch: "x64" },
      }),
    ).toThrow("Unsupported visual gate mode");
  });

  it("accepts canonical pixels only for the pinned Linux amd64 identity", () => {
    expect(
      resolveVisualGate({
        mode: "canonical",
        rendererIdentity: CANONICAL_LINUX_RENDERER,
        runtime: { platform: "linux", arch: "x64" },
      }),
    ).toEqual({ mode: "canonical", renderer: CANONICAL_LINUX_RENDERER });

    expect(() =>
      resolveVisualGate({
        mode: "canonical",
        rendererIdentity: DARWIN_ARM64_RENDERER,
        runtime: { platform: "linux", arch: "x64" },
      }),
    ).toThrow("Canonical visual pixels require renderer");
    expect(() =>
      resolveVisualGate({
        mode: "canonical",
        rendererIdentity: CANONICAL_LINUX_RENDERER,
        runtime: { platform: "darwin", arch: "arm64" },
      }),
    ).toThrow("Canonical visual pixels require linux/x64");
  });

  it("permits local pixels only through the explicit Darwin arm64 identity", () => {
    expect(
      resolveVisualGate({
        mode: "darwin",
        rendererIdentity: DARWIN_ARM64_RENDERER,
        runtime: { platform: "darwin", arch: "arm64" },
      }),
    ).toEqual({ mode: "darwin", renderer: DARWIN_ARM64_RENDERER });

    expect(() =>
      resolveVisualGate({
        mode: "darwin",
        rendererIdentity: DARWIN_ARM64_RENDERER,
        runtime: { platform: "darwin", arch: "x64" },
      }),
    ).toThrow("Darwin visual pixels require darwin/arm64");
  });
});
