import {
  passingWorkflowBenchmarkReceiptFixture,
  workflowBenchmarkReceiptDigest,
  WorkflowBenchmarkReceiptSchema,
  type WorkflowBenchmarkReceipt,
} from "@revelai/contracts";
import { describe, expect, it } from "vitest";
import {
  evaluateCompetitiveEligibility,
  temporaryCompetitivePolicyDecision,
} from "./competitive-policy.js";

const now = "2030-01-30T00:00:00.000Z";

describe("competitive eligibility policy", () => {
  it("never looks up demo or Free inputs", async () => {
    let calls = 0;
    const repository = {
      getActivePolicy: async () => {
        calls += 1;
        return approvedPolicy();
      },
    };

    await expect(
      evaluateCompetitiveEligibility({
        ...verifiedInput(repository),
        provenance: {
          kind: "demo",
          fixtureId: "wall-pass-balanced-v1",
          providerVersion: "demo-observations-v1",
        },
      }),
    ).resolves.toEqual({
      kind: "competitive-ineligible",
      competitiveStatus: "demo",
      competitiveEligible: false,
    });
    await expect(
      evaluateCompetitiveEligibility({
        ...verifiedInput(repository),
        mode: "free",
        provenance: {
          kind: "roboflow",
          workspaceId: "revelai-workspace",
          workflowId: "revelai-free-training-v1",
          workflowVersion: "1.0.0",
          modelBundleId: "free-bundle-v1",
          providerVersion: "roboflow-inference-v1",
        },
      }),
    ).resolves.toEqual({
      kind: "competitive-ineligible",
      competitiveStatus: "experimental",
      competitiveEligible: false,
    });
    expect(calls).toBe(0);
  });

  it("accepts only a current parsed receipt with every exact approved tuple field", async () => {
    const policy = approvedPolicy();
    const repository = { getActivePolicy: async () => policy };

    await expect(
      evaluateCompetitiveEligibility(verifiedInput(repository)),
    ).resolves.toEqual({
      kind: "competitive-eligible",
      competitiveStatus: "ranked",
      competitiveEligible: true,
    });

    for (const mismatch of [
      { workspaceId: "wrong-workspace" },
      { workflowId: "wrong-workflow" },
      { workflowVersion: "9.9.9" },
      { modelBundleId: "wrong-bundle" },
      { providerVersion: "wrong-provider" },
      { calibrationEvidenceVersion: "wrong-calibration" },
      { challengeId: "wrong-challenge" },
      { challengeVersion: 2 },
      { ruleVersion: "wrong-rule" },
      { receiptId: "wrong-receipt" },
      { receiptSha256: "0".repeat(64) },
      { receiptSchemaVersion: "wrong-schema" },
    ]) {
      await expect(
        evaluateCompetitiveEligibility(
          verifiedInput({
            getActivePolicy: async () => ({ ...policy, ...mismatch }),
          }),
        ),
      ).resolves.toMatchObject({
        kind: "competitive-ineligible",
        competitiveStatus: "experimental",
        competitiveEligible: false,
      });
    }
  });

  it("treats absent, malformed, stale, failed, invalidated, and expiry-boundary policy as experimental", async () => {
    const expired = approvedPolicy(receiptWith({ validUntil: now }));
    const failed = approvedPolicy(
      receiptWith({ pooledDispatchToObservationP95Ms: 901, status: "failed" }),
    );
    const invalidated = approvedPolicy(
      receiptWith({
        status: "failed",
        invalidatedAt: now,
        invalidationReason: "operator_revoked",
      }),
    );

    for (const returned of [null, {}, expired, failed, invalidated])
      await expect(
        evaluateCompetitiveEligibility(
          verifiedInput({ getActivePolicy: async () => returned }),
        ),
      ).resolves.toMatchObject({
        kind: "competitive-ineligible",
        competitiveStatus: "experimental",
      });
  });

  it("keeps actual repository outages retryable and non-terminal", async () => {
    await expect(
      evaluateCompetitiveEligibility(
        verifiedInput({
          getActivePolicy: async () => {
            throw new Error("database unavailable");
          },
        }),
      ),
    ).resolves.toEqual(temporaryCompetitivePolicyDecision());
  });
});

function verifiedInput(repository: { getActivePolicy(): Promise<unknown> }) {
  return {
    mode: "verified" as const,
    provenance: {
      kind: "roboflow" as const,
      workspaceId: "revelai-workspace",
      workflowId: "revelai-wall-pass-geometry-v1" as const,
      workflowVersion: "1.0.0" as const,
      modelBundleId: "wall-pass-bundle-v1",
      providerVersion: "roboflow-inference-v1",
    },
    calibrationEvidenceVersion: "wall-pass-calibration-evidence-v1",
    challengeId: "wall-pass" as const,
    challengeVersion: 1 as const,
    ruleVersion: "wall-pass-v1-score-1" as const,
    now,
    repository,
  };
}

function approvedPolicy(
  receipt: WorkflowBenchmarkReceipt = WorkflowBenchmarkReceiptSchema.parse(
    passingWorkflowBenchmarkReceiptFixture,
  ),
) {
  return {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    workspaceId: "revelai-workspace",
    workflowId: "revelai-wall-pass-geometry-v1",
    workflowVersion: "1.0.0",
    modelBundleId: "wall-pass-bundle-v1",
    providerVersion: "roboflow-inference-v1",
    calibrationEvidenceVersion: "wall-pass-calibration-evidence-v1",
    challengeId: "wall-pass",
    challengeVersion: 1,
    ruleVersion: "wall-pass-v1-score-1",
    receiptId: receipt.id,
    receiptSha256: receipt.receiptSha256,
    receiptSchemaVersion: receipt.schemaVersion,
    receipt,
  };
}

function receiptWith(
  patch: Partial<WorkflowBenchmarkReceipt>,
): WorkflowBenchmarkReceipt {
  const { receiptSha256: _receiptSha256, ...payload } =
    passingWorkflowBenchmarkReceiptFixture;
  void _receiptSha256;
  const next = { ...payload, ...patch };
  return {
    ...next,
    receiptSha256: workflowBenchmarkReceiptDigest(next),
  } as WorkflowBenchmarkReceipt;
}
