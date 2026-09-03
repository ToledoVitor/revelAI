import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  createOwnedChildStop,
  createSharedStop,
} from "./owned-child-lifecycle.mjs";

test("keeps owned-child error handling through TERM then KILL until close", async () => {
  const child = new SimulatedOwnedChild();
  const scheduled = [];
  const stopChild = createOwnedChildStop(child, {
    graceMilliseconds: 1,
    schedule(callback) {
      scheduled.push(callback);
      return { unref() {} };
    },
    clear() {},
  });

  const firstStop = stopChild();
  const concurrentStop = stopChild();

  assert.strictEqual(concurrentStop, firstStop);
  assert.deepEqual(child.signals, ["SIGTERM"]);
  assert.equal(child.listenerCount("error"), 1);

  scheduled.shift()?.();
  await firstStop;

  assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
  assert.deepEqual(child.errorSignals, ["SIGTERM", "SIGKILL"]);
  assert.equal(child.listenerCount("error"), 0);
});

test("shares one concurrent teardown promise until owned resources settle", async () => {
  let settle;
  let calls = 0;
  const stop = createSharedStop(
    () =>
      new Promise((resolve) => {
        calls += 1;
        settle = resolve;
      }),
  );

  const firstStop = stop();
  const concurrentStop = stop();

  assert.strictEqual(concurrentStop, firstStop);
  assert.equal(calls, 1);
  settle();
  await firstStop;
});

test("waits for close without KILL after TERM exits the owned child", async () => {
  const child = new TermExitedOwnedChild();
  const scheduled = [];
  const stopChild = createOwnedChildStop(child, {
    graceMilliseconds: 1,
    schedule(callback) {
      scheduled.push(callback);
      return { unref() {} };
    },
    clear() {},
  });

  const stop = stopChild();
  assert.deepEqual(child.signals, ["SIGTERM"]);

  scheduled.shift()?.();
  assert.deepEqual(child.signals, ["SIGTERM"]);

  child.emit("close", null, "SIGTERM");
  await stop;
});

class SimulatedOwnedChild extends EventEmitter {
  exitCode = null;
  signals = [];
  errorSignals = [];

  kill(signal) {
    this.signals.push(signal);
    this.errorSignals.push(signal);
    this.emit("error", new Error(`${signal} kill failure`));
    if (signal === "SIGKILL") {
      this.exitCode = 1;
      this.emit("close", 1);
    }
    return true;
  }
}

class TermExitedOwnedChild extends EventEmitter {
  exitCode = null;
  signalCode = null;
  signals = [];

  kill(signal) {
    this.signals.push(signal);
    if (signal === "SIGTERM") {
      this.signalCode = "SIGTERM";
      this.emit("exit", null, "SIGTERM");
    }
    return true;
  }
}
