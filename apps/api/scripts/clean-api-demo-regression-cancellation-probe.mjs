import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
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
const fixtureRoot = "revelai-clean-api-demo-";
const readinessPrefix = "REVELAI_EXECUTABLE_READY ";
const sessionArgumentPrefix = "--revelai-clean-api-session=";
const readinessWaitMs = 45_000;
const scenarioCloseMs = 30_000;
const closeAfterCleanupMs = 5_000;
const resourceSettleMs = 2_000;
const terminationGraceMs = 1_000;
const processTableTimeoutMs = 750;
const processTableTerminationGraceMs = 100;
const processTableMaxOutputBytes = 512 * 1024;
const failure = "Clean API executable cancellation probe failed.";
const session = configuredSession(
  process.env.CLEAN_API_EXECUTABLE_TEST_SESSION,
);
const sessionFixturePrefix = `${fixtureRoot}${session}-`;
const psMode = configuredPsMode(process.env.CLEAN_API_EXECUTABLE_TEST_PS_MODE);
const probeScenario = configuredProbeScenario(
  process.env.CLEAN_API_EXECUTABLE_TEST_PROBE_SCENARIO,
);
const staleProcessGroup = configuredProcessGroup(
  process.env.CLEAN_API_EXECUTABLE_TEST_STALE_PGID,
);
const failAfterReady =
  process.env.CLEAN_API_EXECUTABLE_TEST_FAIL_AFTER_READY === "1";

for (const scenario of scenariosFor(probeScenario)) {
  await runScenario(scenario);
}

console.log("Clean API executable cancellation probe passed.");

function scenariosFor(value) {
  if (value === "outer-before-main") {
    return [
      {
        name: "outer-before-main",
        boundary: "outer:before-main",
        readiness: "outer:before-main",
      },
    ];
  }

  return [
    {
      name: "between-mode",
      boundary: "outer:before-mode:--mutation-proof",
      readiness: "outer:before-mode:--mutation-proof",
      signal: "SIGTERM",
    },
    {
      name: "between-case",
      boundary: "inner:between-case:demo",
      readiness: "inner:between-case:demo",
      signal: "SIGTERM",
    },
    {
      name: "timeout",
      readiness: "inner:before-case:demo",
      environment: { CLEAN_API_EXECUTABLE_SELF_TEST_TIMEOUT_MS: "5000" },
    },
  ];
}

async function runScenario(options) {
  const child = spawn(process.execPath, [wrapper, sessionArgument(session)], {
    detached: true,
    env: {
      ...process.env,
      CLEAN_API_EXECUTABLE_HANDSHAKE: "1",
      CLEAN_API_EXECUTABLE_SESSION: session,
      ...(options.boundary === undefined
        ? {}
        : { CLEAN_API_EXECUTABLE_BOUNDARY: options.boundary }),
      ...options.environment,
    },
    stdio: ["ignore", "pipe", "ignore"],
  });
  const close = observeClose(child);
  const readiness = observeReadiness(child.stdout);
  const processGroups = new Set(
    typeof child.pid === "number" ? [child.pid] : [],
  );
  const ownedFixtures = new Set();
  let observing = true;
  const collection = captureOutcome(
    typeof child.pid === "number"
      ? collectResources(
          child.pid,
          processGroups,
          ownedFixtures,
          () => observing,
        )
      : Promise.reject(new Error(failure)),
  );
  let passed = false;

  try {
    if (typeof child.pid !== "number") throw new Error(failure);
    const ready = await readiness.waitFor(options.readiness);
    await observeDetachedDescendant(child.pid, ready, processGroups);
    if (failAfterReady) throw new Error(failure);

    if (options.signal !== undefined) child.kill(options.signal);

    const exitCode = await waitForClose(close, scenarioCloseMs);
    observing = false;
    const collectionOutcome = await collection;
    if (collectionOutcome.status !== "fulfilled") throw new Error(failure);
    await captureFixtures(ownedFixtures);
    if (
      exitCode === 0 ||
      !(await resourcesAreGone(processGroups, ownedFixtures))
    ) {
      throw new Error(failure);
    }
    passed = true;
  } finally {
    observing = false;
    if (!passed) {
      await cleanupScenario({
        child,
        close,
        collection,
        processGroups,
        ownedFixtures,
      });
      throw new Error(failure);
    }
  }
}

