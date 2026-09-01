import { mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createLocalDemoRuntime,
  runLocalDemoCheckTrace,
} from "../dist/composition/local-demo-runtime.js";
import { LocalDemoPreflightError } from "../dist/demo/local-demo-support.js";
import { startConfiguredApi } from "../dist/startup.js";

const isCheck = process.argv.includes("--check");
const scratch = isCheck
  ? await mkdtemp(join(tmpdir(), "revelai-local-demo-check-"))
  : undefined;
const environment = scratch
  ? {
      ...process.env,
      DATA_DIR: join(scratch, "data"),
      MEDIA_DIR: join(scratch, "media"),
    }
  : process.env;

let runtime;

try {
  runtime = await createLocalDemoRuntime({
    check: isCheck,
    environment,
    processRunner: { run: runProcess },
  });

  if (isCheck) {
    await runLocalDemoCheckTrace(runtime);
    await runtime.close();
    runtime = undefined;
    await rm(scratch, { recursive: true, force: true });
    console.log("Local demo terminal check passed.");
  } else {
    const started = await startConfiguredApi({
      environment,
      server: runtime.app,
      resources: [{ close: () => runtime.closeResources() }],
      log: {
        warning: (warning) =>
          console.warn(
            JSON.stringify({ event: "startup-warning", ...warning }),
          ),
      },
    });
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      try {
        await started.close();
      } finally {
        process.exitCode = 0;
      }
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    console.log(
      "RevelAI local demo is listening on its configured local host.",
    );
  }
} catch (error) {
  await runtime?.close().catch(() => undefined);
  if (scratch) await rm(scratch, { recursive: true, force: true });
  console.error(
    error instanceof LocalDemoPreflightError
      ? error.message
      : "RevelAI local demo could not start.",
  );
  process.exitCode = 1;
}

async function runProcess(input) {
  return new Promise((resolve, reject) => {
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let termination = "completed";
    let forceKill;
    const child = spawn(input.executable, input.arguments, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const terminate = (reason) => {
      if (termination !== "completed") return;
      termination = reason;
      child.kill("SIGTERM");
      forceKill = setTimeout(() => child.kill("SIGKILL"), 1_000);
      forceKill.unref();
    };
    const timeout = setTimeout(
      () => terminate("timed_out"),
      input.timeoutMilliseconds,
    );
    timeout.unref();
    const append = (current, chunk, limit) => {
      const next = Buffer.concat([current, Buffer.from(chunk)]);
      if (
        next.byteLength > limit ||
        next.byteLength + stdout.byteLength + stderr.byteLength >
          input.maxOutputBytes
      )
        terminate("terminated");
      return next.subarray(0, limit);
    };
    child.stdout.on("data", (chunk) => {
      stdout = append(stdout, chunk, input.maxStdoutBytes);
    });
    child.stderr.on("data", (chunk) => {
      stderr = append(stderr, chunk, input.maxStderrBytes);
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
      resolve({
        exitCode: code ?? 1,
        termination,
        stdout: stdout.toString("utf8"),
        stderr: stderr.toString("utf8"),
      });
    });
  });
}
