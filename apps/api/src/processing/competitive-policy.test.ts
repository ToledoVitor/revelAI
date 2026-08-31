import {
  passingWorkflowBenchmarkReceiptFixture,
  workflowBenchmarkReceiptDigest,
  WorkflowBenchmarkReceiptSchema,
  type WorkflowBenchmarkReceipt,
} from "@revelai/contracts";
import { describe, expect, it } from "vitest";
import type { CompetitivePolicyActivation } from "../repositories/competitive-policy-repository.js";
import {
  evaluateCompetitiveEligibility,
  temporaryCompetitivePolicyDecision,
} from "./competitive-policy.js";
import { verifiedCandidateFixture } from "./c7-fixture.test-support.js";

const now = "2030-01-30T00:00:00.000Z";
const clock = { now: () => now };

describe("competitive eligibility policy", () => {
  it("never looks up the valid demo candidate", async () => {
    let calls = 0;
    const candidate = await verifiedCandidateFixture("demo");
    await expect(
      evaluateCompetitiveEligibility({
        candidate,
        clock,
        repository: {
          async getActivePolicy() {
            calls += 1;
            return approvedPolicy();
          },
        },
      }),
    ).resolves.toMatchObject({ competitiveStatus: "demo" });
    expect(calls).toBe(0);
  });

  it("requires the exact valid Roboflow candidate, tuple, and current receipt", async () => {
    const candidate = await verifiedCandidateFixture("roboflow");
    await expect(
      evaluateCompetitiveEligibility({
        candidate,
        clock,
        repository: {
          async getActivePolicy() {
            return approvedPolicy();
          },
        },
      }),
    ).resolves.toMatchObject({ competitiveStatus: "ranked" });
    for (const mismatch of [
      { workspaceId: "wrong" },
      { providerVersion: "wrong" },
      { calibrationEvidenceVersion: "wrong" },
      { receiptSha256: "0".repeat(64) },
    ]) {
      await expect(
        evaluateCompetitiveEligibility({
          candidate,
          clock,
          repository: {
            async getActivePolicy() {
              return {
                ...approvedPolicy(),
                ...mismatch,
              } as CompetitivePolicyActivation;
            },
          },
        }),
      ).resolves.toMatchObject({ competitiveStatus: "experimental" });
    }
  });

  it("enforces runAt <= trusted now < validUntil at both boundaries", async () => {
    const candidate = await verifiedCandidateFixture("roboflow");
    for (const receipt of [
      receiptWith({ runAt: "2030-01-30T00:00:00.001Z" }),
      receiptWith({ validUntil: now }),
    ])
      await expect(
        evaluateCompetitiveEligibility({
          candidate,
          clock,
          repository: {
            async getActivePolicy() {
              return approvedPolicy(receipt);
            },
          },
        }),
      ).resolves.toMatchObject({ competitiveStatus: "experimental" });
  });

  it("keeps real lookup outages retryable and rejects forged candidates before lookup", async () => {
    const candidate = await verifiedCandidateFixture("roboflow");
    await expect(
      evaluateCompetitiveEligibility({
        candidate,
        clock,
        repository: {
          async getActivePolicy() {
            throw new Error("database unavailable");
          },
        },
      }),
    ).resolves.toEqual(temporaryCompetitivePolicyDecision());
    await expect(
      evaluateCompetitiveEligibility({
        candidate: { kind: "verified-attempt-candidate" },
        clock,
        repository: {
          async getActivePolicy() {
            throw new Error("must not run");
          },
        },
      }),
    ).resolves.toMatchObject({ competitiveStatus: "experimental" });
  });
});

function approvedPolicy(
  receipt: WorkflowBenchmarkReceipt = WorkflowBenchmarkReceiptSchema.parse(
    passingWorkflowBenchmarkReceiptFixture,
  ),
): CompetitivePolicyActivation {
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
  const { receiptSha256: _hash, ...rest } =
    passingWorkflowBenchmarkReceiptFixture;
  void _hash;
  const payload = { ...rest, ...patch };
  return {
    ...payload,
    receiptSha256: workflowBenchmarkReceiptDigest(payload),
  } as WorkflowBenchmarkReceipt;
}
