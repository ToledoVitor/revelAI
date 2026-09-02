import { spawn } from "node:child_process";
import {
  access,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runCleanProductionRouterCheck } from "../production-router-clean-dist.mjs";

const root = process.env.REVELAI_CLEAN_SIGNAL_PROBE_ROOT;

if (!root || !isAbsolute(root)) {
  throw new Error("REVELAI_CLEAN_SIGNAL_PROBE_ROOT must be an absolute path.");
}

const workDirectory = resolve(root, "work");
const workRelativePath = relative(root, workDirectory);
if (
  workRelativePath === "" ||
  workRelativePath.startsWith("..") ||
  isAbsolute(workRelativePath)
) {
  throw new Error("Signal probe work directory escapes its temporary root.");
}

const sources = [
  resolve(workDirectory, "contracts-dist"),
  resolve(workDirectory, "design-system-dist"),
];
const stagingDirectory = resolve(workDirectory, "staging");
const sentinelPath = resolve(root, "restoration-sentinel.txt");
const childPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "production-router-clean-dist-controlled-child.mjs",
);
const originalMarkers = ["contracts-original", "design-system-original"];

function report(message) {
  process.stdout.write(`${message}\n`);
}

function startControlledChild() {
  const child = spawn(process.execPath, [childPath], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
    process.stdout.write(chunk);
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
    process.stderr.write(chunk);
  });

  return {
    completion: new Promise((resolvePromise, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        if (signal) {
          reject(new Error(`Controlled child stopped by ${signal}.`));
          return;
        }
        resolvePromise({ code: code ?? 1, output });
      });
    }),
    stop(signal) {
      child.kill(signal);
    },
  };
}

let releaseRestoration;
const restorationRelease = new Promise((resolvePromise) => {
  releaseRestoration = resolvePromise;
});
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  if (chunk.includes("release-restoration")) releaseRestoration();
});

async function assertOriginalMarkers() {
  for (const [index, source] of sources.entries()) {
    const marker = await readFile(resolve(source, "marker.txt"), "utf8");
    if (marker !== originalMarkers[index]) {
      throw new Error(`Original marker ${index} was not restored.`);
    }
  }
}

try {
  await mkdir(stagingDirectory, { recursive: true });
  await Promise.all(
    sources.map(async (source, index) => {
      await mkdir(source);
      await writeFile(resolve(source, "marker.txt"), originalMarkers[index]);
    }),
  );

  const firstBackup = resolve(stagingDirectory, "dependency-0");
  const fileSystem = {
    access,
    lstat,
    rename: async (from, to) => {
      if (from === firstBackup && to === sources[0]) {
        report("restoration-held");
        await restorationRelease;
      }
      return rename(from, to);
    },
    rm,
  };
  let receivedExpectedInterruption = false;

  try {
    await runCleanProductionRouterCheck({
      createStagingDirectory: async () => stagingDirectory,
      dependencyOutputs: sources,
      fileSystem,
      startCheck: startControlledChild,
    });
  } catch (error) {
    if (
      error instanceof Error &&
      /interrupted by SIGTERM/.test(error.message)
    ) {
      receivedExpectedInterruption = true;
    } else {
      throw error;
    }
  }

  if (!receivedExpectedInterruption) {
    throw new Error(
      "The signal probe did not surface the expected interruption.",
    );
  }
  await assertOriginalMarkers();
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    if (process.listenerCount(signal) !== 0) {
      throw new Error(`Signal listener leaked for ${signal}.`);
    }
  }
  await writeFile(sentinelPath, "restored-after-listener-cleanup");
  report("sentinel-written");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await rm(workDirectory, { force: true, recursive: true });
}
