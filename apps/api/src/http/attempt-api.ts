import { randomBytes, randomUUID } from "node:crypto";
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import {
  AthleteIdentityHeaderSchema,
  AttemptIdPathParamsSchema,
  AttemptListQuerySchema,
  AttemptListResponseSchema,
  AttemptReadResponseSchema,
  AttemptResultResponseSchema,
  CalibrationSessionCreateInputSchema,
  CalibrationSessionIdPathParamsSchema,
  CalibrationSessionReadyInputSchema,
  CalibrationSessionSchema,
  ChallengeListResponseSchema,
  CreateAttemptInputSchema,
  CreateAttemptResponseSchema,
  MAX_MULTIPART_ENVELOPE_BYTES,
  MAX_UPLOAD_BYTES,
  MediaUploadAcceptedSchema,
  RouteErrorMessageByCode,
  RouteErrorRetryabilityByCode,
  RouteErrorSchema,
  RouteErrorStatusByCode,
  type RouteErrorCode,
} from "@revelai/contracts";
import { QueueUnavailableError } from "../queue/analysis-queue.js";
import type { AttemptApiQueuePort } from "../queue/analysis-queue-port.js";
import { MediaPipelineError } from "../media/probe.js";
import { RepositoryError } from "../repositories/attempt-repository.js";
import type {
  AttemptRecord,
  AttemptRepository,
} from "../repositories/attempt-repository.js";
import {
  createC8RecoveryRuntime,
  type C8RecoveryRuntimeHandle,
  type HourlyRecoveryScheduler,
  type MediaAttachmentRecoveryLog,
  type MediaAttachmentRecoveryRepository,
  type MediaDeliveryRedeliveryRepository,
  type OpaqueAcceptedMediaCleaner,
} from "../services/media-attachment-recovery.js";
import { createAttemptReadService } from "../services/attempt-read-service.js";
import { MultipartParserError } from "./streamed-multipart.js";
import { type MediaUploadService } from "../services/media-upload-service.js";
import { registerAttemptMediaUploadPlugin } from "./attempt-media-upload-plugin.js";

type AttemptHttpRepository = AttemptRepository &
  MediaAttachmentRecoveryRepository &
  MediaDeliveryRedeliveryRepository;
type AttemptApiClock = Readonly<{ now(): string }>;
type AttemptApiIdGenerator = Readonly<{ next(): string }>;
type AttemptUploadQueue = AttemptApiQueuePort;
type AttemptApiInput = Readonly<{
  repository: AttemptHttpRepository;
  queue: AttemptUploadQueue;
  cleaner: OpaqueAcceptedMediaCleaner;
  maxUploadBytes?: number;
  scheduler?: HourlyRecoveryScheduler;
  recoveryBatchLimit?: number;
  clock?: AttemptApiClock;
  ids?: AttemptApiIdGenerator;
  nonce?: () => string;
  log?: MediaAttachmentRecoveryLog;
}>;

const RECOVERY_BATCH_LIMIT = 100;
const HOUR_MILLISECONDS = 60 * 60 * 1_000;
const silentRecoveryLog: MediaAttachmentRecoveryLog = Object.freeze({
  event: () => undefined,
});
const badUrlBody = JSON.stringify(
  RouteErrorSchema.parse({
    code: "invalid_request",
    message: RouteErrorMessageByCode.invalid_request,
    retryable: RouteErrorRetryabilityByCode.invalid_request,
  }),
);
type AttemptMediaUploadRegistration = Readonly<{
  maxUploadBytes: number;
  maxMultipartBytes: number;
  requiredAthleteId(request: FastifyRequest): string;
  attemptId(request: FastifyRequest): string;
  sendAccepted(reply: FastifyReply, value: unknown): unknown;
}>;

const processHourlyRecoveryScheduler: HourlyRecoveryScheduler = Object.freeze({
  everyHour: (task: () => void): NodeJS.Timeout => {
    const handle = setInterval(task, HOUR_MILLISECONDS);
    handle.unref();
    return handle;
  },
  cancel: (handle: unknown): void => clearInterval(handle as NodeJS.Timeout),
});

