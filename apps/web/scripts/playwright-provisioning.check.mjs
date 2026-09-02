import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const webRoot = new URL("..", import.meta.url);
const repositoryRoot = new URL("../..", webRoot);

function runWebTest(browserCache) {
  const command = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const environment = {
    ...process.env,
    CI: "true",
    PLAYWRIGHT_BROWSERS_PATH: browserCache,
  };

  return new Promise((resolve, reject) => {
    const child = spawn(command, ["--filter", "@revelai/web", "test"], {
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
      const result = await runWebTest(browserCache);

      assert.equal(result.exitCode, 0, result.output);
    } finally {
      await rm(browserCache, { recursive: true, force: true });
    }
  },
);
