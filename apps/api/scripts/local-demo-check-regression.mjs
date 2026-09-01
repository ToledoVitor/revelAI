import { spawn } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const directory = await mkdtemp(
  join(tmpdir(), "revelai-local-demo-check-env-"),
);
const externalDatabasePath = join(directory, "outside-check.sqlite");
const executable = fileURLToPath(
  new URL("./start-local-demo.mjs", import.meta.url),
);
let requests = 0;
const server = createServer((_request, response) => {
  requests += 1;
  response.statusCode = 500;
  response.end();
});

try {
  const port = await listen(server);
  const result = await invoke({
    ...process.env,
    DATABASE_PATH: externalDatabasePath,
    ROBOFLOW_API_URL: `http://127.0.0.1:${port}`,
    ROBOFLOW_WORKSPACE_ID: "poisoned-workspace",
    ROBOFLOW_WORKFLOW_VERSION: "1.0.0",
    ROBOFLOW_WALL_PASS_WORKFLOW_ID: "revelai-wall-pass-geometry-v1",
    ROBOFLOW_WALL_PASS_MODEL_BUNDLE_ID: "poisoned-wall-pass-bundle",
    ROBOFLOW_FREE_WORKFLOW_ID: "revelai-free-training-v1",
    ROBOFLOW_FREE_MODEL_BUNDLE_ID: "poisoned-free-bundle",
  });
  if (
    result.exitCode !== 0 ||
    result.stdout !== "Local demo terminal check passed.\n" ||
    result.stderr !== "" ||
    requests !== 0
  )
    throw new Error("Local demo check inherited provider configuration.");
  await expectAbsent(externalDatabasePath);
  console.log("Local demo hermetic check regression passed.");
} finally {
  await close(server);
  await rm(directory, { recursive: true, force: true });
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Local demo regression server did not bind."));
        return;
      }
      resolve(address.port);
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function invoke(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [executable, "--check"], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", reject);
    child.once("close", (exitCode) => {
      resolve({ exitCode: exitCode ?? 1, stdout, stderr });
    });
  });
}

async function expectAbsent(path) {
  try {
    await access(path);
  } catch {
    return;
  }
  throw new Error("Local demo check created the inherited database path.");
}
