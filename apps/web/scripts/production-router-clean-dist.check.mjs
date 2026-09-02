import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  runCleanProductionRouterCheck,
  stageDependencyOutputs,
  startProductionRouterCheck,
} from "./production-router-clean-dist.mjs";

const forwardedSignals = ["SIGINT", "SIGTERM", "SIGHUP"];
const pnpmFixturePath = fileURLToPath(
  new URL("./test-fixtures/pnpm-entry.mjs", import.meta.url),
);
const signalProbePath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "test-fixtures/production-router-clean-dist-signal-probe.mjs",
);

function delay(milliseconds) {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, milliseconds);
  });
}

async function waitForProbeOutput(probe, output, expected, description) {
  const deadline = Date.now() + 5_000;
  while (!output().includes(expected)) {
    if (probe.exitCode !== null || probe.signalCode !== null) {
      throw new Error(
        `${description} exited before writing ${expected}: ${probe.exitCode ?? probe.signalCode}`,
      );
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `${description} did not write ${expected} within 5000ms.`,
      );
    }
    await delay(25);
  }
}

async function waitForProbeExit(probe, timeout = 5_000) {
  if (probe.exitCode !== null || probe.signalCode !== null) {
    return { code: probe.exitCode, signal: probe.signalCode };
  }

  let timeoutId;
  try {
    return await Promise.race([
      once(probe, "exit").then(([code, signal]) => ({ code, signal })),
      new Promise((_, reject) => {
        timeoutId = setTimeout(
          () =>
            reject(new Error(`Signal probe did not exit within ${timeout}ms.`)),
          timeout,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeoutId);
  }
}

async function assertMissing(path) {
  await assert.rejects(lstat(path), { code: "ENOENT" });
}

async function createOutputFixture(t) {
  const root = await mkdtemp(resolve(tmpdir(), "revelai-clean-dist-test-"));
  const sources = [
    resolve(root, "contracts-dist"),
    resolve(root, "design-system-dist"),
  ];
  const originalContents = ["contracts-original", "design-system-original"];
  const stagingDirectory = resolve(root, "staging");
  await mkdir(stagingDirectory);
  await Promise.all(
    sources.map(async (source, index) => {
      await mkdir(source);
      await writeFile(resolve(source, "marker.txt"), originalContents[index]);
    }),
  );
  t.after(() => rm(root, { force: true, recursive: true }));

  return { originalContents, sources, stagingDirectory };
}

async function assertOriginalOutputs(fixture) {
  for (const [index, source] of fixture.sources.entries()) {
    assert.equal(
      await readFile(resolve(source, "marker.txt"), "utf8"),
      fixture.originalContents[index],
    );
  }
}

function fakeProductionRouterChild() {
  const child = new EventEmitter();
  const signals = [];
  child.kill = (signal) => {
    signals.push(signal);
    return true;
  };
  child.stderr = new EventEmitter();
  child.stdout = new EventEmitter();
  return { child, signals };
}

function assertSignalListenersRemoved(processRef) {
  for (const signal of forwardedSignals) {
    assert.equal(processRef.listenerCount(signal), 0);
  }
}

test("rolls back the first output when staging the second dependency fails", async (t) => {
  const fixture = await createOutputFixture(t);
  const failingFileSystem = {
    lstat: async (path) => {
      if (path === fixture.sources[1]) {
        throw new Error("second dependency cannot be staged");
      }
      return lstat(path);
    },
    rename,
    rm,
  };

  await assert.rejects(
    stageDependencyOutputs({
      dependencyOutputs: fixture.sources,
      fileSystem: failingFileSystem,
      stagingDirectory: fixture.stagingDirectory,
    }),
    /second dependency cannot be staged/,
  );

  await assertOriginalOutputs(fixture);
  await assertMissing(resolve(fixture.stagingDirectory, "dependency-0"));
  await assertMissing(resolve(fixture.stagingDirectory, "dependency-1"));
});

test("fails closed without replacing a pre-existing backup", async (t) => {
  const fixture = await createOutputFixture(t);
  const collision = resolve(fixture.stagingDirectory, "dependency-1");
  await writeFile(collision, "preserve this backup");

  await assert.rejects(
    stageDependencyOutputs({
      dependencyOutputs: fixture.sources,
      stagingDirectory: fixture.stagingDirectory,
    }),
    /Backup path already exists/,
  );

  await assertOriginalOutputs(fixture);
  assert.equal(await readFile(collision, "utf8"), "preserve this backup");
  await assertMissing(resolve(fixture.stagingDirectory, "dependency-0"));
});

test("retries a failed staging rollback before removing the temporary directory", async (t) => {
  const fixture = await createOutputFixture(t);
  const firstBackup = resolve(fixture.stagingDirectory, "dependency-0");
  let failFirstRollback = true;
  const unstableFileSystem = {
    lstat: async (path) => {
      if (path === fixture.sources[1]) {
        throw new Error("second dependency cannot be staged");
      }
      return lstat(path);
    },
    rename: async (from, to) => {
      if (
        from === firstBackup &&
        to === fixture.sources[0] &&
        failFirstRollback
      ) {
        failFirstRollback = false;
        throw new Error("first rollback attempt failed");
      }
      return rename(from, to);
    },
    rm,
  };

  await assert.rejects(
    runCleanProductionRouterCheck({
      createStagingDirectory: async () => fixture.stagingDirectory,
      dependencyOutputs: fixture.sources,
      fileSystem: unstableFileSystem,
      startCheck: () => {
        throw new Error("the production child must not start after staging");
      },
    }),
    /staging failed and rollback failed/,
  );

  await assertOriginalOutputs(fixture);
  await assertMissing(firstBackup);
});

test("restores staged outputs after a parent termination signal settles the child", async (t) => {
  const fixture = await createOutputFixture(t);
  const processRef = new EventEmitter();
  processRef.execPath = process.execPath;
  const childFixture = fakeProductionRouterChild();
  let resolveStarted;
  const started = new Promise((resolvePromise) => {
    resolveStarted = resolvePromise;
  });
  const completion = runCleanProductionRouterCheck({
    createStagingDirectory: async () => fixture.stagingDirectory,
    dependencyOutputs: fixture.sources,
    processRef,
    startCheck: () => {
      const runner = startProductionRouterCheck({
        environment: { npm_execpath: pnpmFixturePath },
        processRef,
        spawnChild: () => childFixture.child,
      });
      resolveStarted();
      return runner;
    },
  });

  await started;
  await assertMissing(fixture.sources[0]);
  await assertMissing(fixture.sources[1]);

  processRef.emit("SIGTERM");
  processRef.emit("SIGTERM");
  processRef.emit("SIGHUP");
  processRef.emit("SIGINT");
  assert.deepEqual(childFixture.signals, ["SIGTERM"]);
  childFixture.child.emit("exit", null, "SIGTERM");

  await assert.rejects(completion, /interrupted by SIGTERM/);
  await assertOriginalOutputs(fixture);
  assertSignalListenersRemoved(processRef);
});

test(
  "keeps handling repeated SIGTERM until real-process restoration and cleanup finish",
  { timeout: 15_000 },
  async (t) => {
    const root = await mkdtemp(
      resolve(tmpdir(), "revelai-clean-dist-signal-probe-"),
    );
    let probe;
    t.after(async () => {
      if (probe && probe.exitCode === null && probe.signalCode === null) {
        probe.kill("SIGKILL");
        await waitForProbeExit(probe, 1_000).catch(() => {});
      }
      await rm(root, { force: true, recursive: true });
    });

    let output = "";
    probe = spawn(process.execPath, [signalProbePath], {
      env: { ...process.env, REVELAI_CLEAN_SIGNAL_PROBE_ROOT: root },
      stdio: ["pipe", "pipe", "pipe"],
    });
    probe.stdout.on("data", (chunk) => {
      output += chunk;
    });
    probe.stderr.on("data", (chunk) => {
      output += chunk;
    });

    await waitForProbeOutput(
      probe,
      () => output,
      "child-ready",
      "signal probe",
    );
    assert.equal(probe.kill("SIGTERM"), true);
    await waitForProbeOutput(
      probe,
      () => output,
      "restoration-held",
      "signal probe",
    );

    assert.equal(probe.kill("SIGTERM"), true);
    assert.equal(probe.kill("SIGTERM"), true);
    await delay(100);
    assert.equal(probe.exitCode, null, output);
    assert.equal(probe.signalCode, null, output);

    probe.stdin.end("release-restoration\n");
    const result = await waitForProbeExit(probe);

    assert.deepEqual(result, { code: 0, signal: null }, output);
    assert.equal(output.split("forwarded:SIGTERM").length - 1, 1, output);
    assert.match(output, /sentinel-written/);
    assert.equal(
      await readFile(resolve(root, "restoration-sentinel.txt"), "utf8"),
      "restored-after-listener-cleanup",
    );
  },
);

test(
  "builds the production router from clean web dependency outputs and restores them",
  { timeout: 180_000 },
  async () => {
    await runCleanProductionRouterCheck();
  },
);
