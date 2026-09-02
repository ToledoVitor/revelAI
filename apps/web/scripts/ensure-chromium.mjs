import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const forwardedSignals = ["SIGINT", "SIGTERM", "SIGHUP"];

export async function ensureChromium() {
  const executablePath = chromium.executablePath();

  try {
    await access(executablePath);
    return 0;
  } catch {
    console.log(`Chromium is missing at ${executablePath}; installing it now.`);
    return installChromium();
  }
}

export function installChromium({
  processRef = process,
  spawnChild = spawn,
} = {}) {
  const command = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const child = spawnChild(
    command,
    ["exec", "playwright", "install", "chromium"],
    {
      stdio: "inherit",
    },
  );
  const signalHandlers = new Map(
    forwardedSignals.map((signal) => [signal, () => child.kill(signal)]),
  );

  for (const [signal, handler] of signalHandlers) {
    processRef.once(signal, handler);
  }

  return new Promise((resolve, reject) => {
    child.once("error", (error) => {
      removeSignalListeners(processRef, signalHandlers);
      reject(error);
    });
    child.once("exit", (exitCode, signal) => {
      removeSignalListeners(processRef, signalHandlers);

      if (signal) {
        processRef.kill(processRef.pid, signal);
        return;
      }

      resolve(exitCode ?? 1);
    });
  });
}

function removeSignalListeners(processRef, signalHandlers) {
  for (const [signal, handler] of signalHandlers) {
    processRef.removeListener(signal, handler);
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    process.exitCode = await ensureChromium();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
