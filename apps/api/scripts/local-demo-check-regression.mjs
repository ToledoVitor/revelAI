import { spawn } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CHECK_TIMEOUT_MILLISECONDS = 30_000;
const TERMINATION_GRACE_MILLISECONDS = 250;
const MAX_OUTPUT_BYTES = 32 * 1024;
const executable = fileURLToPath(
  new URL("./start-local-demo.mjs", import.meta.url),
);
let directory;
let server;
let succeeded = false;

try {
  directory = await mkdtemp(join(tmpdir(), "revelai-local-demo-check-env-"));
  const externalDatabasePath = join(directory, "outside-check.sqlite");
  let requests = 0;
  server = createServer((_request, response) => {
    requests += 1;
    response.statusCode = 500;
    response.end();
  });
  const port = await listen(server);
  const result = await invoke({
    executable: process.execPath,
    arguments: [executable, "--check"],
    environment: {
      ...process.env,
      DATABASE_PATH: externalDatabasePath,
      ROBOFLOW_API_URL: `http://127.0.0.1:${port}`,
      ROBOFLOW_WORKSPACE_ID: "poisoned-workspace",
      ROBOFLOW_WORKFLOW_VERSION: "1.0.0",
      ROBOFLOW_WALL_PASS_WORKFLOW_ID: "revelai-wall-pass-geometry-v1",
      ROBOFLOW_WALL_PASS_MODEL_BUNDLE_ID: "poisoned-wall-pass-bundle",
      ROBOFLOW_FREE_WORKFLOW_ID: "revelai-free-training-v1",
      ROBOFLOW_FREE_MODEL_BUNDLE_ID: "poisoned-free-bundle",
    },
    timeoutMilliseconds: CHECK_TIMEOUT_MILLISECONDS,
  });
  if (
    result.exitCode !== 0 ||
    result.termination !== "completed" ||
    result.stdout !== "Local demo terminal check passed.\n" ||
    result.stderr !== "" ||
    requests !== 0
  )
    throw new Error("Local demo check inherited provider configuration.");
  await expectAbsent(externalDatabasePath);

  const collisionBlocker = createServer();
  try {
    const blockedPort = await listen(collisionBlocker);
    const collision = await invoke({
      executable: process.execPath,
      arguments: [executable, "--serve-check"],
      environment: {
        ...process.env,
        HOST: "127.0.0.1",
        PORT: String(blockedPort),
      },
      timeoutMilliseconds: CHECK_TIMEOUT_MILLISECONDS,
    });
    if (
      collision.exitCode !== 1 ||
      collision.termination !== "completed" ||
      collision.stdout !== "" ||
      collision.stderr !==
        "RevelAI local demo startup failed: address_in_use.\n"
    )
      throw new Error("Local demo startup did not report a safe bind failure.");
  } finally {
    await close(collisionBlocker);
  }

  const timedOut = await invoke({
    executable: process.execPath,
    arguments: [
      "-e",
      "process.on('SIGTERM', () => {}); setInterval(() => {}, 1_000)",
    ],
    environment: {},
    timeoutMilliseconds: TERMINATION_GRACE_MILLISECONDS,
  });
  if (
    timedOut.termination !== "timed_out" ||
    timedOut.stdout !== "" ||
    timedOut.stderr !== ""
  )
    throw new Error("Local demo child timeout was not bounded.");
  const oversizedOutput = await invoke({
    executable: process.execPath,
    arguments: [
      "-e",
      "process.on('SIGTERM', () => {}); process.stdout.write('x'.repeat(65536)); setInterval(() => {}, 1_000)",
    ],
    environment: {},
    timeoutMilliseconds: CHECK_TIMEOUT_MILLISECONDS,
  });
  if (
    oversizedOutput.termination !== "terminated" ||
    oversizedOutput.stdout.length !== MAX_OUTPUT_BYTES ||
    oversizedOutput.stderr !== ""
  )
    throw new Error("Local demo child output was not bounded.");
  succeeded = true;
} catch {
  succeeded = false;
} finally {
  try {
    await close(server);
    if (directory) await rm(directory, { recursive: true, force: true });
  } catch {
    succeeded = false;
  }
}

if (succeeded) console.log("Local demo hermetic check regression passed.");
else {
  console.error("Local demo hermetic check regression failed.");
  process.exitCode = 1;
}

function listen(host) {
  return new Promise((resolve, reject) => {
    host.once("error", reject);
    host.listen(0, "127.0.0.1", () => {
      host.off("error", reject);
      const address = host.address();
      if (!address || typeof address === "string") {
        reject(new Error("Local demo regression server did not bind."));
        return;
      }
      resolve(address.port);
    });
  });
}

function close(host) {
  if (!host?.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    host.close((error) => (error ? reject(error) : resolve()));
  });
}

function invoke(input) {
  return new Promise((resolve, reject) => {
    const child = spawn(input.executable, input.arguments, {
      env: input.environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let termination = "completed";
    let timeout;
    let forceKill;
    let settled = false;
    const settle = (callback) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
      callback();
    };
    const terminate = (reason) => {
      if (termination !== "completed") return;
      termination = reason;
      child.kill("SIGTERM");
      forceKill = setTimeout(
        () => child.kill("SIGKILL"),
        TERMINATION_GRACE_MILLISECONDS,
      );
      forceKill.unref();
    };
    const append = (current, chunk) => {
      const bytes = Buffer.from(chunk);
      const remaining = MAX_OUTPUT_BYTES - current.length;
      if (remaining <= 0) return current;
      return Buffer.concat([current, bytes.subarray(0, remaining)]);
    };
    const receive = (kind) => (chunk) => {
      if (kind === "stdout") stdout = append(stdout, chunk);
      else stderr = append(stderr, chunk);
      if (
        stdout.length >= MAX_OUTPUT_BYTES ||
        stderr.length >= MAX_OUTPUT_BYTES
      )
        terminate("terminated");
    };

    child.stdout.on("data", receive("stdout"));
    child.stderr.on("data", receive("stderr"));
    child.once("error", () => {
      settle(() => reject(new Error("Local demo child could not start.")));
    });
    child.once("close", (exitCode) => {
      settle(() =>
        resolve({
          exitCode: exitCode ?? 1,
          termination,
          stdout: stdout.toString("utf8"),
          stderr: stderr.toString("utf8"),
        }),
      );
    });
    timeout = setTimeout(
      () => terminate("timed_out"),
      input.timeoutMilliseconds,
    );
    timeout.unref();
  });
}

async function expectAbsent(path) {
  try {
    await access(path);
  } catch {
    return;
  }
  throw new Error("Local demo check created the inherited database path.");
}
