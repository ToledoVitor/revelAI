import {
  FreeVisionFrameRequestSchema,
  VerifiedVisionFrameRequestSchema,
  VisionProviderError,
  type VisionFrameRequest,
} from "@revelai/vision";
import {
  parseExtractionManifest,
  type ExtractionManifest,
} from "../media/extraction-manifest.js";

/** C5-owned opaque capability; C6 never receives a storage path. */
export type OpaqueFrameReader = Readonly<{
  readFrame(reference: string, signal?: AbortSignal): Promise<Uint8Array>;
}>;

export async function extractionManifestToVisionRequests(
  input: Readonly<{
    manifest: ExtractionManifest;
    frames: OpaqueFrameReader;
    signal?: AbortSignal;
  }>,
): Promise<readonly VisionFrameRequest[]> {
  assertNotAborted(input.signal);
  const manifest = parseExtractionManifest(input.manifest);
  const requests = await Promise.all(
    manifest.frames.items.map(async (item) => {
      assertNotAborted(input.signal);
      const frame = {
        index: item.ordinal,
        timestampMs: Math.round(item.timestampSeconds * 1000),
        sourceWidth: manifest.display.width,
        sourceHeight: manifest.display.height,
        jpeg: await input.frames.readFrame(item.reference, input.signal),
      };
      assertNotAborted(input.signal);
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

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted)
    throw new VisionProviderError("provider_temporary_unavailable");
}
