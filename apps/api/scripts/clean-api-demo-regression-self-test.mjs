import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(
  new URL("./clean-api-demo-regression.mjs", import.meta.url),
);
const MAX_OUTPUT_BYTES = 32 * 1024;
const DEFAULT_MODE_TIMEOUT_MS = 120_000;
const TERMINATION_GRACE_MS = 750;
const FAILURE = "Clean API executable self-test failed.";
const readinessPrefix = "REVELAI_EXECUTABLE_READY ";
const sessionArgumentPrefix = "--revelai-clean-api-session=";
const session = parseSession(process.argv.slice(2));
const modeTimeoutMs = configuredTimeoutMs(
  process.env.CLEAN_API_EXECUTABLE_SELF_TEST_TIMEOUT_MS,
);
const activeChildren = new Set();
let boundaryReleased;
const boundaryRelease = new Promise((resolve) => {
  boundaryReleased = resolve;
});
let mainOperation;
let shutdown;
let shuttingDown = false;

if (process.platform === "win32") {
  console.error(
    "Clean API executable self-test requires POSIX process groups.",
  );
  process.exitCode = 1;
} else {
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => {
      void stopForSignal();
    });
  }

  mainOperation = main();
  void mainOperation.catch(() => {
    console.error(FAILURE);
    process.exitCode = 1;
  });
}

async function main() {
  assertCanStart();
  await pauseAtBoundary("outer:before-main");
  await expectMode(
    "--self-test",
    "Clean API executable process guard regression passed.",
  );
  await pauseAtBoundary("outer:before-mode:--mutation-proof");
  await expectMode(
    "--mutation-proof",
    "Clean API executable independent mutation regression passed.",
  );

  console.log("Clean API executable self-tests passed.");
}

async function expectMode(mode, successMessage) {
  assertCanStart();
  const result = await run(mode);
  if (result.exitCode !== 0 || !result.output.includes(successMessage)) {
    throw new Error(FAILURE);
  }
}

function run(mode) {
  if (shuttingDown) return Promise.reject(new Error(FAILURE));
  return new Promise((resolve, reject) => {
    let output = Buffer.alloc(0);
    let readinessOutput = "";
    const child = spawn(
      process.execPath,
      [
        script,
        mode,
        ...(session === undefined ? [] : [sessionArgument(session)]),
      ],
      {
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const record = {
      child,
      settled: false,
      timedOut: false,
      timeout: undefined,
      killTimer: undefined,
      resolveClosed: undefined,
    };
    record.closed = new Promise((resolveClosed) => {
      record.resolveClosed = resolveClosed;
    });
    activeChildren.add(record);

    const settle = (callback) => {
      if (record.settled) return;
      record.settled = true;
      activeChildren.delete(record);
      clearTimeout(record.timeout);
      clearTimeout(record.killTimer);
      record.resolveClosed();
      callback();
    };
    const append = (chunk) => {
      const remaining = MAX_OUTPUT_BYTES - output.length;
      if (remaining > 0) {
        output = Buffer.concat([
          output,
          Buffer.from(chunk).subarray(0, remaining),
        ]);
      }
      readinessOutput += Buffer.from(chunk).toString("utf8");
      while (true) {
        const newline = readinessOutput.indexOf("\n");
        if (newline === -1) break;
        const line = readinessOutput.slice(0, newline);
        readinessOutput = readinessOutput.slice(newline + 1);
        if (/^REVELAI_EXECUTABLE_READY [^ ]+ [1-9][0-9]*$/.test(line)) {
          console.log(line);
        }
      }
      if (readinessOutput.length > 1024) {
        readinessOutput = readinessOutput.slice(-1024);
      }
    };

    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.once("error", () => settle(() => reject(new Error(FAILURE))));
    child.once("close", (exitCode) => {
      if (exitCode === 0 && record.timedOut === false) {
        settle(() => resolve({ exitCode, output: output.toString("utf8") }));
      } else {
        settle(() => reject(new Error(FAILURE)));
      }
    });

    record.timeout = setTimeout(() => {
      record.timedOut = true;
      terminate(record);
    }, modeTimeoutMs);
  });
}

async function stopForSignal() {
  if (shutdown !== undefined) return shutdown;
  shuttingDown = true;
  boundaryReleased();
  shutdown = (async () => {
    const records = [...activeChildren];
    for (const record of records) terminate(record);
    await Promise.all(records.map((record) => record.closed));
    await mainOperation?.catch(() => undefined);
    process.exitCode = 1;
  })();
  return shutdown;
}

async function pauseAtBoundary(name) {
  assertCanStart();
  if (process.env.CLEAN_API_EXECUTABLE_BOUNDARY !== name) return;
  console.log(`${readinessPrefix}${name} ${process.pid}`);
  const keepAlive = setInterval(() => undefined, 1_000);
  try {
    await boundaryRelease;
  } finally {
    clearInterval(keepAlive);
  }
  assertCanStart();
}

function assertCanStart() {
  if (shuttingDown) throw new Error(FAILURE);
}

function terminate(record) {
  if (record.settled || record.killTimer !== undefined) return;
  sendSignal(record.child, "SIGTERM");
  record.killTimer = setTimeout(() => {
    if (record.settled === false) sendSignal(record.child, "SIGKILL");
  }, TERMINATION_GRACE_MS);
}

function sendSignal(child, signal) {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

function configuredTimeoutMs(value) {
  if (value === undefined) return DEFAULT_MODE_TIMEOUT_MS;
  const parsed = Number(value);
  if (
    !Number.isInteger(parsed) ||
    parsed < 1_000 ||
    parsed > DEFAULT_MODE_TIMEOUT_MS
  ) {
    return DEFAULT_MODE_TIMEOUT_MS;
  }
  return parsed;
}

function parseSession(arguments_) {
  if (arguments_.length === 0) return undefined;
  if (arguments_.length !== 1) throw new Error(FAILURE);
  const [argument] = arguments_;
  if (!argument.startsWith(sessionArgumentPrefix)) throw new Error(FAILURE);
  const candidate = argument.slice(sessionArgumentPrefix.length);
  if (!/^[a-f0-9]{32}$/.test(candidate)) throw new Error(FAILURE);
  return candidate;
}

function sessionArgument(value) {
  return `${sessionArgumentPrefix}${value}`;
}
