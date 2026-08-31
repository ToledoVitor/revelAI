import { createHash } from "node:crypto";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encode } from "jpeg-js";
import { describe, expect, it } from "vitest";
import {
  createRoboflowVisionProvider,
  VisionBatchScheduler,
} from "@revelai/vision";
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
function benchmarkJpeg(seed: number) {
  const data = new Uint8Array(1280 * 720 * 4);
  for (let index = 0; index < data.length; index += 4) {
    data[index] = seed;
    data[index + 1] = 255 - seed;
    data[index + 2] = 180;
    data[index + 3] = 255;
  }
  return Uint8Array.from(encode({ width: 1280, height: 720, data }, 80).data);
}

function verifiedWorkflowOutput() {
  return {
    kind: "wall-pass-geometry-v1",
    image: { width: 1280, height: 720, coordinateSystem: "inference_pixels" },
    workflow: {
      id: "revelai-wall-pass-geometry-v1",
      version: "1.0.0",
      modelBundleId: "wall-pass-bundle-v1",
      providerVersion: "provider-v1",
    },
    detections: [
      {
        class: "athlete",
        xMin: 200,
        yMin: 100,
        xMax: 1000,
        yMax: 700,
        confidence: 0.9,
      },
      {
        class: "ball",
        xMin: 600,
        yMin: 500,
        xMax: 630,
        yMax: 530,
        confidence: 0.9,
      },
    ],
    keypoints: [
      { class: "left_foot", x: 600, y: 530, confidence: 0.9 },
      { class: "right_foot", x: 650, y: 530, confidence: 0.9 },
    ],
    fiducials: [
      "a-top-left",
      "a-top-right",
      "a-bottom-right",
      "a-bottom-left",
      "b-top-left",
      "b-top-right",
      "b-bottom-right",
      "b-bottom-left",
    ].map((id, index) => ({
      class: id,
      x: 200 + index * 20,
      y: 300 + (index % 2) * 20,
      confidence: 0.9,
    })),
    geometry: {
      wallFloorEdge: { x1: 160, y1: 0, x2: 1120, y2: 0, confidence: 0.9 },
    },
  };
}

