import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
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
    `--revelai-clean-api-session=${foreignSession}`,
  ],
  { detached: true, stdio: "ignore" },
);

try {
  for (const psMode of ["spawn-error", "nonzero", "hang"]) {
    const session = sessionToken();
    const result = await runProbe({
      CLEAN_API_EXECUTABLE_TEST_PROBE_SCENARIO: "outer-before-main",
      CLEAN_API_EXECUTABLE_TEST_PS_MODE: psMode,
      CLEAN_API_EXECUTABLE_TEST_SESSION: session,
    });

    assertGenericFailure(result);
    await assertNoSessionFixtures(session);
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
  assertActive(foreign.pid);
  await assertExists(foreignFixture);
  await assertMissing(terminationMarker);
} finally {
  terminate(foreign.pid);
  await rm(foreignFixture, { recursive: true, force: true });
}

console.log(
  "Clean API executable cancellation probe fault regressions passed.",
);

function runProbe(environment) {
  return new Promise((resolve, reject) => {
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
      killTimer = setTimeout(() => kill(child.pid), 500);
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
    child.once("close", (exitCode) => settle({ kind: "close", exitCode }));
  });
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
