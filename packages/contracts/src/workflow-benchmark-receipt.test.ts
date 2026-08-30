import { describe, expect, it } from "vitest";
import {
  failedWorkflowBenchmarkReceiptFixture,
  missingWorkflowBenchmarkReceiptFixture,
  passingWorkflowBenchmarkReceiptFixture,
  staleWorkflowBenchmarkReceiptFixture,
  WorkflowBenchmarkReceiptSchema,
} from "./index.js";

describe("workflow benchmark receipt contract", () => {
  it("parses deterministic passing, failed, and stale fixtures", () => {
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

  it("rejects a wrong workflow tuple, malformed hash, run count, and passed threshold", () => {
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
  });
});
