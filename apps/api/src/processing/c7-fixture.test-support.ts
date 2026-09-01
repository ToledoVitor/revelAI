import {
  createDemoVisionProvider,
  createRoboflowVisionProvider,
  type ProviderFetch,
  type VisionProvider,
} from "@revelai/vision";
import { createHash } from "node:crypto";
import { encode } from "jpeg-js";
import {
  attestVerifiedExtractionContinuity,
  createExtractionManifest,
} from "../media/extraction-manifest.js";
import { assembleVerifiedObservation } from "./observation-assembler.js";
import {
  evaluateVerifiedIntegrity,
  type VerifiedAttemptCandidate,
} from "./integrity-evaluator.js";

const attemptId = "11111111-1111-4111-8111-111111111111";
const mediaId = "22222222-2222-4222-8222-222222222222";
const sessionId = "33333333-3333-4333-8333-333333333333";
const nonce = "c".repeat(43);
const mediaSha256 = "a".repeat(64);
const fixtureJpeg = new Uint8Array(
  encode(
    {
      width: 1280,
      height: 720,
      data: new Uint8Array(1280 * 720 * 4).fill(255),
    },
    80,
  ).data,
);
const fixtureJpegSha256 = createHash("sha256")
  .update(fixtureJpeg)
  .digest("hex");

export async function verifiedCandidateFixture(
  provenance: "demo" | "roboflow" = "demo",
): Promise<VerifiedAttemptCandidate> {
  const manifest = createExtractionManifest({
    attemptId,
    generation: 1,
    mediaId,
    mediaSha256,
    mode: "verified",
    probe: {
      container: "mp4",
      durationSeconds: 64,
      displayWidth: 1280,
      displayHeight: 720,
      nominalFps: 30,
      codec: "h264",
      sourceRotationDegrees: 0,
    },
    frames: Array.from({ length: 640 }, (_, index) => ({
      timestampSeconds: index / 10,
      reference: `frame_${index}`,
      rawBytes: fixtureJpeg,
    })),
  });
  if (manifest.mode !== "verified") throw new Error("fixture must be verified");
  attestVerifiedExtractionContinuity(
    manifest,
    manifest.frames.items.slice(40).map((frame) => ({
      timestampSeconds: frame.timestampSeconds,
      score: 0.1,
    })),
  );
  const evidence = await assembleVerifiedObservation({
    manifest,
    provider: createVerifiedFixtureVisionProvider(provenance),
    calibrationSessionId: sessionId,
    calibrationNonce: nonce,
    frames: {
      async readFrame(reference) {
        void reference;
        return fixtureJpeg;
      },
    },
  });
  const decision = evaluateVerifiedIntegrity({
    expected: {
      attemptId,
      generation: 1,
      challenge: { id: "wall-pass", version: 1 },
      calibrationSessionId: sessionId,
      calibrationNonce: nonce,
      mediaId,
      mediaSha256,
      rawPreRollSha256: manifest.rawPreRollSha256,
    },
    manifest,
    evidence,
  });
  if (decision.kind !== "integrity-valid")
    throw new Error("fixture must validate");
  return decision.candidate;
}

