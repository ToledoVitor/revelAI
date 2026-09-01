import { Busboy, type BusboyInstance } from "@fastify/busboy";
import { Transform } from "node:stream";
import type { FastifyRequest, RequestPayload } from "fastify";
import type { MultipartPart } from "../media/multipart-intake.js";
import { RawMultipartByteCounter } from "../media/multipart-intake.js";
import { MediaPipelineError } from "../media/probe.js";

type PreparedMultipart = {
  readonly contentType: string;
  readonly rawBody: RawMultipartByteCounter;
  readonly maxUploadBytes: number;
  readonly maxMultipartBytes: number;
  readonly close: (error: Error) => void;
  source: NodeJS.ReadableStream | undefined;
  payload: Transform | undefined;
  failure: Error | undefined;
  complete: boolean;
};

const preparedMultiparts = new WeakMap<FastifyRequest, PreparedMultipart>();
const drainingSources = new WeakSet<object>();

/** Parser syntax is public `invalid_request`, never a Busboy diagnostic. */
export class MultipartParserError extends Error {
  public constructor() {
    super("Malformed multipart request.");
    this.name = "MultipartParserError";
  }
}

/**
 * Registers a preflight-approved media request without reading it. The route's
 * typed preParsing hook later supplies the only stream consumed by the parser.
 */
export function prepareMediaMultipartRequest(
  request: FastifyRequest,
  input: Readonly<{
    maxUploadBytes: number;
    maxMultipartBytes: number;
    contentType: string;
  }>,
): void {
  if (preparedMultiparts.has(request)) return;
  preparedMultiparts.set(request, {
    contentType: requiredMultipartContentType(
      request.headers["content-type"],
      input.contentType,
    ),
    rawBody: new RawMultipartByteCounter(input.maxMultipartBytes),
    maxUploadBytes: input.maxUploadBytes,
    maxMultipartBytes: input.maxMultipartBytes,
    close: (error) => request.raw.destroy(error),
    source: undefined,
    payload: undefined,
    failure: undefined,
    complete: false,
  });
}

/**
 * Fastify calls this after route onRequest preflight and before parsing. It
 * measures live source bytes without replacing or casting `request.raw`.
 */
export function wrapMediaMultipartPayload(
  request: FastifyRequest,
  payload: RequestPayload,
): Transform {
  const prepared = requiredPreparedMultipart(request);
  if (prepared.payload) throw new MultipartParserError();
  let receivedEncodedLength = 0;
  const monitored = new Transform({
    autoDestroy: false,
    transform(chunk: unknown, _encoding, done) {
      try {
        if (!(chunk instanceof Uint8Array)) throw new MultipartParserError();
        prepared.rawBody.observe(chunk);
        receivedEncodedLength += chunk.byteLength;
        done(null, chunk);
      } catch (error) {
        done(error instanceof Error ? error : new MultipartParserError());
      }
    },
  });
  Object.defineProperty(monitored, "receivedEncodedLength", {
    get: () => receivedEncodedLength,
  });
  monitored.once("error", (error) => {
    prepared.failure = normalizedParserError(error);
  });
  payload.once("error", (error) => monitored.destroy(error));
  payload.once("close", () => {
    if (!monitored.writableEnded) monitored.destroy(new MultipartParserError());
  });
  prepared.source = payload;
  prepared.payload = monitored;
  return monitored;
}

/**
 * Adapts the typed preParsing stream to C5's parser-neutral intake seam. No
 * file body is collected: Busboy pauses on each file until C5 consumes it.
 */
export function createStreamingMultipartIntake(
  request: FastifyRequest,
  requiredFileFieldName: string,
): Readonly<{
  parts: AsyncIterable<MultipartPart>;
  maxUploadBytes: number;
  maxMultipartBytes: number;
  requiredFileFieldName: string;
  rawBody: RawMultipartByteCounter;
}> {
  const prepared = requiredPreparedMultipart(request);
  if (prepared.failure) throw prepared.failure;
  if (!prepared.payload || !prepared.source) throw new MultipartParserError();
  return Object.freeze({
    parts: multipartParts(prepared, () => {
      prepared.complete = true;
    }),
    maxUploadBytes: prepared.maxUploadBytes,
    maxMultipartBytes: prepared.maxMultipartBytes,
    requiredFileFieldName,
    rawBody: prepared.rawBody,
  });
}

/**
 * Rejections happen before Fastify parsing, so explicitly discard the original
 * stream after the response. The discard is streaming and capped; it never
 * buffers a rejected request body or exposes a transport error to the client.
 */
export function drainMediaUploadRequest(
  request: FastifyRequest,
  maxMultipartBytes: number,
): void {
  const prepared = preparedMultiparts.get(request);
  if (prepared?.complete) return;
  const source = prepared?.source ?? request.raw;
  const counter =
    prepared?.rawBody ?? new RawMultipartByteCounter(maxMultipartBytes);
  drainSource(
    source,
    counter,
    prepared?.close ?? ((error) => request.raw.destroy(error)),
  );
}

function requiredPreparedMultipart(request: FastifyRequest): PreparedMultipart {
  const prepared = preparedMultiparts.get(request);
  if (!prepared) throw new MultipartParserError();
  return prepared;
}

