import { describe, expect, it } from "vitest";
import { designTokens } from "./index.js";

describe("design tokens", () => {
  it("exposes the approved visual palette and typography stacks", () => {
    expect(designTokens).toStrictEqual({
      color: {
        warmWhite: "#F7F5F0",
        nearBlack: "#10110F",
        deepEmerald: "#006B3C",
        mutedGray: "#686B67",
        borderGray: "#CDD1CC",
      },
      typography: {
        display: '"Bebas Neue", "Arial Narrow", sans-serif',
        body: '"Arimo", Arial, sans-serif',
      },
    });
  });
});
