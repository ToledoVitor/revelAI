import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createPnpmInvocation } from "./pnpm-invocation.mjs";

const webRoot = new URL("..", import.meta.url);
const repositoryRoot = new URL("../..", webRoot);

function runWebCommand(browserCache, commandArguments) {
  const environment = {
    ...process.env,
    CI: "true",
    PLAYWRIGHT_BROWSERS_PATH: browserCache,
  };
  delete environment.NODE_TEST_CONTEXT;
  const invocation = createPnpmInvocation({
    argumentsList: ["--filter", "@revelai/web", ...commandArguments],
    environment,
  });

  return new Promise((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, {
      cwd: repositoryRoot,
      env: environment,
    });
    let output = "";

    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.once("error", reject);
    child.once("close", (exitCode) => resolve({ exitCode, output }));
  });
}

test(
  "provisions an empty browser cache before the Vitest runner starts",
  { timeout: 180_000 },
  async () => {
    const browserCache = await mkdtemp(
      join(tmpdir(), "revelai-web-browser-cache-"),
    );

    try {
      const result = await runWebCommand(browserCache, ["test"]);

      assert.equal(result.exitCode, 0, result.output);
    } finally {
      await rm(browserCache, { recursive: true, force: true });
    }
  },
);

test(
  "provisions an empty browser cache for the direct structural visual command",
  { timeout: 180_000 },
  async () => {
    const browserCache = await mkdtemp(
      join(tmpdir(), "revelai-web-structural-browser-cache-"),
    );

    try {
      const result = await runWebCommand(browserCache, [
        "run",
        "test:visual:structural",
      ]);

      assert.equal(result.exitCode, 0, result.output);
    } finally {
      await rm(browserCache, { recursive: true, force: true });
    }
  },
);
