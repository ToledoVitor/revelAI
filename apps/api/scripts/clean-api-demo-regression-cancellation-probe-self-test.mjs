import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform === "win32") {
  throw new Error(
    "Clean API executable cancellation probe self-test requires POSIX.",
  );
}

const probe = fileURLToPath(
  new URL(
    "./clean-api-demo-regression-cancellation-probe.mjs",
    import.meta.url,
  ),
);
const failure = "Clean API executable cancellation probe self-test failed.";
const fixtureRoot = "revelai-clean-api-demo-";
const probeTimeoutMs = 90_000;
const terminationGraceMs = 500;
const closeAfterKillMs = 5_000;
const processAuditNoiseBytes = 128 * 1024;
const foreignSession = sessionToken();
const foreignFixture = await mkdtemp(
  join(tmpdir(), `${fixtureRoot}${foreignSession}-`),
);
const terminationMarker = join(foreignFixture, "terminated");
const foreign = spawn(
  process.execPath,
  [
    "-e",
    `process.on("SIGTERM", () => { require("node:fs").writeFileSync(${JSON.stringify(
      terminationMarker,
    )}, "terminated"); }); setInterval(() => {}, 1_000);`,
    "--",
    `--revelai-clean-api-session=${foreignSession}`,
  ],
  { detached: true, stdio: "ignore" },
);
const foreignClose = observeClose(foreign);

try {
  await assertOrderedCleanupFault({
    scenario: "collector-after-inner-ready",
    marker: "REVELAI_EXECUTABLE_PROBE_READY collector-after-inner-ready",
  });
  await assertOrderedCleanupFault({
    scenario: "uncooperative-close-false",
    marker: "REVELAI_EXECUTABLE_PROBE_CLEANUP_CLOSE_FALSE",
  });

  for (const psMode of ["spawn-error", "nonzero", "hang"]) {
    const session = sessionToken();
    const result = await runProbe({
      CLEAN_API_EXECUTABLE_TEST_PROBE_SCENARIO: "outer-before-main",
      CLEAN_API_EXECUTABLE_TEST_PS_MODE: psMode,
      CLEAN_API_EXECUTABLE_TEST_SESSION: session,
    });

    assertGenericFailure(result);
    if (psMode === "hang") await assertProcessTableKillReceipt(session);
    await assertNoSessionFixtures(session);
    await assertNoSessionProcesses(session);
    assertActive(foreign.pid);
    await assertExists(foreignFixture);
  }

  const staleSession = sessionToken();
  const staleResult = await runProbe({
    CLEAN_API_EXECUTABLE_TEST_PROBE_SCENARIO: "outer-before-main",
    CLEAN_API_EXECUTABLE_TEST_SESSION: staleSession,
    CLEAN_API_EXECUTABLE_TEST_STALE_PGID: String(foreign.pid),
    CLEAN_API_EXECUTABLE_TEST_FAIL_AFTER_READY: "1",
  });

  assertGenericFailure(staleResult);
  await assertNoSessionFixtures(staleSession);
  await assertNoSessionProcesses(staleSession);
  assertActive(foreign.pid);
  await assertExists(foreignFixture);
  await assertMissing(terminationMarker);

  await assertProcessAuditFindsLateSession();
} finally {
  try {
    await terminateAndWait(foreign, foreignClose, { requireKill: true });
    await assertExists(terminationMarker);
  } finally {
    await rm(foreignFixture, { recursive: true, force: true });
  }
}

console.log(
  "Clean API executable cancellation probe fault regressions passed.",
);

async function assertOrderedCleanupFault({ scenario, marker }) {
  const session = sessionToken();
  const result = await runProbe({
    CLEAN_API_EXECUTABLE_TEST_PROBE_SCENARIO: scenario,
    CLEAN_API_EXECUTABLE_TEST_SESSION: session,
  });

  assertGenericFailure(result);
  if (!result.output.includes(marker)) throw new Error(failure);
  await assertNoSessionFixtures(session);
  await assertNoSessionProcesses(session);
  assertActive(foreign.pid);
  await assertExists(foreignFixture);
}

async function assertProcessTableKillReceipt(session) {
  const receipt = join(
    tmpdir(),
    `revelai-clean-api-probe-process-table-${session}`,
  );
  try {
    if (!(await readFile(receipt, "utf8")).includes("term\nkilled-close\n")) {
      throw new Error(failure);
    }
  } finally {
    await rm(receipt, { force: true });
  }
}

