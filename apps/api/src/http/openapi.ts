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
  HealthResponseSchema,
  LeaderboardQuerySchema,
  LeaderboardResponseSchema,
  MediaUploadAcceptedSchema,
  ReadinessResponseSchema,
  RouteErrorSchema,
  mediaUploadFixtures,
} from "@revelai/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z, type ZodType } from "zod";

type HttpMethod = "get" | "post" | "delete";
type ResponseDefinition = Readonly<{
  status: number;
  schema?: ZodType;
}>;
export type MultipartWireContract = Readonly<{
  contentType: string;
  required: readonly string[];
  properties: Readonly<
    Record<string, Readonly<{ type: "string"; format: "binary" }>>
  >;
}>;
export type ApiRouteContract = Readonly<{
  method: HttpMethod;
  path: string;
  operationId: string;
  summary: string;
  authenticated?: boolean;
  pathParams?: ZodType;
  query?: ZodType;
  queryDefaults?: Readonly<Record<string, unknown>>;
  requestBody?: ZodType;
  multipart?: MultipartWireContract;
  responses: readonly ResponseDefinition[];
}>;
export type OpenApiDocument = Readonly<{
  openapi: string;
  info: Readonly<{ title: string; version: string }>;
  paths: Record<string, Partial<Record<HttpMethod, unknown>>>;
  components: Record<string, unknown>;
}>;

const response = (status: number, schema?: ZodType): ResponseDefinition =>
  Object.freeze(schema === undefined ? { status } : { status, schema });
const routeError = (status: number): ResponseDefinition =>
  response(status, RouteErrorSchema);

/**
 * The C8 HTTP surface is described only by its route mapping and C2 Zod
 * schemas. The generated artifact never redefines a request or response body.
 */
const c2MediaPart = mediaUploadFixtures.accepted.request.parts[0];
if (!c2MediaPart || c2MediaPart.kind !== "file")
  throw new Error("C2 media fixture must contain one file part.");
const c2MultipartContentType = mediaUploadFixtures.rawMultipart.headers[
  "content-type"
].split(";", 1)[0];
if (!c2MultipartContentType)
  throw new Error("C2 raw media fixture must declare a content type.");

const oneMediaMultipartWire: MultipartWireContract = Object.freeze({
  contentType: c2MultipartContentType,
  required: Object.freeze([c2MediaPart.fieldName]),
  properties: Object.freeze({
    [c2MediaPart.fieldName]: Object.freeze({
      type: "string",
      format: "binary",
    }),
  }),
});

export const apiRouteRegistry: readonly ApiRouteContract[] = Object.freeze([
  {
    method: "get",
    path: "/health",
    operationId: "getHealth",
    summary: "Process liveness",
    responses: [response(200, HealthResponseSchema)],
  },
  {
    method: "get",
    path: "/ready",
    operationId: "getReadiness",
    summary: "Dependency readiness",
    responses: [response(200, ReadinessResponseSchema), routeError(503)],
  },
  {
    method: "get",
    path: "/v1/challenges",
    operationId: "listChallenges",
    summary: "List active challenges",
    responses: [
      response(200, ChallengeListResponseSchema),
      routeError(400),
      routeError(503),
    ],
  },
  {
    method: "post",
    path: "/v1/calibration-sessions",
    operationId: "createCalibrationSession",
    summary: "Issue a calibration session",
    authenticated: true,
    requestBody: CalibrationSessionCreateInputSchema,
    responses: [
      response(201, CalibrationSessionSchema),
      routeError(400),
      routeError(503),
    ],
  },
  {
    method: "post",
    path: "/v1/calibration-sessions/{id}/ready",
    operationId: "readyCalibrationSession",
    summary: "Mark a calibration session ready",
    authenticated: true,
    pathParams: CalibrationSessionIdPathParamsSchema,
    requestBody: CalibrationSessionReadyInputSchema,
    responses: [
      response(204),
      routeError(400),
      routeError(404),
      routeError(409),
      routeError(410),
      routeError(503),
    ],
  },
  {
    method: "get",
    path: "/v1/attempts",
    operationId: "listAttempts",
    summary: "List attempts for the local athlete",
    authenticated: true,
    query: AttemptListQuerySchema,
    responses: [
      response(200, AttemptListResponseSchema),
      routeError(400),
      routeError(503),
    ],
  },
  {
    method: "post",
    path: "/v1/attempts",
    operationId: "createAttempt",
    summary: "Create a Free or Verified attempt",
    authenticated: true,
    requestBody: CreateAttemptInputSchema,
    responses: [
      response(201, CreateAttemptResponseSchema),
      routeError(400),
      routeError(404),
      routeError(409),
      routeError(410),
      routeError(503),
    ],
  },
  {
    method: "get",
    path: "/v1/attempts/{id}",
    operationId: "getAttempt",
    summary: "Read an attempt",
    authenticated: true,
    pathParams: AttemptIdPathParamsSchema,
    responses: [
      response(200, AttemptReadResponseSchema),
      routeError(400),
      routeError(404),
      routeError(503),
    ],
  },
  {
    method: "delete",
    path: "/v1/attempts/{id}",
    operationId: "deleteAttempt",
    summary: "Delete an attempt",
    authenticated: true,
    pathParams: AttemptIdPathParamsSchema,
    responses: [
      response(204),
      routeError(400),
      routeError(404),
      routeError(503),
    ],
  },
  {
    method: "get",
    path: "/v1/attempts/{id}/result",
    operationId: "getAttemptResult",
    summary: "Read an attempt outcome",
    authenticated: true,
    pathParams: AttemptIdPathParamsSchema,
    responses: [
      response(200, AttemptResultResponseSchema),
      response(202, AttemptResultResponseSchema),
      routeError(400),
      routeError(404),
      routeError(503),
    ],
  },
  {
    method: "post",
    path: "/v1/attempts/{id}/media",
    operationId: "uploadAttemptMedia",
    summary: "Upload exactly one media part",
    authenticated: true,
    pathParams: AttemptIdPathParamsSchema,
    multipart: oneMediaMultipartWire,
    responses: [
      response(202, MediaUploadAcceptedSchema),
      routeError(400),
      routeError(404),
      routeError(409),
      routeError(413),
      routeError(415),
      routeError(422),
      routeError(503),
    ],
  },
  {
    method: "get",
    path: "/v1/leaderboards/wall-pass",
    operationId: "getWallPassLeaderboard",
    summary: "Read the live wall-pass leaderboard",
    query: LeaderboardQuerySchema,
    queryDefaults: Object.freeze({ limit: "20" }),
    responses: [
      response(200, LeaderboardResponseSchema),
      routeError(400),
      routeError(503),
    ],
  },
]);