async function cleanupScenario({
  child,
  close,
  collection,
  processGroups,
  ownedFixtures,
}) {
  await allSettled([
    () => collection,
    () => terminateProcessGroups(processGroups, "SIGTERM"),
    () => signalChild(child, "SIGTERM"),
  ]);

  let closed = await settlesWithin(close, terminationGraceMs);
  if (!closed) {
    await allSettled([
      () => terminateProcessGroups(processGroups, "SIGKILL"),
      () => signalChild(child, "SIGKILL"),
    ]);
    closed = await settlesWithin(close, closeAfterCleanupMs);
  }

  await allSettled([
    () => {
      if (!closed) throw new Error(failure);
    },
    () => waitForProcessGroupsToClose(processGroups, closeAfterCleanupMs),
    () => captureFixtures(ownedFixtures),
    () => removeOwnedFixtures(ownedFixtures),
  ]);
}

function captureOutcome(operation) {
  return Promise.resolve(operation).then(
    () => Object.freeze({ status: "fulfilled" }),
    () => Object.freeze({ status: "rejected" }),
  );
}

async function allSettled(steps) {
  await Promise.allSettled(steps.map((step) => step()));
}

async function collectResources(
  rootPid,
  processGroups,
  ownedFixtures,
  isObserving,
) {
  while (isObserving()) {
    for (const processGroup of await descendantProcessGroups(rootPid)) {
      processGroups.add(processGroup);
    }
    await captureFixtures(ownedFixtures);
    await delay(50);
  }
}

async function captureFixtures(ownedFixtures) {
  for (const fixture of await fixtures()) ownedFixtures.add(fixture);
}

async function resourcesAreGone(processGroups, ownedFixtures) {
  const deadline = Date.now() + resourceSettleMs;
  while (Date.now() < deadline) {
    await captureFixtures(ownedFixtures);
    const currentFixtures = await fixtures();
    const fixtureRemains = [...ownedFixtures].some((fixture) =>
      currentFixtures.includes(fixture),
    );
    const activeGroupsRemain =
      (await ownedProcessGroups(processGroups)).size > 0;
    if (!fixtureRemains && !activeGroupsRemain) return true;
    await delay(25);
  }
  return false;
}

async function observeDetachedDescendant(rootPid, ready, processGroups) {
  const processes = await processTable();
  const descendants = descendantPids(processes, new Set([rootPid]));
  const process = processes.find((entry) => entry.pid === ready.pid);
  if (
    process === undefined ||
    !descendants.has(ready.pid) ||
    process.pgid !== ready.pid ||
    !hasSessionIdentity(process)
  ) {
    throw new Error(failure);
  }
  processGroups.add(process.pgid);
  if (staleProcessGroup !== undefined) processGroups.add(staleProcessGroup);
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

async function settlesWithin(close, timeoutMs) {
  try {
    await waitForClose(close, timeoutMs);
    return true;
  } catch {
    return false;
  }
}

async function terminateProcessGroups(processGroups, signal) {
  for (const processGroup of await ownedProcessGroups(processGroups)) {
    signalProcessGroup(processGroup, signal);
  }
}

function signalChild(child, signal) {
  if (child.pid === undefined) return;
  try {
    child.kill(signal);
  } catch {
    // A recently spawned child that already exited needs no further cleanup.
  }
}

async function waitForProcessGroupsToClose(processGroups, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await ownedProcessGroups(processGroups)).size === 0) return;
    await delay(25);
  }
  throw new Error(failure);
}

function signalProcessGroup(processGroup, signal) {
  try {
    process.kill(-processGroup, signal);
  } catch {
    // An already-exited process group needs no further cleanup.
  }
}

async function removeOwnedFixtures(ownedFixtures) {
  for (const fixture of ownedFixtures) {
    if (!fixture.startsWith(sessionFixturePrefix) || fixture.includes("/")) {
      throw new Error(failure);
    }
    await rm(join(tmpdir(), fixture), { recursive: true, force: true });
  }
}

async function fixtures() {
  return (await readdir(tmpdir())).filter((entry) =>
    entry.startsWith(sessionFixturePrefix),
  );
}

async function descendantProcessGroups(rootPid) {
  const processes = await processTable();
  const descendants = descendantPids(processes, new Set([rootPid]));
  return new Set(
    processes
      .filter((process) => descendants.has(process.pid))
      .map((process) => process.pgid),
  );
}

