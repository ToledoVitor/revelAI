import { spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createPnpmInvocation } from "./pnpm-invocation.mjs";

const webDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = resolve(
  webDirectory,
  "coverage/production-router-dist",
);

function runPnpm(argumentsList) {
  const invocation = createPnpmInvocation({ argumentsList });
  const child = spawn(invocation.command, invocation.args, {
    cwd: webDirectory,
    env: process.env,
    stdio: "inherit",
  });

  return new Promise((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`Production router build stopped by ${signal}.`));
        return;
      }
      if (code !== 0) {
        reject(new Error(`Production router build exited with ${code}.`));
        return;
      }
      resolvePromise();
    });
  });
}

await rm(outputDirectory, { force: true, recursive: true });
await mkdir(outputDirectory, { recursive: true });
await runPnpm(["--filter", "@revelai/design-system", "run", "build"]);
await runPnpm(["exec", "tsc", "--project", "tsconfig.json"]);
await runPnpm([
  "exec",
  "vite",
  "build",
  "--mode",
  "production",
  "--outDir",
  outputDirectory,
]);
await runPnpm([
  "exec",
  "node",
  "scripts/assert-production-router-artifact.mjs",
]);
