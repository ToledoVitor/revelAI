import { MediaPipelineError } from "./probe.js";

export type MultipartPart =
  | Readonly<{
      kind: "file";
      name: string;
      filename: string;
      contentType: string;
      body: AsyncIterable<Uint8Array> | Iterable<Uint8Array>;
    }>
  | Readonly<{
      kind: "field";
      name: string;
      body: AsyncIterable<Uint8Array> | Iterable<Uint8Array>;
    }>;

export interface MediaUploadStage {
  write(chunk: Uint8Array): Promise<void>;
  abort(): Promise<void>;
}

/**
 * The HTTP adapter must pass its raw body through this stream before multipart
 * parsing. This makes the first byte beyond the envelope limit terminal even
 * when Content-Length is absent or lies.
 */
export class RawMultipartByteCounter {
  private bytes = 0;

  public constructor(private readonly maxBytes: number) {
    assertLimit(maxBytes, "multipart_body_too_large");
  }

  public get measuredBytes(): number {
    return this.bytes;
  }

  public get limit(): number {
    return this.maxBytes;
  }

  public observe(chunk: Uint8Array): void {
    if (
      !(chunk instanceof Uint8Array) ||
      chunk.length > this.maxBytes - this.bytes
    )
      throw new MediaPipelineError("multipart_body_too_large");
    this.bytes += chunk.length;
  }

  public async *stream(
    source: AsyncIterable<Uint8Array>,
  ): AsyncIterable<Uint8Array> {
    for await (const chunk of source) {
      this.observe(chunk);
      yield chunk;
    }
  }
}

export type MultipartIntake = Readonly<{
  parts: AsyncIterable<MultipartPart>;
  maxUploadBytes: number;
  maxMultipartBytes: number;
  /** HTTP supplies the C2 route descriptor's single required file field. */
  requiredFileFieldName?: string;
  /** The parser receives only raw bytes emitted by this live counter. */
  rawBody: RawMultipartByteCounter;
  /** Advisory only; actual measured bytes always decide acceptance. */
  declaredContentLength?: number;
  createStage(): Promise<MediaUploadStage>;
}>;

export type AcceptedMultipartMedia = Readonly<{
  filenameExtension: "mp4" | "mov" | "webm";
  bytes: number;
  stage: MediaUploadStage;
}>;

/**
 * Parser-agnostic one-file boundary. A transport adapter owns boundary parsing
 * but must consume raw bytes through rawBody; this owns shape, MIME preflight,
 * per-file accounting, and staged cleanup.
 */
export async function acceptSingleMediaPart(
  input: MultipartIntake,
): Promise<AcceptedMultipartMedia> {
  assertLimit(input.maxUploadBytes, "media_too_large");
  assertLimit(input.maxMultipartBytes, "multipart_body_too_large");
  if (
    input.rawBody.limit !== input.maxMultipartBytes ||
    input.rawBody.measuredBytes > input.maxMultipartBytes
  )
    throw new MediaPipelineError("multipart_body_too_large");

  let stage: MediaUploadStage | undefined;
  const requiredFileFieldName = input.requiredFileFieldName ?? "media";
  try {
    let accepted: AcceptedMultipartMedia | undefined;
    for await (const part of input.parts) {
      if (part.kind === "field")
        throw new MediaPipelineError("multipart_extra_part_forbidden");
      if (part.name !== requiredFileFieldName) {
        throw new MediaPipelineError("multipart_extra_part_forbidden");
      }
      if (accepted) throw new MediaPipelineError("media_part_count_invalid");
      const filenameExtension = validateFilenameMime(
        part.filename,
        part.contentType,
      );
      stage = await input.createStage();
      let bytes = 0;
      for await (const chunk of asAsync(part.body)) {
        if (!(chunk instanceof Uint8Array))
          throw new MediaPipelineError("media_part_count_invalid");
        if (chunk.length > input.maxUploadBytes - bytes)
          throw new MediaPipelineError("media_too_large");
        bytes += chunk.length;
        await stage.write(chunk);
      }
      if (bytes === 0) throw new MediaPipelineError("media_empty");
      accepted = Object.freeze({ filenameExtension, bytes, stage });
    }
    if (!accepted) throw new MediaPipelineError("media_part_missing");
    return accepted;
  } catch (error) {
    await stage?.abort().catch(() => undefined);
    throw error;
  }
}

function validateFilenameMime(
  filename: string,
  contentType: string,
): "mp4" | "mov" | "webm" {
  const extension = /\.([a-z0-9]+)$/i.exec(filename.trim())?.[1]?.toLowerCase();
  const mime = contentType.split(";", 1)[0]?.trim().toLowerCase();
  if (
    !filename.trim() ||
    !extension ||
    !mime ||
    !(
      (extension === "mp4" && mime === "video/mp4") ||
      (extension === "mov" && mime === "video/quicktime") ||
      (extension === "webm" && mime === "video/webm")
    )
  )
    throw new MediaPipelineError("media_filename_mime_mismatch");
  return extension;
}

function assertLimit(
  limit: number,
  code: "media_too_large" | "multipart_body_too_large",
): void {
  if (!Number.isSafeInteger(limit) || limit < 1)
    throw new MediaPipelineError(code);
}

async function* asAsync(
  body: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
): AsyncIterable<Uint8Array> {
  for await (const chunk of body) yield chunk;
}
