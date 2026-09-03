import { fork, spawn } from "node:child_process";
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
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  cleanupAcknowledgementRequest,
  cleanupCompleteType,
  cleanupCompleteMessage,
  cleanupRequestRetainedType,
  createCleanupAcknowledgementGate,
} from "./clean-api-demo-regression-cleanup-protocol.mjs";
import {
  assertArgumentsWithinConservativeLinuxLimit,
  conservativeLinuxArgumentMaxBytes,
  createStreamingTokenSearch,
  processTableContains,
} from "./clean-api-demo-regression-process-audit.mjs";
import {
  cleanApiModeTimeoutMs,
  createReadinessObserver,
  readinessPlanFor,
  waitForReadiness,
} from "./clean-api-demo-regression-readiness.mjs";

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
const regression = fileURLToPath(
  new URL("./clean-api-demo-regression.mjs", import.meta.url),
);
const failure = "Clean API executable cancellation probe self-test failed.";
const fixtureRoot = "revelai-clean-api-demo-";
const probeTimeoutMs = 90_000;
const terminationGraceMs = 500;
const closeAfterKillMs = 5_000;
const cleanupAcknowledgementTimeoutMs = 2_000;
const cleanupBoundary = "inner:after-fixture:demo";
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
  await assertRealChildAcknowledgesAcrossDeliveryOrders();
  await assertReadinessPlanBoundsAndClose();
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
    !result.output.includes(
      "Clean API executable cancellation probe passed.",
    ) ||
    !result.output.includes("REVELAI_EXECUTABLE_PROBE_READY timeout")
  ) {
    throw new Error(failure);
  }
  await assertNoSessionFixtures(session);
  await assertNoSessionProcesses(session);
}

async function assertRealChildAcknowledgesAcrossDeliveryOrders() {
  await assertRealChildAcknowledgesCleanup({
    requestBeforeSignal: true,
  });
  await assertRealChildAcknowledgesCleanup({
    requestBeforeSignal: false,
  });
}

async function assertReadinessPlanBoundsAndClose() {
  const plan = readinessPlanFor({
    name: "between-case",
    readiness: "inner:between-case:demo",
  });
  if (
    plan.progress !== "inner:before-case:demo" ||
    plan.targetTimeoutMs !== cleanApiModeTimeoutMs
  ) {
    throw new Error(failure);
  }

  const withinBound = readinessFixture();
  const resolvesWithinBound = waitForReadiness(withinBound.observer, plan);
  withinBound.stdout.write(
    "REVELAI_EXECUTABLE_READY inner:before-case:demo 12345\n",
  );
  await Promise.resolve();
  withinBound.timers.advance(cleanApiModeTimeoutMs - 1);
  withinBound.stdout.write(
    "REVELAI_EXECUTABLE_READY inner:between-case:demo 12345\n",
  );
  const ready = await resolvesWithinBound;
  if (ready.name !== "inner:between-case:demo" || ready.pid !== 12_345) {
    throw new Error(failure);
  }

  const expiresAtBound = readinessFixture();
  const rejectsAtBound = waitForReadiness(expiresAtBound.observer, plan);
  expiresAtBound.stdout.write(
    "REVELAI_EXECUTABLE_READY inner:before-case:demo 12345\n",
  );
  await Promise.resolve();
  expiresAtBound.timers.advance(cleanApiModeTimeoutMs);
  await assertRejects(rejectsAtBound);
  assertReadinessError(expiresAtBound, "timeout", plan.target);

  const closesEarly = readinessFixture();
  const rejectsOnClose = waitForReadiness(closesEarly.observer, plan);
  closesEarly.stdout.write(
    "REVELAI_EXECUTABLE_READY inner:before-case:demo 12345\n",
  );
  await Promise.resolve();
  closesEarly.close.resolve({ kind: "close", exitCode: 1 });
  await assertRejects(rejectsOnClose);
  assertReadinessError(closesEarly, "child-close", plan.target);
}