function benchmarkManifests(seedOffset = 0) {
  return manifestIds.map((id, manifestIndex) => {
    const jpeg = benchmarkJpeg(seedOffset + manifestIndex * 40 + 20);
    return {
      id,
      frames: Array.from({ length: 640 }, (_, index) => ({
        kind: "verified-wall-pass" as const,
        attemptId: "11111111-1111-4111-8111-111111111111",
        challenge: { id: "wall-pass" as const, version: 1 as const },
        frame: {
          index,
          timestampMs: index * 100,
          sourceWidth: 1280,
          sourceHeight: 720,
          jpeg,
        },
      })),
    };
  });
}

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

  it("rejects five source-byte aliases before a structural provider can dispatch", async () => {
    const manifests = benchmarkManifests();
    const aliased = manifests.map((manifest) => ({
      ...manifest,
      frames: manifests[0]!.frames,
    }));
    await expect(
      runWorkflowBenchmark({
        id: () => "e4798abd-7126-4b96-8915-24e4366986f3",
        provider: {
          freeProvenance: {
            kind: "demo",
            fixtureId: "free-well-framed-active-v1",
            providerVersion: "demo-observations-v1",
          },
          verifiedProvenance: {
            kind: "demo",
            fixtureId: "wall-pass-balanced-v1",
            providerVersion: "demo-observations-v1",
          },
          analyzeFree: async () => {
            throw new Error("not used");
          },
          analyzeVerified: async () => {
            throw new Error("not used");
          },
        },
        scheduler: new VisionBatchScheduler(),
        clock: { now: () => Date.parse("2030-01-01T00:00:00.000Z") },
        manifests: aliased,
      }),
    ).rejects.toThrow("source manifest sets must be distinct");
  });

  it("rejects a Roboflow-shaped structural provider without its factory-owned benchmark receipt", async () => {
    const demo = {
      freeProvenance: {
        kind: "demo" as const,
        fixtureId: "free-well-framed-active-v1" as const,
        providerVersion: "demo-observations-v1" as const,
      },
      verifiedProvenance: {
        kind: "roboflow" as const,
        workspaceId: "revelai-workspace",
        workflowId: "revelai-wall-pass-geometry-v1" as const,
        workflowVersion: "1.0.0" as const,
        modelBundleId: "wall-pass-bundle-v1",
        providerVersion: "provider-v1",
      },
      analyzeFree: async () => {
        throw new Error("not used");
      },
      analyzeVerified: async () => {
        throw new Error("not used");
      },
    };
    await expect(
      runWorkflowBenchmark({
        id: () => "e4798abd-7126-4b96-8915-24e4366986f3",
        provider: demo,
        scheduler: new VisionBatchScheduler(),
        clock: { now: () => Date.parse("2030-01-01T00:00:00.000Z") },
        manifests: benchmarkManifests(),
      }),
    ).rejects.toMatchObject({ code: "provider_output_invalid" });
  });

  it("rejects five distinct source manifests that alias to one owned encoded-byte set", async () => {
    let now = Date.parse("2030-01-01T00:00:00.000Z");
    const encoded = benchmarkJpeg(222);
    const provider = createRoboflowVisionProvider({
      config: {
        apiUrl: "http://127.0.0.1:9001",
        workspaceId: "revelai-workspace",
        freeModelBundleId: "free-bundle-v1",
        verifiedModelBundleId: "wall-pass-bundle-v1",
        freeProviderVersion: "provider-v1",
        verifiedProviderVersion: "provider-v1",
      },
      transformer: {
        transform: async (_frame, transform) => ({
          jpeg: encoded,
          sha256: createHash("sha256").update(encoded).digest("hex"),
          transform,
        }),
      },
      fetch: async () => ({
        status: 200,
        json: async () => ({ outputs: [verifiedWorkflowOutput()] }),
      }),
    });
    await expect(
      runWorkflowBenchmark({
        id: () => "e4798abd-7126-4b96-8915-24e4366986f3",
        provider,
        scheduler: new VisionBatchScheduler({
          clock: {
            now: () => ++now,
            sleep: async () => undefined,
            schedule: () => () => undefined,
          },
        }),
        clock: { now: () => ++now },
        manifests: benchmarkManifests(),
      }),
    ).rejects.toThrow("encoded manifest sets must be distinct");
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
      schedule: () => () => undefined,
    };
    const scheduler = new VisionBatchScheduler({ clock });
    const provider = createRoboflowVisionProvider({
      config: {
        apiUrl: "http://127.0.0.1:9001",
        workspaceId: "revelai-workspace",
        freeModelBundleId: "free-bundle-v1",
        verifiedModelBundleId: "wall-pass-bundle-v1",
        freeProviderVersion: "provider-v1",
        verifiedProviderVersion: "provider-v1",
      },
      transformer: {
        transform: async (frame, transform) => ({
          jpeg: frame.jpeg,
          sha256: createHash("sha256").update(frame.jpeg).digest("hex"),
          transform,
        }),
      },
      fetch: async () => ({
        status: 200,
        json: async () => ({ outputs: [verifiedWorkflowOutput()] }),
      }),
    });
    const manifests = benchmarkManifests();
    expect(
      new Set(
        manifests.map((manifest) =>
          createHash("sha256")
            .update(manifest.frames[0]!.frame.jpeg)
            .digest("hex"),
        ),
      ).size,
    ).toBe(5);
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

    const mutated = await runWorkflowBenchmark({
      id: () => "f4798abd-7126-4b96-8915-24e4366986f3",
      provider,
      scheduler,
      clock,
      manifests: benchmarkManifests(-10),
    });
    expect(mutated.manifestSet.sha256).not.toBe(receipt.manifestSet.sha256);
  });
});
