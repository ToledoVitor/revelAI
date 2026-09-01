import { createHash } from "node:crypto";
import { freeSampleTimestamps } from "./eligibility.js";
import type { MediaProbe } from "./probe.js";

export type ExtractedFrame = Readonly<{
  timestampSeconds: number;
  reference: string;
  rawBytes: Uint8Array;
}>;

type ManifestFrame = Readonly<{
  ordinal: number;
  timestampSeconds: number;
  reference: string;
}>;

type VerifiedExtractionFrame = Readonly<{
  ordinal: number;
  reference: string;
  sourceSha256: string;
}>;

type ContinuityScene = Readonly<{
  timestampSeconds: number;
  score: number;
}>;

/**
 * Opaque C5 capability. Its associated bytes are never serialized into a
 * manifest; C6 can only prove a read against this exact, locally issued
 * extraction through the helpers below.
 */
export type VerifiedExtractionCapability = Readonly<{
  kind: "verified-extraction-capability";
}>;

type VerifiedExtractionData = Readonly<{
  manifest: Extract<ExtractionManifest, Readonly<{ mode: "verified" }>>;
  frames: readonly VerifiedExtractionFrame[];
  continuityIdentity: string | null;
  activeScenes: readonly ContinuityScene[] | null;
}>;

const verifiedExtractionCapabilities = new WeakMap<
  Extract<ExtractionManifest, Readonly<{ mode: "verified" }>>,
  VerifiedExtractionCapability
>();
const verifiedExtractionData = new WeakMap<
  VerifiedExtractionCapability,
  VerifiedExtractionData
>();
type ManifestBase = Readonly<{
  kind: "extraction-manifest";
  extractionVersion: "c5-frame-manifest-v1";
  mode: "free" | "verified";
  attemptId: string;
  generation: number;
  mediaId: string;
  mediaSha256: string;
  display: Readonly<{
    width: number;
    height: number;
    rotationDegrees: MediaProbe["sourceRotationDegrees"];
  }>;
  probe: MediaProbe;
  frames: Readonly<{ count: number; items: readonly ManifestFrame[] }>;
}>;

type FreeExtractionManifest = ManifestBase &
  Readonly<{
    mode: "free";
  }>;

type VerifiedExtractionManifest = ManifestBase &
  Readonly<{
    mode: "verified";
    preRoll: Readonly<{ count: 40 }>;
    active: Readonly<{ count: 600 }>;
    rawPreRollSha256: string;
  }>;

export type ExtractionManifest =
  | FreeExtractionManifest
  | VerifiedExtractionManifest;

/**
 * Safe, durable C5 facts used to recreate an in-process extraction
 * capability after a queued delivery. It intentionally never contains a
 * capability, local path, raw frame byte, or provider payload.
 */
export type DurableProcessingContext = Readonly<{
  /**
   * C4 persists only this reference. The receipt itself is atomically
   * published with C5's owned frame batch and carries the full byte
   * binding; context JSON is therefore never self-authenticating.
   */
  kind: "c5-durable-processing-context-v2";
  receipt: Readonly<{
    frameBatchId: string;
    mediaId: string;
    sha256: string;
  }>;
}>;

/** One canonical cross-process binding for a C5-owned receipt. */
export type StorageReceiptAuthority = Readonly<{
  attemptId: string;
  athleteId: string;
  generation: number;
  mode: "free" | "verified";
  mediaId: string;
  sourceSha256: string;
  /** C4's authoritative stored-media timestamp must match this receipt fact. */
  uploadedAt: string;
  calibrationSessionId: string | null;
  calibrationNonce: string | null;
}>;

export type StorageExtractionReceipt = Readonly<{
  kind: "c5-storage-extraction-receipt-v1";
  frameBatchId: string;
  authority: StorageReceiptAuthority;
  manifest: ExtractionManifest;
  frameSha256: readonly string[];
  activeScenes: readonly ContinuityScene[] | null;
}>;

export type DurableReceiptReader = DurableFrameReader &
  Readonly<{
    readReceipt(input: Readonly<{ frameBatchId: string }>): Promise<{
      bytes: Uint8Array;
    }>;
    sourceSha256ForOriginal(
      input: Readonly<{ mediaId: string }>,
    ): Promise<string>;
  }>;