/**
 * Narrow production host boundary for the first attempt routes. Construction
 * auto-starts C8 recovery and app close awaits its drain; HTTP handlers only
 * use the C4 repository port and C2 contracts.
 */
export function createAttemptApi(input: AttemptApiInput): FastifyInstance {
  return createAttemptApiInternal(input, undefined);
}

/**
 * Internal lower-level seam. Outer composition has already validated and
 * bound the C4/C5 service and opaque queue port before HTTP is constructed.
 */
export function createInternallyComposedAttemptApi(
  input: AttemptApiInput,
  mediaUpload: MediaUploadService,
): FastifyInstance {
  return createAttemptApiInternal(input, mediaUpload);
}

function createAttemptApiInternal(
  input: AttemptApiInput,
  mediaUpload: MediaUploadService | undefined,
): FastifyInstance {
  const maxUploadBytes = input.maxUploadBytes ?? MAX_UPLOAD_BYTES;
  const maxMultipartBytes =
    maxUploadBytes + (MAX_MULTIPART_ENVELOPE_BYTES - MAX_UPLOAD_BYTES);
  const app = Fastify({
    logger: false,
    bodyLimit: maxMultipartBytes,
    routerOptions: {
      onBadUrl: (_path, _request, response) => {
        response.statusCode = RouteErrorStatusByCode.invalid_request;
        response.setHeader("content-type", "application/json; charset=utf-8");
        response.setHeader("content-length", Buffer.byteLength(badUrlBody));
        response.end(badUrlBody);
      },
    },
  });
  const athleteIds = new WeakMap<FastifyRequest, string>();
  const clock = input.clock ?? { now: () => new Date().toISOString() };
  const ids = input.ids ?? { next: randomUUID };
  const nonce = input.nonce ?? (() => randomBytes(32).toString("base64url"));
  const attemptRead = createAttemptReadService({
    repository: input.repository,
  });
  let recovery: C8RecoveryRuntimeHandle | undefined;
  try {
    app.addHook("onRequest", async (request) => {
      if (isPublicChallengeRequest(request)) return;
      const athleteId = parseAthleteIdentity(request);
      if (!athleteId) throw new AttemptRouteError("invalid_athlete_identity");
      athleteIds.set(request, athleteId);
    });
    const mediaRegistration: AttemptMediaUploadRegistration = Object.freeze({
      maxUploadBytes,
      maxMultipartBytes,
      requiredAthleteId: (request) => requiredAthleteId(athleteIds, request),
      attemptId: (request) =>
        parseRequest(AttemptIdPathParamsSchema, request.params).id,
      sendAccepted: (reply, value) =>
        sendResponse(reply, 202, MediaUploadAcceptedSchema, value),
    });
    if (mediaUpload)
      registerAttemptMediaUploadPlugin(app, {
        mediaUpload,
        ...mediaRegistration,
      });

    app.get("/v1/challenges", async (request, reply) => {
      assertNoQuery(request.query);
      return sendResponse(reply, 200, ChallengeListResponseSchema, {
        items: [
          {
            id: "wall-pass",
            version: 1,
            sport: "futsal",
            activeDurationSeconds: 60,
            calibrationPreRollSeconds: 4,
            requiredGates: [
              "device",
              "space",
              "athlete",
              "rehearsal",
              "record",
            ],
          },
        ],
      });
    });

    app.post("/v1/calibration-sessions", async (request, reply) => {
      const body = parseRequest(
        CalibrationSessionCreateInputSchema,
        request.body,
      );
      const athleteId = requiredAthleteId(athleteIds, request);
      const sessionId = requiredGeneratedUuid(ids.next());
      const sessionNonce = requiredGeneratedNonce(nonce());
      const session = await input.repository.issueCalibrationSession({
        id: sessionId,
        athleteId,
        nonce: sessionNonce,
        challengeId: body.challengeId,
        challengeVersion: body.challengeVersion,
      });
      return sendResponse(reply, 201, CalibrationSessionSchema, session);
    });

    app.post("/v1/calibration-sessions/:id/ready", async (request, reply) => {
      const params = parseRequest(
        CalibrationSessionIdPathParamsSchema,
        request.params,
      );
      const body = parseRequest(
        CalibrationSessionReadyInputSchema,
        request.body,
      );
      await input.repository.readyCalibrationSession({
        id: params.id,
        athleteId: requiredAthleteId(athleteIds, request),
        requiredGates: body.requiredGates,
      });
      return reply.code(204).send();
    });

    app.post("/v1/attempts", async (request, reply) => {
      const body = parseRequest(CreateAttemptInputSchema, request.body);
      const attemptId = requiredGeneratedUuid(ids.next());
      const attempt = await input.repository.createAttempt({
        id: attemptId,
        athleteId: requiredAthleteId(athleteIds, request),
        input: body,
      });
      return sendResponse(
        reply,
        201,
        CreateAttemptResponseSchema,
        projectAttempt(attempt),
      );
    });

    app.get("/v1/attempts", async (request, reply) => {
      const query = parseRequest(AttemptListQuerySchema, request.query);
      const page = await input.repository.listAttempts({
        athleteId: requiredAthleteId(athleteIds, request),
        limit: query.limit,
        ...(query.cursor ? { cursor: query.cursor } : {}),
      });
      return sendResponse(reply, 200, AttemptListResponseSchema, {
        items: page.items.map(projectAttempt),
        nextCursor: page.nextCursor,
      });
    });

    app.get("/v1/attempts/:id/result", async (request, reply) => {
      assertNoQuery(request.query);
      const outcome = await attemptRead.result({
        attemptId: requiredCanonicalAttemptId(request),
        athleteId: requiredAthleteId(athleteIds, request),
      });
      if (!outcome) throw new AttemptRouteError("attempt_not_found");
      return sendResponse(
        reply,
        outcome.state === "pending" ? 202 : 200,
        AttemptResultResponseSchema,
        outcome,
      );
    });

    app.get("/v1/attempts/:id", async (request, reply) => {
      assertNoQuery(request.query);
      const attempt = await attemptRead.read({
        attemptId: requiredCanonicalAttemptId(request),
        athleteId: requiredAthleteId(athleteIds, request),
      });
      if (!attempt) throw new AttemptRouteError("attempt_not_found");
      return sendResponse(reply, 200, AttemptReadResponseSchema, attempt);
    });

    app.setNotFoundHandler((_request, reply) =>
      sendRouteError(reply, "invalid_request"),
    );
    app.setErrorHandler((error, _request, reply) =>
      sendRouteError(reply, routeErrorCode(error)),
    );
    recovery = createC8RecoveryRuntime({
      repository: input.repository,
      queue: input.queue,
      cleaner: input.cleaner,
      log: input.log ?? silentRecoveryLog,
      scheduler: input.scheduler ?? processHourlyRecoveryScheduler,
      maxBatchSize: input.recoveryBatchLimit ?? RECOVERY_BATCH_LIMIT,
      now: () => clock.now(),
    });
    app.addHook("onClose", async () => {
      await recovery?.stop();
    });
    return app;
  } catch (error) {
    void recovery?.stop();
    void app.close().catch(() => undefined);
    throw error;
  }
}

