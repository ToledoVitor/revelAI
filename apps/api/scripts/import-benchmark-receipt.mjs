import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { parseApiEnv } from "@revelai/config";
import { WorkflowBenchmarkReceiptSchema } from "@revelai/contracts";
import { openSqliteDatabase } from "../dist/database/sqlite-database.js";
import { SQLiteCompetitivePolicyRepository } from "../dist/repositories/sqlite-competitive-policy-repository.js";

if (process.argv.includes("--help")) {
  console.log(
    "Set REVELAI_BENCHMARK_RECEIPT_FILE and optionally REVELAI_ACTIVATE_COMPETITIVE_POLICY=true.",
  );
} else {
  let database;
  try {
    const receiptFile = process.env.REVELAI_BENCHMARK_RECEIPT_FILE;
    if (!receiptFile) throw new Error("missing receipt");
    const receipt = WorkflowBenchmarkReceiptSchema.parse(
      JSON.parse(await readFile(receiptFile, "utf8")),
    );
    const config = parseApiEnv(process.env);
    database = openSqliteDatabase(config.paths.databasePath);
    const policy = new SQLiteCompetitivePolicyRepository({
      database,
      clock: { now: () => new Date().toISOString() },
    });
    await policy.storeBenchmarkReceipt(receipt);
    if (process.env.REVELAI_ACTIVATE_COMPETITIVE_POLICY === "true") {
      await policy.activateCompetitivePolicy({
        id: randomUUID(),
        receiptId: receipt.id,
        receiptSha256: receipt.receiptSha256,
        receiptSchemaVersion: receipt.schemaVersion,
        workspaceId: receipt.workflow.workspaceId,
        modelBundleId: receipt.workflow.modelBundleId,
        workflowId: receipt.workflow.workflowId,
        workflowVersion: receipt.workflow.workflowVersion,
        providerVersion: receipt.workflow.providerVersion,
        calibrationEvidenceVersion: receipt.evidence.calibrationEvidenceVersion,
        extractionEvidenceVersion: receipt.evidence.extractionEvidenceVersion,
        observationEvidenceVersion: receipt.evidence.observationEvidenceVersion,
        challengeId: "wall-pass",
        challengeVersion: 1,
        ruleVersion: "wall-pass-v1-score-1",
      });
      console.log("Benchmark receipt stored and competitive policy activated.");
    } else {
      console.log("Benchmark receipt stored without policy activation.");
    }
  } catch {
    console.error("Benchmark receipt import or activation was not completed.");
    process.exitCode = 1;
  } finally {
    database?.close();
  }
}