export type DurableReconstructionAuthority = Readonly<{
  upload: StorageReceiptAuthority;
}>;

/** C5-owned byte reader. Implementations never disclose a storage path. */
export type DurableFrameReader = Readonly<{
  readFrame(reference: string): Promise<Uint8Array>;
}>;

export function createExtractionManifest(
  input: Readonly<{
    attemptId: string;
    generation: number;
    mediaId: string;
    mediaSha256: string;
    mode: "free" | "verified";
    probe: MediaProbe;
    frames: readonly ExtractedFrame[];
  }>,
): ExtractionManifest {
  assertUuid(input.attemptId);
  assertUuid(input.mediaId);
  if (!Number.isSafeInteger(input.generation) || input.generation < 1)
    throw new Error("Invalid extraction generation.");
  assertDigest(input.mediaSha256);
  assertProbe(input.probe);
  const items = input.frames.map((frame, ordinal) => frameItem(frame, ordinal));
  if (input.mode === "verified") {
    assertVerifiedFrames(input.frames);
    const manifest = freezeManifest({
      kind: "extraction-manifest",
      extractionVersion: "c5-frame-manifest-v1",
      mode: "verified",
      attemptId: input.attemptId,
      generation: input.generation,
      mediaId: input.mediaId,
      mediaSha256: input.mediaSha256,
      display: Object.freeze({
        width: input.probe.displayWidth,
        height: input.probe.displayHeight,
        rotationDegrees: input.probe.sourceRotationDegrees,
      }),
      probe: Object.freeze({ ...input.probe }),
      frames: Object.freeze({
        count: items.length,
        items: Object.freeze(items),
      }),
      preRoll: Object.freeze({ count: 40 }),
      active: Object.freeze({ count: 600 }),
      rawPreRollSha256: framedRawPreRollSha256(input.frames.slice(0, 40)),
    });
    issueVerifiedExtractionCapability(manifest, input.frames);
    return manifest;
  }
  assertFreeFrames(input.frames, input.probe.durationSeconds);
  return freezeManifest({
    kind: "extraction-manifest",
    extractionVersion: "c5-frame-manifest-v1",
    mode: "free",
    attemptId: input.attemptId,
    generation: input.generation,
    mediaId: input.mediaId,
    mediaSha256: input.mediaSha256,
    display: Object.freeze({
      width: input.probe.displayWidth,
      height: input.probe.displayHeight,
      rotationDegrees: input.probe.sourceRotationDegrees,
    }),
    probe: Object.freeze({ ...input.probe }),
    frames: Object.freeze({ count: items.length, items: Object.freeze(items) }),
  });
}

/**
 * Reissues a new process-local C5 capability from strictly parsed durable
 * facts and the opaque frame reader. Byte/digest mismatches fail closed.
 */
export async function reconstructDurableProcessingContext(
  input: Readonly<{
    context: unknown;
    frames: DurableFrameReader;
    receipts?: DurableReceiptReader;
    authority?: DurableReconstructionAuthority;
  }>,
): Promise<ExtractionManifest> {
  const context = parseDurableProcessingContext(input.context);
  return reconstructStorageBackedContext(context, input);
}

