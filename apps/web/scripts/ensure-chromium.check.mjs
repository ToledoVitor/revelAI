import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { installChromium } from "./ensure-chromium.mjs";

const forwardedSignals = ["SIGINT", "SIGTERM", "SIGHUP"];
const pnpmFixturePath = fileURLToPath(
  new URL("./test-fixtures/pnpm-entry.mjs", import.meta.url),
);

function startInstaller() {
  const child = new EventEmitter();
  const childSignals = [];
  child.kill = (signal) => {
    childSignals.push(signal);
    return true;
  };

  const processRef = new EventEmitter();
  const reEmittedSignals = [];
  processRef.pid = 4242;
  processRef.execPath = process.execPath;
  processRef.platform = "win32";
  processRef.kill = (pid, signal) => {
    reEmittedSignals.push([pid, signal]);
  };

  const spawnCalls = [];
  const spawnChild = (...args) => {
    spawnCalls.push(args);
    return child;
  };

  return {
    child,
    childSignals,
    processRef,
    reEmittedSignals,
    spawnCalls,
    completion: installChromium({
      processRef,
      spawnChild,
      environment: { npm_execpath: pnpmFixturePath },
    }),
  };
}

function assertSignalHandlersRemoved(processRef) {
  for (const signal of forwardedSignals) {
    assert.equal(processRef.listenerCount(signal), 0);
  }
}

test("forwards every terminal signal to the Chromium installer child", async () => {
  for (const signal of forwardedSignals) {
    const installer = startInstaller();

    installer.processRef.emit(signal);
    assert.deepEqual(installer.childSignals, [signal]);

    installer.child.emit("exit", 0, null);
    assert.equal(await installer.completion, 0);
    assertSignalHandlersRemoved(installer.processRef);
  }
});

test("preserves a Chromium installer child signal after removing its handlers", () => {
  const installer = startInstaller();

  installer.child.emit("exit", null, "SIGTERM");

  assertSignalHandlersRemoved(installer.processRef);
  assert.deepEqual(installer.reEmittedSignals, [[4242, "SIGTERM"]]);
});

test("returns the child exit code and surfaces child process errors", async () => {
  const successfulInstaller = startInstaller();
  successfulInstaller.child.emit("exit", 23, null);

  assert.equal(await successfulInstaller.completion, 23);
  assert.deepEqual(successfulInstaller.spawnCalls, [
    [
      process.execPath,
      [pnpmFixturePath, "exec", "playwright", "install", "chromium"],
      { stdio: "inherit" },
    ],
  ]);
  assertSignalHandlersRemoved(successfulInstaller.processRef);

  const failingInstaller = startInstaller();
  const failure = new Error("installer spawn failed");
  failingInstaller.child.emit("error", failure);

  await assert.rejects(failingInstaller.completion, failure);
  assertSignalHandlersRemoved(failingInstaller.processRef);
});
