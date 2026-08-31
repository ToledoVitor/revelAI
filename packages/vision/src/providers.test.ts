import { Buffer } from "node:buffer";
import { encode } from "jpeg-js";
import { describe, expect, it } from "vitest";
import {
  analyzeBatch,
  analyzeOwnedVerifiedBatch,
  assertOwnedVerifiedVisionBatchForRequests,
  createDemoVisionProvider,
  createRoboflowVisionProvider,
  VisionProviderError,
} from "./providers.js";
import { VisionBatchScheduler } from "./scheduler.js";
import { assembleFreeInsight } from "./free-insight.js";
import { assembleVerifiedEvidence } from "./verified-evidence.js";
import type {
  FreeVisionObservationBatch,
  FreeVisionFrameRequest,
  VerifiedVisionObservationBatch,
  VerifiedVisionFrameRequest,
  WorkflowEnvelope,
} from "./types.js";
import {
  FreeVisionObservationBatchSchema,
  VerifiedVisionObservationBatchSchema,
  WorkflowEnvelopeSchema,
} from "./types.js";
import {
  createLetterboxTransform,
  assertInferenceJpeg,
  encodeInferenceFrame,
  inverseInferencePoint,
} from "./transform.js";

const attemptId = "11111111-1111-4111-8111-111111111111";
const jpeg = new Uint8Array(
  encode(
    {
      width: 1440,
      height: 1080,
      data: new Uint8Array(1440 * 1080 * 4).fill(255),
    },
    80,
  ).data,
);

function freeRequest(index = 0) {
  return {
    kind: "free-training" as const,
    attemptId,
    frame: {
      index,
      timestampMs: index * 100,
      sourceWidth: 1440,
      sourceHeight: 1080,
      jpeg,
    },
  };
}

function verifiedRequest(index: number) {
  return {
    kind: "verified-wall-pass" as const,
    attemptId,
    challenge: { id: "wall-pass" as const, version: 1 as const },
    frame: {
      index,
      timestampMs: index * 100,
      sourceWidth: 1440,
      sourceHeight: 1080,
      jpeg,
    },
  };
}

const freeCorrelationFixture = {
  kind: "free-training",
  attemptId,
  frame: {
    index: 0,
    timestampMs: 0,
    sourceWidth: 1440,
    sourceHeight: 1080,
    jpeg,
  },
} satisfies FreeVisionFrameRequest;

const verifiedCorrelationFixture = {
  kind: "verified-wall-pass",
  attemptId,
  challenge: { id: "wall-pass", version: 1 },
  frame: {
    index: 0,
    timestampMs: 0,
    sourceWidth: 1440,
    sourceHeight: 1080,
    jpeg,
  },
} satisfies VerifiedVisionFrameRequest;

const invalidCrossKindFixture = {
  kind: "free-training",
  attemptId,
  // @ts-expect-error Free request must not carry a verified challenge selector.
  challenge: { id: "wall-pass", version: 1 },
  frame: freeCorrelationFixture.frame,
} satisfies FreeVisionFrameRequest;
void invalidCrossKindFixture;

const roboflowFreeBatchFixture = {
  attemptId,
  kind: "free-training",
  frames: [
    {
      kind: "free-training",
      frameIndex: 0,
      timestampMs: 0,
      sourceWidth: 1440,
      sourceHeight: 1080,
      inference: {
        sha256: "a".repeat(64),
        transform: {
          sourceWidth: 1440,
          sourceHeight: 1080,
          inferenceWidth: 1280,
          inferenceHeight: 720,
          scale: 2 / 3,
          scaledWidth: 960,
          scaledHeight: 720,
          padLeft: 160,
          padTop: 0,
        },
      },
    },
  ],
  provenance: {
    kind: "roboflow",
    workspaceId: "revelai",
    workflowId: "revelai-free-training-v1",
    workflowVersion: "1.0.0",
    modelBundleId: "free-bundle-v1",
    providerVersion: "provider-v1",
  },
} satisfies FreeVisionObservationBatch;
void roboflowFreeBatchFixture;

const demoFreeBatchFixture = {
  attemptId,
  kind: "free-training",
  frames: [
    {
      kind: "free-training",
      frameIndex: 0,
      timestampMs: 0,
      sourceWidth: 1440,
      sourceHeight: 1080,
    },
  ],
  provenance: {
    kind: "demo",
    fixtureId: "free-well-framed-active-v1",
    providerVersion: "demo-observations-v1",
  },
} satisfies FreeVisionObservationBatch;
void demoFreeBatchFixture;

