import {
  WorkflowBenchmarkReceiptSchema,
  type WorkflowBenchmarkReceipt,
} from "@revelai/contracts";
import type { SqliteDatabase } from "../database/sqlite-database.js";
import type {
  CompetitivePolicyActivation,
  CompetitivePolicyRepository,
  CompetitivePolicyTuple,
} from "./competitive-policy-repository.js";

export type PolicyClock = Readonly<{ now(): string }>;

export class CompetitivePolicyRepositoryError extends Error {
  public constructor(
    public readonly code:
      | "competitive_policy_receipt_not_found"
      | "competitive_policy_receipt_not_approved"
      | "competitive_policy_receipt_mismatch"
      | "competitive_policy_conflict",
  ) {
    super(code);
    this.name = "CompetitivePolicyRepositoryError";
  }
}

export class SQLiteCompetitivePolicyRepository
  implements CompetitivePolicyRepository
{
  private readonly raw;
  private readonly clock: PolicyClock;

  public constructor(
    input: Readonly<{ database: SqliteDatabase; clock: PolicyClock }>,
  ) {
    this.raw = input.database.raw;
    this.clock = input.clock;
  }

  public async storeBenchmarkReceipt(
    receipt: unknown,
  ): Promise<WorkflowBenchmarkReceipt> {
    const parsed = WorkflowBenchmarkReceiptSchema.parse(receipt);
    return this.transaction(() => {
      const existing = this.raw
        .prepare(
          "SELECT receipt_sha256, receipt_json FROM workflow_benchmark_receipts WHERE id = ?",
        )
        .get(parsed.id) as
        | { receipt_sha256: string; receipt_json: string }
        | undefined;
      if (existing) {
        if (
          existing.receipt_sha256 === parsed.receiptSha256 &&
          existing.receipt_json === stableJson(parsed)
        )
          return parsed;
        throw new CompetitivePolicyRepositoryError(
          "competitive_policy_conflict",
        );
      }
      const sameHash = this.raw
        .prepare(
          "SELECT id FROM workflow_benchmark_receipts WHERE receipt_sha256 = ?",
        )
        .get(parsed.receiptSha256) as { id: string } | undefined;
      if (sameHash)
        throw new CompetitivePolicyRepositoryError(
          "competitive_policy_conflict",
        );
      this.raw
        .prepare(
          "INSERT INTO workflow_benchmark_receipts (id, receipt_sha256, schema_version, workflow_id, workflow_version, model_bundle_id, provider_version, status, run_at, valid_until, invalidated_at, receipt_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          parsed.id,
          parsed.receiptSha256,
          parsed.schemaVersion,
          parsed.workflow.workflowId,
          parsed.workflow.workflowVersion,
          parsed.workflow.modelBundleId,
          parsed.workflow.providerVersion,
          parsed.status,
          parsed.runAt,
          parsed.validUntil,
          parsed.invalidatedAt,
          stableJson(parsed),
          this.clock.now(),
        );
      return parsed;
    });
  }

  public async activateCompetitivePolicy(
    input: CompetitivePolicyActivation,
  ): Promise<void> {
    await this.transaction(() => {
      const receipt = this.raw
        .prepare(
          "SELECT receipt_sha256, schema_version, workflow_id, workflow_version, model_bundle_id, provider_version, status, valid_until, invalidated_at FROM workflow_benchmark_receipts WHERE id = ?",
        )
        .get(input.receiptId) as
        | {
            receipt_sha256: string;
            schema_version: string;
            workflow_id: string;
            workflow_version: string;
            model_bundle_id: string;
            provider_version: string;
            status: string;
            valid_until: string;
            invalidated_at: string | null;
          }
        | undefined;
      if (!receipt)
        throw new CompetitivePolicyRepositoryError(
          "competitive_policy_receipt_not_found",
        );
      if (
        receipt.status !== "passed" ||
        receipt.valid_until <= this.clock.now() ||
        receipt.invalidated_at !== null
      )
        throw new CompetitivePolicyRepositoryError(
          "competitive_policy_receipt_not_approved",
        );
      if (
        receipt.receipt_sha256 !== input.receiptSha256 ||
        receipt.schema_version !== input.receiptSchemaVersion ||
        receipt.workflow_id !== input.workflowId ||
        receipt.workflow_version !== input.workflowVersion ||
        receipt.model_bundle_id !== input.modelBundleId ||
        receipt.provider_version !== input.providerVersion
      )
        throw new CompetitivePolicyRepositoryError(
          "competitive_policy_receipt_mismatch",
        );
      try {
        this.raw
          .prepare(
            "INSERT INTO approved_competitive_model_policies (id, receipt_id, receipt_sha256, receipt_schema_version, model_bundle_id, workflow_id, workflow_version, provider_version, calibration_evidence_version, challenge_id, challenge_version, rule_version, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)",
          )
          .run(
            input.id,
            input.receiptId,
            input.receiptSha256,
            input.receiptSchemaVersion,
            input.modelBundleId,
            input.workflowId,
            input.workflowVersion,
            input.providerVersion,
            input.calibrationEvidenceVersion,
            input.challengeId,
            input.challengeVersion,
            input.ruleVersion,
            this.clock.now(),
          );
      } catch {
        throw new CompetitivePolicyRepositoryError(
          "competitive_policy_conflict",
        );
      }
    });
  }

  public async getActiveCompetitivePolicy(
    tuple: CompetitivePolicyTuple,
  ): Promise<CompetitivePolicyActivation | null> {
    const row = this.raw
      .prepare(
        "SELECT id, receipt_id, receipt_sha256, receipt_schema_version, model_bundle_id, workflow_id, workflow_version, provider_version, calibration_evidence_version, challenge_id, challenge_version, rule_version FROM approved_competitive_model_policies WHERE active = 1 AND model_bundle_id = ? AND workflow_id = ? AND workflow_version = ? AND provider_version = ? AND calibration_evidence_version = ? AND challenge_id = ? AND challenge_version = ? AND rule_version = ?",
      )
      .get(
        tuple.modelBundleId,
        tuple.workflowId,
        tuple.workflowVersion,
        tuple.providerVersion,
        tuple.calibrationEvidenceVersion,
        tuple.challengeId,
        tuple.challengeVersion,
        tuple.ruleVersion,
      ) as Record<string, unknown> | undefined;
    if (!row) return null;
    return Object.freeze({
      id: row.id as string,
      receiptId: row.receipt_id as string,
      receiptSha256: row.receipt_sha256 as string,
      receiptSchemaVersion:
        row.receipt_schema_version as "workflow-benchmark-receipt-v1",
      modelBundleId: row.model_bundle_id as string,
      workflowId: row.workflow_id as "revelai-wall-pass-geometry-v1",
      workflowVersion: row.workflow_version as "1.0.0",
      providerVersion: row.provider_version as string,
      calibrationEvidenceVersion: row.calibration_evidence_version as string,
      challengeId: row.challenge_id as "wall-pass",
      challengeVersion: row.challenge_version as 1,
      ruleVersion: row.rule_version as "wall-pass-v1-score-1",
    });
  }

  private transaction<T>(operation: () => T): T {
    this.raw.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.raw.exec("COMMIT");
      return result;
    } catch (error) {
      this.raw.exec("ROLLBACK");
      throw error;
    }
  }
}

function stableJson(value: unknown): string {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  )
    return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object")
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(",")}}`;
  throw new CompetitivePolicyRepositoryError("competitive_policy_conflict");
}
