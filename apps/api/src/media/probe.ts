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
}>;

type UnknownRecord = Record<string, unknown>;

const supportedCodecs = new Set(["h264", "hevc", "mpeg4", "vp8", "vp9", "av1"]);

export function sniffMediaContainer(bytes: Uint8Array): MediaContainer {
  if (bytes.length >= 12 && ascii(bytes, 4, 8) === "ftyp") {
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
  });
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return Buffer.from(bytes.subarray(start, end)).toString("ascii");
}

function containsWebmDocType(bytes: Uint8Array): boolean {
  for (let index = 0; index + 7 <= bytes.length; index += 1) {
    if (
      bytes[index] === 0x42 &&
      bytes[index + 1] === 0x82 &&
      bytes[index + 2] === 0x84 &&
      ascii(bytes, index + 3, index + 7) === "webm"
    )
      return true;
  }
  return false;
}

function containerFromFormat(formatName: string): MediaContainer {
  const names = formatName.split(",").map((name) => name.trim().toLowerCase());
  if (names.includes("webm")) return "webm";
  if (names.includes("mov") || names.includes("mp4") || names.includes("mj2"))
    return "mp4";
  throw new MediaPipelineError("media_probe_failed");
}

function parseRotation(video: UnknownRecord): number {
  const tagRotation = isRecord(video.tags) ? video.tags.rotate : undefined;
  const sideRotation = Array.isArray(video.side_data_list)
    ? video.side_data_list.find(isRecord)?.rotation
    : undefined;
  const candidate = sideRotation ?? tagRotation ?? 0;
  const value = typeof candidate === "string" ? Number(candidate) : candidate;
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new MediaPipelineError("media_probe_failed");
  return value;
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