export function apiRoute(operationId: string): ApiRouteContract {
  const route = apiRouteRegistry.find(
    (candidate) => candidate.operationId === operationId,
  );
  if (!route) throw new Error(`Unknown C2 route contract: ${operationId}`);
  return route;
}

export function fastifyRoutePath(route: ApiRouteContract): string {
  return route.path.replace(/\{([^}]+)\}/g, ":$1");
}

export function apiRouteForFastifyRequest(
  input: Readonly<{ method: string; routePath: string | undefined }>,
  routes: readonly ApiRouteContract[] = apiRouteRegistry,
): ApiRouteContract | undefined {
  return routes.find(
    (route) =>
      route.method === input.method.toLowerCase() &&
      fastifyRoutePath(route) === input.routePath,
  );
}

export function registerApiRoute(
  app: FastifyInstance,
  route: ApiRouteContract,
  handler: (request: FastifyRequest, reply: FastifyReply) => unknown,
): void {
  app.route({
    ...fastifyRouteRegistration(route),
    handler,
  });
}

export function fastifyRouteRegistration(
  route: ApiRouteContract,
): Readonly<{ method: "GET" | "POST" | "DELETE"; url: string }> {
  return Object.freeze({
    method: route.method.toUpperCase() as "GET" | "POST" | "DELETE",
    url: fastifyRoutePath(route),
  });
}

export function sendApiRouteResponse(
  reply: FastifyReply,
  route: ApiRouteContract,
  status: number,
  value?: unknown,
): FastifyReply {
  const response = route.responses.find(
    (definition) => definition.status === status,
  );
  if (!response) throw new Error("C2 route response is not declared.");
  if (!response.schema) {
    if (value !== undefined)
      throw new Error("C2 empty response cannot contain a body.");
    return reply.code(status).send();
  }
  return reply.code(status).send(response.schema.parse(value));
}

export function resolveMultipartWire(
  route: ApiRouteContract,
): Readonly<{ contentType: string; fieldName: string }> {
  const multipart = route.multipart;
  if (!multipart)
    throw new Error("C2 route does not declare multipart wire data.");
  const properties = Object.keys(multipart.properties);
  if (
    properties.length !== 1 ||
    multipart.required.length !== 1 ||
    properties[0] !== multipart.required[0]
  )
    throw new Error("C2 media route must declare exactly one required file.");
  return Object.freeze({
    contentType: multipart.contentType,
    fieldName: properties[0]!,
  });
}

