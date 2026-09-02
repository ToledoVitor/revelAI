import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { runPnpm } from "./production-router-build.mjs";

const forwardedSignals = ["SIGINT", "SIGTERM", "SIGHUP"];
const pnpmFixturePath = fileURLToPath(
  new URL("./test-fixtures/pnpm-entry.mjs", import.meta.url),
);

function startPnpm() {
  const child = new EventEmitter();
  const childSignals = [];
  child.kill = (signal) => {
    childSignals.push(signal);
    return true;
  };

  const processRef = new EventEmitter();
  processRef.execPath = process.execPath;
  const spawnCalls = [];
  const spawnChild = (...args) => {
    spawnCalls.push(args);
    return child;
  };

  return {
    child,
    childSignals,
    completion: runPnpm(["run", "build"], {
      environment: { npm_execpath: pnpmFixturePath },
      processRef,
      spawnChild,
      workingDirectory: "/production-router-build-test",
    }),
    processRef,
    spawnCalls,
  };
}

function assertSignalHandlersRemoved(processRef) {
  for (const signal of forwardedSignals) {
    assert.equal(processRef.listenerCount(signal), 0);
  }
}

test("forwards terminal signals to the active production-router build child", async () => {
  for (const signal of forwardedSignals) {
    const runner = startPnpm();

    runner.processRef.emit(signal);
    assert.deepEqual(runner.childSignals, [signal]);

    runner.child.emit("exit", 0, null);
    await runner.completion;
    assertSignalHandlersRemoved(runner.processRef);
  }
});

test("rejects failed, signalled, and spawn-error production-router build children", async () => {
  const failedRunner = startPnpm();
  failedRunner.child.emit("exit", 23, null);
  await assert.rejects(failedRunner.completion, /exited with 23/);
  assertSignalHandlersRemoved(failedRunner.processRef);

  const signalledRunner = startPnpm();
  signalledRunner.child.emit("exit", null, "SIGTERM");
  await assert.rejects(signalledRunner.completion, /stopped by SIGTERM/);
  assertSignalHandlersRemoved(signalledRunner.processRef);

  const errorRunner = startPnpm();
  const error = new Error("pnpm failed to start");
  errorRunner.child.emit("error", error);
  await assert.rejects(errorRunner.completion, error);
  assertSignalHandlersRemoved(errorRunner.processRef);
  assert.deepEqual(errorRunner.spawnCalls, [
    [
      process.execPath,
      [pnpmFixturePath, "run", "build"],
      {
        cwd: "/production-router-build-test",
        env: { npm_execpath: pnpmFixturePath },
        stdio: "inherit",
      },
    ],
  ]);
});