async function reconstructStorageBackedContext(
  context: Extract<
    DurableProcessingContext,
    { kind: "c5-durable-processing-context-v2" }
  >,
  input: Readonly<{
    frames: DurableFrameReader;
    receipts?: DurableReceiptReader;
    authority?: DurableReconstructionAuthority;
  }>,
): Promise<ExtractionManifest> {
  if (!input.receipts || !input.authority)
    throw new Error("durable extraction authority unavailable");
  const stored = await input.receipts.readReceipt(context.receipt);
  const actualReceiptSha256 = createHash("sha256")
    .update(stored.bytes)
    .digest("hex");
  if (actualReceiptSha256 !== context.receipt.sha256)
    throw new Error("durable extraction authority mismatch");
  const receipt = parseStorageExtractionReceipt(stored.bytes);
  if (receipt.frameBatchId !== context.receipt.frameBatchId)
    throw new Error("durable extraction authority mismatch");
  if (!sameReceiptAuthority(receipt.authority, input.authority.upload))
    throw new Error("durable extraction authority mismatch");
  if (
    (await input.receipts.sourceSha256ForOriginal({
      mediaId: receipt.authority.mediaId,
    })) !== receipt.authority.sourceSha256
  )
    throw new Error("durable extraction authority mismatch");
  const frames = await Promise.all(
    receipt.manifest.frames.items.map(async (frame) =>
      Object.freeze({
        timestampSeconds: frame.timestampSeconds,
        reference: frame.reference,
        rawBytes: await input.frames.readFrame(frame.reference),
      }),
    ),
  );
  if (
    receipt.frameSha256.length !== frames.length ||
    receipt.frameSha256.some(
      (digest, index) =>
        digest !==
        createHash("sha256").update(frames[index]!.rawBytes).digest("hex"),
    )
  )
    throw new Error("durable extraction frame mismatch");
  const reconstructed = createExtractionManifest({
    attemptId: receipt.manifest.attemptId,
    generation: receipt.manifest.generation,
    mediaId: receipt.manifest.mediaId,
    mediaSha256: receipt.manifest.mediaSha256,
    mode: receipt.manifest.mode,
    probe: receipt.manifest.probe,
    frames,
  });
  if (
    !sameExtractionAuthority(receipt.manifest, reconstructed, frames) ||
    reconstructed.mediaSha256 !== input.authority.upload.sourceSha256
  )
    throw new Error("durable extraction authority mismatch");
  if (reconstructed.mode === "verified") {
    if (!receipt.activeScenes)
      throw new Error("durable extraction frame mismatch");
    attestVerifiedExtractionContinuity(reconstructed, receipt.activeScenes);
  } else if (receipt.activeScenes !== null) {
    throw new Error("durable extraction frame mismatch");
  }
  return reconstructed;
}

export function parseStorageExtractionReceipt(
  bytes: Uint8Array,
): StorageExtractionReceipt {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    throw new Error("invalid storage extraction receipt");
  }
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "kind",
      "frameBatchId",
      "authority",
      "manifest",
      "frameSha256",
      "activeScenes",
    ]) ||
    value.kind !== "c5-storage-extraction-receipt-v1" ||
    !isUuid(value.frameBatchId)
  )
    throw new Error("invalid storage extraction receipt");
  const authority = value.authority;
  if (
    !isRecord(authority) ||
    !hasOnlyKeys(authority, [
      "attemptId",
      "athleteId",
      "generation",
      "mode",
      "mediaId",
      "sourceSha256",
      "uploadedAt",
      "calibrationSessionId",
      "calibrationNonce",
    ]) ||
    !isUuid(authority.attemptId) ||
    !isUuid(authority.athleteId) ||
    typeof authority.generation !== "number" ||
    !Number.isSafeInteger(authority.generation) ||
    authority.generation < 1 ||
    (authority.mode !== "free" && authority.mode !== "verified") ||
    !isUuid(authority.mediaId) ||
    typeof authority.sourceSha256 !== "string" ||
    !isDigest(authority.sourceSha256) ||
    typeof authority.uploadedAt !== "string" ||
    !isUtcIsoTimestamp(authority.uploadedAt) ||
    (authority.calibrationSessionId !== null &&
      !isUuid(authority.calibrationSessionId)) ||
    (authority.calibrationNonce !== null &&
      typeof authority.calibrationNonce !== "string")
  )
    throw new Error("invalid storage extraction receipt");
  const manifest = parseExtractionManifest(value.manifest);
  if (
    manifest.frames.items.some(
      (frame) =>
        frame.reference !==
        `${value.frameBatchId}_${String(frame.ordinal).padStart(4, "0")}`,
    )
  )
    throw new Error("invalid storage extraction receipt");
  if (!Array.isArray(value.frameSha256))
    throw new Error("invalid storage extraction receipt");
  const frameSha256 = value.frameSha256.map((digest) => {
    if (typeof digest !== "string" || !isDigest(digest))
      throw new Error("invalid storage extraction receipt");
    return digest;
  });
  if (frameSha256.length !== manifest.frames.count)
    throw new Error("invalid storage extraction receipt");
  const scenes = value.activeScenes;
  const activeScenes =
    scenes === null ? null : parseReceiptScenes(scenes, manifest);
  const parsedAuthority = Object.freeze({
    attemptId: authority.attemptId,
    athleteId: authority.athleteId,
    generation: authority.generation,
    mode: authority.mode,
    mediaId: authority.mediaId,
    sourceSha256: authority.sourceSha256,
    uploadedAt: authority.uploadedAt,
    calibrationSessionId: authority.calibrationSessionId,
    calibrationNonce: authority.calibrationNonce,
  }) as StorageExtractionReceipt["authority"];
  // Validate all cross-field constraints without replacing the already
  // persisted per-frame digests with a digest-of-a-digest.
  if (
    parsedAuthority.attemptId !== manifest.attemptId ||
    parsedAuthority.generation !== manifest.generation ||
    parsedAuthority.mode !== manifest.mode ||
    parsedAuthority.mediaId !== manifest.mediaId ||
    parsedAuthority.sourceSha256 !== manifest.mediaSha256 ||
    (manifest.mode === "free" &&
      (parsedAuthority.calibrationSessionId !== null ||
        parsedAuthority.calibrationNonce !== null)) ||
    (manifest.mode === "verified" &&
      (!parsedAuthority.calibrationSessionId ||
        !parsedAuthority.calibrationNonce))
  )
    throw new Error("invalid storage extraction receipt");
  if (manifest.mode === "verified") {
    if (!activeScenes) throw new Error("invalid storage extraction receipt");
  } else if (activeScenes !== null) {
    throw new Error("invalid storage extraction receipt");
  }
  return Object.freeze({
    kind: "c5-storage-extraction-receipt-v1" as const,
    frameBatchId: value.frameBatchId,
    authority: parsedAuthority,
    manifest,
    frameSha256: Object.freeze(frameSha256),
    activeScenes,
  });
}