const schemaComponents = new Map<ZodType, string>([
  [AthleteIdentityHeaderSchema, "AthleteIdentityHeader"],
  [AttemptIdPathParamsSchema, "AttemptIdPathParams"],
  [AttemptListQuerySchema, "AttemptListQuery"],
  [AttemptListResponseSchema, "AttemptListResponse"],
  [AttemptReadResponseSchema, "AttemptReadResponse"],
  [AttemptResultResponseSchema, "AttemptResultResponse"],
  [CalibrationSessionCreateInputSchema, "CalibrationSessionCreateInput"],
  [CalibrationSessionIdPathParamsSchema, "CalibrationSessionIdPathParams"],
  [CalibrationSessionReadyInputSchema, "CalibrationSessionReadyInput"],
  [CalibrationSessionSchema, "CalibrationSession"],
  [ChallengeListResponseSchema, "ChallengeListResponse"],
  [CreateAttemptInputSchema, "CreateAttemptInput"],
  [CreateAttemptResponseSchema, "CreateAttemptResponse"],
  [HealthResponseSchema, "HealthResponse"],
  [LeaderboardQuerySchema, "LeaderboardQuery"],
  [LeaderboardResponseSchema, "LeaderboardResponse"],
  [MediaUploadAcceptedSchema, "MediaUploadAccepted"],
  [ReadinessResponseSchema, "ReadinessResponse"],
  [RouteErrorSchema, "RouteError"],
]);

export function generateOpenApiDocument(
  routes: readonly ApiRouteContract[] = apiRouteRegistry,
): OpenApiDocument {
  const paths: Record<string, Partial<Record<HttpMethod, unknown>>> = {};
  for (const route of routes) {
    const pathItem = paths[route.path] ?? {};
    pathItem[route.method] = operation(route);
    paths[route.path] = pathItem;
  }
  return {
    openapi: "3.1.1",
    info: { title: "RevelAI API", version: "0.0.0" },
    paths,
    components: {
      securitySchemes: {
        AthleteIdentity: {
          type: "apiKey",
          in: "header",
          name: "X-RevelAI-Athlete-Id",
        },
      },
      schemas: Object.fromEntries(
        [...schemaComponents.entries()].map(([schema, name]) => [
          name,
          jsonSchema(schema),
        ]),
      ),
    },
  };
}

export function renderOpenApiDocument(): string {
  return `${JSON.stringify(generateOpenApiDocument(), null, 2)}\n`;
}

function operation(route: ApiRouteContract): Record<string, unknown> {
  return {
    operationId: route.operationId,
    summary: route.summary,
    ...(route.authenticated
      ? {
          security: [{ AthleteIdentity: [] }],
          parameters: [
            athleteIdentityParameter(),
            ...schemaParameters(route.pathParams, "path"),
            ...schemaParameters(route.query, "query", route.queryDefaults),
          ],
        }
      : {
          parameters: [
            ...schemaParameters(route.pathParams, "path"),
            ...schemaParameters(route.query, "query", route.queryDefaults),
          ],
        }),
    ...(route.requestBody
      ? { requestBody: jsonRequestBody(route.requestBody) }
      : {}),
    ...(route.multipart
      ? { requestBody: multipartRequestBody(route.multipart) }
      : {}),
    responses: Object.fromEntries(
      route.responses.map((definition) => [
        String(definition.status),
        definition.schema
          ? {
              description: `HTTP ${definition.status}`,
              content: {
                "application/json": {
                  schema: schemaReference(definition.schema),
                },
              },
            }
          : { description: `HTTP ${definition.status}` },
      ]),
    ),
  };
}

function athleteIdentityParameter(): Record<string, unknown> {
  const schema = inputJsonSchema(AthleteIdentityHeaderSchema) as {
    properties?: Record<string, unknown>;
  };
  return {
    name: "X-RevelAI-Athlete-Id",
    in: "header",
    required: true,
    schema: schema.properties?.["x-revelai-athlete-id"],
  };
}

function schemaParameters(
  schema: ZodType | undefined,
  location: "path" | "query",
  defaults: Readonly<Record<string, unknown>> = {},
): Record<string, unknown>[] {
  if (!schema) return [];
  const converted = inputJsonSchema(schema) as {
    properties?: Record<string, unknown>;
    required?: string[];
  };
  return Object.entries(converted.properties ?? {}).map(([name, value]) => ({
    name,
    in: location,
    required:
      location === "path" || converted.required?.includes(name) === true,
    schema:
      location === "query" && Object.hasOwn(defaults, name)
        ? { ...(value as Record<string, unknown>), default: defaults[name] }
        : value,
  }));
}

function jsonRequestBody(schema: ZodType): Record<string, unknown> {
  return {
    required: true,
    content: { "application/json": { schema: schemaReference(schema) } },
  };
}

function multipartRequestBody(
  multipart: MultipartWireContract,
): Record<string, unknown> {
  return {
    required: true,
    content: {
      [multipart.contentType]: {
        schema: {
          type: "object",
          additionalProperties: false,
          required: multipart.required,
          properties: multipart.properties,
        },
      },
    },
  };
}

function schemaReference(schema: ZodType): Record<string, string> {
  const name = schemaComponents.get(schema);
  if (!name) throw new Error("OpenAPI route schema is not registered.");
  return { $ref: `#/components/schemas/${name}` };
}

function jsonSchema(schema: ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, { unrepresentable: "any" });
}

function inputJsonSchema(schema: ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, { io: "input", unrepresentable: "any" });
}
