import { spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPnpmInvocation } from "./pnpm-invocation.mjs";

const forwardedSignals = ["SIGINT", "SIGTERM", "SIGHUP"];
const webDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = resolve(
  webDirectory,
  "coverage/production-router-dist",
);

export function runPnpm(
  argumentsList,
  {
    environment = process.env,
    processRef = process,
    spawnChild = spawn,
    workingDirectory = webDirectory,
  } = {},
) {
  let invocation;
  let child;

  try {
    invocation = createPnpmInvocation({
      argumentsList,
      environment,
      runtime: processRef,
    });
    child = spawnChild(invocation.command, invocation.args, {
      cwd: workingDirectory,
      env: environment,
      stdio: "inherit",
    });
  } catch (error) {
    return Promise.reject(error);
  }

  const signalHandlers = new Map(
    forwardedSignals.map((signal) => [signal, () => child.kill(signal)]),
  );
  const removeSignalListeners = () => {
    for (const [signal, handler] of signalHandlers) {
      processRef.removeListener(signal, handler);
    }
  };

  for (const [signal, handler] of signalHandlers) {
    processRef.once(signal, handler);
  }

  return new Promise((resolvePromise, reject) => {
    let settled = false;
    const settle = (complete, value) => {
      if (settled) return;
      settled = true;
      removeSignalListeners();
      complete(value);
    };

    child.once("error", (error) => settle(reject, error));
    child.once("exit", (code, signal) => {
      if (signal) {
        settle(
          reject,
          new Error(`Production router build stopped by ${signal}.`),
        );
        return;
      }
      if (code !== 0) {
        settle(
          reject,
          new Error(`Production router build exited with ${code}.`),
        );
        return;
      }
      settle(resolvePromise);
    });
  });
}

export async function buildProductionRouterArtifact({
  createDirectory = mkdir,
  removeDirectory = rm,
  runCommand = runPnpm,
} = {}) {
  await removeDirectory(outputDirectory, { force: true, recursive: true });
  await createDirectory(outputDirectory, { recursive: true });
  await runCommand([
    "--filter",
    "@revelai/web...",
    "--filter",
    "!@revelai/web",
    "run",
    "build",
  ]);
  await runCommand(["exec", "tsc", "--project", "tsconfig.json"]);
  await runCommand([
    "exec",
    "vite",
    "build",
    "--mode",
    "production",
    "--outDir",
    outputDirectory,
  ]);
  await runCommand([
    "exec",
    "node",
    "scripts/assert-production-router-artifact.mjs",
  ]);
}