function parseReceiptScenes(
  value: unknown,
  manifest: ExtractionManifest,
): readonly ContinuityScene[] {
  if (
    manifest.mode !== "verified" ||
    !Array.isArray(value) ||
    value.length !== 600
  )
    throw new Error("invalid storage extraction receipt");
  return Object.freeze(
    value.map((scene, index) => {
      if (
        !isRecord(scene) ||
        !hasOnlyKeys(scene, ["timestampSeconds", "score"]) ||
        typeof scene.timestampSeconds !== "number" ||
        typeof scene.score !== "number" ||
        scene.timestampSeconds !==
          manifest.frames.items[index + 40]!.timestampSeconds ||
        !Number.isFinite(scene.score) ||
        scene.score < 0 ||
        scene.score >= 0.42
      )
        throw new Error("invalid storage extraction receipt");
      return Object.freeze({
        timestampSeconds: scene.timestampSeconds,
        score: scene.score,
      });
    }),
  );
}

function sameReceiptAuthority(
  left: StorageExtractionReceipt["authority"],
  right: DurableReconstructionAuthority["upload"],
): boolean {
  return (
    left.attemptId === right.attemptId &&
    left.athleteId === right.athleteId &&
    left.generation === right.generation &&
    left.mode === right.mode &&
    left.mediaId === right.mediaId &&
    left.sourceSha256 === right.sourceSha256 &&
    left.uploadedAt === right.uploadedAt &&
    left.calibrationSessionId === right.calibrationSessionId &&
    left.calibrationNonce === right.calibrationNonce
  );
}

function sameExtractionAuthority(
  left: ExtractionManifest,
  right: ExtractionManifest,
  frames: readonly ExtractedFrame[],
): boolean {
  try {
    const parsedLeft = parseExtractionManifest(left);
    const parsedRight = parseExtractionManifest(right);
    if (JSON.stringify(parsedLeft) === JSON.stringify(parsedRight)) return true;
    // v1 receipts precede framing. They are accepted only when their exact
    // ordered bytes verify the former digest and every other durable fact is
    // identical; fresh manifests always use the unambiguous framed digest.
    if (
      parsedLeft.mode !== "verified" ||
      parsedRight.mode !== "verified" ||
      parsedLeft.rawPreRollSha256 !==
        legacyRawPreRollSha256(frames.slice(0, 40))
    )
      return false;
    return (
      JSON.stringify({ ...parsedLeft, rawPreRollSha256: undefined }) ===
      JSON.stringify({ ...parsedRight, rawPreRollSha256: undefined })
    );
  } catch {
    return false;
  }
}

