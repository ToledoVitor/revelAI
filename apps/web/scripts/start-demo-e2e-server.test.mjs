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

function invokeWrapper() {
  return new Promise((resolveResult, rejectResult) => {
    const child = spawn(
      process.execPath,
      ["scripts/start-demo-e2e-server.mjs", "--serve-check"],
      {
        cwd: webRoot,
        env: { ...process.env, REVELAI_DEMO_E2E: "true" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
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
