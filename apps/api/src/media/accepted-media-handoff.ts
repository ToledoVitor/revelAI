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
 * One C5-issued, non-structural handoff. Keeping its correlated facts in one
 * branded value prevents a caller from pairing A's upload context with B's
 * media, digest, receipt, or cleanup capability.
 */
const acceptedMediaHandoffBrand: unique symbol = Symbol(
  "revelai.accepted-media-handoff",
);

export type AcceptedMediaHandoff = Readonly<{
  context: MediaUploadContext;
  storedMedia: StoredMediaAttachment;
  sourceSha256: string;
  processingContext: DurableProcessingContext;
  cleanup: AcceptedMediaCleanup;
  [acceptedMediaHandoffBrand]: true;
}>;

export function createAcceptedMediaHandoff<
  T extends Omit<AcceptedMediaHandoff, typeof acceptedMediaHandoffBrand>,
>(input: T): T & AcceptedMediaHandoff {
  const handoff = {
    ...input,
  };
  Object.defineProperty(handoff, acceptedMediaHandoffBrand, {
    value: true,
    enumerable: false,
  });
  return Object.freeze(handoff) as T & AcceptedMediaHandoff;
}

export function isAcceptedMediaHandoff(
  value: unknown,
): value is AcceptedMediaHandoff {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<PropertyKey, unknown>)[acceptedMediaHandoffBrand] === true
  );
}
