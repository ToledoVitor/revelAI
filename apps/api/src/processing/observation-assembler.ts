import {
  analyzeBatch,
  analyzeOwnedVerifiedBatch,
  assertOwnedVerifiedVisionBatchForRequests,
  assembleFreeInsight,
  assembleVerifiedEvidence,
  VisionBatchScheduler,
  type VerifiedVisionFrameRequest,
  type VerifiedObservationEvidence,
  type VisionFrameRequest,
  type VisionProvider,
} from "@revelai/vision";
import type { FreeInsight } from "@revelai/contracts";
import { createHash } from "node:crypto";
import {
  verifiedExtractionCapability,
  verifiedExtractionContinuityIdentity,
  verifiedExtractionIdentity,
  type ExtractionManifest,
} from "../media/extraction-manifest.js";
import {
  extractionManifestToVisionRequests,
  type OpaqueFrameReader,
} from "./frame-extractor.js";

export type C5BoundVerifiedEvidenceExecution = Readonly<{
  manifest: Extract<ExtractionManifest, Readonly<{ mode: "verified" }>>;
  extractionIdentity: string;
  sourceSha256: readonly string[];
  inferenceSha256: readonly (string | null)[];
  schedulerId: "verified-wall-pass-image-scheduler-v1";
  samplingId: "wall-pass-v1-10fps-640-v1";
}>;

/** C7 can query this map but only this compositor can populate it. */
const c5BoundEvidence = new WeakMap<
  VerifiedObservationEvidence,
  C5BoundVerifiedEvidenceExecution
>();

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
): C5BoundVerifiedEvidenceExecution {
  const execution = c5BoundEvidence.get(evidence);
  if (!execution) throw new Error("C5-bound evidence required");
  return execution;
}

export async function assembleFreeObservation(
  input: Readonly<{
    manifest: ExtractionManifest & Readonly<{ mode: "free" }>;
    frames: OpaqueFrameReader;
    provider: VisionProvider;
    scheduler?: VisionBatchScheduler;
    generatedAt: string;
    signal?: AbortSignal;
  }>,
): Promise<FreeInsight> {
  const requests = await extractionManifestToVisionRequests({
    manifest: input.manifest,
    frames: input.frames,
    signal: input.signal,
  });
  const batch = await analyzeBatch(
    input.provider,
    requests,
    input.scheduler,
    input.signal,
  );
  if (batch.kind !== "free-training")
    throw new Error("cross-kind observation batch");
  return assembleFreeInsight({ batch, generatedAt: input.generatedAt });
}

/**
 * Sole C5→C6 compositor. The C5 array is never rebound to a structural batch:
 * Vision must issue a capability for this exact array before C5 continuity and
 * source/encoded digest facts may become evidence accepted by C7.
 */
export async function assembleVerifiedObservation(
  input: Readonly<{
    manifest: ExtractionManifest & Readonly<{ mode: "verified" }>;
    frames: OpaqueFrameReader;
    provider: VisionProvider;
    scheduler?: VisionBatchScheduler;
    calibrationSessionId: string;
    calibrationNonce: string;
    signal?: AbortSignal;
  }>,
): Promise<ReturnType<typeof assembleVerifiedEvidence>> {
  const requests = await extractionManifestToVisionRequests({
    manifest: input.manifest,
    frames: input.frames,
    signal: input.signal,
  });
  assertVerifiedRequests(requests);
  const ownedBatch = await analyzeOwnedVerifiedBatch(
    input.provider,
    requests,
    input.scheduler,
    input.signal,
  );
  const owned = assertOwnedVerifiedVisionBatchForRequests(ownedBatch, requests);
  if (owned.batch.frames.length !== 640)
    throw new Error("verified analysis batch capability required");
  const sourceSha256 = Object.freeze(
    requests.map((request) =>
      createHash("sha256").update(request.frame.jpeg).digest("hex"),
    ),
  );
  if (
    !sameArray(sourceSha256, owned.sourceSha256) ||
    !sameArray(
      owned.encodedSha256,
      owned.batch.frames.map((frame) => frame.inference?.sha256 ?? null),
    ) ||
    !sameProvenance(owned.provenance, owned.batch.provenance)
  )
    throw new Error("verified analysis batch capability required");
  const extractionIdentity = executionIdentity(
    verifiedExtractionIdentity(input.manifest),
    verifiedExtractionContinuityIdentity(
      verifiedExtractionCapability(input.manifest),
    ),
    sourceSha256,
    owned.encodedSha256,
    owned.provenance.kind,
    owned.schedulerId,
    owned.samplingId,
  );
  const execution: C5BoundVerifiedEvidenceExecution = Object.freeze({
    manifest: input.manifest,
    extractionIdentity,
    sourceSha256,
    inferenceSha256: owned.encodedSha256,
    schedulerId: owned.schedulerId,
    samplingId: owned.samplingId,
  });
  const evidence = assembleVerifiedEvidence({
    batch: owned.batch,
    binding: {
      attemptId: input.manifest.attemptId,
      generation: input.manifest.generation,
      mediaId: input.manifest.mediaId,
      mediaSha256: input.manifest.mediaSha256,
      rawPreRollSha256: input.manifest.rawPreRollSha256,
      calibrationSessionId: input.calibrationSessionId,
      calibrationNonce: input.calibrationNonce,
      extractionVersion: input.manifest.extractionVersion,
      extractionIdentity: verifiedExtractionIdentity(input.manifest),
      executionIdentity: execution.extractionIdentity,
      schedulerId: execution.schedulerId,
      samplingId: execution.samplingId,
    },
  });
  c5BoundEvidence.set(evidence, execution);
  return evidence;
}

function sameArray<T>(left: readonly T[], right: readonly T[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function assertVerifiedRequests(
  requests: readonly VisionFrameRequest[],
): asserts requests is readonly VerifiedVisionFrameRequest[] {
  if (requests.some((request) => request.kind !== "verified-wall-pass"))
    throw new Error("cross-kind verified request array");
}

function sameProvenance(
  left: VerifiedObservationEvidence["provenance"],
  right: VerifiedObservationEvidence["provenance"],
): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "demo" && right.kind === "demo")
    return (
      left.fixtureId === right.fixtureId &&
      left.providerVersion === right.providerVersion
    );
  if (left.kind === "roboflow" && right.kind === "roboflow")
    return (
      left.workspaceId === right.workspaceId &&
      left.workflowId === right.workflowId &&
      left.workflowVersion === right.workflowVersion &&
      left.modelBundleId === right.modelBundleId &&
      left.providerVersion === right.providerVersion
    );
  return false;
}

function executionIdentity(
  extractionIdentity: string,
  continuityIdentity: string,
  sourceSha256: readonly string[],
  inferenceSha256: readonly (string | null)[],
  provenanceKind: "demo" | "roboflow",
  schedulerId: "verified-wall-pass-image-scheduler-v1",
  samplingId: "wall-pass-v1-10fps-640-v1",
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        extractionIdentity,
        continuityIdentity,
        frames: sourceSha256.map((source, ordinal) => [
          ordinal,
          source,
          inferenceSha256[ordinal],
        ]),
        provenanceKind,
        schedulerId,
        samplingId,
      }),
    )
    .digest("hex");
}
