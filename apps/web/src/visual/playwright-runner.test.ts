// @vitest-environment node

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const webRoot = fileURLToPath(new URL("../..", import.meta.url));

type RunnerResult = {
  exitCode: number | null;
  output: string;
};

function runPlaywrightRunner(args: readonly string[]): Promise<RunnerResult> {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    CI: "true",
    NO_COLOR: "1",
  };
  delete environment.FORCE_COLOR;

  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["scripts/run-playwright.mjs", ...args],
      {
        cwd: webRoot,
        env: environment,
      },
    );
    let output = "";

    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (exitCode) => resolve({ exitCode, output }));
  });
}

describe("Playwright runner", () => {
  it("removes NO_COLOR before Playwright forces color in descendant processes", async () => {
    const result = await runPlaywrightRunner([
      "src/visual/playwright-runner-smoke.visual.spec.ts",
      "--grep",
      "launches Chromium for runner environment checks",
      "--project",
      "desktop-home",
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("1 passed");
    expect(result.output).not.toContain("NO_COLOR");
  });

  it("propagates a Playwright process failure", async () => {
    const result = await runPlaywrightRunner(["--not-a-playwright-option"]);

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("unknown option");
  });
});
