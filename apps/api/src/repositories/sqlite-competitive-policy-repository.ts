import {
  UtcIsoTimestampSchema,
  WorkflowBenchmarkInvalidationReasonSchema,
  WorkflowBenchmarkReceiptSchema,
  type UtcIsoTimestamp,
  type WorkflowBenchmarkInvalidationReason,
  type WorkflowBenchmarkReceipt,
} from "@revelai/contracts";
import {
  isFactoryIssuedSqliteDatabase,
  resolveFactoryIssuedSqliteDatabaseCompositionToken,
  type SqliteDatabase,
  type SqliteDatabaseCompositionToken,
} from "../database/sqlite-database.js";
import type {
  CompetitivePolicyActivation,
  CompetitivePolicyActivationInput,
  CompetitivePolicyRepository,
  CompetitivePolicyTuple,
} from "./competitive-policy-repository.js";
import {
  CompetitivePolicyLookupUnavailableError,
  CompetitivePolicyRepositoryError,
  parseStoredBenchmarkReceipt,
} from "./competitive-policy-repository.js";

export type PolicyClock = Readonly<{ now(): string }>;

export type ProductionSQLiteCompetitivePolicyLookupPort = Readonly<{
  token: SqliteDatabaseCompositionToken;
  isCurrent(): boolean;
  lookup: Readonly<{
    getActivePolicy(
      tuple: CompetitivePolicyTuple,
    ): Promise<CompetitivePolicyActivation | null>;
  }>;
}>;

const productionSQLiteCompetitivePolicyLookupPorts = new WeakMap<
  object,
  ProductionSQLiteCompetitivePolicyLookupPort
>();

/** Resolves the immutable policy lookup for one exact production adapter. */
export function resolveProductionSQLiteCompetitivePolicyLookupPort(
  repository: unknown,
): ProductionSQLiteCompetitivePolicyLookupPort | undefined {
  if (typeof repository !== "object" || repository === null) return undefined;
  return productionSQLiteCompetitivePolicyLookupPorts.get(repository);
}

