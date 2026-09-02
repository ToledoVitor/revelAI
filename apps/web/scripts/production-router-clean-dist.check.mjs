import assert from "node:assert/strict";
import { access, lstat, rename, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createPnpmInvocation } from "./pnpm-invocation.mjs";

const webDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dependencyOutputs = [
  resolve(webDirectory, "../../packages/contracts/dist"),
  resolve(webDirectory, "../../packages/design-system/dist"),
];

function runProductionRouterCheck() {
  const invocation = createPnpmInvocation({
    argumentsList: ["run", "test:production-router"],
  });
  const child = spawn(invocation.command, invocation.args, {
    cwd: webDirectory,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });

  return new Promise((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`Production router check stopped by ${signal}.`));
        return;
      }
      resolvePromise({ code, output });
    });
  });
}

async function stageDependencyOutputs() {
  const staged = [];

  for (const source of dependencyOutputs) {
    const backup = `${source}.production-router-clean-dist`;
    await rm(backup, { force: true, recursive: true });
    try {
      await lstat(source);
      await rename(source, backup);
      staged.push({ backup, source, wasPresent: true });
    } catch (error) {
      if (error && typeof error === "object" && error.code === "ENOENT") {
        staged.push({ backup, source, wasPresent: false });
        continue;
      }
      throw error;
    }
  }

  return staged;
}

async function restoreDependencyOutputs(staged) {
  for (const { backup, source, wasPresent } of staged.toReversed()) {
    await rm(source, { force: true, recursive: true });
    if (wasPresent) {
      await rename(backup, source);
    } else {
      await rm(backup, { force: true, recursive: true });
    }
  }
}

test(
  "builds the production router from clean web dependency outputs and restores them",
  { timeout: 180_000 },
  async () => {
    const staged = await stageDependencyOutputs();

    try {
      const result = await runProductionRouterCheck();
      assert.equal(result.code, 0, result.output);
      for (const output of dependencyOutputs) {
        await access(output);
      }
    } finally {
      await restoreDependencyOutputs(staged);
    }
  },
);