const invalidDemoFreeInferenceFixture = {
  ...demoFreeBatchFixture,
  frames: [
    {
      ...demoFreeBatchFixture.frames[0]!,
      inference: roboflowFreeBatchFixture.frames[0]!.inference,
    },
  ],
};
const invalidDemoFreeInferenceCorrelationFixture =
  // @ts-expect-error Demo frames cannot carry an inference binding.
  invalidDemoFreeInferenceFixture satisfies FreeVisionObservationBatch;
void invalidDemoFreeInferenceCorrelationFixture;

const invalidCrossBranchBatchFixture = {
  ...demoFreeBatchFixture,
  provenance: {
    kind: "roboflow" as const,
    workspaceId: "revelai",
    workflowId: "revelai-wall-pass-geometry-v1" as const,
    workflowVersion: "1.0.0" as const,
    modelBundleId: "verified-bundle-v1",
    providerVersion: "provider-v1",
  },
};
const invalidCrossBranchBatchCorrelationFixture =
  // @ts-expect-error Free batches cannot carry verified workflow provenance.
  invalidCrossBranchBatchFixture satisfies FreeVisionObservationBatch;
void invalidCrossBranchBatchCorrelationFixture;

const invalidRoboflowBatchFixture = {
  attemptId,
  kind: "verified-wall-pass" as const,
  frames: [
    {
      kind: "verified-wall-pass" as const,
      frameIndex: 0,
      timestampMs: 0,
      sourceWidth: 1440,
      sourceHeight: 1080,
      feet: [],
      fiducialCorners: [],
    },
  ],
  provenance: {
    kind: "roboflow" as const,
    workspaceId: "revelai",
    workflowId: "revelai-wall-pass-geometry-v1" as const,
    workflowVersion: "1.0.0" as const,
    modelBundleId: "verified-bundle-v1",
    providerVersion: "provider-v1",
  },
};
const invalidRoboflowBatchCorrelationFixture =
  // @ts-expect-error Roboflow batches require every frame to bind exact inference bytes.
  invalidRoboflowBatchFixture satisfies VerifiedVisionObservationBatch;
void invalidRoboflowBatchFixture;
void invalidRoboflowBatchCorrelationFixture;

const demoVerifiedBatchFixture = {
  ...invalidRoboflowBatchFixture,
  provenance: {
    kind: "demo" as const,
    fixtureId: "wall-pass-balanced-v1" as const,
    providerVersion: "demo-observations-v1" as const,
  },
} satisfies VerifiedVisionObservationBatch;
void demoVerifiedBatchFixture;

const roboflowVerifiedBatchFixture = {
  ...invalidRoboflowBatchFixture,
  frames: [
    {
      ...invalidRoboflowBatchFixture.frames[0]!,
      inference: roboflowFreeBatchFixture.frames[0]!.inference,
    },
  ],
} satisfies VerifiedVisionObservationBatch;
void roboflowVerifiedBatchFixture;

const invalidDemoVerifiedInferenceFixture = {
  ...demoVerifiedBatchFixture,
  frames: [
    {
      ...demoVerifiedBatchFixture.frames[0]!,
      inference: roboflowFreeBatchFixture.frames[0]!.inference,
    },
  ],
};
const invalidDemoVerifiedInferenceCorrelationFixture =
  // @ts-expect-error Demo frames cannot carry an inference binding.
  invalidDemoVerifiedInferenceFixture satisfies VerifiedVisionObservationBatch;
void invalidDemoVerifiedInferenceCorrelationFixture;

const freeWorkflowCorrelationFixture = {
  outputs: [
    {
      kind: "free-training-v1",
      image: {
        width: 1280,
        height: 720,
        coordinateSystem: "inference_pixels",
      },
      workflow: {
        id: "revelai-free-training-v1",
        version: "1.0.0",
        modelBundleId: "free-bundle-v1",
        providerVersion: "provider-v1",
      },
      detections: [],
    },
  ],
} satisfies WorkflowEnvelope;
void freeWorkflowCorrelationFixture;

const invalidWorkflowCorrelationFixture = {
  outputs: [
    // @ts-expect-error Free output requires the Free workflow ID.
    {
      kind: "free-training-v1" as const,
      image: {
        width: 1280 as const,
        height: 720 as const,
        coordinateSystem: "inference_pixels" as const,
      },
      workflow: {
        id: "revelai-wall-pass-geometry-v1",
        version: "1.0.0" as const,
        modelBundleId: "free-bundle-v1",
        providerVersion: "provider-v1",
      },
      detections: [],
    },
  ],
} satisfies WorkflowEnvelope;
void invalidWorkflowCorrelationFixture;

