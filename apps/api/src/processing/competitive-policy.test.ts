import {
  failedWorkflowBenchmarkReceiptFixture,
  passingWorkflowBenchmarkReceiptFixture,
  staleWorkflowBenchmarkReceiptFixture,
  workflowBenchmarkReceiptDigest,
  WorkflowBenchmarkReceiptSchema,
  type WorkflowBenchmarkReceipt,
} from "@revelai/contracts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openSqliteDatabase } from "../database/sqlite-database.js";
import type { CompetitivePolicyActivation } from "../repositories/competitive-policy-repository.js";
import {
  CompetitivePolicyLookupUnavailableError,
  CompetitivePolicyRepositoryError,
} from "../repositories/competitive-policy-repository.js";
import { SQLiteCompetitivePolicyRepository } from "../repositories/sqlite-competitive-policy-repository.js";
import { candidatePolicyFacts } from "./integrity-evaluator.js";
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

  it("keeps candidate provenance immutable across policy evaluation", async () => {
    const demoCandidate = await verifiedCandidateFixture("demo");
    const roboflowCandidate = await verifiedCandidateFixture("roboflow");
    const demoFacts = candidatePolicyFacts(demoCandidate);
    const roboflowFacts = candidatePolicyFacts(roboflowCandidate);

    expect(Object.isFrozen(demoFacts.provenance)).toBe(true);
    expect(Object.isFrozen(roboflowFacts.provenance)).toBe(true);
    expect(Object.isFrozen(roboflowFacts.execution)).toBe(true);
    expect(() => {
      (demoFacts.provenance as { kind: string }).kind = "roboflow";
    }).toThrow();
    expect(() => {
      (roboflowFacts.provenance as { workspaceId: string }).workspaceId =
        "wrong";
    }).toThrow();

    await expect(
      evaluateCompetitiveEligibility({
        candidate: demoCandidate,
        clock,
        repository: {
          async getActivePolicy() {
            return approvedPolicy();
          },
        },
      }),
    ).resolves.toMatchObject({ competitiveStatus: "demo" });
    await expect(
      evaluateCompetitiveEligibility({
        candidate: roboflowCandidate,
        clock,
        repository: {
          async getActivePolicy() {
            return approvedPolicy();
          },
        },
      }),
    ).resolves.toMatchObject({ competitiveStatus: "ranked" });
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
      { workflowId: "wrong" },
      { workflowVersion: "wrong" },
      { modelBundleId: "wrong" },
      { providerVersion: "wrong" },
      { calibrationEvidenceVersion: "wrong" },
      { challengeId: "wrong" },
      { challengeVersion: 2 },
      { ruleVersion: "wrong" },
      { receiptId: "wrong" },
      { receiptSha256: "0".repeat(64) },
      { receiptSchemaVersion: "wrong" },
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
    const receipt = WorkflowBenchmarkReceiptSchema.parse(
      passingWorkflowBenchmarkReceiptFixture,
    );
    await expect(
      evaluateCompetitiveEligibility({
        candidate,
        clock: { now: () => receipt.runAt },
        repository: {
          async getActivePolicy() {
            return approvedPolicy(receipt);
          },
        },
      }),
    ).resolves.toMatchObject({ competitiveStatus: "ranked" });
    for (const [boundaryClock, expectedStatus] of [
      ["2029-12-31T23:59:59.999Z", "experimental"],
      ["2030-01-01T00:00:00.001Z", "ranked"],
      ["2030-01-30T23:59:59.999Z", "ranked"],
      ["2030-01-31T00:00:00.000Z", "experimental"],
      ["2030-01-31T00:00:00.001Z", "experimental"],
    ] as const)
      await expect(
        evaluateCompetitiveEligibility({
          candidate,
          clock: { now: () => boundaryClock },
          repository: {
            async getActivePolicy() {
              return approvedPolicy(receipt);
            },
          },
        }),
      ).resolves.toMatchObject({ competitiveStatus: expectedStatus });
  });

  it("keeps failed, stale, invalidated, and malformed receipts experimental", async () => {
    const candidate = await verifiedCandidateFixture("roboflow");
    const invalidated = receiptWith({
      status: "failed",
      invalidatedAt: "2030-01-15T00:00:00.000Z",
      invalidationReason: "operator_revoked",
    });
    const nonCurrent: readonly WorkflowBenchmarkReceipt[] = [
      WorkflowBenchmarkReceiptSchema.parse(
        failedWorkflowBenchmarkReceiptFixture,
      ),
      WorkflowBenchmarkReceiptSchema.parse(
        staleWorkflowBenchmarkReceiptFixture,
      ),
      invalidated,
    ];
    for (const receipt of nonCurrent)
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
    await expect(
      evaluateCompetitiveEligibility({
        candidate,
        clock,
        repository: {
          async getActivePolicy() {
            return approvedPolicy({} as WorkflowBenchmarkReceipt);
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
            throw new CompetitivePolicyLookupUnavailableError();
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

  it("maps durable receipt corruption to experimental while preserving typed outages", async () => {
    const candidate = await verifiedCandidateFixture("roboflow");
    await expect(
      evaluateCompetitiveEligibility({
        candidate,
        clock,
        repository: {
          async getActivePolicy() {
            throw new CompetitivePolicyRepositoryError(
              "competitive_policy_persisted_data_corrupt",
            );
          },
        },
      }),
    ).resolves.toMatchObject({ competitiveStatus: "experimental" });
  });

  it("consumes the real C4 adapter and classifies its durable corruption as experimental", async () => {
    const directory = await mkdtemp(join(tmpdir(), "revelai-c7-policy-"));
    const database = openSqliteDatabase(join(directory, "api.sqlite"));
    try {
      const repository = new SQLiteCompetitivePolicyRepository({
        database,
        clock,
      });
      const receipt = await repository.storeBenchmarkReceipt(
        passingWorkflowBenchmarkReceiptFixture,
      );
      const tuple = {
        workspaceId: receipt.workflow.workspaceId,
        modelBundleId: receipt.workflow.modelBundleId,
        workflowId: receipt.workflow.workflowId,
        workflowVersion: receipt.workflow.workflowVersion,
        providerVersion: receipt.workflow.providerVersion,
        calibrationEvidenceVersion: "wall-pass-calibration-evidence-v1",
        challengeId: "wall-pass" as const,
        challengeVersion: 1 as const,
        ruleVersion: "wall-pass-v1-score-1" as const,
      };
      await repository.activateCompetitivePolicy({
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        receiptId: receipt.id,
        receiptSha256: receipt.receiptSha256,
        receiptSchemaVersion: receipt.schemaVersion,
        ...tuple,
      });
      const candidate = await verifiedCandidateFixture("roboflow");
      const lookup = {
        getActivePolicy: (input: typeof tuple) =>
          repository.getActiveCompetitivePolicy(input),
      };

      await expect(
        evaluateCompetitiveEligibility({
          candidate,
          clock,
          repository: lookup,
        }),
      ).resolves.toMatchObject({ competitiveStatus: "ranked" });

      database.raw
        .prepare(
          "UPDATE workflow_benchmark_receipts SET receipt_json = ? WHERE id = ?",
        )
        .run("{malformed", receipt.id);
      await expect(
        evaluateCompetitiveEligibility({
          candidate,
          clock,
          repository: lookup,
        }),
      ).resolves.toMatchObject({ competitiveStatus: "experimental" });
    } finally {
      database.close();
      await rm(directory, { recursive: true, force: true });
    }
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
  const { receiptSha256: _hash, ...payload } =
    passingWorkflowBenchmarkReceiptFixture;
  void _hash;
  const next = { ...payload, ...patch };
  return WorkflowBenchmarkReceiptSchema.parse({
    ...next,
    receiptSha256: workflowBenchmarkReceiptDigest(next),
  });
}
