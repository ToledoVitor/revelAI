import {
  AthleteIdentityHeaderSchema,
  AttemptIdPathParamsSchema,
  AttemptListQuerySchema,
  AttemptListResponseSchema,
  AttemptOutcomeSchema,
  AttemptReadResponseSchema,
  CalibrationSessionCreateInputSchema,
  CalibrationSessionIdPathParamsSchema,
  CalibrationSessionReadyInputSchema,
  CalibrationSessionSchema,
  ChallengeListResponseSchema,
  CreateAttemptInputSchema,
  CreateAttemptResponseSchema,
  DeleteAttemptResponseSchema,
  LeaderboardQuerySchema,
  LeaderboardResponseSchema,
  MediaUploadAcceptedSchema,
  RouteErrorSchema,
  RouteErrorStatusByCode,
  type AttemptListQuery,
  type CalibrationSessionCreateInput,
  type CalibrationSessionReadyInput,
  type CreateAttemptInput,
  type LeaderboardQuery,
  type RouteError,
} from "@revelai/contracts";

type FetchImplementation = typeof fetch;
type ResponseSchema<T> = Readonly<{ parse(value: unknown): T }>;

type RevelApiClientOptions = Readonly<{
  baseUrl: string;
  athleteId: string;
  fetch?: FetchImplementation;
}>;

export type RevelApiError = Readonly<{
  code: RouteError["code"];
  message: string;
  retryable: boolean;
  status: number;
}>;

export type RevelApiAbort = Readonly<{ kind: "aborted" }>;
export type RevelApiRequestOptions = Readonly<{ signal?: AbortSignal }>;

function isAbortWithoutResponse(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { name?: unknown }).name === "AbortError"
  );
}

function routeErrorForClient(
  response: Response,
  value: unknown,
): RevelApiError {
  const parsed = RouteErrorSchema.parse(value);
  if (RouteErrorStatusByCode[parsed.code] !== response.status) {
    throw new Error("Route error status does not match its contract.");
  }
  return Object.freeze({
    code: parsed.code,
    message: parsed.message,
    retryable: parsed.retryable,
    status: response.status,
  });
}

async function parseApiResponse<T>(
  response: Response,
  successStatuses: readonly number[],
  schema: ResponseSchema<T>,
): Promise<T> {
  const value = response.status === 204 ? undefined : await response.json();
  if (successStatuses.includes(response.status)) return schema.parse(value);
  throw routeErrorForClient(response, value);
}