class AttemptRouteError extends Error {
  public constructor(public readonly routeCode: RouteErrorCode) {
    super(routeCode);
  }
}

function parseRequest<Output>(
  schema: Readonly<{
    safeParse(
      value: unknown,
    ): { success: true; data: Output } | { success: false };
  }>,
  value: unknown,
): Output {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new AttemptRouteError("invalid_request");
  return parsed.data;
}

function assertNoQuery(query: unknown): void {
  if (
    typeof query !== "object" ||
    query === null ||
    Array.isArray(query) ||
    Object.keys(query).length !== 0
  )
    throw new AttemptRouteError("invalid_request");
}

function sendResponse<Output>(
  reply: FastifyReply,
  statusCode: number,
  schema: Readonly<{ parse(value: unknown): Output }>,
  value: unknown,
): Output {
  try {
    return reply.code(statusCode).send(schema.parse(value)) as Output;
  } catch {
    throw new AttemptRouteError("service_not_ready");
  }
}

function sendRouteError(
  reply: FastifyReply,
  code: RouteErrorCode,
): FastifyReply {
  const body = RouteErrorSchema.parse({
    code,
    message: RouteErrorMessageByCode[code],
    retryable: RouteErrorRetryabilityByCode[code],
  });
  return reply.code(RouteErrorStatusByCode[code]).send(body);
}

