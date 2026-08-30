export type MediaFailureCode =
  | "media_container_not_allowed"
  | "media_probe_failed"
  | "media_requirements_not_met"
  | "media_empty"
  | "media_too_large"
  | "multipart_body_too_large"
  | "media_part_missing"
  | "media_part_count_invalid"
  | "multipart_extra_part_forbidden"
  | "media_filename_mime_mismatch";

/** Safe internal error. Its message never contains paths, keys, or process output. */
export class MediaPipelineError extends Error {
  public constructor(public readonly code: MediaFailureCode) {
    super(code);
    this.name = "MediaPipelineError";
  }
}

export type MediaContainer = "mp4" | "mov" | "webm";

export type MediaProbe = Readonly<{
  container: MediaContainer;
  durationSeconds: number;
  displayWidth: number;
  displayHeight: number;
  nominalFps: number;
  codec: string;
  sourceRotationDegrees: 0 | 90 | 180 | 270;
}>;

type UnknownRecord = Record<string, unknown>;

const supportedCodecs = new Set(["h264", "hevc", "mpeg4", "vp8", "vp9", "av1"]);

export function sniffMediaContainer(bytes: Uint8Array): MediaContainer {
  if (isBmffFtypBox(bytes)) {
    const brand = ascii(bytes, 8, 12);
    return brand === "qt  " ? "mov" : "mp4";
  }
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x1a &&
    bytes[1] === 0x45 &&
    bytes[2] === 0xdf &&
    bytes[3] === 0xa3 &&
    containsWebmDocType(bytes)
  )
    return "webm";
  throw new MediaPipelineError("media_container_not_allowed");
}

export function parseFfprobePayload(serialized: string): MediaProbe {
  let payload: unknown;
  try {
    payload = JSON.parse(serialized);
  } catch {
    throw new MediaPipelineError("media_probe_failed");
  }
  if (
    !isRecord(payload) ||
    !isRecord(payload.format) ||
    !Array.isArray(payload.streams)
  )
    throw new MediaPipelineError("media_probe_failed");
  const formatName = stringValue(payload.format.format_name);
  const durationSeconds = finitePositive(payload.format.duration);
  const container = containerFromFormat(formatName);
  const videos = payload.streams.filter(
    (stream): stream is UnknownRecord =>
      isRecord(stream) && stream.codec_type === "video",
  );
  if (videos.length !== 1) throw new MediaPipelineError("media_probe_failed");
  const video = videos[0];
  if (
    isRecord(video.disposition) &&
    (video.disposition.attached_pic === 1 ||
      video.disposition.attached_pic === "1")
  )
    throw new MediaPipelineError("media_probe_failed");
  if (video.encryption !== undefined || video.encrypted === true)
    throw new MediaPipelineError("media_probe_failed");
  const codec = stringValue(video.codec_name);
  if (!supportedCodecs.has(codec))
    throw new MediaPipelineError("media_probe_failed");
  const width = finiteInteger(video.width);
  const height = finiteInteger(video.height);
  const nominalFps = parseRational(
    stringValue(video.avg_frame_rate ?? video.r_frame_rate),
  );
  const rotation = parseRotation(video);
  if (!width || !height || !nominalFps)
    throw new MediaPipelineError("media_probe_failed");
  const quarterTurns = Math.abs(rotation) % 180 === 90;
  return Object.freeze({
    container,
    durationSeconds,
    displayWidth: quarterTurns ? height : width,
    displayHeight: quarterTurns ? width : height,
    nominalFps,
    codec,
    sourceRotationDegrees: rotation,
  });
}

function isBmffFtypBox(bytes: Uint8Array): boolean {
  if (bytes.length < 16 || ascii(bytes, 4, 8) !== "ftyp") return false;
  const size = Buffer.from(bytes.subarray(0, 4)).readUInt32BE();
  return size >= 16 && size !== 1 && size <= bytes.length;
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return Buffer.from(bytes.subarray(start, end)).toString("ascii");
}

