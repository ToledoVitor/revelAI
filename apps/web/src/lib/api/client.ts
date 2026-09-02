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

export type RevelApiUploadProgress = Readonly<{
  loaded: number;
  total?: number;
}>;

type XhrFactory = () => XMLHttpRequest;

type RevelApiClientOptions = Readonly<{
  baseUrl: string;
  athleteId: string;
  fetch?: FetchImplementation;
  xhrFactory?: XhrFactory;
}>;

export type RevelApiError = Readonly<{
  code: RouteError["code"];
  message: string;
  retryable: boolean;
  status: number;
}>;

export type RevelApiAbort = Readonly<{ kind: "aborted" }>;
export type RevelApiRequestOptions = Readonly<{ signal?: AbortSignal }>;
export type RevelApiUploadOptions = RevelApiRequestOptions &
  Readonly<{ onProgress?(progress: RevelApiUploadProgress): void }>;

function isAbortWithoutResponse(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { name?: unknown }).name === "AbortError"
  );
}

function routeErrorForClient(
  response: Pick<Response, "status">,
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

function defaultXhrFactory(): XhrFactory | undefined {
  if (import.meta.env.MODE === "test" || typeof XMLHttpRequest === "undefined")
    return undefined;
  return () => new XMLHttpRequest();
}

function xhrUpload<T>(
  input: Readonly<{
    factory: XhrFactory;
    url: string;
    headers: Readonly<Record<string, string>>;
    body: FormData;
    signal?: AbortSignal;
    onProgress(progress: RevelApiUploadProgress): void;
    successStatuses: readonly number[];
    schema: ResponseSchema<T>;
  }>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const xhr = input.factory();
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      xhr.upload.removeEventListener("progress", onProgress);
      xhr.removeEventListener("load", onLoad);
      xhr.removeEventListener("error", onError);
      xhr.removeEventListener("abort", onAbort);
      input.signal?.removeEventListener("abort", abortRequest);
      callback();
    };
    const onProgress = (event: ProgressEvent) =>
      input.onProgress({
        loaded: event.loaded,
        ...(event.lengthComputable ? { total: event.total } : {}),
      });
    const onLoad = () => {
      let value: unknown;
      try {
        value = xhr.status === 204 ? undefined : JSON.parse(xhr.responseText);
        if (input.successStatuses.includes(xhr.status)) {
          const parsed = input.schema.parse(value);
          finish(() => resolve(parsed));
          return;
        }
        const error = routeErrorForClient(xhr, value);
        finish(() => reject(error));
      } catch (error) {
        finish(() => reject(error));
      }
    };
    const onError = () =>
      finish(() => reject(new TypeError("The upload network request failed.")));
    const onAbort = () =>
      finish(() => reject(new DOMException("Aborted", "AbortError")));
    const abortRequest = () => xhr.abort();
    if (input.signal?.aborted) {
      onAbort();
      return;
    }
    xhr.open("POST", input.url);
    if (typeof window !== "undefined")
      xhr.withCredentials =
        new URL(input.url).origin === window.location.origin;
    for (const [name, value] of Object.entries(input.headers))
      xhr.setRequestHeader(name, value);
    xhr.upload.addEventListener("progress", onProgress);
    xhr.addEventListener("load", onLoad);
    xhr.addEventListener("error", onError);
    xhr.addEventListener("abort", onAbort);
    input.signal?.addEventListener("abort", abortRequest, { once: true });
    xhr.send(input.body);
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
  const xhrFactory = options.xhrFactory ?? defaultXhrFactory();
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
      options?: RevelApiUploadOptions,
    ) {
      const params = AttemptIdPathParamsSchema.parse({ id });
      const formData = new FormData();
      formData.append("media", media, media.name);
      if (options?.onProgress && xhrFactory) {
        return xhrUpload({
          factory: xhrFactory,
          url: requestUrl(
            `/v1/attempts/${encodeURIComponent(params.id)}/media`,
          ).toString(),
          headers,
          body: formData,
          signal: options.signal,
          onProgress: options.onProgress,
          successStatuses: [202],
          schema: MediaUploadAcceptedSchema,
        }).catch((error: unknown) => {
          if (isAbortWithoutResponse(error)) {
            throw Object.freeze({ kind: "aborted" } satisfies RevelApiAbort);
          }
          throw error;
        });
      }
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
