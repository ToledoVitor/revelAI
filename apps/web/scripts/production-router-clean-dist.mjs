import { spawn } from "node:child_process";
import { access, lstat, mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPnpmInvocation } from "./pnpm-invocation.mjs";

export const forwardedSignals = ["SIGINT", "SIGTERM", "SIGHUP"];

const webDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dependencyOutputs = [
  resolve(webDirectory, "../../packages/contracts/dist"),
  resolve(webDirectory, "../../packages/design-system/dist"),
];
const defaultFileSystem = { access, lstat, rename, rm };

function isMissingPath(error) {
  return error && typeof error === "object" && error.code === "ENOENT";
}

function combineFailures(message, failures) {
  const presentFailures = failures.filter(Boolean);
  if (presentFailures.length === 1) return presentFailures[0];
  return new AggregateError(presentFailures, message);
}

function withStagedOutputs(error, staged) {
  Object.defineProperty(error, "stagedOutputs", {
    value: staged,
  });
  return error;
}

function plannedOutputs(dependencyPaths, stagingDirectory) {
  if (!isAbsolute(stagingDirectory)) {
    throw new Error("Production router staging directory must be absolute.");
  }

  return dependencyPaths.map((source, index) => {
    if (!isAbsolute(source)) {
      throw new Error("Production router dependency output must be absolute.");
    }
    const backup = resolve(stagingDirectory, `dependency-${index}`);
    const backupRelativePath = relative(stagingDirectory, backup);
    if (
      backupRelativePath === "" ||
      backupRelativePath.startsWith("..") ||
      isAbsolute(backupRelativePath)
    ) {
      throw new Error("Production router staging path escapes its directory.");
    }
    return { backup, source };
  });
}

async function assertBackupsAreVacant(planned, fileSystem) {
  for (const { backup } of planned) {
    try {
      await fileSystem.lstat(backup);
    } catch (error) {
      if (isMissingPath(error)) continue;
      throw error;
    }
    throw new Error(`Backup path already exists: ${backup}`);
  }
}

export async function restoreDependencyOutputs(staged, { fileSystem } = {}) {
  const operations = fileSystem ?? defaultFileSystem;
  const failures = [];

  for (const output of staged.toReversed()) {
    if (output.restored) continue;
    const { backup, source, wasPresent } = output;
    try {
      if (wasPresent) {
        await operations.lstat(backup);
        await operations.rm(source, { force: true, recursive: true });
        await operations.rename(backup, source);
      } else {
        await operations.rm(source, { force: true, recursive: true });
      }
      output.restored = true;
    } catch (error) {
      failures.push(error);
    }
  }

  if (failures.length > 0) {
    throw combineFailures(
      "Production router dependency-output recovery failed.",
      failures,
    );
  }
}

export async function stageDependencyOutputs({
  dependencyOutputs: paths = dependencyOutputs,
  fileSystem,
  stagingDirectory,
} = {}) {
  const operations = fileSystem ?? defaultFileSystem;
  const planned = plannedOutputs(paths, stagingDirectory);
  await assertBackupsAreVacant(planned, operations);
  const staged = [];

  try {
    for (const { backup, source } of planned) {
      try {
        await operations.lstat(source);
      } catch (error) {
        if (isMissingPath(error)) {
          staged.push({ backup, source, wasPresent: false });
          continue;
        }
        throw error;
      }
      await operations.rename(source, backup);
      staged.push({ backup, source, wasPresent: true });
    }
  } catch (error) {
    try {
      await restoreDependencyOutputs(staged, { fileSystem: operations });
    } catch (recoveryError) {
      throw withStagedOutputs(
        combineFailures(
          "Production router dependency-output staging failed and rollback failed.",
          [error, recoveryError],
        ),
        staged,
      );
    }
    throw error;
  }

  return staged;
}

