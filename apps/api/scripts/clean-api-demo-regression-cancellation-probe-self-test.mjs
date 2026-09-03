import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  access,
  chmod,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  cleanupCompleteMessage,
  createCleanupAcknowledgementGate,
} from "./clean-api-demo-regression-cleanup-protocol.mjs";
import {
  assertArgumentsWithinConservativeLinuxLimit,
  conservativeLinuxArgumentMaxBytes,
  createStreamingTokenSearch,
  processTableContains,
} from "./clean-api-demo-regression-process-audit.mjs";

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
const auditChildReadinessTimeoutMs = 1_000;
const auditChildReadyMarker = "REVELAI_CLEAN_API_AUDIT_CHILD_READY";
const processAuditNoiseBytes = 128 * 1024;
const processAuditNoiseChunkBytes = 16 * 1024;
const processAuditNoiseChunkCount = 9;
const processAuditMarkerEnvironment = "REVELAI_CLEAN_API_AUDIT_PROCESS_MARKER";
const foreignSession = sessionToken();
const foreignFixture = await mkdtemp(
  join(tmpdir(), `${fixtureRoot}${foreignSession}-`),
);
const terminationMarker = join(foreignFixture, "terminated");
const foreignArguments = [
  "-e",
  `process.on("SIGTERM", () => { require("node:fs").writeFileSync(${JSON.stringify(
    terminationMarker,
  )}, "terminated"); }); setInterval(() => {}, 1_000);`,
  "--",
  `--revelai-clean-api-session=${foreignSession}`,
];
assertArgumentsWithinConservativeLinuxLimit(foreignArguments);
const foreign = spawn(process.execPath, foreignArguments, {
  detached: true,
  stdio: "ignore",
});
const foreignClose = observeClose(foreign);

