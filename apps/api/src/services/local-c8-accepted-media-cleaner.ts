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
  if (!isLocalMediaStorageCapability(input.storage))
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
      const owned = await ownership.ownsExactAcceptedMediaCleanupPair(claim);
      if (!owned) throw new Error("C8 cleaner ownership mismatch.");
      const outcomes = await Promise.allSettled([
        input.storage.delete(claim.mediaId),
        input.storage.deleteFrame(claim.frameBatchId),
      ]);
      if (outcomes.some((outcome) => outcome.status === "rejected"))
        throw new Error("C8 cleaner physical cleanup failed.");
    },
  });
}
