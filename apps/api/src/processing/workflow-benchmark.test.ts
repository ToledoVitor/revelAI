import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { VisionBatchScheduler } from "@revelai/vision";
import {
  createWorkflowBenchmarkReceipt,
  runWorkflowBenchmark,
  writeWorkflowBenchmarkReceipt,
} from "./workflow-benchmark.js";

const manifestIds = [
  "wall-pass-benchmark-a",
  "wall-pass-benchmark-b",
  "wall-pass-benchmark-c",
  "wall-pass-benchmark-d",
  "wall-pass-benchmark-e",
] as const;

function receiptInput(
  overrides: Partial<Parameters<typeof createWorkflowBenchmarkReceipt>[0]> = {},
) {
  return {
    id: "e4798abd-7126-4b96-8915-24e4366986f3",
    runAt: "2030-01-01T00:00:00.000Z",
    workflow: {
      workspaceId: "revelai-workspace",
      modelBundleId: "wall-pass-bundle-v1",
      providerVersion: "roboflow-inference-v1",
    },
    manifests: manifestIds.map((id, index) => ({
      id,
      sha256: `${String(index + 1).repeat(64)}`,
    })),
    runs: manifestIds.map((manifestId) => ({
      manifestId,
      batchDurationMs: 165_000,
      completedFrameRequests: 640 as const,
    })),
    pooledDispatchToObservationP95Ms: 900,
    ...overrides,
  };
}

describe("workflow benchmark receipt", () => {
  it("produces a canonical passed receipt and atomically writes only its redacted JSON", async () => {
    const receipt = createWorkflowBenchmarkReceipt(receiptInput());
    expect(receipt.status).toBe("passed");
    expect(receipt.validUntil).toBe("2030-01-31T00:00:00.000Z");

    const directory = await mkdtemp(join(tmpdir(), "revelai-benchmark-"));
    const path = await writeWorkflowBenchmarkReceipt({ directory, receipt });
    const content = await readFile(path, "utf8");
    expect(JSON.parse(content)).toEqual(receipt);
    expect(content).not.toContain("api_key");
    expect(content).not.toContain("/private/");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    await expect(
      writeWorkflowBenchmarkReceipt({ directory, receipt }),
    ).rejects.toThrow("already exists");
  });

  it("fails exactly above either p95 or batch-duration threshold", () => {
    expect(
      createWorkflowBenchmarkReceipt(
        receiptInput({ pooledDispatchToObservationP95Ms: 901 }),
      ).status,
    ).toBe("failed");
    expect(
      createWorkflowBenchmarkReceipt(
        receiptInput({
          runs: manifestIds.map((manifestId, index) => ({
            manifestId,
            batchDurationMs: index === 0 ? 165_001 : 165_000,
            completedFrameRequests: 640 as const,
          })),
        }),
      ).status,
    ).toBe("failed");
  });

  it("rejects non-distinct or incomplete benchmark manifest sets before receipt creation", () => {
    expect(() =>
      createWorkflowBenchmarkReceipt(
        receiptInput({
          manifests: [
            ...receiptInput().manifests.slice(0, 4),
            receiptInput().manifests[0]!,
          ],
        }),
      ),
    ).toThrow("distinct");
    expect(() =>
      createWorkflowBenchmarkReceipt(
        receiptInput({ manifests: receiptInput().manifests.slice(0, 4) }),
      ),
    ).toThrow();
  });

  it("runs five complete 1280x720 manifests through the injected scheduler and captures 3,200 samples", async () => {
    let now = Date.parse("2030-01-01T00:00:00.000Z");
    const clock = {
      now: () => ++now,
      sleep: (_milliseconds: number, signal?: AbortSignal) =>
        new Promise<void>((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => reject(new Error("aborted")),
            {
              once: true,
            },
          );
        }),
    };
    const scheduler = new VisionBatchScheduler({ clock });
    const provider = {
      freeProvenance: {
        kind: "roboflow",
        workspaceId: "revelai-workspace",
        workflowId: "revelai-free-training-v1",
        workflowVersion: "1.0.0",
        modelBundleId: "free-bundle-v1",
        providerVersion: "provider-v1",
      },
      verifiedProvenance: {
        kind: "roboflow",
        workspaceId: "revelai-workspace",
        workflowId: "revelai-wall-pass-geometry-v1",
        workflowVersion: "1.0.0",
        modelBundleId: "wall-pass-bundle-v1",
        providerVersion: "provider-v1",
      },
      async analyzeFree(): Promise<never> {
        throw new Error("not used by verified benchmark");
      },
      async analyzeVerified(request: {
        frame: { index: number; timestampMs: number };
      }) {
        return {
          kind: "verified-wall-pass" as const,
          frameIndex: request.frame.index,
          timestampMs: request.frame.timestampMs,
          sourceWidth: 1280,
          sourceHeight: 720,
          feet: [],
          fiducialCorners: [],
        };
      },
    } as const;
    const manifests = manifestIds.map((id, manifestIndex) => ({
      id,
      sha256: String(manifestIndex + 1).repeat(64),
      frames: Array.from({ length: 640 }, (_, index) => ({
        kind: "verified-wall-pass" as const,
        attemptId: "11111111-1111-4111-8111-111111111111",
        challenge: { id: "wall-pass" as const, version: 1 as const },
        frame: {
          index,
          timestampMs: index * 100,
          sourceWidth: 1280,
          sourceHeight: 720,
          jpeg: Uint8Array.of(0xff),
        },
      })),
    }));
    const receipt = await runWorkflowBenchmark({
      id: () => "e4798abd-7126-4b96-8915-24e4366986f3",
      provider,
      scheduler,
      clock,
      manifests,
    });
    expect(receipt.runs).toHaveLength(5);
    expect(
      receipt.runs.every((run) => run.completedFrameRequests === 640),
    ).toBe(true);
    expect(receipt.status).toBe("passed");
  });
});
