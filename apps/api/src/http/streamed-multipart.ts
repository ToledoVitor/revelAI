import { Transform, type Readable } from "node:stream";
import type { FastifyRequest } from "fastify";
import type { MultipartPart } from "../media/multipart-intake.js";
import { RawMultipartByteCounter } from "../media/multipart-intake.js";
import { MediaPipelineError } from "../media/probe.js";

type PreparedRawMultipart = Readonly<{
  source: Readable;
  monitored: Transform;
  rawBody: RawMultipartByteCounter;
  maxUploadBytes: number;
  maxMultipartBytes: number;
}>;

const preparedRawMultiparts = new WeakMap<
  FastifyRequest,
  PreparedRawMultipart
>();
const drainingSources = new WeakSet<object>();

/** Parser syntax is public `invalid_request`, never a Busboy diagnostic. */
export class MultipartParserError extends Error {
  public constructor() {
    super("Malformed multipart request.");
    this.name = "MultipartParserError";
  }
}

/**
 * Replaces Fastify's raw request with an inert monitored stream. The original
 * source is deliberately not piped until the route has completed ownership
 * and queue preflight, so those branches cannot consume a body byte.
 */
export function prepareRawMultipartRequest(
  request: FastifyRequest,
  input: Readonly<{ maxUploadBytes: number; maxMultipartBytes: number }>,
): void {
  if (preparedRawMultiparts.has(request)) return;
  const source = request.raw as unknown as Readable & {
    headers: Record<string, string | string[] | undefined>;
    rawHeaders: string[];
    url?: string;
    method?: string;
    aborted?: boolean;
    socket?: unknown;
  };
  const rawBody = new RawMultipartByteCounter(input.maxMultipartBytes);
  const monitored = new Transform({
    autoDestroy: false,
    transform(chunk: unknown, _encoding, done) {
      try {
        if (!(chunk instanceof Uint8Array))
          throw new TypeError("Multipart stream emitted a non-byte chunk.");
        rawBody.observe(chunk);
        done(null, chunk);
      } catch (error) {
        done(error as Error);
      }
    },
  });
  Object.defineProperties(monitored, {
    headers: { value: source.headers },
    rawHeaders: { value: source.rawHeaders },
    url: { get: () => source.url },
    method: { get: () => source.method },
    aborted: { get: () => source.aborted ?? false },
    socket: { get: () => source.socket },
  });
  const abortParser = (): void => {
    // An IncomingMessage can end because its peer disappeared without an
    // `error` event. Surface that to Busboy so C5 abandons its reservation
    // instead of waiting for an unterminated multipart body.
    if (!source.readableEnded && !monitored.destroyed)
      monitored.destroy(new MultipartParserError());
  };
  source.once("error", (error) => monitored.destroy(error));
  source.once("aborted", abortParser);
  source.once("close", abortParser);
  (request as unknown as { raw: Transform }).raw = monitored;
  preparedRawMultiparts.set(
    request,
    Object.freeze({ ...input, source, monitored, rawBody }),
  );
}

/**
 * Adapts @fastify/multipart's parser output to C5's parser-neutral intake
 * seam without collecting file bytes. The parser sees only the counter's
 * live output. Parser exits stop the parser and then drain the original
 * request when possible, preserving keep-alive response semantics.
 */
export function createStreamingMultipartIntake(
  request: FastifyRequest,
): Readonly<{
  parts: AsyncIterable<MultipartPart>;
  maxUploadBytes: number;
  maxMultipartBytes: number;
  rawBody: RawMultipartByteCounter;
  declaredContentLength?: number;
}> {
  const prepared = preparedRawMultiparts.get(request);
  if (!prepared) throw new Error("Multipart request was not prepared.");
  let started = false;
  let complete = false;
  const start = (): void => {
    if (started) return;
    started = true;
    prepared.source.pipe(prepared.monitored);
  };
  const abort = (): void => {
    if (complete) return;
    prepared.source.unpipe(prepared.monitored);
    if (!prepared.monitored.destroyed) prepared.monitored.destroy();
    drainSource(prepared);
  };
  const length = declaredContentLength(request);
  return Object.freeze({
    parts: multipartParts(request, start, abort, () => {
      complete = true;
    }),
    maxUploadBytes: prepared.maxUploadBytes,
    maxMultipartBytes: prepared.maxMultipartBytes,
    rawBody: prepared.rawBody,
    ...(length === undefined ? {} : { declaredContentLength: length }),
  });
}

/**
 * After a preflight rejection, defer disposal until the response lifecycle so
 * the handler never reads before ownership/queue checks yet a keep-alive
 * connection is not stranded behind an unread request body.
 */
export function drainPreparedMultipartRequest(request: FastifyRequest): void {
  const prepared = preparedRawMultiparts.get(request);
  if (!prepared || prepared.source.destroyed || prepared.source.readableEnded)
    return;
  drainSource(prepared);
}

async function* multipartParts(
  request: FastifyRequest,
  start: () => void,
  abort: () => void,
  markComplete: () => void,
): AsyncIterable<MultipartPart> {
  let exhausted = false;
  try {
    const parts = request.parts({
      limits: { files: 16, fields: 16, parts: 32 },
    });
    // @fastify/multipart attaches Busboy to the monitored stream eagerly.
    // Only then may the original request start flowing.
    start();
    for await (const part of parts) {
      if (part.type === "file") {
        yield Object.freeze({
          kind: "file" as const,
          name: part.fieldname,
          filename: part.filename,
          contentType: part.mimetype,
          body: part.file,
        });
      } else {
        yield Object.freeze({
          kind: "field" as const,
          name: part.fieldname,
          body: utf8Bytes(part.value),
        });
      }
    }
    exhausted = true;
    markComplete();
  } catch (error) {
    if (error instanceof MediaPipelineError) throw error;
    throw new MultipartParserError();
  } finally {
    if (!exhausted) abort();
  }
}

async function* utf8Bytes(value: unknown): AsyncIterable<Uint8Array> {
  yield Buffer.from(typeof value === "string" ? value : "", "utf8");
}

function declaredContentLength(request: FastifyRequest): number | undefined {
  const value = request.headers["content-length"];
  if (typeof value !== "string" || !/^[0-9]+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function drainSource(prepared: PreparedRawMultipart): void {
  if (
    prepared.source.destroyed ||
    prepared.source.readableEnded ||
    drainingSources.has(prepared.source)
  )
    return;
  drainingSources.add(prepared.source);
  const discard = new Transform({
    transform(chunk: unknown, _encoding, done) {
      try {
        if (!(chunk instanceof Uint8Array))
          throw new TypeError("Multipart stream emitted a non-byte chunk.");
        prepared.rawBody.observe(chunk);
        done();
      } catch (error) {
        done(error as Error);
      }
    },
  });
  discard.once("error", (error) => prepared.source.destroy(error));
  prepared.source.pipe(discard);
  prepared.source.resume();
}
