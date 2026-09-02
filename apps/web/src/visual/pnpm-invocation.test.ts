// @vitest-environment node

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createPnpmInvocation } from "../../scripts/pnpm-invocation.mjs";

const fixturePath = fileURLToPath(
  new URL("../../scripts/test-fixtures/pnpm-entry.mjs", import.meta.url),
);

function runInvocation({
  command,
  args,
}: {
  command: string;
  args: readonly string[];
}) {
  return new Promise<{ exitCode: number | null; output: string }>(
    (resolve, reject) => {
      const child = spawn(command, args);
      let output = "";

      child.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString();
      });
      child.once("error", reject);
      child.once("close", (exitCode) => resolve({ exitCode, output }));
    },
  );
}

describe("pnpm invocation", () => {
  it("uses Node to run the active pnpm entry on a simulated Windows runtime", async () => {
    const invocation = createPnpmInvocation({
      argumentsList: [
        "exec",
        "playwright",
        "test",
        "--project",
        "desktop-home",
      ],
      environment: { npm_execpath: fixturePath },
      runtime: { execPath: process.execPath, platform: "win32" },
    });

    expect(invocation.command).toBe(process.execPath);
    expect(invocation.args).toEqual([
      fixturePath,
      "exec",
      "playwright",
      "test",
      "--project",
      "desktop-home",
    ]);

    const result = await runInvocation(invocation);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.output)).toEqual([
      "exec",
      "playwright",
      "test",
      "--project",
      "desktop-home",
    ]);
  });

  it("preserves the active entry's exit code", async () => {
    const invocation = createPnpmInvocation({
      argumentsList: ["--fail"],
      environment: { npm_execpath: fixturePath },
      runtime: { execPath: process.execPath, platform: "win32" },
    });

    expect((await runInvocation(invocation)).exitCode).toBe(17);
  });

  it("requires a real lifecycle pnpm entry", () => {
    expect(() =>
      createPnpmInvocation({
        argumentsList: ["--version"],
        environment: {},
        runtime: { execPath: process.execPath, platform: "win32" },
      }),
    ).toThrow("npm_execpath");
  });
});