/** Test-only deterministic provider; it never performs a network request. */
export function createVerifiedFixtureVisionProvider(
  provenance: "demo" | "roboflow",
  options: Readonly<{
    onWorkflowRequest?: (
      url: Parameters<ProviderFetch>[0],
      init: Parameters<ProviderFetch>[1],
    ) => void;
    beforeWorkflowResponse?: (frameIndex: number) => void | Promise<void>;
    /** Exercises the production retry/deadline classification without I/O. */
    temporaryWorkflowFailures?: number;
    apiUrl?: string;
    workspaceId?: string;
    apiKey?: string;
    verifiedModelBundleId?: string;
    verifiedProviderVersion?: string;
    workflowId?: string;
    workflowVersion?: string;
    fiducialXOffsetForFrame?: (frameIndex: number) => number;
    workflowResponse?: unknown;
    workflowError?: Error;
  }> = {},
): VisionProvider {
  if (provenance === "demo") return createDemoVisionProvider();
  const workspaceId = options.workspaceId ?? "revelai-workspace";
  const verifiedModelBundleId =
    options.verifiedModelBundleId ?? "wall-pass-bundle-v1";
  const verifiedProviderVersion =
    options.verifiedProviderVersion ?? "roboflow-inference-v1";
  const frameIndexes: number[] = [];
  let temporaryFailures = options.temporaryWorkflowFailures ?? 0;
  return createRoboflowVisionProvider({
    config: {
      apiUrl: options.apiUrl ?? "http://127.0.0.1:9001",
      workspaceId,
      ...(options.apiKey ? { apiKey: options.apiKey } : {}),
      freeModelBundleId: "free-bundle-v1",
      verifiedModelBundleId,
      freeProviderVersion: "roboflow-inference-v1",
      verifiedProviderVersion,
    },
    transformer: {
      async transform(frame, transform, signal) {
        void signal;
        frameIndexes.push(frame.index);
        return Object.freeze({
          jpeg: fixtureJpeg,
          sha256: fixtureJpegSha256,
          transform,
        });
      },
    },
    fetch: async (url, init) => {
      options.onWorkflowRequest?.(url, init);
      if (temporaryFailures > 0) {
        temporaryFailures -= 1;
        return {
          status: 503,
          json: async () => ({ errors: ["temporary fixture failure"] }),
        };
      }
      const index = frameIndexes.shift();
      if (index === undefined) throw new Error("fixture frame index required");
      await options.beforeWorkflowResponse?.(index);
      if (options.workflowError) throw options.workflowError;
      return {
        status: 200,
        json: async () => ({
          ...(options.workflowResponse
            ? options.workflowResponse
            : {
                outputs: [
                  roboflowOutput(index, {
                    verifiedModelBundleId,
                    verifiedProviderVersion,
                    workflowId: options.workflowId,
                    workflowVersion: options.workflowVersion,
                    fiducialXOffset: options.fiducialXOffsetForFrame?.(index),
                  }),
                ],
              }),
        }),
      };
    },
  });
}

function roboflowOutput(
  frameIndex: number,
  input: Readonly<{
    verifiedModelBundleId: string;
    verifiedProviderVersion: string;
    workflowId?: string;
    workflowVersion?: string;
    fiducialXOffset?: number;
  }>,
) {
  const activeIndex = frameIndex - 40;
  const active = activeIndex >= 0 && activeIndex < 600;
  const phase = activeIndex >= 0 ? activeIndex % 5 : 0;
  const contact = active && activeIndex < 597 && (phase === 0 || phase === 1);
  const ballY =
    !active || activeIndex >= 597
      ? undefined
      : phase === 0 || phase === 1
        ? 530
        : phase === 2
          ? 100
          : phase === 3
            ? 10
            : 40;
  const side = Math.floor(activeIndex / 5) % 2 === 0 ? "left" : "right";
  return {
    kind: "wall-pass-geometry-v1",
    image: { width: 1280, height: 720, coordinateSystem: "inference_pixels" },
    workflow: {
      id: input.workflowId ?? "revelai-wall-pass-geometry-v1",
      version: input.workflowVersion ?? "1.0.0",
      modelBundleId: input.verifiedModelBundleId,
      providerVersion: input.verifiedProviderVersion,
    },
    detections: [
      {
        class: "athlete",
        xMin: 400,
        yMin: 100,
        xMax: 800,
        yMax: 650,
        confidence: 0.93,
      },
      ...(ballY === undefined
        ? []
        : [
            {
              class: "ball",
              xMin: 500,
              yMin: Math.max(0, ballY - 15),
              xMax: 530,
              yMax: ballY,
              confidence: 0.88,
            },
          ]),
    ],
    keypoints: [
      {
        class: "left_foot",
        x: 515,
        y: ballY ?? 515,
        confidence: contact && side === "left" ? 0.9 : 0.1,
      },
      {
        class: "right_foot",
        x: 515,
        y: ballY ?? 515,
        confidence: contact && side === "right" ? 0.9 : 0.1,
      },
    ],
    fiducials: [
      ["a-top-left", 140, 290],
      ["a-top-right", 160, 290],
      ["a-bottom-right", 160, 310],
      ["a-bottom-left", 140, 310],
      ["b-top-left", 440, 290],
      ["b-top-right", 460, 290],
      ["b-bottom-right", 460, 310],
      ["b-bottom-left", 440, 310],
    ].map(([name, x, y]) => ({
      class: name,
      x: Number(x) + (input.fiducialXOffset ?? 0),
      y: Number(y),
      confidence: 0.92,
    })),
    geometry: {
      wallFloorEdge: { x1: 0, y1: 0, x2: 800, y2: 0, confidence: 0.94 },
    },
  };
}
