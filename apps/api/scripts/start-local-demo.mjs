import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseApiEnv } from "@revelai/config";
import { createProductionAttemptApi } from "../dist/composition/sqlite-media-upload-composition.js";
import { openSqliteDatabase } from "../dist/database/sqlite-database.js";
import {
  createMediaPipeline,
  createMediaPipelineCapability,
} from "../dist/media/media-pipeline.js";
import { FfprobeMediaProber } from "../dist/media/ffprobe-media-prober.js";
import { SQLiteRetentionRepository } from "../dist/media/sqlite-retention-repository.js";
import { InMemoryAnalysisQueue } from "../dist/queue/in-memory-analysis-queue.js";
import { SQLiteAttemptRepository } from "../dist/repositories/sqlite-attempt-repository.js";
import { createLocalC8AcceptedMediaCleaner } from "../dist/services/local-c8-accepted-media-cleaner.js";
import { createLocalFrameExtraction } from "../dist/storage/local-frame-extraction.js";
import { createLocalMediaStorage } from "../dist/storage/local-media-storage.js";
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

let app;
let database;
let queue;

try {
  const config = parseApiEnv(environment);
  await mkdir(config.paths.dataDir, { recursive: true, mode: 0o700 });
  database = openSqliteDatabase(config.paths.databasePath);
  const retention = new SQLiteRetentionRepository({ database });
  const storage = createLocalMediaStorage({
    root: config.paths.mediaDir,
    ids: { next: randomUUID },
    prober: new FfprobeMediaProber({
      runner: {
        run: async (command) => {
          const result = await runProcess({
            executable: command.executable,
            arguments: command.arguments,
            timeoutMilliseconds: command.timeoutMilliseconds,
            maxStdoutBytes: command.maxOutputBytes,
            maxStderrBytes: command.maxOutputBytes,
            maxOutputBytes: command.maxOutputBytes,
          });
          return {
            exitCode: result.exitCode,
            stdout: result.stdout,
            stderr: result.stderr,
          };
        },
      },
    }),
  });
  const extraction = createLocalFrameExtraction({
    root: config.paths.mediaDir,
    ids: { next: randomUUID },
    retention,
    runner: {
      run: async (command) => runProcess(command),
    },
  });
  const pipeline = createMediaPipeline(
    createMediaPipelineCapability({ storage, extraction }),
  );
  const repository = new SQLiteAttemptRepository({
    database,
    clock: { now: () => new Date().toISOString() },
    ids: { next: randomUUID },
    handoffVerifier: pipeline.handoffVerifier(),
  });
  queue = new InMemoryAnalysisQueue();
  app = createProductionAttemptApi({
    repository,
    retention,
    mediaPipeline: pipeline,
    queue,
    cleaner: createLocalC8AcceptedMediaCleaner({ repository, storage }),
  });

  if (isCheck) {
    const [health, ready] = await Promise.all([
      app.inject({ method: "GET", url: "/health" }),
      app.inject({ method: "GET", url: "/ready" }),
    ]);
    if (health.statusCode !== 200 || ready.statusCode !== 200)
      throw new Error("Local demo profile did not pass health and readiness.");
    await app.close();
    queue.close();
    database.close();
    await rm(scratch, { recursive: true, force: true });
    console.log("Local demo profile check passed.");
  } else {
    const started = await startConfiguredApi({
      environment,
      server: app,
      resources: [
        { close: () => queue.close() },
        { close: () => database.close() },
      ],
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
} catch {
  await app?.close().catch(() => undefined);
  queue?.close();
  database?.close();
  if (scratch) await rm(scratch, { recursive: true, force: true });
  console.error("RevelAI local demo could not start.");
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