export function parseDurableProcessingContext(
  value: unknown,
): DurableProcessingContext {
  if (!isRecord(value)) throw new Error("Invalid durable processing context.");
  if (value.kind === "c5-durable-processing-context-v2") {
    if (!hasOnlyKeys(value, ["kind", "receipt"]) || !isRecord(value.receipt))
      throw new Error("Invalid durable processing context.");
    const receipt = value.receipt;
    if (
      !hasOnlyKeys(receipt, ["frameBatchId", "mediaId", "sha256"]) ||
      !isUuid(receipt.frameBatchId) ||
      typeof receipt.mediaId !== "string" ||
      receipt.mediaId.length < 1 ||
      receipt.mediaId.length > 80 ||
      typeof receipt.sha256 !== "string" ||
      !isDigest(receipt.sha256)
    )
      throw new Error("Invalid durable processing context.");
    return Object.freeze({
      kind: "c5-durable-processing-context-v2" as const,
      receipt: Object.freeze({
        frameBatchId: receipt.frameBatchId,
        mediaId: receipt.mediaId,
        sha256: receipt.sha256,
      }),
    });
  }
  throw new Error("Invalid durable processing context.");
}

/**
 * Stable, path-free identity for the exact C5 decoded sequence. It binds the
 * source frame references and sampling timeline without exposing either to a
 * public decision.
 */
export function verifiedExtractionIdentity(
  manifest: Extract<ExtractionManifest, Readonly<{ mode: "verified" }>>,
): string {
  const parsed = parseExtractionManifest(manifest);
  if (parsed.mode !== "verified")
    throw new Error("Verified extraction required.");
  return createHash("sha256")
    .update(
      JSON.stringify({
        extractionVersion: parsed.extractionVersion,
        attemptId: parsed.attemptId,
        generation: parsed.generation,
        mediaId: parsed.mediaId,
        mediaSha256: parsed.mediaSha256,
        rawPreRollSha256: parsed.rawPreRollSha256,
        frames: parsed.frames.items.map((frame) => [
          frame.ordinal,
          frame.timestampSeconds,
          frame.reference,
        ]),
      }),
    )
    .digest("hex");
}

/** Returns the non-structural C5 capability for this exact in-memory result. */
export function verifiedExtractionCapability(
  manifest: Extract<ExtractionManifest, Readonly<{ mode: "verified" }>>,
): VerifiedExtractionCapability {
  const capability = verifiedExtractionCapabilities.get(manifest);
  if (
    !capability ||
    verifiedExtractionData.get(capability)?.continuityIdentity === null
  )
    throw new Error("verified continuity evidence required");
  return capability;
}

/**
 * C5's scene-cut gate attaches its ordered, measured active-frame evidence to
 * the exact materialized extraction. The manifest remains redacted; only the
 * private capability retains the continuity identity.
 */
export function attestVerifiedExtractionContinuity(
  manifest: Extract<ExtractionManifest, Readonly<{ mode: "verified" }>>,
  active: readonly Readonly<{ timestampSeconds: number; score: number }>[],
): void {
  const capability = verifiedExtractionCapabilities.get(manifest);
  const data = capability && verifiedExtractionData.get(capability);
  if (!capability || !data || active.length !== 600)
    throw new Error("invalid verified continuity evidence");
  const expected = manifest.frames.items.slice(40);
  if (
    active.some(
      (scene, index) =>
        scene.timestampSeconds !== expected[index]!.timestampSeconds ||
        !Number.isFinite(scene.score) ||
        scene.score < 0 ||
        scene.score >= 0.42 ||
        (index > 0 &&
          scene.timestampSeconds <= active[index - 1]!.timestampSeconds),
    )
  )
    throw new Error("invalid verified continuity evidence");
  verifiedExtractionData.set(
    capability,
    Object.freeze({
      ...data,
      activeScenes: Object.freeze(
        active.map((scene) =>
          Object.freeze({
            timestampSeconds: scene.timestampSeconds,
            score: scene.score,
          }),
        ),
      ),
      continuityIdentity: createHash("sha256")
        .update(
          JSON.stringify(
            active.map((scene) => [scene.timestampSeconds, scene.score]),
          ),
        )
        .digest("hex"),
    }),
  );
}

/**
 * Validates an OpaqueFrameReader byte read against the source frame C5
 * materialized. A different reference, ordinal, or byte sequence is terminal
 * evidence corruption, never a fresh extraction.
 */
