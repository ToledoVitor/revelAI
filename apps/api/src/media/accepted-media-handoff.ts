import type { DurableProcessingContext } from "./extraction-manifest.js";
import type {
  MediaUploadContext,
  StoredMediaAttachment,
} from "../repositories/attempt-repository.js";

/** Opaque C5 cleanup capability: consumers never receive a storage path. */
export type AcceptedMediaCleanup = Readonly<{
  cleanup(): Promise<void>;
}>;

/**
 * One C5-issued handoff. Runtime authority lives in the pipeline-local
 * verifier; this structural type deliberately exposes no minting mechanism.
 */
export type AcceptedMediaHandoff = Readonly<{
  context: MediaUploadContext;
  storedMedia: StoredMediaAttachment;
  sourceSha256: string;
  processingContext: DurableProcessingContext;
  cleanup: AcceptedMediaCleanup;
}>;

/** C4 receives this verifier, never the pipeline's issuer. */
export interface AcceptedMediaHandoffVerifier {
  accepts(value: unknown): value is AcceptedMediaHandoff;
}
