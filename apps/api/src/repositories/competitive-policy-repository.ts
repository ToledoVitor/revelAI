import type {
  UtcIsoTimestamp,
  WorkflowBenchmarkInvalidationReason,
  WorkflowBenchmarkReceipt,
} from "@revelai/contracts";

export type CompetitivePolicyTuple = Readonly<{
  modelBundleId: string;
  workflowId: "revelai-wall-pass-geometry-v1";
  workflowVersion: "1.0.0";
  providerVersion: string;
  calibrationEvidenceVersion: string;
  challengeId: "wall-pass";
  challengeVersion: 1;
  ruleVersion: "wall-pass-v1-score-1";
}>;

export type CompetitivePolicyActivation = CompetitivePolicyTuple &
  Readonly<{
    id: string;
    receiptId: string;
    receiptSha256: string;
    receiptSchemaVersion: "workflow-benchmark-receipt-v1";
  }>;

export interface CompetitivePolicyRepository {
  storeBenchmarkReceipt(receipt: unknown): Promise<WorkflowBenchmarkReceipt>;
  activateCompetitivePolicy(input: CompetitivePolicyActivation): Promise<void>;
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
