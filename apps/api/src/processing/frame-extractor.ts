import {
  FreeVisionFrameRequestSchema,
  VerifiedVisionFrameRequestSchema,
  VisionProviderError,
  type VisionFrameRequest,
  type VerifiedVisionObservationBatch,
} from "@revelai/vision";
import { createHash } from "node:crypto";
import {
  assertVerifiedExtractionFrame,
  parseExtractionManifest,
  verifiedExtractionCapability,
  verifiedExtractionContinuityIdentity,
  verifiedExtractionIdentity,
  type ExtractionManifest,
} from "../media/extraction-manifest.js";

/** C5-owned opaque capability; C6 never receives a storage path. */
export type OpaqueFrameReader = Readonly<{
  readFrame(reference: string, signal?: AbortSignal): Promise<Uint8Array>;
}>;

/** Private proof that every scheduled request came from C5's exact bytes. */
export type VerifiedVisionRequestExecution = Readonly<{
  kind: "verified-vision-request-execution";
}>;

type VerifiedVisionRequestExecutionData = Readonly<{
  manifest: Extract<ExtractionManifest, Readonly<{ mode: "verified" }>>;
  /** Present only after C6 has correlated this exact batch to C5 reads. */
  extractionIdentity: string | null;
  sourceSha256: readonly string[];
  inferenceSha256: readonly (string | null)[] | null;
  schedulerId: "verified-wall-pass-image-scheduler-v1";
  samplingId: "wall-pass-v1-10fps-640-v1";
}>;

type BoundVerifiedVisionRequestExecutionData = Omit<
  VerifiedVisionRequestExecutionData,
  "extractionIdentity" | "inferenceSha256"
> &
  Readonly<{
    extractionIdentity: string;
    inferenceSha256: readonly (string | null)[];
  }>;

const verifiedRequestExecutions = new WeakMap<
  readonly VisionFrameRequest[],
  VerifiedVisionRequestExecution
>();
const verifiedRequestExecutionData = new WeakMap<
  VerifiedVisionRequestExecution,
  VerifiedVisionRequestExecutionData
>();

export async function extractionManifestToVisionRequests(
  input: Readonly<{
    manifest: ExtractionManifest;
    frames: OpaqueFrameReader;
    signal?: AbortSignal;
  }>,
): Promise<readonly VisionFrameRequest[]> {
  assertNotAborted(input.signal);
  const manifest = parseExtractionManifest(input.manifest);
  const capability =
    manifest.mode === "verified"
      ? verifiedExtractionCapability(
          input.manifest as Extract<
            ExtractionManifest,
            Readonly<{ mode: "verified" }>
          >,
        )
      : null;
  const sourceSha256: string[] = [];
  const requests = await Promise.all(
    manifest.frames.items.map(async (item) => {
      assertNotAborted(input.signal);
      const jpeg = await input.frames.readFrame(item.reference, input.signal);
      if (capability)
        sourceSha256[item.ordinal] = assertVerifiedExtractionFrame(capability, {
          ordinal: item.ordinal,
          reference: item.reference,
          bytes: jpeg,
        });
      const frame = {
        index: item.ordinal,
        timestampMs: Math.round(item.timestampSeconds * 1000),
        sourceWidth: manifest.display.width,
        sourceHeight: manifest.display.height,
        jpeg,
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
  const result = Object.freeze(requests);
  if (capability && input.manifest.mode === "verified") {
    const execution = Object.freeze({
      kind: "verified-vision-request-execution" as const,
    });
    verifiedRequestExecutions.set(result, execution);
    verifiedRequestExecutionData.set(
      execution,
      Object.freeze({
        manifest: input.manifest,
        extractionIdentity: null,
        sourceSha256: Object.freeze([...sourceSha256]),
        inferenceSha256: null,
        schedulerId: "verified-wall-pass-image-scheduler-v1",
        samplingId: "wall-pass-v1-10fps-640-v1",
      }),
    );
  }
  return result;
}

function executionIdentity(
  extractionIdentity: string,
  continuityIdentity: string,
  sourceSha256: readonly string[],
  inferenceSha256: readonly (string | null)[],
  provenanceKind: "demo" | "roboflow",
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
        schedulerId: "verified-wall-pass-image-scheduler-v1",
        samplingId: "wall-pass-v1-10fps-640-v1",
      }),
    )
    .digest("hex");
}

/** Rejects replayed arrays and parsed/structural manifests before C6 assembly. */
export function verifiedVisionRequestExecution(
  manifest: Extract<ExtractionManifest, Readonly<{ mode: "verified" }>>,
  requests: readonly VisionFrameRequest[],
): VerifiedVisionRequestExecution {
  const execution = verifiedRequestExecutions.get(requests);
  const data = execution && verifiedRequestExecutionData.get(execution);
  if (!data || data.manifest !== manifest || data.sourceSha256.length !== 640)
    throw new Error("verified extraction execution required");
  return execution;
}

export function verifiedVisionRequestExecutionData(
  execution: VerifiedVisionRequestExecution,
): BoundVerifiedVisionRequestExecutionData {
  const data = verifiedRequestExecutionData.get(execution);
  if (!data?.extractionIdentity || !data.inferenceSha256)
    throw new Error("verified batch execution required");
  return data as BoundVerifiedVisionRequestExecutionData;
}

/**
 * C6's one-way join: every observation batch is correlated to the exact C5
 * read digest at the same ordinal and, for Roboflow, to its encoded inference
 * digest. The resulting identity is the only one C7 accepts.
 */
export function bindVerifiedVisionRequestExecution(
  execution: VerifiedVisionRequestExecution,
  batch: VerifiedVisionObservationBatch,
): BoundVerifiedVisionRequestExecutionData {
  const data = verifiedRequestExecutionData.get(execution);
  if (!data || batch.frames.length !== data.sourceSha256.length)
    throw new Error("verified extraction execution required");
  const inferenceSha256 = batch.frames.map((frame) =>
    frame.inference ? frame.inference.sha256 : null,
  );
  if (
    (batch.provenance.kind === "roboflow" &&
      inferenceSha256.some((digest) => digest === null)) ||
    (batch.provenance.kind === "demo" &&
      inferenceSha256.some((digest) => digest !== null))
  )
    throw new Error("verified inference binding required");
  const extractionIdentity = executionIdentity(
    verifiedExtractionIdentity(data.manifest),
    verifiedExtractionContinuityIdentity(
      verifiedExtractionCapability(data.manifest),
    ),
    data.sourceSha256,
    inferenceSha256,
    batch.provenance.kind,
  );
  const next: BoundVerifiedVisionRequestExecutionData = Object.freeze({
    ...data,
    extractionIdentity,
    inferenceSha256: Object.freeze(inferenceSha256),
  });
  const existing = data.extractionIdentity;
  if (existing && existing !== next.extractionIdentity)
    throw new Error("verified extraction execution replay");
  verifiedRequestExecutionData.set(execution, next);
  return next;
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted)
    throw new VisionProviderError("provider_temporary_unavailable");
}