export function assertVerifiedExtractionFrame(
  capability: VerifiedExtractionCapability,
  input: Readonly<{ ordinal: number; reference: string; bytes: Uint8Array }>,
): string {
  const data = verifiedExtractionData.get(capability);
  const expected = data?.frames[input.ordinal];
  if (
    !expected ||
    expected.reference !== input.reference ||
    !(input.bytes instanceof Uint8Array) ||
    createHash("sha256").update(input.bytes).digest("hex") !==
      expected.sourceSha256
  )
    throw new Error("verified extraction frame mismatch");
  return expected.sourceSha256;
}

/** Private continuity identity incorporated into the C5→C6 execution proof. */
export function verifiedExtractionContinuityIdentity(
  capability: VerifiedExtractionCapability,
): string {
  const identity = verifiedExtractionData.get(capability)?.continuityIdentity;
  if (!identity) throw new Error("verified continuity evidence required");
  return identity;
}

function issueVerifiedExtractionCapability(
  manifest: Extract<ExtractionManifest, Readonly<{ mode: "verified" }>>,
  frames: readonly ExtractedFrame[],
): void {
  const capability = Object.freeze({
    kind: "verified-extraction-capability" as const,
  });
  const data: VerifiedExtractionData = Object.freeze({
    manifest,
    frames: Object.freeze(
      frames.map((frame, ordinal) =>
        Object.freeze({
          ordinal,
          reference: frame.reference,
          sourceSha256: createHash("sha256")
            .update(frame.rawBytes)
            .digest("hex"),
        }),
      ),
    ),
    continuityIdentity: null,
    activeScenes: null,
  });
  verifiedExtractionCapabilities.set(manifest, capability);
  verifiedExtractionData.set(capability, data);
}

/** Strict persisted-input boundary; manifests never carry local filesystem paths. */
export function parseExtractionManifest(value: unknown): ExtractionManifest {
  if (!isRecord(value)) throw new Error("Invalid extraction manifest.");
  const mode = value.mode;
  if (mode !== "free" && mode !== "verified")
    throw new Error("Invalid extraction manifest.");
  const expected =
    mode === "verified"
      ? [
          "kind",
          "extractionVersion",
          "mode",
          "attemptId",
          "generation",
          "mediaId",
          "mediaSha256",
          "display",
          "probe",
          "frames",
          "preRoll",
          "active",
          "rawPreRollSha256",
        ]
      : [
          "kind",
          "extractionVersion",
          "mode",
          "attemptId",
          "generation",
          "mediaId",
          "mediaSha256",
          "display",
          "probe",
          "frames",
        ];
  if (
    !hasOnlyKeys(value, expected) ||
    value.kind !== "extraction-manifest" ||
    value.extractionVersion !== "c5-frame-manifest-v1"
  )
    throw new Error("Invalid extraction manifest.");
  const attemptId = readUuid(value.attemptId);
  const mediaId = readUuid(value.mediaId);
  const generation = readGeneration(value.generation);
  const mediaSha256 = readDigest(value.mediaSha256);
  const probe = readProbe(value.probe);
  const display = readDisplay(value.display, probe);
  const frames = readFrames(value.frames);
  const rawFrames = frames.items.map((frame) => ({
    timestampSeconds: frame.timestampSeconds,
    reference: frame.reference,
    rawBytes: new Uint8Array(),
  }));
  if (mode === "verified") {
    if (
      !isRecord(value.preRoll) ||
      !hasOnlyKeys(value.preRoll, ["count"]) ||
      value.preRoll.count !== 40 ||
      !isRecord(value.active) ||
      !hasOnlyKeys(value.active, ["count"]) ||
      value.active.count !== 600
    )
      throw new Error("Invalid extraction manifest.");
    const rawPreRollSha256 = readDigest(value.rawPreRollSha256);
    assertVerifiedFrames(rawFrames);
    return freezeManifest({
      kind: "extraction-manifest",
      extractionVersion: "c5-frame-manifest-v1",
      mode,
      attemptId,
      generation,
      mediaId,
      mediaSha256,
      display,
      probe,
      frames,
      preRoll: Object.freeze({ count: 40 }),
      active: Object.freeze({ count: 600 }),
      rawPreRollSha256,
    });
  }
  assertFreeFrames(rawFrames, probe.durationSeconds);
  return freezeManifest({
    kind: "extraction-manifest",
    extractionVersion: "c5-frame-manifest-v1",
    mode,
    attemptId,
    generation,
    mediaId,
    mediaSha256,
    display,
    probe,
    frames,
  });
}

