import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import {
  createPlaywrightCommand,
  parseVisualGateArguments,
} from "./playwright-command.mjs";

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

export function runPlaywright(
  args,
  environment = process.env,
  runtime = process,
) {
  const { mode, rendererIdentity, playwrightArgs } =
    parseVisualGateArguments(args);
  const command = createPlaywrightCommand({
    platform: runtime.platform,
    mode,
    rendererIdentity,
    playwrightArgs,
    environment: sanitizePlaywrightEnvironment(environment),
  });
  const child = spawn(command.command, command.args, {
    env: command.environment,
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

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    process.exitCode = await runPlaywright(process.argv.slice(2));
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
