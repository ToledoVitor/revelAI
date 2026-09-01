import { spawn } from "node:child_process";
import { readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

if (process.platform === "win32") {
  throw new Error("Clean API executable cancellation probe requires POSIX.");
}

const wrapper = fileURLToPath(
  new URL("./clean-api-demo-regression-self-test.mjs", import.meta.url),
);
const fixturePrefix = "revelai-clean-api-demo-";
const readinessPrefix = "REVELAI_EXECUTABLE_READY ";
const readinessWaitMs = 45_000;
const scenarioCloseMs = 30_000;
const closeAfterCleanupMs = 5_000;
const resourceSettleMs = 2_000;
const terminationGraceMs = 1_000;
const failure = "Clean API executable cancellation probe failed.";

await runScenario({
  name: "between-mode",
  boundary: "outer:before-mode:--mutation-proof",
  readiness: "outer:before-mode:--mutation-proof",
  signal: "SIGTERM",
});
await runScenario({
  name: "between-case",
  boundary: "inner:between-case:demo",
  readiness: "inner:between-case:demo",
  signal: "SIGTERM",
});
await runScenario({
  name: "timeout",
  readiness: "inner:before-case:demo",
  environment: { CLEAN_API_EXECUTABLE_SELF_TEST_TIMEOUT_MS: "5000" },
});

console.log("Clean API executable cancellation probe passed.");

async function runScenario(options) {
  const fixturesBefore = new Set(await fixtures());
  const child = spawn(process.execPath, [wrapper], {
    detached: true,
    env: {
      ...process.env,
      CLEAN_API_EXECUTABLE_HANDSHAKE: "1",
      ...(options.boundary === undefined
        ? {}
        : { CLEAN_API_EXECUTABLE_BOUNDARY: options.boundary }),
      ...options.environment,
    },
    stdio: ["ignore", "pipe", "ignore"],
  });
  const close = observeClose(child);
  const readiness = observeReadiness(child.stdout);
  const processGroups = new Set([child.pid]);
  const ownedFixtures = new Set();
  let observing = true;
  const collection = collectResources(
    child.pid,
    fixturesBefore,
    processGroups,
    ownedFixtures,
    () => observing,
  );
  let passed = false;

  try {
    const ready = await readiness.waitFor(options.readiness);
    await observeDetachedDescendant(child.pid, ready, processGroups);

    if (options.signal !== undefined) child.kill(options.signal);

    const exitCode = await waitForClose(close, scenarioCloseMs);
    observing = false;
    await collection;
    await captureFixtures(fixturesBefore, ownedFixtures);
    if (
      exitCode === 0 ||
      !(await resourcesAreGone(fixturesBefore, processGroups, ownedFixtures))
    ) {
      throw new Error(failure);
    }
    passed = true;
  } finally {
    observing = false;
    await collection;
    await captureFixtures(fixturesBefore, ownedFixtures);
    if (!passed) {
      try {
        await terminateProcessGroups(processGroups);
        await waitForClose(close, closeAfterCleanupMs);
        await waitForProcessGroupsToClose(processGroups, closeAfterCleanupMs);
        await captureFixtures(fixturesBefore, ownedFixtures);
      } finally {
        await removeOwnedFixtures(ownedFixtures);
      }
    }
  }
}

async function collectResources(
  rootPid,
  fixturesBefore,
  processGroups,
  ownedFixtures,
  isObserving,
) {
  while (isObserving()) {
    for (const processGroup of await descendantProcessGroups(rootPid)) {
      processGroups.add(processGroup);
    }
    await captureFixtures(fixturesBefore, ownedFixtures);
    await delay(50);
  }
}

async function captureFixtures(fixturesBefore, ownedFixtures) {
  for (const fixture of await fixtures()) {
    if (!fixturesBefore.has(fixture)) ownedFixtures.add(fixture);
  }
}

async function resourcesAreGone(fixturesBefore, processGroups, ownedFixtures) {
  const deadline = Date.now() + resourceSettleMs;
  while (Date.now() < deadline) {
    await captureFixtures(fixturesBefore, ownedFixtures);
    const currentFixtures = await fixtures();
    const fixtureRemains = [...ownedFixtures].some((fixture) =>
      currentFixtures.includes(fixture),
    );
    const activeGroupsRemain = [...processGroups].some(isProcessGroupActive);
    if (!fixtureRemains && !activeGroupsRemain) return true;
    await delay(25);
  }
  return false;
}

async function observeDetachedDescendant(rootPid, ready, processGroups) {
  const processes = await processTable();
  const descendants = descendantPids(processes, rootPid);
  const process = processes.find((entry) => entry.pid === ready.pid);
  if (
    process === undefined ||
    !descendants.has(ready.pid) ||
    process.pgid !== ready.pid
  ) {
    throw new Error(failure);
  }
  processGroups.add(process.pgid);
}

function observeReadiness(stdout) {
  let output = "";
  const ready = new Map();
  const waiters = new Map();

  stdout.on("data", (chunk) => {
    output += Buffer.from(chunk).toString("utf8");
    while (true) {
      const newline = output.indexOf("\n");
      if (newline === -1) break;
      const line = output.slice(0, newline);
      output = output.slice(newline + 1);
      const match = new RegExp(
        `^${readinessPrefix}(?<name>[^ ]+) (?<pid>[1-9][0-9]*)$`,
      ).exec(line);
      if (match?.groups === undefined) continue;
      const entry = Object.freeze({
        name: match.groups.name,
        pid: Number(match.groups.pid),
      });
      ready.set(entry.name, entry);
      const waiter = waiters.get(entry.name);
      if (waiter !== undefined) waiter(entry);
    }
  });

  return Object.freeze({
    async waitFor(name) {
      const existing = ready.get(name);
      if (existing !== undefined) return existing;
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          waiters.delete(name);
          reject(new Error(failure));
        }, readinessWaitMs);
        waiters.set(name, (entry) => {
          clearTimeout(timeout);
          waiters.delete(name);
          resolve(entry);
        });
      });
    },
  });
}

