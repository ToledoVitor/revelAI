import {
  UtcIsoTimestampSchema,
  WorkflowBenchmarkInvalidationReasonSchema,
  WorkflowBenchmarkReceiptSchema,
  type UtcIsoTimestamp,
  type WorkflowBenchmarkInvalidationReason,
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
      | "competitive_policy_conflict"
      | "competitive_policy_invalid_invalidation"
      | "competitive_policy_persisted_data_corrupt",
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
          "SELECT r.receipt_sha256, r.schema_version, r.workflow_id, r.workflow_version, r.model_bundle_id, r.provider_version, r.status, r.valid_until, r.invalidated_at, r.receipt_json, i.receipt_id AS invalidation_receipt_id FROM workflow_benchmark_receipts r LEFT JOIN workflow_benchmark_receipt_invalidations i ON i.receipt_id = r.id WHERE r.id = ?",
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
            receipt_json: string;
            invalidation_receipt_id: string | null;
          }
        | undefined;
      if (!receipt)
        throw new CompetitivePolicyRepositoryError(
          "competitive_policy_receipt_not_found",
        );
      if (
        receipt.status !== "passed" ||
        receipt.valid_until <= this.clock.now() ||
        receipt.invalidated_at !== null ||
        receipt.invalidation_receipt_id !== null
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
      assertReceiptRowMatches({
        id: input.receiptId,
        receiptSha256: receipt.receipt_sha256,
        schemaVersion: receipt.schema_version,
        workflowId: receipt.workflow_id,
        workflowVersion: receipt.workflow_version,
        modelBundleId: receipt.model_bundle_id,
        providerVersion: receipt.provider_version,
        receiptJson: receipt.receipt_json,
      });
      try {
        this.raw
          .prepare(
            "UPDATE approved_competitive_model_policies SET active = 0 WHERE active = 1 AND model_bundle_id = ? AND workflow_id = ? AND workflow_version = ? AND provider_version = ? AND calibration_evidence_version = ? AND challenge_id = ? AND challenge_version = ? AND rule_version = ?",
          )
          .run(
            input.modelBundleId,
            input.workflowId,
            input.workflowVersion,
            input.providerVersion,
            input.calibrationEvidenceVersion,
            input.challengeId,
            input.challengeVersion,
            input.ruleVersion,
          );
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

  public async deactivateCompetitivePolicy(
    input: Readonly<{ id: string }>,
  ): Promise<void> {
    await this.transaction(() => {
      this.raw
        .prepare(
          "UPDATE approved_competitive_model_policies SET active = 0 WHERE id = ? AND active = 1",
        )
        .run(input.id);
    });
  }

  public async invalidateBenchmarkReceipt(
    input: Readonly<{
      receiptId: string;
      invalidatedAt: UtcIsoTimestamp;
      reason: WorkflowBenchmarkInvalidationReason;
    }>,
  ): Promise<void> {
    if (
      !UtcIsoTimestampSchema.safeParse(input.invalidatedAt).success ||
      !WorkflowBenchmarkInvalidationReasonSchema.safeParse(input.reason).success
    )
      throw new CompetitivePolicyRepositoryError(
        "competitive_policy_invalid_invalidation",
      );
    const invalidatedAt = new Date(input.invalidatedAt).toISOString();
    await this.transaction(() => {
      const receipt = this.raw
        .prepare("SELECT id FROM workflow_benchmark_receipts WHERE id = ?")
        .get(input.receiptId) as { id: string } | undefined;
      if (!receipt)
        throw new CompetitivePolicyRepositoryError(
          "competitive_policy_receipt_not_found",
        );
      const existing = this.raw
        .prepare(
          "SELECT invalidated_at, reason FROM workflow_benchmark_receipt_invalidations WHERE receipt_id = ?",
        )
        .get(input.receiptId) as
        | { invalidated_at: string; reason: string }
        | undefined;
      if (existing) {
        if (
          existing.invalidated_at === invalidatedAt &&
          existing.reason === input.reason
        )
          return;
        throw new CompetitivePolicyRepositoryError(
          "competitive_policy_conflict",
        );
      }
      try {
        this.raw
          .prepare(
            "INSERT INTO workflow_benchmark_receipt_invalidations (receipt_id, invalidated_at, reason, created_at) VALUES (?, ?, ?, ?)",
          )
          .run(input.receiptId, invalidatedAt, input.reason, this.clock.now());
      } catch (error) {
        if (isSqliteConstraintError(error))
          throw new CompetitivePolicyRepositoryError(
            "competitive_policy_invalid_invalidation",
          );
        throw error;
      }
    });
  }

  public async getActiveCompetitivePolicy(
    tuple: CompetitivePolicyTuple,
  ): Promise<CompetitivePolicyActivation | null> {
    const row = this.raw
      .prepare(
        `SELECT p.id, p.receipt_id, p.receipt_sha256, p.receipt_schema_version, p.model_bundle_id, p.workflow_id, p.workflow_version, p.provider_version, p.calibration_evidence_version, p.challenge_id, p.challenge_version, p.rule_version,
                r.receipt_json, r.receipt_sha256 AS source_receipt_sha256, r.schema_version AS source_schema_version, r.model_bundle_id AS source_model_bundle_id, r.workflow_id AS source_workflow_id, r.workflow_version AS source_workflow_version, r.provider_version AS source_provider_version
         FROM approved_competitive_model_policies p
         INNER JOIN workflow_benchmark_receipts r
           ON r.id = p.receipt_id
          AND r.receipt_sha256 = p.receipt_sha256
          AND r.schema_version = p.receipt_schema_version
          AND r.model_bundle_id = p.model_bundle_id
          AND r.workflow_id = p.workflow_id
          AND r.workflow_version = p.workflow_version
          AND r.provider_version = p.provider_version
         LEFT JOIN workflow_benchmark_receipt_invalidations i ON i.receipt_id = r.id
         WHERE p.active = 1 AND r.status = 'passed' AND r.invalidated_at IS NULL AND i.receipt_id IS NULL AND r.valid_until > ?
           AND p.model_bundle_id = ? AND p.workflow_id = ? AND p.workflow_version = ? AND p.provider_version = ? AND p.calibration_evidence_version = ? AND p.challenge_id = ? AND p.challenge_version = ? AND p.rule_version = ?`,
      )
      .get(
        this.clock.now(),
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
    return parsePolicyRow(row);
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

function isSqliteConstraintError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code.startsWith("SQLITE_CONSTRAINT")
  );
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

function assertReceiptRowMatches(
  input: Readonly<{
    id: string;
    receiptSha256: string;
    schemaVersion: string;
    modelBundleId: string;
    workflowId: string;
    workflowVersion: string;
    providerVersion: string;
    receiptJson: string;
  }>,
): void {
  let receipt: WorkflowBenchmarkReceipt;
  try {
    const parsed = WorkflowBenchmarkReceiptSchema.safeParse(
      JSON.parse(input.receiptJson),
    );
    if (!parsed.success) throw new Error("invalid receipt");
    receipt = parsed.data;
  } catch {
    throw new CompetitivePolicyRepositoryError(
      "competitive_policy_persisted_data_corrupt",
    );
  }
  if (
    receipt.id !== input.id ||
    receipt.receiptSha256 !== input.receiptSha256 ||
    receipt.schemaVersion !== input.schemaVersion ||
    receipt.workflow.modelBundleId !== input.modelBundleId ||
    receipt.workflow.workflowId !== input.workflowId ||
    receipt.workflow.workflowVersion !== input.workflowVersion ||
    receipt.workflow.providerVersion !== input.providerVersion
  )
    throw new CompetitivePolicyRepositoryError(
      "competitive_policy_persisted_data_corrupt",
    );
}

function parsePolicyRow(row: unknown): CompetitivePolicyActivation {
  if (!row || typeof row !== "object")
    throw new CompetitivePolicyRepositoryError(
      "competitive_policy_persisted_data_corrupt",
    );
  const value = row as Record<string, unknown>;
  const strings = [
    "id",
    "receipt_id",
    "receipt_sha256",
    "receipt_schema_version",
    "model_bundle_id",
    "workflow_id",
    "workflow_version",
    "provider_version",
    "calibration_evidence_version",
    "challenge_id",
    "rule_version",
    "receipt_json",
    "source_receipt_sha256",
    "source_schema_version",
    "source_model_bundle_id",
    "source_workflow_id",
    "source_workflow_version",
    "source_provider_version",
  ];
  if (strings.some((key) => typeof value[key] !== "string"))
    throw new CompetitivePolicyRepositoryError(
      "competitive_policy_persisted_data_corrupt",
    );
  if (
    value.receipt_schema_version !== "workflow-benchmark-receipt-v1" ||
    value.workflow_id !== "revelai-wall-pass-geometry-v1" ||
    value.workflow_version !== "1.0.0" ||
    value.challenge_id !== "wall-pass" ||
    typeof value.challenge_version !== "number" ||
    value.challenge_version !== 1 ||
    value.rule_version !== "wall-pass-v1-score-1"
  )
    throw new CompetitivePolicyRepositoryError(
      "competitive_policy_persisted_data_corrupt",
    );
  assertReceiptRowMatches({
    id: value.receipt_id as string,
    receiptSha256: value.source_receipt_sha256 as string,
    schemaVersion: value.source_schema_version as string,
    modelBundleId: value.source_model_bundle_id as string,
    workflowId: value.source_workflow_id as string,
    workflowVersion: value.source_workflow_version as string,
    providerVersion: value.source_provider_version as string,
    receiptJson: value.receipt_json as string,
  });
  return Object.freeze({
    id: value.id as string,
    receiptId: value.receipt_id as string,
    receiptSha256: value.receipt_sha256 as string,
    receiptSchemaVersion: "workflow-benchmark-receipt-v1",
    modelBundleId: value.model_bundle_id as string,
    workflowId: "revelai-wall-pass-geometry-v1",
    workflowVersion: "1.0.0",
    providerVersion: value.provider_version as string,
    calibrationEvidenceVersion: value.calibration_evidence_version as string,
    challengeId: "wall-pass",
    challengeVersion: 1,
    ruleVersion: "wall-pass-v1-score-1",
  });
}
