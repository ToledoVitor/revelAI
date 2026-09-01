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
  CalibrationSessionCreateInputSchema,
  CalibrationSessionIdPathParamsSchema,
  CalibrationSessionReadyInputSchema,
  CreateAttemptInputSchema,
  LeaderboardQuerySchema,
  MAX_MULTIPART_ENVELOPE_BYTES,
  MAX_UPLOAD_BYTES,
  RouteErrorMessageByCode,
  RouteErrorRetryabilityByCode,
  RouteErrorSchema,
  RouteErrorStatusByCode,
  type RouteErrorCode,
} from "@revelai/contracts";
import { QueueUnavailableError } from "../queue/analysis-queue.js";
import type { AttemptApiQueuePort } from "../queue/analysis-queue-port.js";
import { MediaPipelineError } from "../media/probe.js";
import type { RetentionLog } from "../media/retention-scavenger.js";
import { RepositoryError } from "../repositories/attempt-repository.js";
import type {
  AttemptRecord,
  AttemptRepository,
} from "../repositories/attempt-repository.js";
import {
  prepareC8RecoveryRuntime,
  type HourlyRecoveryScheduler,
  type MediaAttachmentRecoveryLog,
  type MediaAttachmentRecoveryRepository,
  type MediaDeliveryRedeliveryRepository,
  type OpaqueAcceptedMediaCleaner,
} from "../services/media-attachment-recovery.js";
import { type RetentionRuntimeFactory } from "../services/retention-runtime.js";
import {
  startC8RuntimeSupervisor,
  type C8RuntimeSupervisorHandle,
} from "../services/c8-runtime-supervisor.js";
import { createAttemptReadService } from "../services/attempt-read-service.js";
import { MultipartParserError } from "./streamed-multipart.js";
import { type MediaUploadService } from "../services/media-upload-service.js";
import { registerAttemptMediaUploadPlugin } from "./attempt-media-upload-plugin.js";
import {
  registerOperabilityRoutes,
  type ReadinessProbes,
} from "./operability-routes.js";
import {
  apiRoute,
  apiRouteForFastifyRequest,
  registerApiRoute,
  sendApiRouteResponse,
  type ApiRouteContract,
} from "./openapi.js";

type AttemptHttpRepository = AttemptRepository &
  MediaAttachmentRecoveryRepository &
  MediaDeliveryRedeliveryRepository;
type AttemptApiClock = Readonly<{ now(): string }>;
type AttemptApiIdGenerator = Readonly<{ next(): string }>;
type AttemptUploadQueue = AttemptApiQueuePort;
type AttemptApiInput = Readonly<{
  repository: AttemptHttpRepository;
  leaderboard?: Pick<AttemptRepository, "listLiveLeaderboard">;
  tombstone?: Pick<AttemptRepository, "tombstoneAttempt">;
  queue: AttemptUploadQueue;
  cleaner: OpaqueAcceptedMediaCleaner;
  maxUploadBytes?: number;
  scheduler?: HourlyRecoveryScheduler;
  recoveryBatchLimit?: number;
  clock?: AttemptApiClock;
  ids?: AttemptApiIdGenerator;
  nonce?: () => string;
  log?: MediaAttachmentRecoveryLog;
  retentionLog?: RetentionLog;
  readiness?: ReadinessProbes;
  /** Outer production composition supplies the sealed C4/C5 retention join. */
  retentionRuntime?: RetentionRuntimeFactory;
}>;

