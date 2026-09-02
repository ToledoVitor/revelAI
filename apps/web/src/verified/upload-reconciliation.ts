import type { AttemptOutcome } from "@revelai/contracts";
import { isOutcomeForAttempt } from "../lib/attempt-flow/upload-reconciliation";

export {
  isOutcomeForAttempt,
  isAmbiguousUploadError,
  resolveUploadReconciliation,
  type UploadReconciliation,
} from "../lib/attempt-flow/upload-reconciliation";

/** Kept as the W4 public seam while the neutral implementation lives in lib. */
export function isVerifiedOutcomeForAttempt(
  outcome: AttemptOutcome,
  attemptId: string,
): boolean {
  return isOutcomeForAttempt(outcome, attemptId, "verified");
}
