import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { passingWorkflowBenchmarkReceiptFixture } from "@revelai/contracts";
import { openSqliteDatabase } from "../dist/database/sqlite-database.js";

const directory = await mkdtemp(join(tmpdir(), "revelai-operator-receipt-"));
const receiptPath = join(directory, "receipt.json");
const databasePath = join(directory, "operator.sqlite");
const privateMissingReceiptPath = join(
  directory,
  "receipt-private-marker.json",
);
const importScript = fileURLToPath(
  new URL("./import-benchmark-receipt.mjs", import.meta.url),
);
const environment = {
  ...process.env,
  DATA_DIR: join(directory, "data"),
  MEDIA_DIR: join(directory, "media"),
  DATABASE_PATH: databasePath,
};

try {
  await writeFile(
    receiptPath,
    JSON.stringify(passingWorkflowBenchmarkReceiptFixture),
  );
  await expectSuccess({
    ...environment,
    REVELAI_BENCHMARK_RECEIPT_FILE: receiptPath,
  });
  assertDatabase({ activePolicy: false });
  await expectSuccess({
    ...environment,
    REVELAI_BENCHMARK_RECEIPT_FILE: receiptPath,
    REVELAI_ACTIVATE_COMPETITIVE_POLICY: "true",
  });
  assertDatabase({ activePolicy: true });
  const failed = await invoke({
    ...environment,
    REVELAI_BENCHMARK_RECEIPT_FILE: privateMissingReceiptPath,
  });
  if (
    failed.exitCode !== 1 ||
    failed.stdout !== "" ||
    failed.stderr !==
      "Benchmark receipt import or activation was not completed.\n" ||
    failed.stderr.includes(privateMissingReceiptPath)
  )
    throw new Error("Operator receipt failure was not safely redacted.");
  console.log("Operator receipt import smoke passed.");
} catch {
  console.error("Operator receipt import smoke failed.");
  process.exitCode = 1;
} finally {
  await rm(directory, { recursive: true, force: true });
}

async function expectSuccess(env) {
  const result = await invoke(env);
  if (result.exitCode !== 0 || result.stderr !== "")
    throw new Error("Operator receipt command did not complete.");
}

function assertDatabase(input) {
  const database = openSqliteDatabase(databasePath);
  try {
    const receipt = database.raw
      .prepare("SELECT id FROM workflow_benchmark_receipts WHERE id = ?")
      .get(passingWorkflowBenchmarkReceiptFixture.id);
    const policy = database.raw
      .prepare(
        "SELECT id FROM approved_competitive_model_policies WHERE active = 1",
      )
      .get();
    if (!receipt || Boolean(policy) !== input.activePolicy)
      throw new Error("Operator receipt persistence state was incorrect.");
  } finally {
    database.close();
  }
}

async function invoke(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [importScript], {
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
