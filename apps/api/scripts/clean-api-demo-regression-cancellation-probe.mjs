import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

if (process.platform === "win32") {
  throw new Error("Clean API executable cancellation probe requires POSIX.");
}

const wrapper = fileURLToPath(
  new URL("./clean-api-demo-regression-self-test.mjs", import.meta.url),
);
const fixturePrefix = "revelai-clean-api-demo-";
const fixtureWaitMs = 30_000;
const postCloseSettleMs = 400;
const resourceSettleMs = 2_000;

await runScenario({ name: "signal" });
await runScenario({
  name: "timeout",
  environment: { CLEAN_API_EXECUTABLE_SELF_TEST_TIMEOUT_MS: "5000" },
});

console.log("Clean API executable cancellation probe passed.");

async function runScenario(options) {
  const fixturesBefore = new Set(await fixtures());
  const child = spawn(process.execPath, [wrapper], {
    detached: true,
    env: { ...process.env, ...options.environment },
    stdio: "ignore",
  });
  const fixture = await waitForFixture(fixturesBefore);
  const processGroups = new Set(await descendantProcessGroups(child.pid));
  let collectingProcessGroups = true;
  const collection = collectProcessGroups(
    child.pid,
    processGroups,
    () => collectingProcessGroups,
  );

  if (options.name === "signal") child.kill("SIGTERM");

  const exitCode = await waitForClose(child);
  collectingProcessGroups = false;
  await collection;
  await delay(postCloseSettleMs);
  if (
    exitCode === 0 ||
    !(await resourcesAreGone(fixture, [...processGroups]))
  ) {
    throw new Error("Clean API executable cancellation probe failed.");
  }
}

async function collectProcessGroups(rootPid, processGroups, isCollecting) {
  while (isCollecting()) {
    for (const processGroup of await descendantProcessGroups(rootPid)) {
      processGroups.add(processGroup);
    }
    await delay(100);
  }
}

async function resourcesAreGone(fixture, processGroups) {
  const deadline = Date.now() + resourceSettleMs;
  while (Date.now() < deadline) {
    const fixtureRemains = (await fixtures()).includes(fixture);
    const activeGroupsRemain = processGroups.some(isProcessGroupActive);
    if (!fixtureRemains && !activeGroupsRemain) return true;
    await delay(25);
  }
  return false;
}

async function waitForFixture(fixturesBefore) {
  const deadline = Date.now() + fixtureWaitMs;
  while (Date.now() < deadline) {
    const created = (await fixtures()).find(
      (fixture) => !fixturesBefore.has(fixture),
    );
    if (created !== undefined) return created;
    await delay(25);
  }

  throw new Error("Clean API executable cancellation probe failed.");
}

async function fixtures() {
  return (await readdir(tmpdir())).filter((entry) =>
    entry.startsWith(fixturePrefix),
  );
}

async function descendantProcessGroups(rootPid) {
  const processes = await processTable();
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

  return [
    ...new Set(
      processes
        .filter((process) => descendants.has(process.pid))
        .map((process) => process.pgid),
    ),
  ];
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
    child.once("error", () =>
      reject(new Error("Clean API executable cancellation probe failed.")),
    );
    child.once("close", (exitCode) => {
      if (exitCode !== 0) {
        reject(new Error("Clean API executable cancellation probe failed."));
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

function waitForClose(child) {
  return new Promise((resolve, reject) => {
    child.once("error", () =>
      reject(new Error("Clean API executable cancellation probe failed.")),
    );
    child.once("close", (exitCode) => resolve(exitCode));
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
