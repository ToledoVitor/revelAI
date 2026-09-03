import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, rename } from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const webRoot = fileURLToPath(new URL("../", import.meta.url));
const apiPort = 4174;
const webPort = 4175;
const wrapperTimeoutMilliseconds = 3_000;
const terminationGraceMilliseconds = 250;
const ownedShutdownTimeoutMilliseconds = 2_000;
const resistantChild = resolve(
  webRoot,
  "scripts/fixtures/demo-e2e-resistant-child.mjs",
);
const pretryFailureChild = resolve(
  webRoot,
  "scripts/fixtures/demo-e2e-pretry-failure-child.mjs",
);

test(
  "rejects a foreign health response instead of treating it as the spawned API",
  async () => {
    await assertPortAvailable(webPort);
    await withApiPortBlocker("health", async () => {
      const result = await invokeWrapper();

      assert.equal(result.termination, "completed");
      assert.equal(result.exitCode, 1);
      assert.match(result.output, /RevelAI demo E2E server failed to start\./);
      assert.doesNotMatch(result.output, new RegExp(escapeRegExp(webRoot)));
    });
  },
  wrapperTimeoutMilliseconds + terminationGraceMilliseconds + 2_000,
);

test(
  "rejects a foreign API socket that accepts a health probe but never responds",
  async () => {
    await assertPortAvailable(webPort);
    await withApiPortBlocker("hanging", async () => {
      const result = await invokeWrapper();

      assert.equal(result.termination, "completed");
      assert.equal(result.exitCode, 1);
      assert.match(result.output, /RevelAI demo E2E server failed to start\./);
      assert.doesNotMatch(result.output, new RegExp(escapeRegExp(webRoot)));
    });
  },
  wrapperTimeoutMilliseconds + terminationGraceMilliseconds + 2_000,
);

test("sanitizes wrapper setup failures that contain a local absolute path", async () => {
  const index = resolve(webRoot, "dist/index.html");
  const withheldIndex = `${index}.w6-test-withheld`;
  await access(index);
  await assert.rejects(access(withheldIndex));
  await rename(index, withheldIndex);
  try {
    const result = await invokeWrapper();

    assert.equal(result.termination, "completed");
    assert.equal(result.exitCode, 1);
    assert.equal(result.output, "RevelAI demo E2E server failed to start.\n");
    assert.doesNotMatch(result.output, new RegExp(escapeRegExp(webRoot)));
  } finally {
    await rename(withheldIndex, index);
  }
});

test("does not forward a child failure before local-demo setup", async () => {
  const secret = "w6-child-pretry-secret";
  const result = await invokeWrapper({
    environment: { DEMO_E2E_TEST_SECRET: secret, NODE_ENV: "test" },
    testApiEntry: pretryFailureChild,
  });

  assert.equal(result.termination, "completed");
  assert.equal(result.exitCode, 1);
  assert.equal(result.output, "RevelAI demo E2E server failed to start.\n");
  assert.doesNotMatch(result.output, new RegExp(escapeRegExp(webRoot)));
  assert.doesNotMatch(result.output, /ERR_MODULE_NOT_FOUND|\bat\s/);
  assert.doesNotMatch(result.output, new RegExp(secret));
});

test("releases both demo ports after a successful wrapper run", async () => {
  await assertPortAvailable(apiPort);
  await assertPortAvailable(webPort);
  const wrapper = launchWrapper();
  try {
    await waitForWrapperHealth(wrapper);
    const exitCode = await stopWrapper(wrapper);

    assert.equal(exitCode, 0);
    await assertPortAvailable(apiPort);
    await assertPortAvailable(webPort);
  } finally {
    await stopOwnedWrapperGroup(wrapper);
  }
});