function readinessFixture() {
  const stdout = new PassThrough();
  const close = deferred();
  const timers = manualTimers();
  const errors = [];
  const observer = createReadinessObserver({
    stdout,
    close: Object.freeze({ closed: close.promise }),
    createError: (details) => {
      errors.push(details);
      return new Error(failure);
    },
    schedule: timers.schedule,
    clear: timers.clear,
  });
  return Object.freeze({ close, errors, observer, stdout, timers });
}

function assertReadinessError(fixture, kind, name) {
  const error = fixture.errors.at(-1);
  if (error?.kind !== kind || error.name !== name) throw new Error(failure);
}

async function assertRejects(promise) {
  let rejected = false;
  try {
    await promise;
  } catch {
    rejected = true;
  }
  if (!rejected) throw new Error(failure);
}

async function assertRealChildAcknowledgesCleanup({ requestBeforeSignal }) {
  const session = sessionToken();
  const invocationNonce = sessionToken();
  const terminationNonce = sessionToken();
  const child = fork(
    regression,
    ["--mutation-proof", sessionArgument(session)],
    {
      detached: true,
      env: {
        ...process.env,
        CLEAN_API_EXECUTABLE_BOUNDARY: cleanupBoundary,
        CLEAN_API_EXECUTABLE_CLEANUP_NONCE: invocationNonce,
        CLEAN_API_EXECUTABLE_HANDSHAKE: "1",
        CLEAN_API_EXECUTABLE_TEST_REQUEST_RETAINED_RECEIPT: "1",
      },
      silent: true,
    },
  );
  const close = observeClose(child);
  const messages = [];
  child.on("message", (message) => {
    messages.push({ message, observedAt: Date.now() });
  });

  try {
    if (child.pid === undefined || child.stdout === null) {
      throw new Error(failure);
    }
    await waitForStreamMarker(
      child.stdout,
      close,
      `REVELAI_EXECUTABLE_READY ${cleanupBoundary} ${child.pid}`,
      cleanupAcknowledgementTimeoutMs,
    );
    const request = cleanupAcknowledgementRequest({
      invocationNonce,
      terminationNonce,
    });

    if (requestBeforeSignal) {
      await sendIpcMessage(child, request);
      await waitForRequestRetained({
        child,
        close,
        messages,
        pid: child.pid,
        invocationNonce,
        terminationNonce,
        timeoutMs: cleanupAcknowledgementTimeoutMs,
      });
      if (
        messages.some(({ message }) =>
          isExpectedCleanupAcknowledgement({
            message,
            pid: child.pid,
            invocationNonce,
            terminationNonce,
          }),
        )
      ) {
        throw new Error(failure);
      }
    }

    const shutdownStartedAt = Date.now();
    child.kill("SIGTERM");
    if (!requestBeforeSignal) await sendIpcMessage(child, request);

    const acknowledgement = await waitForCleanupAcknowledgement({
      child,
      close,
      messages,
      pid: child.pid,
      invocationNonce,
      terminationNonce,
      timeoutMs: cleanupAcknowledgementTimeoutMs,
    });
    if (
      acknowledgement.observedAt - shutdownStartedAt >
      cleanupAcknowledgementTimeoutMs
    ) {
      throw new Error(failure);
    }
    const closeResult = await closeWithin(
      close,
      cleanupAcknowledgementTimeoutMs - (Date.now() - shutdownStartedAt),
    );
    if (
      closeResult === undefined ||
      closeResult.kind !== "close" ||
      closeResult.exitCode !== 1 ||
      closeResult.signal !== null
    ) {
      throw new Error(failure);
    }
  } finally {
    await terminateAndWait(child, close, { requireKill: false });
    await assertNoSessionFixtures(session);
    await assertNoSessionProcesses(session);
  }
}

