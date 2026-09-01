import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("../../../", import.meta.url));
const COMMAND_TIMEOUT_MS = 120_000;
const TERMINATION_GRACE_MS = 250;
const MAX_CAPTURED_OUTPUT_BYTES = 32 * 1024;
const COMMAND_FAILURE = "Clean API executable regression command failed.";
const executableCases = [
  { name: "demo", script: "demo:smoke" },
  { name: "operator", script: "operator:receipt-smoke" },
  { name: "openapi", script: "openapi:check" },
];
const activeChildren = new Set();
let shuttingDown = false;

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    stopForSignal();
  });
}

void main().catch(() => {
  console.error("Clean API executable regression failed.");
  process.exitCode = 1;
});

async function main() {
  const [mode] = process.argv.slice(2);

  if (mode === "--self-test") {
    await verifyProcessGuard();
    console.log("Clean API executable process guard regression passed.");
    return;
  }

  if (mode === "--mutation-proof") {
    await verifyIndependentMutation();
    console.log("Clean API executable independent mutation regression passed.");
    return;
  }

  if (mode !== undefined) throw new Error(COMMAND_FAILURE);

  for (const executableCase of executableCases) {
    await runCleanCase(executableCase);
  }

  console.log("Clean API executable regression passed.");
}

async function verifyProcessGuard() {
  const capped = await run(process.execPath, [
    "-e",
    `process.stdout.write("x".repeat(${MAX_CAPTURED_OUTPUT_BYTES * 2}))`,
  ]);
  if (capped.capturedOutputBytes > MAX_CAPTURED_OUTPUT_BYTES) {
    throw new Error(COMMAND_FAILURE);
  }

  let rejected = false;
  try {
    await run(
      process.execPath,
      ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1_000)"],
      { timeoutMs: 50 },
    );
  } catch (error) {
    rejected = error instanceof Error && error.message === COMMAND_FAILURE;
  }

  if (!rejected) throw new Error(COMMAND_FAILURE);
}

async function verifyIndependentMutation() {
  for (const executableCase of executableCases) {
    const mutation =
      executableCase.name === "operator"
        ? { removeWorkspaceBuildFrom: executableCase.script }
        : undefined;
    await runCleanCase(executableCase, {
      expectCommandFailure: mutation !== undefined,
      mutation,
    });
  }
}

async function runCleanCase(executableCase, options = {}) {
  const fixture = await mkdtemp(join(tmpdir(), "revelai-clean-api-demo-"));
  const archive = join(fixture, "revelai.tar");

  try {
    await run("git", ["archive", "--format=tar", "--output", archive, "HEAD"], {
      cwd: repository,
    });
    await run("tar", ["-xf", archive, "-C", fixture], { cwd: repository });
    await run("pnpm", ["install", "--frozen-lockfile"], { cwd: fixture });

    if (options.mutation !== undefined) {
      await removeWorkspaceBuild(
        fixture,
        options.mutation.removeWorkspaceBuildFrom,
      );
    }

    try {
      await run(
        "pnpm",
        ["--filter", "@revelai/api", "run", executableCase.script],
        {
          cwd: fixture,
        },
      );
    } catch {
      if (options.expectCommandFailure === true) return;
      throw new Error(COMMAND_FAILURE);
    }

    if (options.expectCommandFailure === true) throw new Error(COMMAND_FAILURE);
  } finally {
    await rm(fixture, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function removeWorkspaceBuild(fixture, scriptName) {
  const manifestPath = join(fixture, "apps/api/package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const buildPrefix = "pnpm run build:workspace && ";
  const script = manifest.scripts?.[scriptName];

  if (typeof script !== "string" || !script.startsWith(buildPrefix)) {
    throw new Error(COMMAND_FAILURE);
  }

  manifest.scripts[scriptName] = script.slice(buildPrefix.length);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

function run(executable, arguments_, options = {}) {
  return new Promise((resolve, reject) => {
    let timeout;
    let capturedOutputBytes = 0;
    const child = spawn(executable, arguments_, {
      cwd: options.cwd,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const record = {
      child,
      settled: false,
      killTimer: undefined,
      timedOut: false,
    };
    activeChildren.add(record);

    const settle = (callback) => {
      if (record.settled) return;
      record.settled = true;
      activeChildren.delete(record);
      clearTimeout(timeout);
      clearTimeout(record.killTimer);
      callback();
    };
    const fail = () => settle(() => reject(new Error(COMMAND_FAILURE)));
    const consumeOutput = (chunk) => {
      if (capturedOutputBytes >= MAX_CAPTURED_OUTPUT_BYTES) return;
      capturedOutputBytes += Math.min(
        Buffer.byteLength(chunk),
        MAX_CAPTURED_OUTPUT_BYTES - capturedOutputBytes,
      );
    };

    child.stdout.on("data", consumeOutput);
    child.stderr.on("data", consumeOutput);
    child.once("error", fail);
    child.once("close", (exitCode) => {
      if (exitCode === 0 && record.timedOut === false) {
        settle(() => resolve({ capturedOutputBytes }));
      } else {
        fail();
      }
    });

    timeout = setTimeout(() => {
      record.timedOut = true;
      terminate(record);
    }, options.timeoutMs ?? COMMAND_TIMEOUT_MS);
  });
}

function stopForSignal() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const record of activeChildren) terminate(record);
  setTimeout(() => process.exit(1), TERMINATION_GRACE_MS + 100);
}

function terminate(record) {
  if (record.killTimer !== undefined || record.settled) return;
  sendSignal(record.child, "SIGTERM");
  record.killTimer = setTimeout(() => {
    if (record.settled === false) sendSignal(record.child, "SIGKILL");
  }, TERMINATION_GRACE_MS);
}

function sendSignal(child, signal) {
  if (child.pid === undefined) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}