async function assertProcessAuditFindsLateSession() {
  const session = sessionToken();
  const child = spawn(
    process.execPath,
    [
      "-e",
      "process.on('SIGTERM', () => {}); setInterval(() => {}, 1_000)",
      "--",
      "x".repeat(processAuditNoiseBytes + 4 * 1024),
      `--revelai-clean-api-session=${session}`,
    ],
    { detached: true, stdio: "ignore" },
  );
  const close = observeClose(child);

  try {
    assertChunkBoundarySearch(`--revelai-clean-api-session=${session}`);
    let rejected = false;
    try {
      await assertNoSessionProcesses(session);
    } catch (error) {
      rejected = error instanceof Error && error.message === failure;
    }
    if (!rejected) throw new Error(failure);
  } finally {
    await terminateAndWait(child, close, { requireKill: true });
  }
}

function runProbe(environment) {
  return new Promise((resolve) => {
    let output = "";
    let settled = false;
    let killTimer;
    const child = spawn(process.execPath, [probe], {
      detached: true,
      env: { ...process.env, ...environment },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timeout = setTimeout(() => {
      terminate(child.pid);
      killTimer = setTimeout(() => kill(child.pid), terminationGraceMs);
    }, probeTimeoutMs);
    const settle = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(killTimer);
      resolve({ ...result, output });
    };
    const append = (chunk) => {
      if (output.length < 32 * 1024) {
        output += Buffer.from(chunk)
          .toString("utf8")
          .slice(0, 32 * 1024 - output.length);
      }
    };

    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.once("error", () => settle({ kind: "error" }));
    child.once("close", (exitCode, signal) =>
      settle({ kind: "close", exitCode, signal }),
    );
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
  child.once("close", (exitCode, signal) =>
    settle({ kind: "close", exitCode, signal }),
  );
  return Object.freeze({ closed });
}

function assertGenericFailure(result) {
  if (
    result.kind !== "close" ||
    result.exitCode === 0 ||
    !result.output.includes("Clean API executable cancellation probe failed.")
  ) {
    throw new Error(failure);
  }
}

async function assertNoSessionFixtures(session) {
  const prefix = `${fixtureRoot}${session}-`;
  const remaining = (await readdir(tmpdir())).filter((entry) =>
    entry.startsWith(prefix),
  );
  if (remaining.length !== 0) throw new Error(failure);
}

async function assertNoSessionProcesses(session) {
  if (await processTableContains(`--revelai-clean-api-session=${session}`)) {
    throw new Error(failure);
  }
}

function processTableContains(needle) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let killTimer;
    const search = createStreamingTokenSearch(needle);
    const child = spawn("ps", ["-ww", "-axo", "command="], {
      detached: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const close = observeClose(child);
    const timeout = setTimeout(() => {
      terminate(child.pid);
      killTimer = setTimeout(() => kill(child.pid), terminationGraceMs);
    }, 5_000);
    const settle = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(killTimer);
      callback();
    };
    child.stdout.on("data", (chunk) => {
      search.push(chunk);
    });
    child.once("error", () => settle(() => reject(new Error(failure))));
    child.once("close", (exitCode) => {
      if (exitCode !== 0) {
        settle(() => reject(new Error(failure)));
        return;
      }
      settle(() => resolve(search.found));
    });

    void close.closed.catch(() => undefined);
  });
}

function createStreamingTokenSearch(needle) {
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

function assertChunkBoundarySearch(needle) {
  const search = createStreamingTokenSearch(needle);
  search.push(Buffer.from(needle.slice(0, -1)));
  search.push(Buffer.from(needle.slice(-1)));
  if (!search.found) throw new Error(failure);
}

async function terminateAndWait(child, close, { requireKill }) {
  terminate(child.pid);
  let result = await closeWithin(close, terminationGraceMs);
  if (result === undefined) {
    kill(child.pid);
    result = await closeWithin(close, closeAfterKillMs);
    if (result === undefined || result.signal !== "SIGKILL") {
      throw new Error(failure);
    }
  }
  if (result.kind !== "close" || (requireKill && result.signal !== "SIGKILL")) {
    throw new Error(failure);
  }
}

async function closeWithin(close, timeoutMs) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(undefined), timeoutMs);
    void close.closed.then((result) => {
      clearTimeout(timeout);
      resolve(result);
    });
  });
}

function assertActive(pid) {
  try {
    process.kill(pid, 0);
  } catch {
    throw new Error(failure);
  }
}

async function assertExists(path) {
  try {
    await access(path);
  } catch {
    throw new Error(failure);
  }
}

async function assertMissing(path) {
  try {
    await access(path);
  } catch {
    return;
  }
  throw new Error(failure);
}

function terminate(pid) {
  if (pid === undefined) return;
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    // Process already exited or process group unavailable.
  }
}

function kill(pid) {
  if (pid === undefined) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // Process already exited or process group unavailable.
  }
}

function sessionToken() {
  return randomUUID().replaceAll("-", "");
}
