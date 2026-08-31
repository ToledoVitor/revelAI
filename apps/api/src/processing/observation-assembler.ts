import {
  analyzeBatch,
  assembleFreeInsight,
  assembleVerifiedEvidence,
  VisionBatchScheduler,
  type VisionProvider,
} from "@revelai/vision";
import type { FreeInsight } from "@revelai/contracts";
import type { ExtractionManifest } from "../media/extraction-manifest.js";
import {
  extractionManifestToVisionRequests,
  type OpaqueFrameReader,
} from "./frame-extractor.js";

export async function assembleFreeObservation(
  input: Readonly<{
    manifest: ExtractionManifest & Readonly<{ mode: "free" }>;
    frames: OpaqueFrameReader;
    provider: VisionProvider;
    scheduler?: VisionBatchScheduler;
    generatedAt: string;
  }>,
): Promise<FreeInsight> {
  const requests = await extractionManifestToVisionRequests({
    manifest: input.manifest,
    frames: input.frames,
  });
  const batch = await analyzeBatch(input.provider, requests, input.scheduler);
  if (batch.kind !== "free-training")
    throw new Error("cross-kind observation batch");
  return assembleFreeInsight({ batch, generatedAt: input.generatedAt });
}

export async function assembleVerifiedObservation(
  input: Readonly<{
    manifest: ExtractionManifest & Readonly<{ mode: "verified" }>;
    frames: OpaqueFrameReader;
    provider: VisionProvider;
    scheduler?: VisionBatchScheduler;
  }>,
): Promise<ReturnType<typeof assembleVerifiedEvidence>> {
  const requests = await extractionManifestToVisionRequests({
    manifest: input.manifest,
    frames: input.frames,
  });
  const batch = await analyzeBatch(input.provider, requests, input.scheduler);
  if (batch.kind !== "verified-wall-pass")
    throw new Error("cross-kind observation batch");
  return assembleVerifiedEvidence({
    batch,
    binding: {
      attemptId: input.manifest.attemptId,
      generation: input.manifest.generation,
      mediaId: input.manifest.mediaId,
      mediaSha256: input.manifest.mediaSha256,
      rawPreRollSha256: input.manifest.rawPreRollSha256,
    },
  });
}