export function startProductionRouterCheck({
  environment = process.env,
  processRef = process,
  spawnChild = spawn,
  workingDirectory = webDirectory,
} = {}) {
  const invocation = createPnpmInvocation({
    argumentsList: ["run", "test:production-router"],
    environment,
    runtime: processRef,
  });
  const child = spawnChild(invocation.command, invocation.args, {
    cwd: workingDirectory,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout?.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr?.on("data", (chunk) => {
    output += chunk;
  });

  let stopSignal;
  let settled = false;
  let resolveCompletion;
  let rejectCompletion;
  const completion = new Promise((resolvePromise, reject) => {
    resolveCompletion = resolvePromise;
    rejectCompletion = reject;
  });
  const settle = (complete, value) => {
    if (settled) return;
    settled = true;
    complete(value);
  };

  child.once("error", (error) => settle(rejectCompletion, error));
  child.once("exit", (code, signal) => {
    if (signal) {
      settle(
        rejectCompletion,
        new Error(`Production router check stopped by ${signal}.`),
      );
      return;
    }
    settle(resolveCompletion, { code: code ?? 1, output });
  });

  return Object.freeze({
    completion,
    stop(signal) {
      if (stopSignal) return;
      stopSignal = signal;
      child.kill(signal);
    },
  });
}

async function createDefaultStagingDirectory() {
  return mkdtemp(resolve(tmpdir(), "revelai-production-router-clean-dist-"));
}

async function assertOutputsWereRebuilt(paths, fileSystem) {
  await Promise.all(paths.map((source) => fileSystem.access(source)));
}

export async function runCleanProductionRouterCheck({
  createStagingDirectory = createDefaultStagingDirectory,
  dependencyOutputs: paths = dependencyOutputs,
  fileSystem,
  processRef = process,
  removeStagingDirectory,
  startCheck = startProductionRouterCheck,
  verifyRebuilt = assertOutputsWereRebuilt,
} = {}) {
  const operations = fileSystem ?? defaultFileSystem;
  const removeDirectory = removeStagingDirectory ?? operations.rm;
  const stagingDirectory = await createStagingDirectory();
  let staged = [];
  let runner;
  let parentSignal;
  const signalHandlers = new Map(
    forwardedSignals.map((signal) => [
      signal,
      () => {
        if (parentSignal) return;
        parentSignal = signal;
        runner?.stop(signal);
      },
    ]),
  );
  const removeSignalListeners = () => {
    for (const [signal, handler] of signalHandlers) {
      processRef.removeListener(signal, handler);
    }
  };

  for (const [signal, handler] of signalHandlers) {
    processRef.once(signal, handler);
  }

  let result;
  let primaryError;
  try {
    staged = await stageDependencyOutputs({
      dependencyOutputs: paths,
      fileSystem: operations,
      stagingDirectory,
    });
    if (parentSignal) {
      throw new Error(
        `Production router check interrupted by ${parentSignal}.`,
      );
    }
    runner = startCheck({ processRef });
    if (parentSignal) runner.stop(parentSignal);
    result = await runner.completion;
    if (result.code !== 0) {
      throw new Error(
        `Production router check exited with ${result.code}.\n${result.output}`,
      );
    }
    if (parentSignal) {
      throw new Error(
        `Production router check interrupted by ${parentSignal}.`,
      );
    }
    await verifyRebuilt(paths, operations);
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      Array.isArray(error.stagedOutputs)
    ) {
      staged = error.stagedOutputs;
    }
    primaryError = error;
  }

  let recoveryError;
  try {
    await restoreDependencyOutputs(staged, { fileSystem: operations });
    await removeDirectory(stagingDirectory, { force: true, recursive: true });
  } catch (error) {
    recoveryError = error;
  } finally {
    removeSignalListeners();
  }

  if (parentSignal) {
    throw combineFailures(
      `Production router check interrupted by ${parentSignal}.`,
      [
        new Error(`Production router check interrupted by ${parentSignal}.`),
        recoveryError,
      ],
    );
  }
  if (primaryError && recoveryError) {
    throw combineFailures(
      "Production router check failed and recovery failed.",
      [primaryError, recoveryError],
    );
  }
  if (primaryError) throw primaryError;
  if (recoveryError) throw recoveryError;
  return result;
}
