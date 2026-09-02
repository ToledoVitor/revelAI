import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { chromium } from "@playwright/test";

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

function installChromium() {
  const command = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

  return new Promise((resolve, reject) => {
    const child = spawn(
      command,
      ["exec", "playwright", "install", "chromium"],
      {
        stdio: "inherit",
      },
    );

    child.once("error", reject);
    child.once("close", (exitCode) => resolve(exitCode ?? 1));
  });
}

try {
  process.exitCode = await ensureChromium();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