const RECOVERY_BATCH_LIMIT = 100;
const HOUR_MILLISECONDS = 60 * 60 * 1_000;
const challengeRoute = apiRoute("listChallenges");
const leaderboardRoute = apiRoute("getWallPassLeaderboard");
const LEADERBOARD_NAMESPACE_PATH = leaderboardRoute.path.slice(
  0,
  leaderboardRoute.path.lastIndexOf("/"),
);
const createCalibrationRoute = apiRoute("createCalibrationSession");
const readyCalibrationRoute = apiRoute("readyCalibrationSession");
const createAttemptRoute = apiRoute("createAttempt");
const deleteAttemptRoute = apiRoute("deleteAttempt");
const listAttemptsRoute = apiRoute("listAttempts");
const getAttemptResultRoute = apiRoute("getAttemptResult");
const getAttemptRoute = apiRoute("getAttempt");
const uploadAttemptMediaRoute = apiRoute("uploadAttemptMedia");
const silentRecoveryLog: MediaAttachmentRecoveryLog = Object.freeze({
  event: () => undefined,
});
const unavailableReadiness: ReadinessProbes = Object.freeze({
  database: async () => {
    throw new Error("database readiness is not composed");
  },
  storage: async () => {
    throw new Error("storage readiness is not composed");
  },
  queue: async () => false,
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
  const now = clock.now.bind(clock);
  const scheduler = input.scheduler ?? processHourlyRecoveryScheduler;
  const listLiveLeaderboard = input.leaderboard
    ? input.leaderboard.listLiveLeaderboard
    : input.repository.listLiveLeaderboard.bind(input.repository);
  const tombstoneAttempt = input.tombstone
    ? input.tombstone.tombstoneAttempt
    : input.repository.tombstoneAttempt.bind(input.repository);
  const ids = input.ids ?? { next: randomUUID };
  const nonce = input.nonce ?? (() => randomBytes(32).toString("base64url"));
  const attemptRead = createAttemptReadService({
    repository: input.repository,
  });
  let recovery: ReturnType<typeof prepareC8RecoveryRuntime> | undefined;
  let retention: ReturnType<RetentionRuntimeFactory["prepare"]> | undefined;
  let runtimeSupervisor: C8RuntimeSupervisorHandle | undefined;
  try {
    registerOperabilityRoutes(app, {
      readiness: input.readiness ?? unavailableReadiness,
    });
    app.addHook("onRequest", async (request) => {
      if (isPublicRouteRequest(request)) return;
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
        sendResponse(reply, uploadAttemptMediaRoute, 202, value),
    });
    if (mediaUpload)
      registerAttemptMediaUploadPlugin(app, {
        mediaUpload,
        route: uploadAttemptMediaRoute,
        ...mediaRegistration,
      });

    registerApiRoute(app, challengeRoute, async (request, reply) => {
      assertNoQuery(request.query);
      return sendResponse(reply, challengeRoute, 200, {
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

    registerApiRoute(app, leaderboardRoute, async (request, reply) => {
      if (!hasExactPublicPath(request, leaderboardRoute))
        throw new AttemptRouteError("invalid_request");
      const query = parseRequest(LeaderboardQuerySchema, request.query);
      const page = await listLiveLeaderboard({
        challenge: {
          id: "wall-pass",
          version: query.version,
          ruleVersion: query.ruleVersion,
        },
        limit: query.limit,
        ...(query.cursor ? { cursor: query.cursor } : {}),
      });
      return sendResponse(reply, leaderboardRoute, 200, {
        view: "live",
        challengeId: "wall-pass",
        challengeVersion: query.version,
        ruleVersion: query.ruleVersion,
        calculatedAt: page.calculatedAt,
        cohortSize: page.cohortSize,
        entries: page.entries,
        nextCursor: page.nextCursor,
      });
    });

    registerApiRoute(app, createCalibrationRoute, async (request, reply) => {
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
      return sendResponse(reply, createCalibrationRoute, 201, session);
    });

    registerApiRoute(app, readyCalibrationRoute, async (request, reply) => {
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
      return sendResponse(reply, readyCalibrationRoute, 204);
    });

    registerApiRoute(app, createAttemptRoute, async (request, reply) => {
      const body = parseRequest(CreateAttemptInputSchema, request.body);
      const attemptId = requiredGeneratedUuid(ids.next());
      const attempt = await input.repository.createAttempt({
        id: attemptId,
        athleteId: requiredAthleteId(athleteIds, request),
        input: body,
      });
      return sendResponse(
        reply,
        createAttemptRoute,
        201,
        projectAttempt(attempt),
      );
    });

    registerApiRoute(app, deleteAttemptRoute, async (request, reply) => {
      assertNoQuery(request.query);
      assertNoBody(request.body);
      await tombstoneAttempt({
        attemptId: requiredCanonicalAttemptId(request, deleteAttemptRoute),
        athleteId: requiredAthleteId(athleteIds, request),
      });
      return sendResponse(reply, deleteAttemptRoute, 204);
    });

    registerApiRoute(app, listAttemptsRoute, async (request, reply) => {
      const query = parseRequest(AttemptListQuerySchema, request.query);
      const page = await input.repository.listAttempts({
        athleteId: requiredAthleteId(athleteIds, request),
        limit: query.limit,
        ...(query.cursor ? { cursor: query.cursor } : {}),
      });
      return sendResponse(reply, listAttemptsRoute, 200, {
        items: page.items.map(projectAttempt),
        nextCursor: page.nextCursor,
      });
    });

    registerApiRoute(app, getAttemptResultRoute, async (request, reply) => {
      assertNoQuery(request.query);
      const outcome = await attemptRead.result({
        attemptId: requiredCanonicalAttemptId(request, getAttemptResultRoute),
        athleteId: requiredAthleteId(athleteIds, request),
      });
      if (!outcome) throw new AttemptRouteError("attempt_not_found");
      return sendResponse(
        reply,
        getAttemptResultRoute,
        outcome.state === "pending" ? 202 : 200,
        outcome,
      );
    });

    registerApiRoute(app, getAttemptRoute, async (request, reply) => {
      assertNoQuery(request.query);
      const attempt = await attemptRead.read({
        attemptId: requiredCanonicalAttemptId(request, getAttemptRoute),
        athleteId: requiredAthleteId(athleteIds, request),
      });
      if (!attempt) throw new AttemptRouteError("attempt_not_found");
      return sendResponse(reply, getAttemptRoute, 200, attempt);
    });

    app.setNotFoundHandler((_request, reply) =>
      sendRouteError(reply, "invalid_request"),
    );
    app.setErrorHandler((error, _request, reply) =>
      sendRouteError(reply, routeErrorCode(error)),
    );
    // Install shutdown while no runtime is active so there is no fallible app
    // composition step after paired activation.
    app.addHook("onClose", async () => {
      await runtimeSupervisor?.stop();
    });
    // Reserve both durable-runtime owners before either scheduler callback can
    // run. The supervisor then registers both inert callbacks and activates
    // their immediate passes only after every registration succeeds.
    recovery = prepareC8RecoveryRuntime({
      repository: input.repository,
      queue: input.queue,
      cleaner: input.cleaner,
      log: input.log ?? silentRecoveryLog,
      maxBatchSize: input.recoveryBatchLimit ?? RECOVERY_BATCH_LIMIT,
      now,
    });
    retention = input.retentionRuntime?.prepare({
      maxBatchSize: input.recoveryBatchLimit ?? RECOVERY_BATCH_LIMIT,
      now,
    });
    runtimeSupervisor = startC8RuntimeSupervisor({
      recovery,
      ...(retention ? { retention } : {}),
      scheduler,
      now,
    });
    return app;
  } catch (error) {
    // Paired startup rollback is synchronous while both runtimes are inert;
    // this preserves an immediate retry even when a scheduler registration
    // throws after accepting its first callback.
    retention?.abortStartup();
    recovery?.abortStartup();
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

function assertNoBody(body: unknown): void {
  if (body !== undefined) throw new AttemptRouteError("invalid_request");
}

function sendResponse(
  reply: FastifyReply,
  route: ApiRouteContract,
  statusCode: number,
  value?: unknown,
): FastifyReply {
  try {
    return sendApiRouteResponse(reply, route, statusCode, value);
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

function isPublicRouteRequest(request: FastifyRequest): boolean {
  const route = apiRouteForFastifyRequest({
    method: request.method,
    routePath: request.routeOptions.url,
  });
  return route
    ? !route.authenticated
    : isPublicLeaderboardPathCandidate(publicRoutePath(request));
}

/**
 * The leaderboard namespace is public. Route only its literal namespace
 * failures through the public error surface, leaving lookalike API paths
 * behind normal athlete authentication.
 */
function isPublicLeaderboardPathCandidate(path: string | undefined): boolean {
  return (
    path === LEADERBOARD_NAMESPACE_PATH ||
    path?.startsWith(`${LEADERBOARD_NAMESPACE_PATH}/`) === true
  );
}

function hasExactPublicPath(
  request: FastifyRequest,
  route: ApiRouteContract,
): boolean {
  return publicRoutePath(request) === route.path;
}

function publicRoutePath(request: FastifyRequest): string | undefined {
  const rawUrl = request.raw.url;
  if (typeof rawUrl !== "string") return undefined;
  return rawUrl.split("?", 1)[0];
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

function requiredCanonicalAttemptId(
  request: FastifyRequest,
  route: ApiRouteContract,
): string {
  const id = parseRequest(AttemptIdPathParamsSchema, request.params).id;
  const rawUrl = request.raw.url;
  if (
    rawUrl !== route.path.replace("{id}", id) ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      id,
    )
  )
    throw new AttemptRouteError("invalid_request");
  return id;
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