async function ownedProcessGroups(candidates) {
  const processes = await processTable();
  const sessionRoots = new Set(
    processes.filter(hasSessionIdentity).map((process) => process.pid),
  );
  const sessionDescendants = descendantPids(processes, sessionRoots);
  return new Set(
    processes
      .filter(
        (process) =>
          candidates.has(process.pgid) && sessionDescendants.has(process.pid),
      )
      .map((process) => process.pgid),
  );
}

function descendantPids(processes, roots) {
  const descendants = new Set(roots);
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

function hasSessionIdentity(process) {
  return process.command.includes(sessionArgument(session));
}

async function processTable() {
  const output = await runBoundedProcessTable();
  return output
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(\d+)\s*(.*)$/.exec(line))
    .filter((match) => match !== null)
    .map((match) => ({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      pgid: Number(match[3]),
      command: match[4],
    }))
    .filter(
      (entry) =>
        Number.isSafeInteger(entry.pid) &&
        Number.isSafeInteger(entry.ppid) &&
        Number.isSafeInteger(entry.pgid),
    );
}

function runBoundedProcessTable() {
  return new Promise((resolve, reject) => {
    const command = processTableCommand();
    let output = Buffer.alloc(0);
    let capturedOutputBytes = 0;
    let settled = false;
    let timedOut = false;
    let outputExceeded = false;
    let timeout;
    let killTimer;
    let child;

    const settle = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(killTimer);
      callback();
    };
    const terminate = () => {
      if (child?.pid === undefined || killTimer !== undefined) return;
      signalProcessGroup(child.pid, "SIGTERM");
      killTimer = setTimeout(() => {
        if (!settled && child?.pid !== undefined) {
          signalProcessGroup(child.pid, "SIGKILL");
        }
      }, processTableTerminationGraceMs);
    };
    const append = (chunk, store) => {
      const bytes = Buffer.byteLength(chunk);
      const remaining = processTableMaxOutputBytes - capturedOutputBytes;
      capturedOutputBytes += Math.min(bytes, Math.max(remaining, 0));
      if (store && remaining > 0) {
        output = Buffer.concat([
          output,
          Buffer.from(chunk).subarray(0, Math.min(bytes, remaining)),
        ]);
      }
      if (bytes > remaining) {
        outputExceeded = true;
        terminate();
      }
    };

    try {
      child = spawn(command.executable, command.arguments, {
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      settle(() => reject(new Error(failure)));
      return;
    }

    child.stdout.on("data", (chunk) => append(chunk, true));
    child.stderr.on("data", (chunk) => append(chunk, false));
    child.once("error", () => settle(() => reject(new Error(failure))));
    child.once("close", (exitCode) => {
      if (exitCode === 0 && !timedOut && !outputExceeded) {
        settle(() => resolve(output.toString("utf8")));
      } else {
        settle(() => reject(new Error(failure)));
      }
    });
    timeout = setTimeout(() => {
      timedOut = true;
      terminate();
    }, processTableTimeoutMs);
  });
}

function processTableCommand() {
  switch (psMode) {
    case "spawn-error":
      return Object.freeze({
        executable: "/revelai-clean-api-executable-does-not-exist",
        arguments: [],
      });
    case "nonzero":
      return Object.freeze({
        executable: process.execPath,
        arguments: ["-e", "process.exit(1)"],
      });
    case "hang":
      return Object.freeze({
        executable: process.execPath,
        arguments: ["-e", "setInterval(() => {}, 1_000)"],
      });
    default:
      return Object.freeze({
        executable: "ps",
        arguments: ["-axo", "pid=,ppid=,pgid=,command="],
      });
  }
}

function configuredSession(value) {
  if (value === undefined) return randomUUID().replaceAll("-", "");
  if (!/^[a-f0-9]{32}$/.test(value)) throw new Error(failure);
  return value;
}

function configuredPsMode(value) {
  if (value === undefined) return undefined;
  if (!["spawn-error", "nonzero", "hang"].includes(value)) {
    throw new Error(failure);
  }
  return value;
}

function configuredProbeScenario(value) {
  if (value === undefined) return undefined;
  if (value !== "outer-before-main") throw new Error(failure);
  return value;
}

function configuredProcessGroup(value) {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(failure);
  return parsed;
}

function sessionArgument(value) {
  return `${sessionArgumentPrefix}${value}`;
}