function observeClose(child) {
  let resolved = false;
  let resolveClose;
  const closed = new Promise((resolve) => {
    resolveClose = resolve;
  });
  const settle = (result) => {
    if (resolved) return;
    resolved = true;
    resolveClose(result);
  };
  child.once("error", () => settle({ kind: "error" }));
  child.once("close", (exitCode) => settle({ kind: "close", exitCode }));
  return Object.freeze({ closed });
}

async function waitForClose(close, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(failure)), timeoutMs);
    void close.closed.then((result) => {
      clearTimeout(timeout);
      if (result.kind !== "close") {
        reject(new Error(failure));
        return;
      }
      resolve(result.exitCode);
    });
  });
}

async function terminateProcessGroups(processGroups) {
  for (const processGroup of processGroups) {
    sendSignal(processGroup, "SIGTERM");
  }
  await delay(terminationGraceMs);
  for (const processGroup of processGroups) {
    if (isProcessGroupActive(processGroup)) sendSignal(processGroup, "SIGKILL");
  }
}

async function waitForProcessGroupsToClose(processGroups, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (![...processGroups].some(isProcessGroupActive)) return;
    await delay(25);
  }
  throw new Error(failure);
}

function sendSignal(processGroup, signal) {
  try {
    process.kill(-processGroup, signal);
  } catch {
    // An already-exited process group needs no further cleanup.
  }
}

async function removeOwnedFixtures(ownedFixtures) {
  for (const fixture of ownedFixtures) {
    if (!fixture.startsWith(fixturePrefix) || fixture.includes("/")) {
      throw new Error(failure);
    }
    await rm(join(tmpdir(), fixture), { recursive: true, force: true });
  }
}

async function fixtures() {
  return (await readdir(tmpdir())).filter((entry) =>
    entry.startsWith(fixturePrefix),
  );
}

async function descendantProcessGroups(rootPid) {
  const processes = await processTable();
  const descendants = descendantPids(processes, rootPid);
  return [
    ...new Set(
      processes
        .filter((process) => descendants.has(process.pid))
        .map((process) => process.pgid),
    ),
  ];
}

function descendantPids(processes, rootPid) {
  const descendants = new Set([rootPid]);
  let discovered = true;

  while (discovered) {
    discovered = false;
    for (const process of processes) {
      if (descendants.has(process.ppid) && !descendants.has(process.pid)) {
        descendants.add(process.pid);
        discovered = true;
      }
    }
  }

  return descendants;
}

function processTable() {
  return new Promise((resolve, reject) => {
    let output = "";
    const child = spawn("ps", ["-axo", "pid=,ppid=,pgid="], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.once("error", () => reject(new Error(failure)));
    child.once("close", (exitCode) => {
      if (exitCode !== 0) {
        reject(new Error(failure));
        return;
      }
      resolve(
        output
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => line.trim().split(/\s+/).map(Number))
          .filter(
            (entry) => entry.length === 3 && entry.every(Number.isSafeInteger),
          )
          .map(([pid, ppid, pgid]) => ({ pid, ppid, pgid })),
      );
    });
  });
}

function isProcessGroupActive(processGroup) {
  try {
    process.kill(-processGroup, 0);
    return true;
  } catch (error) {
    return !(
      error instanceof Error &&
      "code" in error &&
      error.code === "ESRCH"
    );
  }
}
