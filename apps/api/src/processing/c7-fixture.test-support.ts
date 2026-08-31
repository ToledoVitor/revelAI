import { createDemoVisionProvider, type VisionProvider } from "@revelai/vision";
import { createExtractionManifest } from "../media/extraction-manifest.js";
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
      rawBytes: Uint8Array.of(index % 256),
    })),
  });
  if (manifest.mode !== "verified") throw new Error("fixture must be verified");
  const evidence = await assembleVerifiedObservation({
    manifest,
    provider: fixtureProvider(provenance),
    calibrationSessionId: sessionId,
    calibrationNonce: nonce,
    frames: {
      async readFrame() {
        return Uint8Array.of(1);
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

function fixtureProvider(provenance: "demo" | "roboflow"): VisionProvider {
  const demo = createDemoVisionProvider();
  if (provenance === "demo") return demo;
  return Object.freeze({
    ...demo,
    verifiedProvenance: Object.freeze({
      kind: "roboflow" as const,
      workspaceId: "revelai-workspace",
      workflowId: "revelai-wall-pass-geometry-v1" as const,
      workflowVersion: "1.0.0" as const,
      modelBundleId: "wall-pass-bundle-v1",
      providerVersion: "roboflow-inference-v1",
    }),
    async analyzeVerified(input, signal, deadline) {
      const observation = await demo.analyzeVerified(input, signal, deadline);
      return Object.freeze({
        ...observation,
        inference: Object.freeze({
          sha256: "d".repeat(64),
          transform: Object.freeze({
            sourceWidth: 1280,
            sourceHeight: 720,
            inferenceWidth: 1280 as const,
            inferenceHeight: 720 as const,
            scale: 1,
            scaledWidth: 1280,
            scaledHeight: 720,
            padLeft: 0,
            padTop: 0,
          }),
        }),
      });
    },
  });
}
