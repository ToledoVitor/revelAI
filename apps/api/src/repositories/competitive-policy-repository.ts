import type {
  UtcIsoTimestamp,
  WorkflowBenchmarkInvalidationReason,
  WorkflowBenchmarkReceipt,
} from "@revelai/contracts";
import { WorkflowBenchmarkReceiptSchema } from "@revelai/contracts";

/** Only this explicit classification may become a retryable C7 lookup result. */
export class CompetitivePolicyLookupUnavailableError extends Error {
  public constructor() {
    super("competitive_policy_lookup_unavailable");
    this.name = "CompetitivePolicyLookupUnavailableError";
  }
}

/** Persisted-data and approval faults are permanent non-eligibility facts. */
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

/** Shared strict matcher for durable receipt rows and migration repair. */
export function parseStoredBenchmarkReceipt(
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
): WorkflowBenchmarkReceipt {
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
  return receipt;
}

export type CompetitivePolicyTuple = Readonly<{
  workspaceId: string;
  modelBundleId: string;
  workflowId: "revelai-wall-pass-geometry-v1";
  workflowVersion: "1.0.0";
  providerVersion: string;
  calibrationEvidenceVersion: string;
  extractionEvidenceVersion: "c5-frame-manifest-v1";
  observationEvidenceVersion: "wall-pass-geometry-evidence-v1";
  challengeId: "wall-pass";
  challengeVersion: 1;
  ruleVersion: "wall-pass-v1-score-1";
}>;

export type CompetitivePolicyActivationInput = CompetitivePolicyTuple &
  Readonly<{
    id: string;
    receiptId: string;
    receiptSha256: string;
    receiptSchemaVersion: "workflow-benchmark-receipt-v1";
  }>;

/**
 * A returned activation is never a loose row: consumers receive the exact
 * strict receipt from which its workspace and benchmark tuple were derived.
 */
export type CompetitivePolicyActivation = CompetitivePolicyActivationInput &
  Readonly<{ receipt: WorkflowBenchmarkReceipt }>;

export interface CompetitivePolicyRepository {
  storeBenchmarkReceipt(receipt: unknown): Promise<WorkflowBenchmarkReceipt>;
  activateCompetitivePolicy(
    input: CompetitivePolicyActivationInput,
  ): Promise<void>;
  deactivateCompetitivePolicy(input: Readonly<{ id: string }>): Promise<void>;
  invalidateBenchmarkReceipt(
    input: Readonly<{
      receiptId: string;
      invalidatedAt: UtcIsoTimestamp;
      reason: WorkflowBenchmarkInvalidationReason;
    }>,
  ): Promise<void>;
  getActiveCompetitivePolicy(
    tuple: CompetitivePolicyTuple,
  ): Promise<CompetitivePolicyActivation | null>;
}