test("force-stops only its owned resistant child before returning demo ports", async () => {
  await assertPortAvailable(apiPort);
  await assertPortAvailable(webPort);
  const wrapper = launchWrapper({
    environment: { NODE_ENV: "test" },
    testApiEntry: resistantChild,
  });
  try {
    await waitForWrapperHealth(wrapper);
    const exitCode = await stopWrapper(wrapper);

    assert.equal(exitCode, 0);
    await assertPortAvailable(apiPort);
    await assertPortAvailable(webPort);
  } finally {
    await stopOwnedWrapperGroup(wrapper);
  }
});

async function withApiPortBlocker(kind, callback) {
  const blocker = createServer((_request, response) => {
    if (kind === "health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"status":"ok"}');
    }
  });
  await listen(blocker, apiPort);
  try {
    await callback();
  } finally {
    await close(blocker);
  }
}

function invokeWrapper(options = {}) {
  return new Promise((resolveResult, rejectResult) => {
    const child = launchWrapper(options);
    let output = "";
    let termination = "completed";
    let forceKill;
    const timeout = setTimeout(() => {
      termination = "timed_out";
      child.kill("SIGTERM");
      forceKill = setTimeout(
        () => child.kill("SIGKILL"),
        terminationGraceMilliseconds,
      );
      forceKill.unref();
    }, wrapperTimeoutMilliseconds);
    timeout.unref();

    const capture = (chunk) => {
      output += chunk.toString("utf8");
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    child.once("error", rejectResult);
    child.once("close", (exitCode) => {
      clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
      resolveResult({
        exitCode: exitCode ?? 1,
        output,
        termination,
      });
    });
  });
}

function launchWrapper({ environment = {}, testApiEntry } = {}) {
  const args = ["scripts/start-demo-e2e-server.mjs", "--serve-check"];
  if (testApiEntry) args.push(`--test-api-entry=${testApiEntry}`);
  const child = spawn(process.execPath, args, {
    cwd: webRoot,
    detached: true,
    env: {
      ...process.env,
      REVELAI_DEMO_E2E: "true",
      ...environment,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.resume();
  child.stderr.resume();
  return child;
}

async function waitForWrapperHealth(child) {
  const deadline = Date.now() + wrapperTimeoutMilliseconds;
  while (Date.now() < deadline) {
    if (child.exitCode !== null)
      throw new Error(
        "Demo wrapper exited before its web server became ready.",
      );
    try {
      const response = await fetch("http://127.0.0.1:4175/health", {
        signal: AbortSignal.timeout(100),
      });
      if (response.ok) return;
    } catch {
      // The owned wrapper has not bound the Web port yet.
    }
    await new Promise((resolveTimer) => setTimeout(resolveTimer, 25));
  }
  throw new Error("Demo wrapper did not become ready within its test budget.");
}

async function stopWrapper(child) {
  if (child.exitCode !== null) return child.exitCode;
  child.kill("SIGTERM");
  const exitCode = await waitForClose(child, ownedShutdownTimeoutMilliseconds);
  if (exitCode === undefined)
    throw new Error("Owned demo wrapper did not close after shutdown.");
  return exitCode;
}

function waitForClose(child, timeoutMilliseconds) {
  return new Promise((resolveClose) => {
    const close = (exitCode) => {
      clearTimeout(timeout);
      resolveClose(exitCode ?? 1);
    };
    const timeout = setTimeout(() => {
      child.off("close", close);
      resolveClose(undefined);
    }, timeoutMilliseconds);
    child.once("close", close);
  });
}

async function stopOwnedWrapperGroup(wrapper) {
  if (!wrapper.pid) return;
  try {
    process.kill(-wrapper.pid, "SIGKILL");
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
  await waitForClose(wrapper, terminationGraceMilliseconds);
}

function listen(server, port) {
  return new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });
}

async function assertPortAvailable(port) {
  const reservation = createServer();
  await listen(reservation, port);
  await close(reservation);
}

function close(server) {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolveClose, rejectClose) =>
    server.close((error) => (error ? rejectClose(error) : resolveClose())),
  );
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
