import {
  FreeVisionFrameRequestSchema,
  VerifiedVisionFrameRequestSchema,
  type VisionFrameRequest,
} from "@revelai/vision";
import {
  parseExtractionManifest,
  type ExtractionManifest,
} from "../media/extraction-manifest.js";

/** C5-owned opaque capability; C6 never receives a storage path. */
export type OpaqueFrameReader = Readonly<{
  readFrame(reference: string): Promise<Uint8Array>;
}>;

export async function extractionManifestToVisionRequests(
  input: Readonly<{
    manifest: ExtractionManifest;
    frames: OpaqueFrameReader;
  }>,
): Promise<readonly VisionFrameRequest[]> {
  const manifest = parseExtractionManifest(input.manifest);
  const requests = await Promise.all(
    manifest.frames.items.map(async (item) => {
      const frame = {
        index: item.ordinal,
        timestampMs: Math.round(item.timestampSeconds * 1000),
        sourceWidth: manifest.display.width,
        sourceHeight: manifest.display.height,
        jpeg: await input.frames.readFrame(item.reference),
      };
      return manifest.mode === "free"
        ? FreeVisionFrameRequestSchema.parse({
            kind: "free-training",
            attemptId: manifest.attemptId,
            frame,
          })
        : VerifiedVisionFrameRequestSchema.parse({
            kind: "verified-wall-pass",
            attemptId: manifest.attemptId,
            challenge: { id: "wall-pass", version: 1 },
            frame,
          });
    }),
  );
  return Object.freeze(requests);
}