export class SQLiteCompetitivePolicyRepository
  implements CompetitivePolicyRepository
{
  readonly #raw;
  readonly #clock: PolicyClock;

  public constructor(
    input: Readonly<{ database: SqliteDatabase; clock: PolicyClock }>,
  ) {
    if (!isFactoryIssuedSqliteDatabase(input.database))
      throw new Error(
        "Competitive policy requires a factory-issued SQLite database capability.",
      );
    this.#raw = input.database.raw;
    this.#clock = input.clock;
    const token = resolveFactoryIssuedSqliteDatabaseCompositionToken(
      input.database,
    );
    if (!token)
      throw new Error(
        "Competitive policy factory database composition token is required.",
      );
    registerProductionSQLiteCompetitivePolicyLookupPort(this, token);
  }

  public async storeBenchmarkReceipt(
    receipt: unknown,
  ): Promise<WorkflowBenchmarkReceipt> {
    const parsed = WorkflowBenchmarkReceiptSchema.parse(receipt);
    return this.#transaction(() => {
      const existing = this.#raw
        .prepare(
          "SELECT receipt_sha256, schema_version, workflow_id, workflow_version, model_bundle_id, provider_version, status, run_at, valid_until, invalidated_at, receipt_json FROM workflow_benchmark_receipts WHERE id = ?",
        )
        .get(parsed.id) as
        | {
            receipt_sha256: string;
            schema_version: string;
            workflow_id: string;
            workflow_version: string;
            model_bundle_id: string;
            provider_version: string;
            status: string;
            run_at: string;
            valid_until: string;
            invalidated_at: string | null;
            receipt_json: string;
          }
        | undefined;
      if (existing) {
        if (
          existing.receipt_sha256 === parsed.receiptSha256 &&
          existing.receipt_json === stableJson(parsed)
        ) {
          parseStoredBenchmarkReceipt({
            id: parsed.id,
            receiptSha256: existing.receipt_sha256,
            schemaVersion: existing.schema_version,
            workflowId: existing.workflow_id,
            workflowVersion: existing.workflow_version,
            modelBundleId: existing.model_bundle_id,
            providerVersion: existing.provider_version,
            status: existing.status,
            runAt: existing.run_at,
            validUntil: existing.valid_until,
            invalidatedAt: existing.invalidated_at,
            receiptJson: existing.receipt_json,
          });
          return parsed;
        }
        throw new CompetitivePolicyRepositoryError(
          "competitive_policy_conflict",
        );
      }
      const sameHash = this.#raw
        .prepare(
          "SELECT id FROM workflow_benchmark_receipts WHERE receipt_sha256 = ?",
        )
        .get(parsed.receiptSha256) as { id: string } | undefined;
      if (sameHash)
        throw new CompetitivePolicyRepositoryError(
          "competitive_policy_conflict",
        );
      this.#raw
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
          this.#clock.now(),
        );
      return parsed;
    });
  }

  public async activateCompetitivePolicy(
    input: CompetitivePolicyActivationInput,
  ): Promise<void> {
    await this.#transaction(() => {
      const receipt = this.#raw
        .prepare(
          "SELECT r.receipt_sha256, r.schema_version, r.workflow_id, r.workflow_version, r.model_bundle_id, r.provider_version, r.status, r.run_at, r.valid_until, r.invalidated_at, r.receipt_json, i.receipt_id AS invalidation_receipt_id, q.receipt_id AS quarantined_invalidation_receipt_id FROM workflow_benchmark_receipts r LEFT JOIN workflow_benchmark_receipt_invalidations i ON i.receipt_id = r.id LEFT JOIN workflow_benchmark_receipt_invalidation_quarantine q ON q.receipt_id = r.id WHERE r.id = ?",
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
            run_at: string;
            valid_until: string;
            invalidated_at: string | null;
            receipt_json: string;
            invalidation_receipt_id: string | null;
            quarantined_invalidation_receipt_id: string | null;
          }
        | undefined;
      if (!receipt)
        throw new CompetitivePolicyRepositoryError(
          "competitive_policy_receipt_not_found",
        );
      if (
        receipt.status !== "passed" ||
        receipt.valid_until <= this.#clock.now() ||
        receipt.invalidated_at !== null ||
        receipt.invalidation_receipt_id !== null ||
        receipt.quarantined_invalidation_receipt_id !== null
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
      const parsedReceipt = assertReceiptRowMatches({
        id: input.receiptId,
        receiptSha256: receipt.receipt_sha256,
        schemaVersion: receipt.schema_version,
        workflowId: receipt.workflow_id,
        workflowVersion: receipt.workflow_version,
        modelBundleId: receipt.model_bundle_id,
        providerVersion: receipt.provider_version,
        status: receipt.status,
        runAt: receipt.run_at,
        validUntil: receipt.valid_until,
        invalidatedAt: receipt.invalidated_at,
        receiptJson: receipt.receipt_json,
      });
      if (
        parsedReceipt.workflow.workspaceId !== input.workspaceId ||
        parsedReceipt.evidence.calibrationEvidenceVersion !==
          input.calibrationEvidenceVersion ||
        parsedReceipt.evidence.extractionEvidenceVersion !==
          input.extractionEvidenceVersion ||
        parsedReceipt.evidence.observationEvidenceVersion !==
          input.observationEvidenceVersion
      )
        throw new CompetitivePolicyRepositoryError(
          "competitive_policy_receipt_mismatch",
        );
      try {
        this.#raw
          .prepare(
            "UPDATE approved_competitive_model_policies SET active = 0 WHERE active = 1 AND workspace_id = ? AND model_bundle_id = ? AND workflow_id = ? AND workflow_version = ? AND provider_version = ? AND calibration_evidence_version = ? AND extraction_evidence_version = ? AND observation_evidence_version = ? AND challenge_id = ? AND challenge_version = ? AND rule_version = ?",
          )
          .run(
            input.workspaceId,
            input.modelBundleId,
            input.workflowId,
            input.workflowVersion,
            input.providerVersion,
            input.calibrationEvidenceVersion,
            input.extractionEvidenceVersion,
            input.observationEvidenceVersion,
            input.challengeId,
            input.challengeVersion,
            input.ruleVersion,
          );
        this.#raw
          .prepare(
            "INSERT INTO approved_competitive_model_policies (id, receipt_id, receipt_sha256, receipt_schema_version, workspace_id, model_bundle_id, workflow_id, workflow_version, provider_version, calibration_evidence_version, extraction_evidence_version, observation_evidence_version, challenge_id, challenge_version, rule_version, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)",
          )
          .run(
            input.id,
            input.receiptId,
            input.receiptSha256,
            input.receiptSchemaVersion,
            input.workspaceId,
            input.modelBundleId,
            input.workflowId,
            input.workflowVersion,
            input.providerVersion,
            input.calibrationEvidenceVersion,
            input.extractionEvidenceVersion,
            input.observationEvidenceVersion,
            input.challengeId,
            input.challengeVersion,
            input.ruleVersion,
            this.#clock.now(),
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
    await this.#transaction(() => {
      this.#raw
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
    await this.#transaction(() => {
      const receipt = this.#raw
        .prepare("SELECT id FROM workflow_benchmark_receipts WHERE id = ?")
        .get(input.receiptId) as { id: string } | undefined;
      if (!receipt)
        throw new CompetitivePolicyRepositoryError(
          "competitive_policy_receipt_not_found",
        );
      const existing = this.#raw
        .prepare(
          `SELECT invalidated_at, reason, source FROM (
             SELECT invalidated_at, reason, 'primary' AS source
             FROM workflow_benchmark_receipt_invalidations
             WHERE receipt_id = ?
             UNION ALL
             SELECT invalidated_at, reason, 'quarantine' AS source
             FROM workflow_benchmark_receipt_invalidation_quarantine
             WHERE receipt_id = ?
           ) LIMIT 1`,
        )
        .get(input.receiptId, input.receiptId) as
        | {
            invalidated_at: string;
            reason: string;
            source: "primary" | "quarantine";
          }
        | undefined;
      if (existing) {
        const existingInvalidatedAt =
          existing.source === "quarantine"
            ? normalizeQuarantinedInvalidationTimestamp(existing.invalidated_at)
            : existing.invalidated_at;
        if (
          existingInvalidatedAt === invalidatedAt &&
          existing.reason === input.reason
        )
          return;
        throw new CompetitivePolicyRepositoryError(
          "competitive_policy_conflict",
        );
      }
      try {
        this.#raw
          .prepare(
            "INSERT INTO workflow_benchmark_receipt_invalidations (receipt_id, invalidated_at, reason, created_at) VALUES (?, ?, ?, ?)",
          )
          .run(input.receiptId, invalidatedAt, input.reason, this.#clock.now());
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
    let row: Record<string, unknown> | undefined;
    try {
      row = this.#raw
        .prepare(
          `SELECT p.id, p.receipt_id, p.receipt_sha256, p.receipt_schema_version, p.workspace_id, p.model_bundle_id, p.workflow_id, p.workflow_version, p.provider_version, p.calibration_evidence_version, p.extraction_evidence_version, p.observation_evidence_version, p.challenge_id, p.challenge_version, p.rule_version,
                r.receipt_json, r.receipt_sha256 AS source_receipt_sha256, r.schema_version AS source_schema_version, r.model_bundle_id AS source_model_bundle_id, r.workflow_id AS source_workflow_id, r.workflow_version AS source_workflow_version, r.provider_version AS source_provider_version, r.status AS source_status, r.run_at AS source_run_at, r.valid_until AS source_valid_until, r.invalidated_at AS source_invalidated_at
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
         LEFT JOIN workflow_benchmark_receipt_invalidation_quarantine q ON q.receipt_id = r.id
         WHERE p.active = 1 AND r.status = 'passed' AND r.invalidated_at IS NULL AND i.receipt_id IS NULL AND q.receipt_id IS NULL AND r.valid_until > ?
           AND p.workspace_id = ? AND p.model_bundle_id = ? AND p.workflow_id = ? AND p.workflow_version = ? AND p.provider_version = ? AND p.calibration_evidence_version = ? AND p.extraction_evidence_version = ? AND p.observation_evidence_version = ? AND p.challenge_id = ? AND p.challenge_version = ? AND p.rule_version = ?`,
        )
        .get(
          this.#clock.now(),
          tuple.workspaceId,
          tuple.modelBundleId,
          tuple.workflowId,
          tuple.workflowVersion,
          tuple.providerVersion,
          tuple.calibrationEvidenceVersion,
          tuple.extractionEvidenceVersion,
          tuple.observationEvidenceVersion,
          tuple.challengeId,
          tuple.challengeVersion,
          tuple.ruleVersion,
        ) as Record<string, unknown> | undefined;
    } catch (error) {
      if (error instanceof CompetitivePolicyRepositoryError) throw error;
      throw new CompetitivePolicyLookupUnavailableError();
    }
    if (!row) return null;
    return parsePolicyRow(row);
  }

  #transaction<T>(operation: () => T): T {
    this.#raw.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.#raw.exec("COMMIT");
      return result;
    } catch (error) {
      this.#raw.exec("ROLLBACK");
      throw error;
    }
  }
}

const exactGetActiveCompetitivePolicy =
  SQLiteCompetitivePolicyRepository.prototype.getActiveCompetitivePolicy;

function registerProductionSQLiteCompetitivePolicyLookupPort(
  repository: SQLiteCompetitivePolicyRepository,
  token: SqliteDatabaseCompositionToken,
): void {
  if (!isCurrentProductionSQLiteCompetitivePolicyRepository(repository)) return;
  productionSQLiteCompetitivePolicyLookupPorts.set(
    repository,
    Object.freeze({
      token,
      isCurrent: () =>
        isCurrentProductionSQLiteCompetitivePolicyRepository(repository),
      lookup: Object.freeze({
        getActivePolicy: (tuple: CompetitivePolicyTuple) =>
          exactGetActiveCompetitivePolicy.call(repository, tuple),
      }),
    }),
  );
}

function isCurrentProductionSQLiteCompetitivePolicyRepository(
  repository: SQLiteCompetitivePolicyRepository,
): boolean {
  return (
    Object.getPrototypeOf(repository) ===
      SQLiteCompetitivePolicyRepository.prototype &&
    !Object.hasOwn(repository, "getActiveCompetitivePolicy") &&
    SQLiteCompetitivePolicyRepository.prototype.getActiveCompetitivePolicy ===
      exactGetActiveCompetitivePolicy
  );
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

/**
 * v6 admitted hour 24. Its next-day representation is the only quarantined
 * timestamp that can be compared to the current UTC contract without changing
 * the archived raw fact. Other quarantined values remain conflict-only.
 */
function normalizeQuarantinedInvalidationTimestamp(
  value: string,
): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T24:(\d{2}):(\d{2})\.(\d{3})Z$/.exec(
    value,
  );
  if (!match) return null;
  const [, year, month, day, minute, second, millisecond] = match;
  const minuteValue = Number(minute);
  const secondValue = Number(second);
  if (minuteValue > 59 || secondValue > 59) return null;
  const midnight = new Date(`${year}-${month}-${day}T00:00:00.000Z`);
  if (
    Number.isNaN(midnight.getTime()) ||
    midnight.toISOString().slice(0, 10) !== `${year}-${month}-${day}`
  )
    return null;
  return new Date(
    midnight.getTime() +
      24 * 60 * 60_000 +
      minuteValue * 60_000 +
      secondValue * 1_000 +
      Number(millisecond),
  ).toISOString();
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
    status: string;
    runAt: string;
    validUntil: string;
    invalidatedAt: string | null;
    receiptJson: string;
  }>,
): WorkflowBenchmarkReceipt {
  return parseStoredBenchmarkReceipt(input);
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
    "workspace_id",
    "model_bundle_id",
    "workflow_id",
    "workflow_version",
    "provider_version",
    "calibration_evidence_version",
    "extraction_evidence_version",
    "observation_evidence_version",
    "challenge_id",
    "rule_version",
    "receipt_json",
    "source_receipt_sha256",
    "source_schema_version",
    "source_model_bundle_id",
    "source_workflow_id",
    "source_workflow_version",
    "source_provider_version",
    "source_status",
    "source_run_at",
    "source_valid_until",
  ];
  if (strings.some((key) => typeof value[key] !== "string"))
    throw new CompetitivePolicyRepositoryError(
      "competitive_policy_persisted_data_corrupt",
    );
  if (
    value.source_invalidated_at !== null &&
    typeof value.source_invalidated_at !== "string"
  )
    throw new CompetitivePolicyRepositoryError(
      "competitive_policy_persisted_data_corrupt",
    );
  if (
    value.receipt_schema_version !== "workflow-benchmark-receipt-v1" ||
    value.workflow_id !== "revelai-wall-pass-geometry-v1" ||
    value.workflow_version !== "1.0.0" ||
    value.extraction_evidence_version !== "c5-frame-manifest-v1" ||
    value.observation_evidence_version !== "wall-pass-geometry-evidence-v1" ||
    value.challenge_id !== "wall-pass" ||
    typeof value.challenge_version !== "number" ||
    value.challenge_version !== 1 ||
    value.rule_version !== "wall-pass-v1-score-1"
  )
    throw new CompetitivePolicyRepositoryError(
      "competitive_policy_persisted_data_corrupt",
    );
  const receipt = assertReceiptRowMatches({
    id: value.receipt_id as string,
    receiptSha256: value.source_receipt_sha256 as string,
    schemaVersion: value.source_schema_version as string,
    modelBundleId: value.source_model_bundle_id as string,
    workflowId: value.source_workflow_id as string,
    workflowVersion: value.source_workflow_version as string,
    providerVersion: value.source_provider_version as string,
    status: value.source_status as string,
    runAt: value.source_run_at as string,
    validUntil: value.source_valid_until as string,
    invalidatedAt:
      value.source_invalidated_at === null
        ? null
        : (value.source_invalidated_at as string),
    receiptJson: value.receipt_json as string,
  });
  if (
    value.workspace_id !== receipt.workflow.workspaceId ||
    value.model_bundle_id !== receipt.workflow.modelBundleId ||
    value.workflow_id !== receipt.workflow.workflowId ||
    value.workflow_version !== receipt.workflow.workflowVersion ||
    value.provider_version !== receipt.workflow.providerVersion ||
    value.calibration_evidence_version !==
      receipt.evidence.calibrationEvidenceVersion ||
    value.extraction_evidence_version !==
      receipt.evidence.extractionEvidenceVersion ||
    value.observation_evidence_version !==
      receipt.evidence.observationEvidenceVersion
  )
    throw new CompetitivePolicyRepositoryError(
      "competitive_policy_persisted_data_corrupt",
    );
  return Object.freeze({
    id: value.id as string,
    receiptId: value.receipt_id as string,
    receiptSha256: value.receipt_sha256 as string,
    receiptSchemaVersion: "workflow-benchmark-receipt-v1",
    workspaceId: value.workspace_id as string,
    modelBundleId: value.model_bundle_id as string,
    workflowId: "revelai-wall-pass-geometry-v1",
    workflowVersion: "1.0.0",
    providerVersion: value.provider_version as string,
    calibrationEvidenceVersion: value.calibration_evidence_version as string,
    extractionEvidenceVersion: "c5-frame-manifest-v1",
    observationEvidenceVersion: "wall-pass-geometry-evidence-v1",
    challengeId: "wall-pass",
    challengeVersion: 1,
    ruleVersion: "wall-pass-v1-score-1",
    receipt,
  });
}