function frameItem(frame: ExtractedFrame, ordinal: number): ManifestFrame {
  if (!(frame.rawBytes instanceof Uint8Array))
    throw new Error("Invalid extracted frame.");
  assertFrameReference(frame.reference);
  if (!Number.isFinite(frame.timestampSeconds) || frame.timestampSeconds < 0)
    throw new Error("Invalid extracted frame.");
  return Object.freeze({
    ordinal,
    timestampSeconds: frame.timestampSeconds,
    reference: frame.reference,
  });
}

function assertVerifiedFrames(
  frames: readonly Pick<ExtractedFrame, "timestampSeconds" | "reference">[],
): void {
  if (frames.length !== 640)
    throw new Error("Invalid verified extraction cardinality.");
  let previous = -Infinity;
  for (let index = 0; index < frames.length; index += 1) {
    const frame = frames[index];
    assertFrameReference(frame.reference);
    if (
      !Number.isFinite(frame.timestampSeconds) ||
      frame.timestampSeconds <= previous ||
      (index > 0 && frame.timestampSeconds - previous > 0.25) ||
      (index < 40
        ? frame.timestampSeconds < 0 || frame.timestampSeconds >= 4
        : frame.timestampSeconds < 4 || frame.timestampSeconds >= 64)
    )
      throw new Error("Invalid verified extraction timeline.");
    previous = frame.timestampSeconds;
  }
}

function assertFreeFrames(
  frames: readonly Pick<ExtractedFrame, "timestampSeconds" | "reference">[],
  duration: number,
): void {
  const expected = freeSampleTimestamps(duration);
  if (frames.length !== expected.length)
    throw new Error("Invalid Free extraction cardinality.");
  let previous = -Infinity;
  for (let index = 0; index < frames.length; index += 1) {
    assertFrameReference(frames[index].reference);
    if (
      !Number.isFinite(frames[index].timestampSeconds) ||
      frames[index].timestampSeconds <= previous ||
      frames[index].timestampSeconds < 0 ||
      frames[index].timestampSeconds > duration
    )
      throw new Error("Invalid Free extraction timeline.");
    previous = frames[index].timestampSeconds;
  }
}

function assertProbe(probe: MediaProbe): void {
  if (
    !["mp4", "mov", "webm"].includes(probe.container) ||
    !Number.isFinite(probe.durationSeconds) ||
    probe.durationSeconds <= 0 ||
    !Number.isSafeInteger(probe.displayWidth) ||
    !Number.isSafeInteger(probe.displayHeight) ||
    probe.displayWidth < 1 ||
    probe.displayHeight < 1 ||
    !Number.isFinite(probe.nominalFps) ||
    probe.nominalFps <= 0 ||
    typeof probe.codec !== "string" ||
    probe.codec.length === 0 ||
    ![0, 90, 180, 270].includes(probe.sourceRotationDegrees)
  )
    throw new Error("Invalid extraction probe.");
}

function readProbe(value: unknown): MediaProbe {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "container",
      "durationSeconds",
      "displayWidth",
      "displayHeight",
      "nominalFps",
      "codec",
      "sourceRotationDegrees",
    ])
  )
    throw new Error("Invalid extraction manifest.");
  if (
    (value.container !== "mp4" &&
      value.container !== "mov" &&
      value.container !== "webm") ||
    typeof value.durationSeconds !== "number" ||
    typeof value.displayWidth !== "number" ||
    typeof value.displayHeight !== "number" ||
    typeof value.nominalFps !== "number" ||
    typeof value.codec !== "string" ||
    (value.sourceRotationDegrees !== 0 &&
      value.sourceRotationDegrees !== 90 &&
      value.sourceRotationDegrees !== 180 &&
      value.sourceRotationDegrees !== 270)
  )
    throw new Error("Invalid extraction manifest.");
  const probe: MediaProbe = {
    container: value.container,
    durationSeconds: value.durationSeconds,
    displayWidth: value.displayWidth,
    displayHeight: value.displayHeight,
    nominalFps: value.nominalFps,
    codec: value.codec,
    sourceRotationDegrees: value.sourceRotationDegrees,
  };
  assertProbe(probe);
  return Object.freeze(probe);
}

