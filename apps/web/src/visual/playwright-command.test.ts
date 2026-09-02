// @vitest-environment node

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CANONICAL_LINUX_RENDERER as commandCanonicalRenderer,
  DARWIN_ARM64_RENDERER as commandDarwinRenderer,
  createPlaywrightCommand,
  parseVisualGateArguments,
} from "../../scripts/playwright-command.mjs";
import { CANONICAL_LINUX_RENDERER, DARWIN_ARM64_RENDERER } from "./visual-gate";

describe("Playwright command", () => {
  it("uses the same renderer identities as the browser gate", () => {
    expect(commandCanonicalRenderer).toBe(CANONICAL_LINUX_RENDERER);
    expect(commandDarwinRenderer).toBe(DARWIN_ARM64_RENDERER);
  });

  it("keeps public visual-mode scripts portable", async () => {
    const packageJson = JSON.parse(
      await readFile(
        fileURLToPath(new URL("../../package.json", import.meta.url)),
        "utf8",
      ),
    ) as { scripts: Record<string, string> };

    expect(packageJson.scripts["test:visual:structural"]).toBe(
      "node scripts/run-playwright.mjs --revelai-visual-mode structural",
    );
    expect(packageJson.scripts["test:visual:darwin"]).toBe(
      "node scripts/run-playwright.mjs --revelai-visual-mode darwin",
    );
    expect(packageJson.scripts["test:visual:canonical"]).toBe(
      "node scripts/run-playwright.mjs --revelai-visual-mode canonical",
    );
  });

  it("requires one explicit mode and leaves Playwright arguments intact", () => {
    expect(() => parseVisualGateArguments([])).toThrow(
      "Visual gate mode is required",
    );
    expect(() =>
      parseVisualGateArguments(["--revelai-visual-mode", "preview"]),
    ).toThrow("Unsupported visual gate mode");
    expect(
      parseVisualGateArguments([
        "--revelai-visual-mode",
        "canonical",
        "--project",
        "desktop-home",
      ]),
    ).toEqual({
      mode: "canonical",
      rendererIdentity: commandCanonicalRenderer,
      playwrightArgs: ["--project", "desktop-home"],
    });
  });

  it("creates a Windows-safe pnpm invocation without inline environment syntax", () => {
    const command = createPlaywrightCommand({
      platform: "win32",
      mode: "structural",
      rendererIdentity: undefined,
      playwrightArgs: ["--project", "desktop-home"],
      environment: {
        NO_COLOR: "1",
        REVELAI_VISUAL_MODE: "canonical",
        REVELAI_VISUAL_RENDERER: commandCanonicalRenderer,
      },
    });

    expect(command).toEqual({
      command: "pnpm.cmd",
      args: ["exec", "playwright", "test", "--project", "desktop-home"],
      environment: { REVELAI_VISUAL_MODE: "structural" },
    });
  });
});