export function createRevelApiClient(options: RevelApiClientOptions) {
  const identityHeader = AthleteIdentityHeaderSchema.parse({
    "x-revelai-athlete-id": options.athleteId,
  });
  const headers = {
    "x-revelai-athlete-id": identityHeader["x-revelai-athlete-id"],
  };
  const fetchImplementation = options.fetch ?? fetch;
  const requestUrl = (path: string) => new URL(path, options.baseUrl);
  const request = async <T>(
    path: string,
    init: RequestInit,
    successStatuses: readonly number[],
    schema: ResponseSchema<T>,
  ): Promise<T> => {
    try {
      const response = await fetchImplementation(requestUrl(path), init);
      return parseApiResponse(response, successStatuses, schema);
    } catch (error) {
      if (isAbortWithoutResponse(error)) {
        throw Object.freeze({ kind: "aborted" } satisfies RevelApiAbort);
      }
      throw error;
    }
  };
  const requestOptions = (input?: RevelApiRequestOptions): RequestInit => ({
    headers,
    ...(input?.signal ? { signal: input.signal } : {}),
  });
  const postJson = <T>(
    path: string,
    body: unknown,
    successStatuses: readonly number[],
    schema: ResponseSchema<T>,
    input?: RevelApiRequestOptions,
  ) =>
    request(
      path,
      {
        ...requestOptions(input),
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify(body),
      },
      successStatuses,
      schema,
    );

  return Object.freeze({
    listChallenges(input?: RevelApiRequestOptions) {
      return request(
        "/v1/challenges",
        requestOptions(input),
        [200],
        ChallengeListResponseSchema,
      );
    },
    createAttempt(input: CreateAttemptInput, options?: RevelApiRequestOptions) {
      return postJson(
        "/v1/attempts",
        CreateAttemptInputSchema.parse(input),
        [201],
        CreateAttemptResponseSchema,
        options,
      );
    },
    createCalibrationSession(
      input: CalibrationSessionCreateInput,
      options?: RevelApiRequestOptions,
    ) {
      return postJson(
        "/v1/calibration-sessions",
        CalibrationSessionCreateInputSchema.parse(input),
        [201],
        CalibrationSessionSchema,
        options,
      );
    },
    readyCalibrationSession(
      id: string,
      input: CalibrationSessionReadyInput,
      options?: RevelApiRequestOptions,
    ) {
      const params = CalibrationSessionIdPathParamsSchema.parse({ id });
      return postJson(
        `/v1/calibration-sessions/${encodeURIComponent(params.id)}/ready`,
        CalibrationSessionReadyInputSchema.parse(input),
        [204],
        DeleteAttemptResponseSchema,
        options,
      );
    },
    listAttempts(
      input?: Partial<AttemptListQuery>,
      options?: RevelApiRequestOptions,
    ) {
      const query = AttemptListQuerySchema.parse(input ?? {});
      const search = new URLSearchParams({ limit: String(query.limit) });
      if (query.cursor) search.set("cursor", query.cursor);
      return request(
        `/v1/attempts?${search}`,
        requestOptions(options),
        [200],
        AttemptListResponseSchema,
      );
    },
    getAttempt(id: string, options?: RevelApiRequestOptions) {
      const params = AttemptIdPathParamsSchema.parse({ id });
      return request(
        `/v1/attempts/${encodeURIComponent(params.id)}`,
        requestOptions(options),
        [200],
        AttemptReadResponseSchema,
      );
    },
    getAttemptOutcome(id: string, options?: RevelApiRequestOptions) {
      const params = AttemptIdPathParamsSchema.parse({ id });
      return request(
        `/v1/attempts/${encodeURIComponent(params.id)}/result`,
        requestOptions(options),
        [200, 202],
        AttemptOutcomeSchema,
      );
    },
    getLeaderboard(input: LeaderboardQuery, options?: RevelApiRequestOptions) {
      const query = LeaderboardQuerySchema.parse({
        version: String(input.version),
        ruleVersion: input.ruleVersion,
        limit: String(input.limit),
        ...(input.cursor ? { cursor: input.cursor } : {}),
      });
      const search = new URLSearchParams({
        version: String(query.version),
        ruleVersion: query.ruleVersion,
        limit: String(query.limit),
      });
      if (query.cursor) search.set("cursor", query.cursor);
      return request(
        `/v1/leaderboards/wall-pass?${search}`,
        requestOptions(options),
        [200],
        LeaderboardResponseSchema,
      );
    },
    uploadAttemptMedia(
      id: string,
      media: File,
      options?: RevelApiRequestOptions,
    ) {
      const params = AttemptIdPathParamsSchema.parse({ id });
      const formData = new FormData();
      formData.append("media", media, media.name);
      return request(
        `/v1/attempts/${encodeURIComponent(params.id)}/media`,
        { ...requestOptions(options), method: "POST", body: formData },
        [202],
        MediaUploadAcceptedSchema,
      );
    },
    deleteAttempt(id: string, options?: RevelApiRequestOptions) {
      const params = AttemptIdPathParamsSchema.parse({ id });
      return request(
        `/v1/attempts/${encodeURIComponent(params.id)}`,
        { ...requestOptions(options), method: "DELETE" },
        [204],
        DeleteAttemptResponseSchema,
      );
    },
  });
}
