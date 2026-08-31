import type { VerifiedObservationEvidence } from "@revelai/vision";
import type { VerifiedVisionRequestExecution } from "./frame-extractor.js";

const c5BoundEvidence = new WeakMap<
  VerifiedObservationEvidence,
  VerifiedVisionRequestExecution
>();

/** C7 accepts only a C6 output registered by C5's verified composition. */
export function registerC5BoundVerifiedEvidence(
  evidence: VerifiedObservationEvidence,
  execution: VerifiedVisionRequestExecution,
): void {
  c5BoundEvidence.set(evidence, execution);
}

export function isC5BoundVerifiedEvidence(
  evidence: unknown,
): evidence is VerifiedObservationEvidence {
  return (
    typeof evidence === "object" &&
    evidence !== null &&
    c5BoundEvidence.has(evidence as VerifiedObservationEvidence)
  );
}

export function c5BoundEvidenceExecution(
  evidence: VerifiedObservationEvidence,
): VerifiedVisionRequestExecution {
  const execution = c5BoundEvidence.get(evidence);
  if (!execution) throw new Error("C5-bound evidence required");
  return execution;
}
