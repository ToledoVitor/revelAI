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

type ManifestBase = Readonly<{
  kind: "extraction-manifest";
  extractionVersion: "c5-frame-manifest-v1";
  mode: "free" | "verified";
  attemptId: string;
  generation: number;
  mediaId: string;
  mediaSha256: string;
  display: Readonly<{ width: number; height: number; rotationDegrees: 0 }>;
  probe: MediaProbe;
  frames: Readonly<{ count: number; items: readonly ManifestFrame[] }>;
}>;

export type ExtractionManifest =
  | (ManifestBase &
      Readonly<{
        mode: "free";
      }>)
  | (ManifestBase &
      Readonly<{
        mode: "verified";
        preRoll: Readonly<{ count: 40 }>;
        active: Readonly<{ count: 600 }>;
        rawPreRollSha256: string;
      }>);

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
    return freezeManifest({
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
        rotationDegrees: 0,
      }),
      probe: Object.freeze({ ...input.probe }),
      frames: Object.freeze({
        count: items.length,
        items: Object.freeze(items),
      }),
      preRoll: Object.freeze({ count: 40 }),
      active: Object.freeze({ count: 600 }),
      rawPreRollSha256: createHash("sha256")
        .update(
          Buffer.concat(
            input.frames
              .slice(0, 40)
              .map((frame) => Buffer.from(frame.rawBytes)),
          ),
        )
        .digest("hex"),
    });
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
      rotationDegrees: 0,
    }),
    probe: Object.freeze({ ...input.probe }),
    frames: Object.freeze({ count: items.length, items: Object.freeze(items) }),
  });
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
      value.preRoll.count !== 40 ||
      !isRecord(value.active) ||
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
  for (let index = 0; index < frames.length; index += 1) {
    const frame = frames[index];
    assertFrameReference(frame.reference);
    const expected = index / 10;
    if (
      !Number.isFinite(frame.timestampSeconds) ||
      frame.timestampSeconds !== expected
    )
      throw new Error("Invalid verified extraction timeline.");
  }
}

function assertFreeFrames(
  frames: readonly Pick<ExtractedFrame, "timestampSeconds" | "reference">[],
  duration: number,
): void {
  const expected = freeSampleTimestamps(duration);
  if (frames.length !== expected.length)
    throw new Error("Invalid Free extraction cardinality.");
  for (let index = 0; index < frames.length; index += 1) {
    assertFrameReference(frames[index].reference);
    if (frames[index].timestampSeconds !== expected[index])
      throw new Error("Invalid Free extraction timeline.");
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
    probe.codec.length === 0
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
    typeof value.codec !== "string"
  )
    throw new Error("Invalid extraction manifest.");
  const probe: MediaProbe = {
    container: value.container,
    durationSeconds: value.durationSeconds,
    displayWidth: value.displayWidth,
    displayHeight: value.displayHeight,
    nominalFps: value.nominalFps,
    codec: value.codec,
  };
  assertProbe(probe);
  return Object.freeze(probe);
}

function readDisplay(
  value: unknown,
  probe: MediaProbe,
): Readonly<{ width: number; height: number; rotationDegrees: 0 }> {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["width", "height", "rotationDegrees"]) ||
    value.width !== probe.displayWidth ||
    value.height !== probe.displayHeight ||
    value.rotationDegrees !== 0
  )
    throw new Error("Invalid extraction manifest.");
  return Object.freeze({
    width: probe.displayWidth,
    height: probe.displayHeight,
    rotationDegrees: 0,
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

function assertUuid(value: string): void {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  )
    throw new Error("Invalid extraction identifier.");
}

function assertDigest(value: string): void {
  if (!/^[a-f0-9]{64}$/i.test(value))
    throw new Error("Invalid extraction digest.");
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
