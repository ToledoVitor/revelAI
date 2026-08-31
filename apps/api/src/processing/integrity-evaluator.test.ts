import { createDemoVisionProvider, type VisionProvider } from "@revelai/vision";
import { describe, expect, it } from "vitest";
import { createExtractionManifest } from "../media/extraction-manifest.js";
import { assembleVerifiedObservation } from "./observation-assembler.js";
import {
  evaluateVerifiedIntegrity,
  scoreVerifiedCandidate,
  serializeIntegrityDecision,
  temporaryIntegrityDecision,
} from "./integrity-evaluator.js";

const attemptId = "11111111-1111-4111-8111-111111111111";
const mediaId = "22222222-2222-4222-8222-222222222222";
const sessionId = "33333333-3333-4333-8333-333333333333";
const nonce = "c".repeat(43);
const mediaSha256 = "a".repeat(64);

describe("verified integrity evaluator", () => {
  it("creates a score-capable opaque candidate only from C5 to C6 evidence", async () => {
    const input = await validInput();
    const decision = evaluateVerifiedIntegrity(input);

    expect(decision.kind).toBe("integrity-valid");
    if (decision.kind !== "integrity-valid") return;
    expect(scoreVerifiedCandidate(decision.candidate)).toMatchObject({
      ruleVersion: "wall-pass-v1-score-1",
    });
    expect(JSON.stringify(serializeIntegrityDecision(decision))).not.toMatch(
      /sha|nonce|frame|confidence|drift|media/i,
    );
  });

  it("rejects detached structural evidence even when its fields are complete", async () => {
    const input = await validInput();
    expect(
      evaluateVerifiedIntegrity({
        ...input,
        evidence: structuredClone(input.evidence),
      }),
    ).toMatchObject({
      kind: "integrity-invalid",
      code: "calibration_not_verified",
    });
  });

  it("gives C5 probe/continuity binding failures precedence", async () => {
    const input = await validInput();
    const portrait = {
      ...input.manifest,
      probe: {
        ...input.manifest.probe,
        displayWidth: 720,
        displayHeight: 1280,
      },
      display: { ...input.manifest.display, width: 720, height: 1280 },
    };
    expect(
      evaluateVerifiedIntegrity({ ...input, manifest: portrait }),
    ).toMatchObject({ code: "video_not_continuous" });
  });

  it("preserves temporary analysis failures as retryable without a candidate", () => {
    expect(temporaryIntegrityDecision()).toEqual({
      kind: "analysis-temporary-unavailable",
      code: "analysis_temporary_unavailable",
      message: "A análise está indisponível temporariamente.",
      retryable: true,
    });
  });
});

async function validInput(
  provider: VisionProvider = createDemoVisionProvider(),
) {
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
    provider,
    calibrationSessionId: sessionId,
    calibrationNonce: nonce,
    frames: {
      async readFrame() {
        return Uint8Array.of(1);
      },
    },
  });
  return {
    expected: {
      attemptId,
      generation: 1,
      challenge: { id: "wall-pass" as const, version: 1 as const },
      calibrationSessionId: sessionId,
      calibrationNonce: nonce,
      mediaId,
      mediaSha256,
      rawPreRollSha256: manifest.rawPreRollSha256,
    },
    manifest,
    evidence,
  };
}