function readDisplay(
  value: unknown,
  probe: MediaProbe,
): Readonly<{
  width: number;
  height: number;
  rotationDegrees: MediaProbe["sourceRotationDegrees"];
}> {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["width", "height", "rotationDegrees"]) ||
    value.width !== probe.displayWidth ||
    value.height !== probe.displayHeight ||
    value.rotationDegrees !== probe.sourceRotationDegrees
  )
    throw new Error("Invalid extraction manifest.");
  return Object.freeze({
    width: probe.displayWidth,
    height: probe.displayHeight,
    rotationDegrees: probe.sourceRotationDegrees,
  });
}

function readFrames(
  value: unknown,
): Readonly<{ count: number; items: readonly ManifestFrame[] }> {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["count", "items"]) ||
    !Number.isSafeInteger(value.count) ||
    !Array.isArray(value.items)
  )
    throw new Error("Invalid extraction manifest.");
  const items = value.items.map((item, ordinal) => {
    if (
      !isRecord(item) ||
      !hasOnlyKeys(item, ["ordinal", "timestampSeconds", "reference"]) ||
      item.ordinal !== ordinal ||
      typeof item.timestampSeconds !== "number" ||
      typeof item.reference !== "string"
    )
      throw new Error("Invalid extraction manifest.");
    assertFrameReference(item.reference);
    if (!Number.isFinite(item.timestampSeconds) || item.timestampSeconds < 0)
      throw new Error("Invalid extraction manifest.");
    return Object.freeze({
      ordinal,
      timestampSeconds: item.timestampSeconds,
      reference: item.reference,
    });
  });
  if (value.count !== items.length)
    throw new Error("Invalid extraction manifest.");
  return Object.freeze({ count: items.length, items: Object.freeze(items) });
}

function readUuid(value: unknown): string {
  if (typeof value !== "string")
    throw new Error("Invalid extraction manifest.");
  assertUuid(value);
  return value;
}

function readGeneration(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    throw new Error("Invalid extraction manifest.");
  return value;
}

function readDigest(value: unknown): string {
  if (typeof value !== "string")
    throw new Error("Invalid extraction manifest.");
  assertDigest(value);
  return value;
}

/**
 * The exact frame boundary is part of C5's private pre-roll binding. A plain
 * concatenation aliases `[a, bc]` to `[ab, c]`; this stable header/count/size
 * framing does not. The digest remains opaque outside C5/C7.
 */
function framedRawPreRollSha256(
  frames: readonly Readonly<{ rawBytes: Uint8Array }>[],
): string {
  const hash = createHash("sha256").update("revelai:c5:pre-roll:v1\\0");
  const count = Buffer.allocUnsafe(4);
  count.writeUInt32BE(frames.length);
  hash.update(count);
  for (const frame of frames) {
    const length = Buffer.allocUnsafe(8);
    length.writeBigUInt64BE(BigInt(frame.rawBytes.byteLength));
    hash.update(length);
    hash.update(frame.rawBytes);
  }
  return hash.digest("hex");
}

function legacyRawPreRollSha256(
  frames: readonly Readonly<{ rawBytes: Uint8Array }>[],
): string {
  return createHash("sha256")
    .update(Buffer.concat(frames.map((frame) => Buffer.from(frame.rawBytes))))
    .digest("hex");
}

function assertUuid(value: string): void {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  )
    throw new Error("Invalid extraction identifier.");
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  );
}

function assertDigest(value: string): void {
  if (!/^[a-f0-9]{64}$/i.test(value))
    throw new Error("Invalid extraction digest.");
}

function isDigest(value: string): boolean {
  return /^[a-f0-9]{64}$/i.test(value);
}

function isUtcIsoTimestamp(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    !Number.isNaN(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function assertFrameReference(value: string): void {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(value))
    throw new Error("Invalid extracted-frame reference.");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return (
    Object.keys(value).length === keys.length &&
    Object.keys(value).every((key) => keys.includes(key))
  );
}

function freezeManifest<T extends ExtractionManifest>(manifest: T): T {
  return Object.freeze(manifest);
}