function requiredMultipartContentType(
  value: unknown,
  expected: string,
): string {
  if (typeof value !== "string") throw new MultipartParserError();
  const [mediaType, ...parameters] = value.split(";");
  if (mediaType?.trim().toLowerCase() !== expected.toLowerCase())
    throw new MultipartParserError();
  const boundaryParameters = parameters.filter((parameter) =>
    /^\s*boundary\s*=/i.test(parameter),
  );
  if (boundaryParameters.length !== 1) throw new MultipartParserError();
  const boundaryValue = boundaryParameters[0]!.replace(
    /^\s*boundary\s*=\s*/i,
    "",
  );
  const boundary =
    boundaryValue.startsWith('"') && boundaryValue.endsWith('"')
      ? boundaryValue.slice(1, -1)
      : boundaryValue;
  if (
    boundary.length < 1 ||
    boundary.length > 70 ||
    /[\r\n"]/.test(boundary) ||
    (!boundaryValue.startsWith('"') &&
      !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(boundary))
  )
    throw new MultipartParserError();
  return value;
}

async function* multipartParts(
  prepared: PreparedMultipart,
  markComplete: () => void,
): AsyncIterable<MultipartPart> {
  const payload = prepared.payload;
  const source = prepared.source;
  if (!payload || !source) throw new MultipartParserError();
  const queue = new MultipartPartQueue();
  let parser: BusboyInstance;
  try {
    parser = new Busboy({
      headers: { "content-type": prepared.contentType },
      limits: {
        fileSize: prepared.maxUploadBytes + 1,
        files: 16,
        fields: 16,
        parts: 32,
        fieldSize: 1,
      },
    });
  } catch {
    throw new MultipartParserError();
  }
  const fail = (error: unknown): void => {
    queue.fail(normalizedParserError(error));
  };
  let activeFile:
    | Readonly<{
        destroy(error: Error): void;
        once(event: "end" | "error", listener: () => void): unknown;
      }>
    | undefined;
  parser.on("file", (name, body, filename, _encoding, contentType) => {
    activeFile = body;
    body.once("limit", () => fail(new MediaPipelineError("media_too_large")));
    body.once("error", () => fail(new MultipartParserError()));
    body.once("end", () => {
      activeFile = undefined;
    });
    queue.push(
      Object.freeze({
        kind: "file" as const,
        name,
        filename,
        contentType,
        body,
      }),
    );
  });
  parser.on("field", (name, value) => {
    queue.push(
      Object.freeze({
        kind: "field" as const,
        name,
        body: bytes(value),
      }),
    );
  });
  parser.once("finish", () => {
    prepared.complete = true;
    markComplete();
    queue.complete();
  });
  parser.once("error", fail);
  parser.once("partsLimit", () => fail(new MultipartParserError()));
  parser.once("filesLimit", () => fail(new MultipartParserError()));
  parser.once("fieldsLimit", () => fail(new MultipartParserError()));
  payload.once("error", (error) => {
    const terminal = normalizedParserError(error);
    activeFile?.destroy(terminal);
    fail(terminal);
  });
  payload.pipe(parser);
  source.pipe(payload);
  let exhausted = false;
  try {
    for await (const part of queue) yield part;
    exhausted = true;
  } finally {
    if (!exhausted) {
      // C5 can reject on file headers before it reads the body. Detach the
      // parser wrapper first: leaving source→payload live while starting the
      // raw discard would double-count bytes and backpressure its unread side.
      source.unpipe(payload);
      payload.unpipe(parser);
      parser.destroy();
      payload.destroy();
      drainSource(source, prepared.rawBody, prepared.close);
    }
  }
}

function normalizedParserError(error: unknown): Error {
  return error instanceof MediaPipelineError
    ? error
    : new MultipartParserError();
}

async function* bytes(value: string): AsyncIterable<Uint8Array> {
  yield Buffer.from(value, "utf8");
}

function drainSource(
  source: NodeJS.ReadableStream,
  counter: RawMultipartByteCounter,
  close: (error: Error) => void,
): void {
  if (drainingSources.has(source)) return;
  drainingSources.add(source);
  const discard = new Transform({
    transform(chunk: unknown, _encoding, done) {
      try {
        if (!(chunk instanceof Uint8Array)) throw new MultipartParserError();
        counter.observe(chunk);
        done();
      } catch (error) {
        done(error instanceof Error ? error : new MultipartParserError());
      }
    },
  });
  source.once("error", () => discard.destroy());
  discard.once("error", (error) => {
    source.unpipe(discard);
    close(error);
  });
  discard.once("finish", () => drainingSources.delete(source));
  source.pipe(discard);
  source.resume();
}

class MultipartPartQueue implements AsyncIterable<MultipartPart> {
  private readonly pending: MultipartPart[] = [];
  private waiting:
    | Readonly<{
        resolve: (value: IteratorResult<MultipartPart>) => void;
        reject: (reason: Error) => void;
      }>
    | undefined;
  private failure: Error | undefined;
  private ended = false;

  public push(part: MultipartPart): void {
    if (this.ended || this.failure) return;
    const waiting = this.waiting;
    this.waiting = undefined;
    if (waiting) waiting.resolve({ value: part, done: false });
    else this.pending.push(part);
  }

  public complete(): void {
    if (this.ended || this.failure) return;
    this.ended = true;
    this.resolveDone();
  }

  public fail(error: Error): void {
    if (this.ended || this.failure) return;
    this.failure = error;
    const waiting = this.waiting;
    this.waiting = undefined;
    waiting?.reject(error);
  }

  public [Symbol.asyncIterator](): AsyncIterator<MultipartPart> {
    return { next: () => this.next() };
  }

  private next(): Promise<IteratorResult<MultipartPart>> {
    if (this.failure) return Promise.reject(this.failure);
    const part = this.pending.shift();
    if (part) return Promise.resolve({ value: part, done: false });
    if (this.ended) return Promise.resolve({ value: undefined, done: true });
    return new Promise<IteratorResult<MultipartPart>>((resolve, reject) => {
      this.waiting = Object.freeze({ resolve, reject });
    });
  }

  private resolveDone(): void {
    const waiting = this.waiting;
    this.waiting = undefined;
    if (waiting) waiting.resolve({ value: undefined, done: true });
  }
}