try {
  assertCleanupAcknowledgementProtocol();
  await assertTimeoutScenarioCleansItsFixture();
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

  await assertRealSessionProcessAudit();
  await assertSyntheticProcessAuditFindsLateSession();
  await assertPresenceAuditFailsClosed();
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

async function assertTimeoutScenarioCleansItsFixture() {
  const session = sessionToken();
  const result = await runProbe({
    CLEAN_API_EXECUTABLE_TEST_PROBE_SCENARIO: "timeout",
    CLEAN_API_EXECUTABLE_TEST_SESSION: session,
  });

  if (
    result.kind !== "close" ||
    result.exitCode !== 0 ||
    !result.output.includes("Clean API executable cancellation probe passed.")
  ) {
    throw new Error(failure);
  }
  await assertNoSessionFixtures(session);
  await assertNoSessionProcesses(session);
}

function assertCleanupAcknowledgementProtocol() {
  const expectedPid = 12_345;
  const invocationNonce = "a".repeat(32);
  const terminationNonce = "b".repeat(32);
  const validAcknowledgement = cleanupCompleteMessage({
    pid: expectedPid,
    invocationNonce,
    terminationNonce,
  });
  const slowTimers = manualTimers();
  const slowSignals = [];
  const slowGate = createCleanupAcknowledgementGate({
    expectedPid,
    invocationNonce,
    terminationNonce,
    cleanupDeadlineMs: 10_000,
    closeAfterCleanupMs: 1_000,
    schedule: slowTimers.schedule,
    clear: slowTimers.clear,
    onDeadline: () => slowSignals.push("SIGKILL:cleanup-deadline"),
    onCloseAfterAcknowledgement: () => slowSignals.push("SIGKILL:after-ack"),
  });

  if (slowGate.accept(validAcknowledgement) !== false) throw new Error(failure);
  slowGate.beginTermination();
  if (
    slowGate.accept("REVELAI_EXECUTABLE_CLEANUP_COMPLETE ") !== false ||
    slowGate.accept(Buffer.from(String(expectedPid))) !== false ||
    slowGate.accept({ ...validAcknowledgement, pid: expectedPid + 1 }) !==
      false ||
    slowGate.accept({
      ...validAcknowledgement,
      invocationNonce: "d".repeat(32),
    }) !== false ||
    slowGate.accept({
      ...validAcknowledgement,
      terminationNonce: "c".repeat(32),
    }) !== false ||
    slowGate.accept({ ...validAcknowledgement, extra: "spoof" }) !== false
  ) {
    throw new Error(failure);
  }
  slowTimers.advance(9_999);
  if (
    slowSignals.length !== 0 ||
    slowGate.accept(validAcknowledgement) !== true
  ) {
    throw new Error(failure);
  }
  if (slowGate.accept(validAcknowledgement) !== false) throw new Error(failure);
  slowTimers.advance(999);
  if (slowSignals.length !== 0) throw new Error(failure);
  slowTimers.advance(1);
  if (slowSignals.join(",") !== "SIGKILL:after-ack") throw new Error(failure);

  const deadlineTimers = manualTimers();
  const deadlineSignals = [];
  const deadlineGate = createCleanupAcknowledgementGate({
    expectedPid,
    invocationNonce,
    terminationNonce,
    cleanupDeadlineMs: 10_000,
    closeAfterCleanupMs: 1_000,
    schedule: deadlineTimers.schedule,
    clear: deadlineTimers.clear,
    onDeadline: () => deadlineSignals.push("SIGKILL:cleanup-deadline"),
    onCloseAfterAcknowledgement: () =>
      deadlineSignals.push("SIGKILL:after-ack"),
  });

  deadlineGate.beginTermination();
  if (
    deadlineGate.accept({ ...validAcknowledgement, pid: expectedPid + 1 }) !==
    false
  ) {
    throw new Error(failure);
  }
  deadlineTimers.advance(10_000);
  if (deadlineSignals.join(",") !== "SIGKILL:cleanup-deadline") {
    throw new Error(failure);
  }
}

function manualTimers() {
  let now = 0;
  let nextId = 0;
  const timers = new Map();

  const schedule = (callback, delayMs) => {
    const id = nextId;
    nextId += 1;
    timers.set(id, { callback, at: now + delayMs });
    return id;
  };
  const clear = (id) => timers.delete(id);
  const advance = (durationMs) => {
    const deadline = now + durationMs;
    while (true) {
      const due = [...timers.entries()]
        .filter(([, timer]) => timer.at <= deadline)
        .sort(([, left], [, right]) => left.at - right.at)[0];
      if (due === undefined) break;
      const [id, timer] = due;
      timers.delete(id);
      now = timer.at;
      timer.callback();
    }
    now = deadline;
  };

  return Object.freeze({ advance, clear, schedule });
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

async function assertRealSessionProcessAudit() {
  const session = sessionToken();
  const childArguments = [
    "-e",
    `process.on("SIGTERM", () => {}); process.stdout.write(${JSON.stringify(
      `${auditChildReadyMarker}\n`,
    )}); setInterval(() => {}, 1_000)`,
    "--",
    `--revelai-clean-api-session=${session}`,
  ];
  assertArgumentsWithinConservativeLinuxLimit(childArguments);
  const child = spawn(process.execPath, childArguments, {
    detached: true,
    stdio: ["ignore", "pipe", "ignore"],
  });
  const close = observeClose(child);

  try {
    await waitForChildReadiness(child.stdout, close);
    await assertSessionAuditDetectsLiveSession(session);
  } finally {
    await terminateAndWait(child, close, { requireKill: true });
  }
  await assertNoSessionProcesses(session);
}

async function waitForChildReadiness(stdout, close) {
  if (stdout === null) throw new Error(failure);

  return new Promise((resolve, reject) => {
    let output = "";
    let settled = false;
    const timeout = setTimeout(
      () => settle(() => reject(new Error(failure))),
      auditChildReadinessTimeoutMs,
    );
    const onData = (chunk) => {
      output += Buffer.from(chunk).toString("utf8");
      if (output.includes(auditChildReadyMarker)) settle(resolve);
    };
    const onError = () => settle(() => reject(new Error(failure)));
    const onEnd = () => settle(() => reject(new Error(failure)));
    const settle = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      stdout.off("data", onData);
      stdout.off("error", onError);
      stdout.off("end", onEnd);
      callback();
    };

    stdout.on("data", onData);
    stdout.once("error", onError);
    stdout.once("end", onEnd);
    void close.closed.then(() => settle(() => reject(new Error(failure))));
  });
}

async function assertSyntheticProcessAuditFindsLateSession() {
  const session = sessionToken();
  const marker = `--revelai-clean-api-session=${session}`;
  const executableDirectory = await mkdtemp(
    join(tmpdir(), "revelai-clean-api-process-audit-"),
  );
  const executable = join(executableDirectory, "ps");
  const previousPath = process.env.PATH;
  const previousMarker = process.env[processAuditMarkerEnvironment];

  try {
    await writeFile(executable, syntheticProcessTableScript(), {
      mode: 0o700,
    });
    await chmod(executable, 0o700);
    assertArgumentsWithinConservativeLinuxLimit(["-ww", "-axo", "command="]);
    assertOversizedLinuxArgumentIsRejected();
    if (
      processAuditNoiseChunkBytes * processAuditNoiseChunkCount <=
      processAuditNoiseBytes
    ) {
      throw new Error(failure);
    }
    process.env.PATH = [executableDirectory, previousPath]
      .filter((entry) => entry !== undefined && entry.length > 0)
      .join(delimiter);
    process.env[processAuditMarkerEnvironment] = marker;
    assertChunkBoundarySearch(marker);

    await assertSessionProcessPresent(session);
  } finally {
    restoreEnvironment(processAuditMarkerEnvironment, previousMarker);
    restoreEnvironment("PATH", previousPath);
    await rm(executableDirectory, { recursive: true, force: true });
  }
}

async function assertSessionAuditDetectsLiveSession(session) {
  const deadline = Date.now() + 5_000;
  const marker = `--revelai-clean-api-session=${session}`;
  while (Date.now() < deadline) {
    try {
      if ((await processTableContains(marker)) === true) return;
    } catch {
      throw new Error(failure);
    }
    await wait(25);
  }
  throw new Error(failure);
}

async function assertSessionProcessPresent(session, environment) {
  try {
    if (
      (await processTableContains(
        `--revelai-clean-api-session=${session}`,
        environment,
      )) !== true
    ) {
      throw new Error(failure);
    }
  } catch {
    throw new Error(failure);
  }
}

async function assertPresenceAuditFailsClosed() {
  for (const mode of ["broken", "nonzero", "hang", "overflow"]) {
    const session = sessionToken();
    const stubDirectory = await mkdtemp(
      join(tmpdir(), "revelai-clean-api-process-audit-fault-"),
    );
    const stub = join(stubDirectory, "ps");
    const previousPath = process.env.PATH;
    const environment = {
      ...process.env,
      PATH: [stubDirectory, previousPath]
        .filter((entry) => entry !== undefined && entry.length > 0)
        .join(delimiter),
    };

    try {
      await writeFile(stub, processAuditFaultStub(mode), { mode: 0o700 });
      if (mode !== "broken") await chmod(stub, 0o700);
      let accepted = false;
      try {
        await assertSessionProcessPresent(session, environment);
        accepted = true;
      } catch {
        // Audit infrastructure failures must not prove process presence.
      }
      if (accepted) throw new Error(failure);
    } finally {
      await rm(stubDirectory, { recursive: true, force: true });
    }
  }
}

function processAuditFaultStub(mode) {
  switch (mode) {
    case "broken":
      return "#!/revelai-clean-api-no-such-interpreter\n";
    case "nonzero":
      return "#!/bin/sh\nexit 9\n";
    case "hang":
      return "#!/bin/sh\ntrap '' TERM\nwhile :; do :; done\n";
    case "overflow":
      return `#!/usr/bin/env node
process.stdout.write("x".repeat(513 * 1024));
setInterval(() => {}, 1_000);
`;
    default:
      throw new Error(failure);
  }
}

function syntheticProcessTableScript() {
  return `#!/usr/bin/env node
const marker = process.env.${processAuditMarkerEnvironment};
if (typeof marker !== "string") process.exit(2);
const noise = "x".repeat(${processAuditNoiseChunkBytes});
for (let chunk = 0; chunk < ${processAuditNoiseChunkCount}; chunk += 1) {
  process.stdout.write(noise);
}
const split = Math.max(1, Math.floor(marker.length / 2));
process.stdout.write(marker.slice(0, split));
process.stdout.write(marker.slice(split));
`;
}

function assertOversizedLinuxArgumentIsRejected() {
  let rejected = false;
  try {
    assertArgumentsWithinConservativeLinuxLimit([
      "x".repeat(conservativeLinuxArgumentMaxBytes + 1),
    ]);
  } catch {
    rejected = true;
  }
  if (!rejected) throw new Error(failure);
}

function runProbe(environment) {
  return new Promise((resolve) => {
    let output = "";
    let settled = false;
    let killTimer;
    const childArguments = [probe];
    assertArgumentsWithinConservativeLinuxLimit(childArguments);
    const child = spawn(process.execPath, childArguments, {
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
  try {
    if (await processTableContains(`--revelai-clean-api-session=${session}`)) {
      throw new Error(failure);
    }
  } catch (error) {
    if (error instanceof Error && error.message === failure) throw error;
    throw new Error(failure);
  }
}

function assertChunkBoundarySearch(needle) {
  const search = createStreamingTokenSearch(needle);
  search.push(Buffer.from(needle.slice(0, -1)));
  search.push(Buffer.from(needle.slice(-1)));
  if (!search.found) throw new Error(failure);
}

function restoreEnvironment(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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
