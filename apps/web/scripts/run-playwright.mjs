import { spawn } from "node:child_process";

const forwardedSignals = ["SIGINT", "SIGTERM", "SIGHUP"];

export function sanitizePlaywrightEnvironment(environment) {
  const sanitized = { ...environment };

  // Playwright sets FORCE_COLOR for its web-server and worker descendants.
  // Remove only the conflicting opt-out before that environment is inherited.
  if (sanitized.NO_COLOR) {
    delete sanitized.NO_COLOR;
  }

  return sanitized;
}

export function runPlaywright(args, environment = process.env) {
  const command = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const child = spawn(command, ["exec", "playwright", "test", ...args], {
    env: sanitizePlaywrightEnvironment(environment),
    stdio: "inherit",
  });
  const signalHandlers = new Map(
    forwardedSignals.map((signal) => [signal, () => child.kill(signal)]),
  );

  for (const [signal, handler] of signalHandlers) {
    process.once(signal, handler);
  }

  return new Promise((resolve, reject) => {
    child.once("error", (error) => {
      removeSignalListeners(signalHandlers);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      removeSignalListeners(signalHandlers);

      if (signal) {
        process.kill(process.pid, signal);
        return;
      }

      resolve(code ?? 1);
    });
  });
}

function removeSignalListeners(signalHandlers) {
  for (const [signal, handler] of signalHandlers) {
    process.removeListener(signal, handler);
  }
}

try {
  process.exitCode = await runPlaywright(process.argv.slice(2));
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
