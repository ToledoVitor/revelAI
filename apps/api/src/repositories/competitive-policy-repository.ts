import type {
  UtcIsoTimestamp,
  WorkflowBenchmarkInvalidationReason,
  WorkflowBenchmarkReceipt,
} from "@revelai/contracts";

export type CompetitivePolicyTuple = Readonly<{
  workspaceId: string;
  modelBundleId: string;
  workflowId: "revelai-wall-pass-geometry-v1";
  workflowVersion: "1.0.0";
  providerVersion: string;
  calibrationEvidenceVersion: string;
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
