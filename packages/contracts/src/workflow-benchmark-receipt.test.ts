import { describe, expect, it } from "vitest";
import {
  failedWorkflowBenchmarkReceiptFixture,
  missingWorkflowBenchmarkReceiptFixture,
  passingWorkflowBenchmarkReceiptFixture,
  sha256Hex,
  staleWorkflowBenchmarkReceiptFixture,
  WorkflowBenchmarkReceiptSchema,
  workflowBenchmarkReceiptDigest,
} from "./index.js";

function withRecomputedDigest(receipt: Record<string, unknown>) {
  const { receiptSha256, ...payload } = receipt;
  void receiptSha256;

  return {
    ...payload,
    receiptSha256: workflowBenchmarkReceiptDigest(payload),
  };
}

describe("workflow benchmark receipt contract", () => {
  it("parses deterministic passing, failed, and stale fixtures", () => {
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(passingWorkflowBenchmarkReceiptFixture.receiptSha256).toBe(
      "16100d95caa25eb8ec6a6bfc545943e01d19b02af90f8a071ab6a9e2fe9f86e0",
    );
    expect(failedWorkflowBenchmarkReceiptFixture.receiptSha256).toBe(
      "cb74f6a175859d55f7b4d0519789cde12fabd8e6ce6e228a45c99011b953c945",
    );
    expect(staleWorkflowBenchmarkReceiptFixture.receiptSha256).toBe(
      "f0106ea9f2bb49eb465a48687d6aa6deab05798559ad1b4220e37b0a89e50532",
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
    const wrongTuple = withRecomputedDigest({
      ...passingWorkflowBenchmarkReceiptFixture,
      workflow: {
        ...passingWorkflowBenchmarkReceiptFixture.workflow,
        workflowId: "revelai-free-training-v1",
      },
    });
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
      WorkflowBenchmarkReceiptSchema.safeParse(
        withRecomputedDigest({
          ...passingWorkflowBenchmarkReceiptFixture,
          runs: passingWorkflowBenchmarkReceiptFixture.runs.slice(0, 4),
        }),
      ).success,
    ).toBe(false);
    expect(
      WorkflowBenchmarkReceiptSchema.safeParse(
        withRecomputedDigest({
          ...passingWorkflowBenchmarkReceiptFixture,
          pooledDispatchToObservationP95Ms: 901,
        }),
      ).success,
    ).toBe(false);
    expect(
      WorkflowBenchmarkReceiptSchema.safeParse({
        ...passingWorkflowBenchmarkReceiptFixture,
        runAt: "not-a-timestamp",
      }).success,
    ).toBe(false);
    expect(
      WorkflowBenchmarkReceiptSchema.safeParse(
        withRecomputedDigest({
          ...passingWorkflowBenchmarkReceiptFixture,
          status: "failed",
        }),
      ).success,
    ).toBe(false);
    expect(
      WorkflowBenchmarkReceiptSchema.safeParse(
        withRecomputedDigest({
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
        }),
      ).success,
    ).toBe(false);
    expect(
      WorkflowBenchmarkReceiptSchema.safeParse(
        withRecomputedDigest({
          ...passingWorkflowBenchmarkReceiptFixture,
          runs: [
            passingWorkflowBenchmarkReceiptFixture.runs[1],
            passingWorkflowBenchmarkReceiptFixture.runs[0],
            passingWorkflowBenchmarkReceiptFixture.runs[2],
            passingWorkflowBenchmarkReceiptFixture.runs[3],
            passingWorkflowBenchmarkReceiptFixture.runs[4],
          ],
        }),
      ).success,
    ).toBe(false);
  });
});