function verifiedWorkflowOutput(overrides: Record<string, unknown> = {}) {
  return {
    kind: "wall-pass-geometry-v1",
    image: { width: 1280, height: 720, coordinateSystem: "inference_pixels" },
    workflow: {
      id: "revelai-wall-pass-geometry-v1",
      version: "1.0.0",
      modelBundleId: "verified-bundle-v1",
      providerVersion: "provider-v1",
    },
    detections: [
      {
        class: "athlete",
        xMin: 160,
        yMin: 20,
        xMax: 1120,
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
    ...overrides,
  };
}

describe("vision providers", () => {
  it("keeps Free and verified request fixtures discriminated at compile time", () => {
    expect(freeCorrelationFixture.kind).toBe("free-training");
    expect(verifiedCorrelationFixture.kind).toBe("verified-wall-pass");
  });

  it("correlates Roboflow provenance to exact per-frame inference bindings", () => {
    expect(
      FreeVisionObservationBatchSchema.safeParse(roboflowFreeBatchFixture)
        .success,
    ).toBe(true);
    for (const invalid of [
      {
        ...roboflowFreeBatchFixture,
        frames: roboflowFreeBatchFixture.frames.map((frame) => ({
          kind: frame.kind,
          frameIndex: frame.frameIndex,
          timestampMs: frame.timestampMs,
          sourceWidth: frame.sourceWidth,
          sourceHeight: frame.sourceHeight,
        })),
      },
      {
        ...roboflowFreeBatchFixture,
        frames: roboflowFreeBatchFixture.frames.map((frame) => ({
          ...frame,
          inference: {
            ...frame.inference,
            transform: { ...frame.inference.transform, padLeft: 159 },
          },
        })),
      },
      {
        ...roboflowFreeBatchFixture,
        frames: roboflowFreeBatchFixture.frames.map((frame) => ({
          ...frame,
          inference: {
            ...frame.inference,
            transform: {
              sourceWidth: 1920,
              sourceHeight: 1080,
              inferenceWidth: 1280,
              inferenceHeight: 720,
              scale: 2 / 3,
              scaledWidth: 1280,
              scaledHeight: 720,
              padLeft: 0,
              padTop: 0,
            },
          },
        })),
      },
      invalidCrossBranchBatchFixture,
      invalidDemoFreeInferenceFixture,
    ])
      expect(FreeVisionObservationBatchSchema.safeParse(invalid).success).toBe(
        false,
      );
    expect(
      WorkflowEnvelopeSchema.safeParse(freeWorkflowCorrelationFixture).success,
    ).toBe(true);
    expect(
      WorkflowEnvelopeSchema.safeParse(invalidWorkflowCorrelationFixture)
        .success,
    ).toBe(false);
    expect(
      VerifiedVisionObservationBatchSchema.safeParse({
        ...invalidRoboflowBatchFixture,
        provenance: {
          kind: "demo",
          fixtureId: "wall-pass-balanced-v1",
          providerVersion: "demo-observations-v1",
        },
        frames: [
          {
            ...invalidRoboflowBatchFixture.frames[0],
            inference: roboflowFreeBatchFixture.frames[0]!.inference,
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      VerifiedVisionObservationBatchSchema.safeParse(
        roboflowVerifiedBatchFixture,
      ).success,
    ).toBe(true);
    expect(
      VerifiedVisionObservationBatchSchema.safeParse({
        ...roboflowVerifiedBatchFixture,
        frames: roboflowVerifiedBatchFixture.frames.map((frame) => ({
          ...frame,
          inference: {
            ...frame.inference,
            transform: {
              sourceWidth: 1920,
              sourceHeight: 1080,
              inferenceWidth: 1280,
              inferenceHeight: 720,
              scale: 2 / 3,
              scaledWidth: 1280,
              scaledHeight: 720,
              padLeft: 0,
              padTop: 0,
            },
          },
        })),
      }).success,
    ).toBe(false);
  });

  it("rejects a mixed Free/verified request array before any provider dispatch", async () => {
    const provider = createDemoVisionProvider();
    await expect(
      analyzeBatch(provider, [freeRequest(), verifiedRequest(1)]),
    ).rejects.toMatchObject({ code: "provider_output_invalid" });
  });

  it("uses injected demo fixture selection and never emits an eligibility verdict", async () => {
    const provider = createDemoVisionProvider({
      free: "free-limited-ball-v1",
      verified: "wall-pass-insufficient-v1",
    });
    const batch = await analyzeBatch(provider, [
      freeRequest(0),
      freeRequest(1),
    ]);
    expect(batch).toMatchObject({
      kind: "free-training",
      provenance: { kind: "demo", fixtureId: "free-limited-ball-v1" },
    });
    expect(JSON.stringify(batch)).not.toContain("eligible");
    expect(batch.frames[1]?.ball).toBeUndefined();
  });

  it("provides four semantically distinct deterministic fixture timelines end to end", async () => {
    const balanced = createDemoVisionProvider();
    const verified = await analyzeBatch(
      balanced,
      Array.from({ length: 640 }, (_, index) => verifiedRequest(index)),
    );
    if (verified.kind !== "verified-wall-pass")
      throw new Error("wrong fixture kind");
    const evidence = assembleVerifiedEvidence({
      batch: verified,
      binding: {
        attemptId,
        generation: 1,
        mediaId: "22222222-2222-4222-8222-222222222222",
        mediaSha256: "a".repeat(64),
        rawPreRollSha256: "b".repeat(64),
        calibrationSessionId: "33333333-3333-4333-8333-333333333333",
        calibrationNonce: "c".repeat(43),
      },
    });
    expect(evidence.selectedReferenceFrameIndex).toBe(0);
    expect(evidence.activeStableCount).toBe(600);
    expect(evidence.wallImpacts).toHaveLength(119);
    const completedPasses = evidence.passEvidence.filter(
      (pass) => pass.kind === "complete",
    );
    expect(completedPasses).toHaveLength(119);
    expect(completedPasses.filter((pass) => pass.side === "left")).toHaveLength(
      60,
    );
    expect(
      completedPasses.filter((pass) => pass.side === "right"),
    ).toHaveLength(59);

    const insufficient = createDemoVisionProvider({
      free: "free-limited-ball-v1",
      verified: "wall-pass-insufficient-v1",
    });
    const insufficientBatch = await analyzeBatch(
      insufficient,
      Array.from({ length: 640 }, (_, index) => verifiedRequest(index)),
    );
    if (insufficientBatch.kind !== "verified-wall-pass")
      throw new Error("wrong fixture kind");
    const insufficientEvidence = assembleVerifiedEvidence({
      batch: insufficientBatch,
      binding: {
        attemptId,
        generation: 1,
        mediaId: "22222222-2222-4222-8222-222222222222",
        mediaSha256: "a".repeat(64),
        rawPreRollSha256: "b".repeat(64),
        calibrationSessionId: "33333333-3333-4333-8333-333333333333",
        calibrationNonce: "c".repeat(43),
      },
    });
    expect(insufficientEvidence.selectedReferenceFrameIndex).toBeNull();
    expect(insufficientEvidence.activeStableCount).toBe(0);

    const free = await analyzeBatch(
      balanced,
      Array.from({ length: 12 }, (_, index) => freeRequest(index)),
    );
    if (free.kind !== "free-training") throw new Error("wrong fixture kind");
    expect(
      assembleFreeInsight({
        batch: free,
        generatedAt: "2030-01-01T00:00:00.000Z",
      }).observations[2],
    ).toMatchObject({ kind: "movement-activity", range: "high" });
  });

  it("submits every ordinary batch through the four-frame scheduler", async () => {
    const demo = createDemoVisionProvider();
    let inFlight = 0;
    let maximum = 0;
    const provider = {
      ...demo,
      async analyzeFree(request: ReturnType<typeof freeRequest>) {
        inFlight += 1;
        maximum = Math.max(maximum, inFlight);
        await Promise.resolve();
        inFlight -= 1;
        return demo.analyzeFree(request);
      },
    };
    const batch = await analyzeBatch(
      provider,
      Array.from({ length: 12 }, (_, index) => freeRequest(index)),
    );
    expect(batch.frames).toHaveLength(12);
    expect(maximum).toBe(4);
  });

  it("rejects a provider observation that cannot correlate to its source frame", async () => {
    const demo = createDemoVisionProvider();
    const provider = {
      ...demo,
      async analyzeFree(request: ReturnType<typeof freeRequest>) {
        const observation = await demo.analyzeFree(request);
        return { ...observation, frameIndex: observation.frameIndex + 1 };
      },
    };
    await expect(analyzeBatch(provider, [freeRequest()])).rejects.toMatchObject(
      {
        code: "provider_output_invalid",
      },
    );
  });

  it("uses exact side-padding transform and rejects points outside content", () => {
    const transform = createLetterboxTransform(freeRequest().frame);
    expect(transform).toMatchObject({
      scale: 2 / 3,
      scaledWidth: 960,
      scaledHeight: 720,
      padLeft: 160,
      padTop: 0,
    });
    expect(inverseInferencePoint({ x: 160, y: 0 }, transform)).toEqual({
      x: 0,
      y: 0,
    });
    expect(() => inverseInferencePoint({ x: 158, y: 20 }, transform)).toThrow(
      "outside letterbox",
    );
  });

  it("posts the exact Workflow JSON body without an authorization header", async () => {
    const calls: Array<{ url: string; init: unknown }> = [];
    const provider = createRoboflowVisionProvider({
      config: {
        apiUrl: "http://127.0.0.1:9001",
        workspaceId: "revelai",
        freeModelBundleId: "free-bundle-v1",
        verifiedModelBundleId: "verified-bundle-v1",
        freeProviderVersion: "provider-v1",
        verifiedProviderVersion: "provider-v1",
      },
      fetch: async (url, init) => {
        calls.push({ url, init });
        return {
          status: 200,
          json: async () => ({
            outputs: [
              {
                kind: "free-training-v1",
                image: {
                  width: 1280,
                  height: 720,
                  coordinateSystem: "inference_pixels",
                },
                workflow: {
                  id: "revelai-free-training-v1",
                  version: "1.0.0",
                  modelBundleId: "free-bundle-v1",
                  providerVersion: "provider-v1",
                },
                detections: [
                  {
                    class: "athlete",
                    xMin: 160,
                    yMin: 0,
                    xMax: 1120,
                    yMax: 720,
                    confidence: 0.9,
                  },
                ],
              },
            ],
          }),
        };
      },
    });
    const result = await provider.analyzeFree(freeRequest());
    expect(result.athlete).toMatchObject({ xMin: 0, xMax: 1440 });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      url: "http://127.0.0.1:9001/infer/workflows/revelai/revelai-free-training-v1",
      init: {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
        },
      },
    });
    const body = JSON.parse((calls[0]!.init as { body: string }).body) as {
      inputs: { image: { type: string; value: string } };
    };
    expect(body.inputs.image.type).toBe("base64");
    expect(() =>
      assertInferenceJpeg(
        new Uint8Array(Buffer.from(body.inputs.image.value, "base64")),
      ),
    ).not.toThrow();
    expect(result.inference).toMatchObject({
      transform: { scaledWidth: 960, scaledHeight: 720, padLeft: 160 },
    });
    expect(JSON.stringify(calls[0])).not.toContain("Authorization");
  });

  it("normalizes the exact verified Workflow branch and rejects cross-kind or unknown classes", async () => {
    const provider = createRoboflowVisionProvider({
      config: {
        apiUrl: "http://127.0.0.1:9001",
        workspaceId: "revelai",
        freeModelBundleId: "free-bundle-v1",
        verifiedModelBundleId: "verified-bundle-v1",
        freeProviderVersion: "provider-v1",
        verifiedProviderVersion: "provider-v1",
      },
      fetch: async () => ({
        status: 200,
        json: async () => ({ outputs: [verifiedWorkflowOutput()] }),
      }),
    });
    await expect(
      provider.analyzeVerified(verifiedRequest(0)),
    ).resolves.toMatchObject({
      kind: "verified-wall-pass",
      feet: [{ side: "left" }, { side: "right" }],
      fiducialCorners: { length: 8 },
    });

    for (const output of [
      { ...verifiedWorkflowOutput(), kind: "free-training-v1" },
      {
        ...verifiedWorkflowOutput(),
        detections: [
          ...verifiedWorkflowOutput().detections,
          {
            class: "unknown",
            xMin: 1,
            yMin: 1,
            xMax: 2,
            yMax: 2,
            confidence: 0.9,
          },
        ],
      },
      {
        ...verifiedWorkflowOutput(),
        detections: [
          ...verifiedWorkflowOutput().detections,
          {
            ...verifiedWorkflowOutput().detections[0]!,
          },
        ],
      },
      {
        ...verifiedWorkflowOutput(),
        image: {
          width: 1280,
          height: 721,
          coordinateSystem: "inference_pixels",
        },
      },
      {
        ...verifiedWorkflowOutput(),
        workflow: {
          ...verifiedWorkflowOutput().workflow,
          modelBundleId: "different-bundle-v1",
        },
      },
    ]) {
      const invalid = createRoboflowVisionProvider({
        config: {
          apiUrl: "http://127.0.0.1:9001",
          workspaceId: "revelai",
          freeModelBundleId: "free-bundle-v1",
          verifiedModelBundleId: "verified-bundle-v1",
          freeProviderVersion: "provider-v1",
          verifiedProviderVersion: "provider-v1",
        },
        fetch: async () => ({
          status: 200,
          json: async () => ({ outputs: [output] }),
        }),
      });
      await expect(
        invalid.analyzeVerified(verifiedRequest(0)),
      ).rejects.toMatchObject({
        code: "provider_output_invalid",
      });
    }
  });

  it("rejects cross-kind Workflow output, unknown class, and insecure keyed URL", async () => {
    expect(() =>
      createRoboflowVisionProvider({
        config: {
          apiUrl: "http://localhost:9001",
          apiKey: "secret",
          workspaceId: "revelai",
          freeModelBundleId: "free-bundle-v1",
          verifiedModelBundleId: "verified-bundle-v1",
          freeProviderVersion: "provider-v1",
          verifiedProviderVersion: "provider-v1",
        },
        transformer: {
          transform: async (frame, _transform, signal) =>
            encodeInferenceFrame(frame, signal),
        },
        fetch: async () => ({ status: 500, json: async () => ({}) }),
      }),
    ).toThrow(VisionProviderError);
  });

  it("rejects a response whose configured provider version does not match", async () => {
    const provider = createRoboflowVisionProvider({
      config: {
        apiUrl: "http://127.0.0.1:9001",
        workspaceId: "revelai",
        freeModelBundleId: "free-bundle-v1",
        verifiedModelBundleId: "verified-bundle-v1",
        freeProviderVersion: "provider-v1",
        verifiedProviderVersion: "provider-v1",
      },
      transformer: {
        transform: async (frame, _transform, signal) =>
          encodeInferenceFrame(frame, signal),
      },
      fetch: async () => ({
        status: 200,
        json: async () => ({
          outputs: [
            {
              kind: "free-training-v1",
              image: {
                width: 1280,
                height: 720,
                coordinateSystem: "inference_pixels",
              },
              workflow: {
                id: "revelai-free-training-v1",
                version: "1.0.0",
                modelBundleId: "free-bundle-v1",
                providerVersion: "different-provider-v1",
              },
              detections: [],
            },
          ],
        }),
      }),
    });
    await expect(provider.analyzeFree(freeRequest())).rejects.toMatchObject({
      code: "provider_output_invalid",
    });
  });

  it("classifies an unreadable Workflow response as invalid output, not a network retry", async () => {
    const provider = createRoboflowVisionProvider({
      config: {
        apiUrl: "http://127.0.0.1:9001",
        workspaceId: "revelai",
        freeModelBundleId: "free-bundle-v1",
        verifiedModelBundleId: "verified-bundle-v1",
        freeProviderVersion: "provider-v1",
        verifiedProviderVersion: "provider-v1",
      },
      transformer: {
        transform: async (frame, _transform, signal) =>
          encodeInferenceFrame(frame, signal),
      },
      fetch: async () => ({
        status: 200,
        json: async () => Promise.reject(new Error("unreadable response")),
      }),
    });
    await expect(provider.analyzeFree(freeRequest())).rejects.toMatchObject({
      code: "provider_output_invalid",
    });
  });

  it("does not retry an ordinary fetch programming error as a network outage", async () => {
    let fetches = 0;
    const sleeps: number[] = [];
    const provider = createRoboflowVisionProvider({
      config: {
        apiUrl: "http://127.0.0.1:9001",
        workspaceId: "revelai",
        freeModelBundleId: "free-bundle-v1",
        verifiedModelBundleId: "verified-bundle-v1",
        freeProviderVersion: "provider-v1",
        verifiedProviderVersion: "provider-v1",
      },
      fetch: async () => {
        fetches += 1;
        throw new Error("fixture programming error");
      },
    });
    const scheduler = new VisionBatchScheduler({
      clock: {
        now: () => 0,
        sleep: async (milliseconds) => {
          sleeps.push(milliseconds);
        },
        schedule: () => () => undefined,
      },
    });
    await expect(
      analyzeBatch(provider, [freeRequest()], scheduler),
    ).rejects.toMatchObject({ code: "provider_output_invalid" });
    expect(fetches).toBe(1);
    expect(sleeps).toEqual([]);
  });

  it("retries only an exact configured transport code through batch scheduling", async () => {
    let fetches = 0;
    const sleeps: number[] = [];
    const provider = createRoboflowVisionProvider({
      config: {
        apiUrl: "http://127.0.0.1:9001",
        workspaceId: "revelai",
        freeModelBundleId: "free-bundle-v1",
        verifiedModelBundleId: "verified-bundle-v1",
        freeProviderVersion: "provider-v1",
        verifiedProviderVersion: "provider-v1",
      },
      fetch: async () => {
        fetches += 1;
        const error = Object.assign(new Error("connection reset"), {
          code: "ECONNRESET",
        });
        throw error;
      },
    });
    const scheduler = new VisionBatchScheduler({
      clock: {
        now: () => 0,
        sleep: async (milliseconds) => {
          sleeps.push(milliseconds);
        },
        schedule: () => () => undefined,
      },
    });
    await expect(
      analyzeBatch(provider, [freeRequest()], scheduler),
    ).rejects.toMatchObject({ code: "provider_temporary_unavailable" });
    expect(fetches).toBe(3);
    expect(sleeps).toEqual([250, 1000]);
  });

  it("does not retry an unlisted HTTP status through batch scheduling", async () => {
    let fetches = 0;
    const provider = createRoboflowVisionProvider({
      config: {
        apiUrl: "http://127.0.0.1:9001",
        workspaceId: "revelai",
        freeModelBundleId: "free-bundle-v1",
        verifiedModelBundleId: "verified-bundle-v1",
        freeProviderVersion: "provider-v1",
        verifiedProviderVersion: "provider-v1",
      },
      fetch: async () => {
        fetches += 1;
        return { status: 400, json: async () => ({}) };
      },
    });
    await expect(analyzeBatch(provider, [freeRequest()])).rejects.toMatchObject(
      {
        code: "provider_output_invalid",
      },
    );
    expect(fetches).toBe(1);
  });

  it("carries the scheduler request deadline through transform and prevents post-timeout HTTP", async () => {
    let now = 0;
    let fetches = 0;
    const provider = createRoboflowVisionProvider({
      config: {
        apiUrl: "http://127.0.0.1:9001",
        workspaceId: "revelai",
        freeModelBundleId: "free-bundle-v1",
        verifiedModelBundleId: "verified-bundle-v1",
        freeProviderVersion: "provider-v1",
        verifiedProviderVersion: "provider-v1",
      },
      transformer: {
        transform: async (frame) => {
          const encoded = encodeInferenceFrame(frame);
          now += 8001;
          return encoded;
        },
      },
      fetch: async () => {
        fetches += 1;
        return {
          status: 200,
          json: async () => ({
            outputs: [
              {
                kind: "free-training-v1",
                image: {
                  width: 1280,
                  height: 720,
                  coordinateSystem: "inference_pixels",
                },
                workflow: {
                  id: "revelai-free-training-v1",
                  version: "1.0.0",
                  modelBundleId: "free-bundle-v1",
                  providerVersion: "provider-v1",
                },
                detections: [],
              },
            ],
          }),
        };
      },
    });
    const scheduler = new VisionBatchScheduler({
      clock: {
        now: () => now,
        sleep: async () => undefined,
        schedule: () => () => undefined,
      },
    });
    await expect(
      analyzeBatch(provider, [freeRequest()], scheduler),
    ).rejects.toMatchObject({ code: "provider_temporary_unavailable" });
    expect(fetches).toBe(0);
    expect(now).toBe(8001);
  });

  it("never starts fetch when external cancellation wins while a transform is pending", async () => {
    let releaseTransform:
      | ((value: ReturnType<typeof encodeInferenceFrame>) => void)
      | undefined;
    let fetches = 0;
    const provider = createRoboflowVisionProvider({
      config: {
        apiUrl: "http://127.0.0.1:9001",
        workspaceId: "revelai",
        freeModelBundleId: "free-bundle-v1",
        verifiedModelBundleId: "verified-bundle-v1",
        freeProviderVersion: "provider-v1",
        verifiedProviderVersion: "provider-v1",
      },
      transformer: {
        transform: async (frame) =>
          new Promise((resolve) => {
            releaseTransform = resolve;
            void frame;
          }),
      },
      fetch: async () => {
        fetches += 1;
        return { status: 500, json: async () => ({}) };
      },
    });
    const controller = new AbortController();
    const analysis = provider.analyzeFree(freeRequest(), controller.signal);
    await Promise.resolve();
    controller.abort();
    releaseTransform?.(encodeInferenceFrame(freeRequest().frame));
    await expect(analysis).rejects.toMatchObject({
      code: "provider_temporary_unavailable",
    });
    expect(fetches).toBe(0);
  });

  it("rejects a decoder-valid transformed JPEG bound to a different inverse transform", async () => {
    let fetches = 0;
    const provider = createRoboflowVisionProvider({
      config: {
        apiUrl: "http://127.0.0.1:9001",
        workspaceId: "revelai",
        freeModelBundleId: "free-bundle-v1",
        verifiedModelBundleId: "verified-bundle-v1",
        freeProviderVersion: "provider-v1",
        verifiedProviderVersion: "provider-v1",
      },
      transformer: {
        transform: async (frame) => {
          const encoded = encodeInferenceFrame(frame);
          return {
            ...encoded,
            transform: { ...encoded.transform, padLeft: 0 },
          };
        },
      },
      fetch: async () => {
        fetches += 1;
        return { status: 500, json: async () => ({}) };
      },
    });
    await expect(provider.analyzeFree(freeRequest())).rejects.toMatchObject({
      code: "provider_output_invalid",
    });
    expect(fetches).toBe(0);
  });

  it("rejects an encoded-frame receipt hash that does not match bytes before fetch", async () => {
    let fetches = 0;
    const provider = createRoboflowVisionProvider({
      config: {
        apiUrl: "http://127.0.0.1:9001",
        workspaceId: "revelai",
        freeModelBundleId: "free-bundle-v1",
        verifiedModelBundleId: "verified-bundle-v1",
        freeProviderVersion: "provider-v1",
        verifiedProviderVersion: "provider-v1",
      },
      transformer: {
        transform: async (frame) => ({
          ...encodeInferenceFrame(frame),
          sha256: "a".repeat(64),
        }),
      },
      fetch: async () => {
        fetches += 1;
        return { status: 500, json: async () => ({}) };
      },
    });
    await expect(provider.analyzeFree(freeRequest())).rejects.toMatchObject({
      code: "provider_output_invalid",
    });
    expect(fetches).toBe(0);
  });

  it("rejects A-batch/B-execution swaps for both factory-owned demo and Roboflow batches", async () => {
    const providers = [
      createDemoVisionProvider(),
      createRoboflowVisionProvider({
        config: {
          apiUrl: "http://127.0.0.1:9001",
          workspaceId: "revelai",
          freeModelBundleId: "free-bundle-v1",
          verifiedModelBundleId: "verified-bundle-v1",
          freeProviderVersion: "provider-v1",
          verifiedProviderVersion: "provider-v1",
        },
        fetch: async () => ({
          status: 200,
          json: async () => ({ outputs: [verifiedWorkflowOutput()] }),
        }),
      }),
    ];

    for (const provider of providers) {
      const requestsA = Object.freeze([verifiedRequest(0)]);
      const requestsB = Object.freeze([verifiedRequest(0)]);
      const batchA = await analyzeOwnedVerifiedBatch(provider, requestsA);
      const batchB = await analyzeOwnedVerifiedBatch(provider, requestsB);

      expect(batchA.kind).toBe("owned-verified-vision-batch");
      expect(
        assertOwnedVerifiedVisionBatchForRequests(batchA, requestsA).requests,
      ).toBe(requestsA);
      expect(() =>
        assertOwnedVerifiedVisionBatchForRequests(batchA, requestsB),
      ).toThrow("provider_output_invalid");
      expect(() =>
        assertOwnedVerifiedVisionBatchForRequests(batchB, requestsA),
      ).toThrow("provider_output_invalid");
      await expect(
        analyzeOwnedVerifiedBatch(Object.freeze({ ...provider }), requestsA),
      ).rejects.toMatchObject({ code: "provider_output_invalid" });
    }
  });

  it("refuses caller-owned scheduler output for a competitive Roboflow batch", async () => {
    let fetches = 0;
    const provider = createRoboflowVisionProvider({
      config: {
        apiUrl: "http://127.0.0.1:9001",
        workspaceId: "revelai",
        freeModelBundleId: "free-bundle-v1",
        verifiedModelBundleId: "verified-bundle-v1",
        freeProviderVersion: "provider-v1",
        verifiedProviderVersion: "provider-v1",
      },
      fetch: async () => {
        fetches += 1;
        throw new Error("factory fetch must not be bypassed");
      },
    });
    const fakeScheduler = {
      async run() {
        return [roboflowVerifiedBatchFixture.frames[0]!];
      },
    } as unknown as VisionBatchScheduler;

    await expect(
      analyzeOwnedVerifiedBatch(
        provider,
        Object.freeze([verifiedRequest(0)]),
        fakeScheduler,
      ),
    ).rejects.toMatchObject({ code: "provider_output_invalid" });
    expect(fetches).toBe(0);
  });

  it("rejects a source frame changed while factory-owned Roboflow work is in flight", async () => {
    let release!: () => void;
    let beganFetch!: () => void;
    const fetching = new Promise<void>((resolve) => {
      beganFetch = resolve;
    });
    const provider = createRoboflowVisionProvider({
      config: {
        apiUrl: "http://127.0.0.1:9001",
        workspaceId: "revelai",
        freeModelBundleId: "free-bundle-v1",
        verifiedModelBundleId: "verified-bundle-v1",
        freeProviderVersion: "provider-v1",
        verifiedProviderVersion: "provider-v1",
      },
      fetch: async () => {
        beganFetch();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return {
          status: 200,
          json: async () => ({ outputs: [verifiedWorkflowOutput()] }),
        };
      },
    });
    const request = verifiedRequest(0);
    request.frame.jpeg = new Uint8Array(jpeg);
    const analysis = analyzeOwnedVerifiedBatch(
      provider,
      Object.freeze([request]),
    );

    await fetching;
    request.frame.jpeg[0] ^= 0xff;
    release();

    await expect(analysis).rejects.toMatchObject({
      code: "provider_output_invalid",
    });
  });
});
