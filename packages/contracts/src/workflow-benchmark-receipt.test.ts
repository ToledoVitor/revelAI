import { describe, expect, it } from "vitest";
import * as publicContracts from "./index.js";
import { sha256Hex } from "./workflow-benchmark-receipt.js";
import {
  failedWorkflowBenchmarkReceiptFixture,
  missingWorkflowBenchmarkReceiptFixture,
  passingWorkflowBenchmarkReceiptFixture,
  staleWorkflowBenchmarkReceiptFixture,
  WorkflowBenchmarkReceiptSchema,
  workflowBenchmarkReceiptDigest,
} from "./index.js";

describe("workflow benchmark receipt contract", () => {
  it("parses deterministic passing, failed, and stale fixtures", () => {
    expect("sha256Hex" in publicContracts).toBe(false);
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(passingWorkflowBenchmarkReceiptFixture.receiptSha256).toBe(
      "9f11f281981819f30a081d738ca17be07f37f98aa5e56d835ae3a4602bed09ad",
    );
    expect(failedWorkflowBenchmarkReceiptFixture.receiptSha256).toBe(
      "21832a403eb4341e4bcbc03b31333ed393a9ee969eba0329a7688cd231490d88",
    );
    expect(staleWorkflowBenchmarkReceiptFixture.receiptSha256).toBe(
      "4113823410311b63c329368a0b9306270532130f9060704b589898c6b204a9a8",
    );
    expect(
      WorkflowBenchmarkReceiptSchema.safeParse(
        passingWorkflowBenchmarkReceiptFixture,
      ).success,
    ).toBe(true);
    expect(
      WorkflowBenchmarkReceiptSchema.safeParse(
        failedWorkflowBenchmarkReceiptFixture,
      ).success,
    ).toBe(true);
    expect(
      WorkflowBenchmarkReceiptSchema.safeParse(
        staleWorkflowBenchmarkReceiptFixture,
      ).success,
    ).toBe(true);
    expect(
      WorkflowBenchmarkReceiptSchema.safeParse(
        missingWorkflowBenchmarkReceiptFixture,
      ).success,
    ).toBe(false);
  });

  it("binds the exact C5 extraction and C6 observation revisions into approval", () => {
    expect(passingWorkflowBenchmarkReceiptFixture.evidence).toEqual({
      calibrationEvidenceVersion: "wall-pass-calibration-evidence-v1",
      extractionEvidenceVersion: "c5-frame-manifest-v1",
      observationEvidenceVersion: "wall-pass-geometry-evidence-v1",
    });
  });

  it("binds receipt content to its canonical digest independently of object key order", () => {
    const { receiptSha256, ...payload } =
      passingWorkflowBenchmarkReceiptFixture;
    void receiptSha256;
    const reorderedPayload = {
      workflow: payload.workflow,
      schemaVersion: payload.schemaVersion,
      id: payload.id,
      scheduler: payload.scheduler,
      sampling: payload.sampling,
      evidence: payload.evidence,
      manifestSet: payload.manifestSet,
      runs: payload.runs,
      pooledDispatchToObservationP95Ms:
        payload.pooledDispatchToObservationP95Ms,
      runAt: payload.runAt,
      validUntil: payload.validUntil,
      status: payload.status,
      invalidatedAt: payload.invalidatedAt,
      invalidationReason: payload.invalidationReason,
    };

    expect(workflowBenchmarkReceiptDigest(payload)).toBe(
      passingWorkflowBenchmarkReceiptFixture.receiptSha256,
    );
    expect(workflowBenchmarkReceiptDigest(reorderedPayload)).toBe(
      passingWorkflowBenchmarkReceiptFixture.receiptSha256,
    );
    expect(
      WorkflowBenchmarkReceiptSchema.safeParse({
        ...passingWorkflowBenchmarkReceiptFixture,
        workflow: {
          ...passingWorkflowBenchmarkReceiptFixture.workflow,
          workspaceId: "changed-workspace",
        },
      }).success,
    ).toBe(false);
    expect(
      WorkflowBenchmarkReceiptSchema.safeParse({
        ...passingWorkflowBenchmarkReceiptFixture,
        invalidatedAt: "2030-01-02T00:00:00.000Z",
        invalidationReason: "operator_revoked",
        status: "failed",
      }).success,
    ).toBe(false);
  });

  it("rejects a wrong workflow tuple, malformed hash, manifests, run order, and passed threshold", () => {
    const wrongTuple = {
      ...passingWorkflowBenchmarkReceiptFixture,
      workflow: {
        ...passingWorkflowBenchmarkReceiptFixture.workflow,
        workflowId: "revelai-free-training-v1",
      },
    };
    expect(WorkflowBenchmarkReceiptSchema.safeParse(wrongTuple).success).toBe(
      false,
    );
    expect(
      WorkflowBenchmarkReceiptSchema.safeParse({
        ...passingWorkflowBenchmarkReceiptFixture,
        receiptSha256: "not-a-sha256",
      }).success,
    ).toBe(false);
    expect(
      WorkflowBenchmarkReceiptSchema.safeParse({
        ...passingWorkflowBenchmarkReceiptFixture,
        runs: passingWorkflowBenchmarkReceiptFixture.runs.slice(0, 4),
      }).success,
    ).toBe(false);
    expect(
      WorkflowBenchmarkReceiptSchema.safeParse({
        ...passingWorkflowBenchmarkReceiptFixture,
        pooledDispatchToObservationP95Ms: 901,
      }).success,
    ).toBe(false);
    expect(
      WorkflowBenchmarkReceiptSchema.safeParse({
        ...passingWorkflowBenchmarkReceiptFixture,
        runAt: "not-a-timestamp",
      }).success,
    ).toBe(false);
    expect(
      WorkflowBenchmarkReceiptSchema.safeParse({
        ...passingWorkflowBenchmarkReceiptFixture,
        status: "failed",
      }).success,
    ).toBe(false);
    expect(
      WorkflowBenchmarkReceiptSchema.safeParse({
        ...passingWorkflowBenchmarkReceiptFixture,
        manifestSet: {
          ...passingWorkflowBenchmarkReceiptFixture.manifestSet,
          manifestIds: [
            "wall-pass-benchmark-a",
            "wall-pass-benchmark-a",
            "wall-pass-benchmark-c",
            "wall-pass-benchmark-d",
            "wall-pass-benchmark-e",
          ],
        },
      }).success,
    ).toBe(false);
    expect(
      WorkflowBenchmarkReceiptSchema.safeParse({
        ...passingWorkflowBenchmarkReceiptFixture,
        runs: [
          passingWorkflowBenchmarkReceiptFixture.runs[1],
          passingWorkflowBenchmarkReceiptFixture.runs[0],
          passingWorkflowBenchmarkReceiptFixture.runs[2],
          passingWorkflowBenchmarkReceiptFixture.runs[3],
          passingWorkflowBenchmarkReceiptFixture.runs[4],
        ],
      }).success,
    ).toBe(false);
  });
});