function isPublicChallengeRequest(request: FastifyRequest): boolean {
  return request.routeOptions.url === "/v1/challenges";
}

function parseAthleteIdentity(request: FastifyRequest): string | undefined {
  const values: string[] = [];
  for (let index = 0; index < request.raw.rawHeaders.length; index += 2) {
    if (
      request.raw.rawHeaders[index]?.toLowerCase() === "x-revelai-athlete-id"
    ) {
      const value = request.raw.rawHeaders[index + 1];
      if (value !== undefined) values.push(value);
    }
  }
  if (values.length !== 1) return undefined;
  const parsed = AthleteIdentityHeaderSchema.safeParse({
    "x-revelai-athlete-id": values[0],
  });
  return parsed.success ? parsed.data["x-revelai-athlete-id"] : undefined;
}

function requiredAthleteId(
  athleteIds: WeakMap<FastifyRequest, string>,
  request: FastifyRequest,
): string {
  const athleteId = athleteIds.get(request);
  if (!athleteId) throw new AttemptRouteError("invalid_athlete_identity");
  return athleteId;
}

function requiredCanonicalAttemptId(request: FastifyRequest): string {
  const id = parseRequest(AttemptIdPathParamsSchema, request.params).id;
  if (
    !hasExactCanonicalAttemptPath(request, id) ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      id,
    )
  )
    throw new AttemptRouteError("invalid_request");
  return id;
}

/** C2 decodes/trims generic path strings; reads require literal canonical URI. */
function hasExactCanonicalAttemptPath(
  request: FastifyRequest,
  attemptId: string,
): boolean {
  const rawUrl = request.raw.url;
  if (typeof rawUrl !== "string") return false;
  return (
    rawUrl === `/v1/attempts/${attemptId}` ||
    rawUrl === `/v1/attempts/${attemptId}/result`
  );
}

function requiredGeneratedUuid(value: string): string {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  )
    throw new AttemptRouteError("service_not_ready");
  return value;
}

function requiredGeneratedNonce(value: string): string {
  if (
    !/^[A-Za-z0-9_-]{43}$/.test(value) ||
    Buffer.from(value, "base64url").byteLength !== 32 ||
    Buffer.from(value, "base64url").toString("base64url") !== value
  )
    throw new AttemptRouteError("service_not_ready");
  return value;
}

function projectAttempt(attempt: AttemptRecord): unknown {
  const common = {
    id: attempt.id,
    mode: attempt.mode,
    status: attempt.status,
    createdAt: attempt.createdAt,
    outcome: attempt.outcome,
  };
  if (attempt.mode === "free") return common;
  if (!attempt.challenge) throw new AttemptRouteError("service_not_ready");
  return { ...common, challenge: attempt.challenge };
}

function routeErrorCode(error: unknown): RouteErrorCode {
  if (error instanceof AttemptRouteError) return error.routeCode;
  if (error instanceof MediaPipelineError) return error.code;
  if (error instanceof QueueUnavailableError) return "queue_unavailable";
  if (error instanceof MultipartParserError) return "invalid_request";
  if (error instanceof RepositoryError) {
    if (error.code === "invalid_input") return "invalid_request";
    switch (error.code) {
      case "attempt_not_found":
      case "duplicate_media_upload":
      case "invalid_attempt_transition":
      case "calibration_session_not_found":
      case "calibration_session_expired":
      case "calibration_session_not_ready":
      case "calibration_session_consumed":
      case "calibration_session_challenge_mismatch":
        return error.code;
      default:
        return "service_not_ready";
    }
  }
  if (isFastifyRequestError(error)) return "invalid_request";
  return "service_not_ready";
}

function isFastifyRequestError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = Reflect.get(error, "code");
  return (
    typeof code === "string" &&
    (code.startsWith("FST_ERR_CTP_") ||
      code.startsWith("FST_ERR_VALIDATION") ||
      code.startsWith("FST_ERR_QS") ||
      code.startsWith("FST_MP_"))
  );
}