function containsWebmDocType(bytes: Uint8Array): boolean {
  const bound = Math.min(bytes.length, 1024);
  const headerSize = readEbmlSize(bytes, 4, bound);
  if (!headerSize) return false;
  const headerStart = 4 + headerSize.length;
  const headerEnd = headerStart + headerSize.value;
  if (headerEnd > bound) return false;
  let cursor = headerStart;
  let docType: string | undefined;
  while (cursor < headerEnd) {
    const idLength = ebmlVintLength(bytes[cursor]);
    if (!idLength || cursor + idLength > headerEnd) return false;
    const isDocType =
      idLength === 2 && bytes[cursor] === 0x42 && bytes[cursor + 1] === 0x82;
    cursor += idLength;
    const size = readEbmlSize(bytes, cursor, headerEnd);
    if (!size) return false;
    cursor += size.length;
    const valueEnd = cursor + size.value;
    if (valueEnd > headerEnd) return false;
    if (isDocType) {
      if (docType !== undefined) return false;
      docType = ascii(bytes, cursor, valueEnd);
    }
    cursor = valueEnd;
  }
  return cursor === headerEnd && docType === "webm";
}

function readEbmlSize(
  bytes: Uint8Array,
  offset: number,
  limit: number,
): Readonly<{ length: number; value: number }> | null {
  const length = ebmlVintLength(bytes[offset]);
  if (!length || offset + length > limit) return null;
  let value = bytes[offset]! & ((1 << (8 - length)) - 1);
  for (let index = 1; index < length; index += 1)
    value = value * 256 + bytes[offset + index]!;
  // Unknown-sized EBML elements cannot bound the header safely.
  if (value === 2 ** (7 * length) - 1) return null;
  return Object.freeze({ length, value });
}

function ebmlVintLength(first: number | undefined): number | null {
  if (first === undefined || first === 0) return null;
  for (let length = 1; length <= 8; length += 1)
    if ((first & (1 << (8 - length))) !== 0) return length;
  return null;
}

function containerFromFormat(formatName: string): MediaContainer {
  const names = formatName.split(",").map((name) => name.trim().toLowerCase());
  if (names.includes("webm")) return "webm";
  if (names.includes("mov") || names.includes("mp4") || names.includes("mj2"))
    return "mp4";
  throw new MediaPipelineError("media_probe_failed");
}

function parseRotation(video: UnknownRecord): 0 | 90 | 180 | 270 {
  const tagRotation = isRecord(video.tags) ? video.tags.rotate : undefined;
  const sideRotation = Array.isArray(video.side_data_list)
    ? video.side_data_list
        .filter(isRecord)
        .find(
          (entry) =>
            entry.side_data_type === "Display Matrix" &&
            entry.rotation !== undefined,
        )?.rotation
    : undefined;
  const candidate = sideRotation ?? tagRotation ?? 0;
  const value = typeof candidate === "string" ? Number(candidate) : candidate;
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new MediaPipelineError("media_probe_failed");
  const normalized = ((value % 360) + 360) % 360;
  if (
    normalized !== 0 &&
    normalized !== 90 &&
    normalized !== 180 &&
    normalized !== 270
  )
    throw new MediaPipelineError("media_probe_failed");
  return normalized;
}

function parseRational(value: string): number {
  const match = /^(\d+)\/(\d+)$/.exec(value);
  if (!match) throw new MediaPipelineError("media_probe_failed");
  const numerator = Number(match[1]);
  const denominator = Number(match[2]);
  const result = numerator / denominator;
  if (!Number.isFinite(result) || result <= 0)
    throw new MediaPipelineError("media_probe_failed");
  return result;
}

function finitePositive(value: unknown): number {
  const parsed = typeof value === "string" ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isFinite(parsed) || parsed <= 0)
    throw new MediaPipelineError("media_probe_failed");
  return parsed;
}

function finiteInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : null;
}

function stringValue(value: unknown): string {
  if (typeof value !== "string" || value.length === 0)
    throw new MediaPipelineError("media_probe_failed");
  return value;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