async function waitForRequestRetained({
  child,
  close,
  messages,
  pid,
  invocationNonce,
  terminationNonce,
  timeoutMs,
}) {
  const deadline = Date.now() + timeoutMs;
  let closeResult;
  void close.closed.then((result) => {
    closeResult = result;
  });

  while (Date.now() < deadline) {
    if (
      messages.some(({ message }) =>
        isExpectedRequestRetained({
          message,
          pid,
          invocationNonce,
          terminationNonce,
        }),
      )
    ) {
      return;
    }
    if (closeResult !== undefined || child.connected !== true) {
      throw new Error(failure);
    }
    await wait(10);
  }
  throw new Error(failure);
}

function isExpectedRequestRetained({
  message,
  pid,
  invocationNonce,
  terminationNonce,
}) {
  return (
    message !== null &&
    typeof message === "object" &&
    Object.getPrototypeOf(message) === Object.prototype &&
    Object.keys(message).length === 4 &&
    Object.hasOwn(message, "type") &&
    Object.hasOwn(message, "pid") &&
    Object.hasOwn(message, "invocationNonce") &&
    Object.hasOwn(message, "terminationNonce") &&
    message.type === cleanupRequestRetainedType &&
    message.pid === pid &&
    message.invocationNonce === invocationNonce &&
    message.terminationNonce === terminationNonce
  );
}

async function waitForCleanupAcknowledgement({
  child,
  close,
  messages,
  pid,
  invocationNonce,
  terminationNonce,
  timeoutMs,
}) {
  const deadline = Date.now() + timeoutMs;
  let closeResult;
  void close.closed.then((result) => {
    closeResult = result;
  });

  while (Date.now() < deadline) {
    const acknowledgement = messages.find(({ message }) =>
      isExpectedCleanupAcknowledgement({
        message,
        pid,
        invocationNonce,
        terminationNonce,
      }),
    );
    if (acknowledgement !== undefined) return acknowledgement;
    if (closeResult !== undefined) throw new Error(failure);
    if (child.connected !== true) throw new Error(failure);
    await wait(10);
  }
  throw new Error(failure);
}

function isExpectedCleanupAcknowledgement({
  message,
  pid,
  invocationNonce,
  terminationNonce,
}) {
  return (
    message !== null &&
    typeof message === "object" &&
    Object.getPrototypeOf(message) === Object.prototype &&
    Object.keys(message).length === 4 &&
    Object.hasOwn(message, "type") &&
    Object.hasOwn(message, "pid") &&
    Object.hasOwn(message, "invocationNonce") &&
    Object.hasOwn(message, "terminationNonce") &&
    message.type === cleanupCompleteType &&
    message.pid === pid &&
    message.invocationNonce === invocationNonce &&
    message.terminationNonce === terminationNonce
  );
}

function sendIpcMessage(child, message) {
  return new Promise((resolve, reject) => {
    try {
      child.send(message, (error) => {
        if (error === null || error === undefined) resolve();
        else reject(error);
      });
    } catch (error) {
      reject(error);
    }
  });
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
  return waitForStreamMarker(
    stdout,
    close,
    auditChildReadyMarker,
    auditChildReadinessTimeoutMs,
  );
}

async function waitForStreamMarker(stdout, close, marker, timeoutMs) {
  if (stdout === null) throw new Error(failure);

  return new Promise((resolve, reject) => {
    let output = "";
    let settled = false;
    const timeout = setTimeout(
      () => settle(() => reject(new Error(failure))),
      timeoutMs,
    );
    const onData = (chunk) => {
      output += Buffer.from(chunk).toString("utf8");
      if (output.includes(marker)) settle(resolve);
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

function sessionArgument(value) {
  return `--revelai-clean-api-session=${value}`;
}

function deferred() {
  let resolve;
  const promise = new Promise((resolveDeferred) => {
    resolve = resolveDeferred;
  });
  return Object.freeze({ promise, resolve });
}
