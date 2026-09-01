import { spawn } from "node:child_process";

export const conservativeLinuxArgumentMaxBytes = 64 * 1024;

const processTableArguments = Object.freeze(["-ww", "-axo", "command="]);
const processTableTimeoutMs = 5_000;
const terminationGraceMs = 500;
const processTableMaxOutputBytes = 512 * 1024;

export function assertArgumentsWithinConservativeLinuxLimit(argumentsList) {
  for (const argument of argumentsList) {
    if (
      typeof argument !== "string" ||
      Buffer.byteLength(argument) > conservativeLinuxArgumentMaxBytes
    ) {
      throw new Error("Unsafe process argument for portable CI audit.");
    }
  }
}

export function createStreamingTokenSearch(needle) {
  let found = false;
  let overlap = "";
  return Object.freeze({
    get found() {
      return found;
    },
    push(chunk) {
      if (found) return;
      const text = overlap + Buffer.from(chunk).toString("utf8");
      found = text.includes(needle);
      overlap = text.slice(-(needle.length - 1));
    },
  });
}

export function processTableContains(needle, environment = process.env) {
  assertArgumentsWithinConservativeLinuxLimit(processTableArguments);
  if (typeof needle !== "string" || needle.length === 0) {
    return Promise.reject(new Error("Unsafe process audit token."));
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    let outputExceeded = false;
    let capturedOutputBytes = 0;
    let terminationTimer;
    let hardDeadline;
    let child;
    const search = createStreamingTokenSearch(needle);

    const settle = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(terminationTimer);
      clearTimeout(hardDeadline);
      callback();
    };
    const terminate = () => {
      if (child?.pid === undefined || terminationTimer !== undefined) return;
      signalProcessGroup(child.pid, "SIGTERM");
      terminationTimer = setTimeout(() => {
        if (!settled && child?.pid !== undefined) {
          signalProcessGroup(child.pid, "SIGKILL");
        }
      }, terminationGraceMs);
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      terminate();
    }, processTableTimeoutMs);

    try {
      child = spawn("ps", processTableArguments, {
        detached: true,
        env: environment,
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      settle(() => reject(new Error("Process-table audit failed.")));
      return;
    }

    hardDeadline = setTimeout(() => {
      timedOut = true;
      terminate();
      if (child?.pid !== undefined) signalProcessGroup(child.pid, "SIGKILL");
      settle(() => reject(new Error("Process-table audit failed.")));
    }, processTableTimeoutMs + terminationGraceMs + 500);

    child.stdout.on("data", (chunk) => {
      const bytes = Buffer.byteLength(chunk);
      if (bytes > processTableMaxOutputBytes - capturedOutputBytes) {
        outputExceeded = true;
        terminate();
        return;
      }
      capturedOutputBytes += bytes;
      search.push(chunk);
    });
    child.once("error", () =>
      settle(() => reject(new Error("Process-table audit failed."))),
    );
    child.once("close", (exitCode) => {
      if (exitCode !== 0 || timedOut || outputExceeded) {
        settle(() => reject(new Error("Process-table audit failed.")));
        return;
      }
      settle(() => resolve(search.found));
    });
  });
}

function signalProcessGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch {
    // A process that has already exited has no remaining audit work.
  }
}
