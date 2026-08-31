import { describe, expect, it } from "vitest";
import {
  analyzeBatch,
  createDemoVisionProvider,
  createRoboflowVisionProvider,
  VisionProviderError,
} from "./providers.js";
import {
  createLetterboxTransform,
  inverseInferencePoint,
} from "./transform.js";

const attemptId = "11111111-1111-4111-8111-111111111111";

function freeRequest(index = 0) {
  return {
    kind: "free-training" as const,
    attemptId,
    frame: {
      index,
      timestampMs: index * 100,
      sourceWidth: 1440,
      sourceHeight: 1080,
      jpeg: Uint8Array.of(0xff, 0xd8, 0xff, 0xd9),
    },
  };
}

describe("vision providers", () => {
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
      transformer: { transform: async (frame) => frame.jpeg },
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
        body: JSON.stringify({
          inputs: { image: { type: "base64", value: "/9j/2Q==" } },
        }),
      },
    });
    expect(JSON.stringify(calls[0])).not.toContain("Authorization");
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
        transformer: { transform: async (frame) => frame.jpeg },
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
      transformer: { transform: async (frame) => frame.jpeg },
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
      transformer: { transform: async (frame) => frame.jpeg },
      fetch: async () => ({
        status: 200,
        json: async () => Promise.reject(new Error("unreadable response")),
      }),
    });
    await expect(provider.analyzeFree(freeRequest())).rejects.toMatchObject({
      code: "provider_output_invalid",
    });
  });
});
