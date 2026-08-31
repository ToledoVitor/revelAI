import {
  isLocalMediaStorageCapability,
  type LocalMediaStorage,
} from "../storage/local-media-storage.js";
import {
  resolveC4AcceptedMediaCleanupAuthority,
  type SQLiteAttemptRepository,
} from "../repositories/sqlite-attempt-repository.js";
import type { OpaqueAcceptedMediaCleaner } from "./media-attachment-recovery.js";

/**
 * Production C8 bridge for local storage. It accepts only C5's factory
 * capability and verifies durable C4 retention ownership before any opaque
 * identifier reaches a physical delete operation. Paths stay inside storage.
 */
export function createLocalC8AcceptedMediaCleaner(
  input: Readonly<{
    storage: LocalMediaStorage;
    repository: SQLiteAttemptRepository;
  }>,
): OpaqueAcceptedMediaCleaner {
  const storage = input.storage;
  if (!isLocalMediaStorageCapability(storage))
    throw new Error("C8 cleaner requires a C5 local storage capability.");
  const ownership = resolveC4AcceptedMediaCleanupAuthority(input.repository);
  if (!ownership)
    throw new Error("C8 cleaner requires a C4 repository capability.");
  return Object.freeze({
    cleanup: async (
      claim: Readonly<{
        attemptId: string;
        mediaId: string;
        frameBatchId: string;
      }>,
    ) => {
      const snapshot = snapshotCleanupClaim(claim);
      const owned = await ownership.ownsExactAcceptedMediaCleanupPair(snapshot);
      if (!owned) throw new Error("C8 cleaner ownership mismatch.");
      const outcomes = await Promise.allSettled([
        storage.delete(snapshot.mediaId),
        storage.deleteFrame(snapshot.frameBatchId),
      ]);
      if (outcomes.some((outcome) => outcome.status === "rejected"))
        throw new Error("C8 cleaner physical cleanup failed.");
    },
  });
}

function snapshotCleanupClaim(
  claim: Readonly<{
    attemptId: string;
    mediaId: string;
    frameBatchId: string;
  }>,
): Readonly<{ attemptId: string; mediaId: string; frameBatchId: string }> {
  const attemptId = requireOpaqueUuid(claim.attemptId);
  const mediaId = requireOpaqueUuid(claim.mediaId);
  const frameBatchId = requireOpaqueUuid(claim.frameBatchId);
  return Object.freeze({ attemptId, mediaId, frameBatchId });
}

function requireOpaqueUuid(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  )
    throw new Error("C8 cleaner cleanup identifiers must be UUIDs.");
  return value;
}
