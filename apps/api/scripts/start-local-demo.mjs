import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createLocalDemoRuntime,
  runLocalDemoCheckTrace,
} from "../dist/composition/local-demo-runtime.js";
import { createLocalDemoProcessRunner } from "../dist/demo/local-demo-process-runner.js";
import { LocalDemoPreflightError } from "../dist/demo/local-demo-support.js";
import { startConfiguredApi } from "../dist/startup.js";

const isCheck = process.argv.includes("--check");
const scratch = isCheck
  ? await mkdtemp(join(tmpdir(), "revelai-local-demo-check-"))
  : undefined;
const environment = scratch ? checkEnvironment(scratch) : process.env;

let runtime;

try {
  runtime = await createLocalDemoRuntime({
    check: isCheck,
    environment,
    processRunner: createLocalDemoProcessRunner(),
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

function checkEnvironment(directory) {
  return Object.freeze({
    NODE_ENV: "development",
    HOST: "127.0.0.1",
    PORT: "3000",
    DATA_DIR: join(directory, "data"),
    MEDIA_DIR: join(directory, "media"),
  });
}
