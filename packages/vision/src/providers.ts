import type {
  FreeAnalysisProvenance,
  VerifiedAnalysisProvenance,
} from "@revelai/contracts";
import {
  createLetterboxTransform,
  inverseInferencePoint,
  type LetterboxTransform,
} from "./transform.js";
import { VisionBatchScheduler } from "./scheduler.js";
import {
  FIDUCIAL_CORNER_IDS,
  FreeVisionFrameRequestSchema,
  FreeVisionObservationBatchSchema,
  type FreeFrameObservation,
  FreeFrameObservationSchema,
  type FreeVisionFrameRequest,
  type FreeVisionObservationBatch,
  type SourceFrame,
  type VerifiedVisionFrameRequest,
  type VerifiedVisionObservationBatch,
  VerifiedVisionFrameRequestSchema,
  VerifiedVisionObservationBatchSchema,
  type VisionFrameRequest,
  WorkflowEnvelopeSchema,
  type WallPassFrameObservation,
  WallPassFrameObservationSchema,
} from "./types.js";

export type FrameTransformer = Readonly<{
  transform(
    frame: SourceFrame,
    transform: LetterboxTransform,
  ): Promise<Uint8Array>;
}>;

export type ProviderHttpResponse = Readonly<{
  status: number;
  json(): Promise<unknown>;
}>;

export type ProviderFetch = (
  url: string,
  init: Readonly<{
    method: "POST";
    headers: Readonly<Record<string, string>>;
    body: string;
    signal: AbortSignal;
  }>,
) => Promise<ProviderHttpResponse>;

export type VisionProvider = Readonly<{
  analyzeFree(
    request: FreeVisionFrameRequest,
    signal?: AbortSignal,
  ): Promise<FreeFrameObservation>;
  analyzeVerified(
    request: VerifiedVisionFrameRequest,
    signal?: AbortSignal,
  ): Promise<WallPassFrameObservation>;
  freeProvenance: FreeAnalysisProvenance;
  verifiedProvenance: VerifiedAnalysisProvenance;
}>;

export type DemoFixtureSelection = Readonly<{
  free: "free-well-framed-active-v1" | "free-limited-ball-v1";
  verified: "wall-pass-balanced-v1" | "wall-pass-insufficient-v1";
}>;

export function createDemoVisionProvider(
  selection: DemoFixtureSelection = {
    free: "free-well-framed-active-v1",
    verified: "wall-pass-balanced-v1",
  },
): VisionProvider {
  const freeProvenance = Object.freeze({
    kind: "demo" as const,
    fixtureId: selection.free,
    providerVersion: "demo-observations-v1" as const,
  });
  const verifiedProvenance = Object.freeze({
    kind: "demo" as const,
    fixtureId: selection.verified,
    providerVersion: "demo-observations-v1" as const,
  });
  return Object.freeze({
    freeProvenance,
    verifiedProvenance,
    async analyzeFree(input) {
      const request = FreeVisionFrameRequestSchema.parse(input);
      const athlete = boxFor(request.frame, 0.2, 0.18, 0.55, 0.9, 0.91);
      const ball =
        selection.free === "free-limited-ball-v1" &&
        request.frame.index % 3 !== 0
          ? undefined
          : boxFor(request.frame, 0.58, 0.58, 0.66, 0.68, 0.82);
      return FreeFrameObservationSchema.parse({
        kind: "free-training" as const,
        frameIndex: request.frame.index,
        timestampMs: request.frame.timestampMs,
        sourceWidth: request.frame.sourceWidth,
        sourceHeight: request.frame.sourceHeight,
        athlete,
        ...(ball ? { ball } : {}),
      });
    },
    async analyzeVerified(input) {
      const request = VerifiedVisionFrameRequestSchema.parse(input);
      const frame = request.frame;
      const corners = cornerPoints(frame);
      const feet = [
        pointFor(frame, "left" as const, 0.41, 0.76, 0.9),
        pointFor(frame, "right" as const, 0.51, 0.76, 0.9),
      ];
      const ball = boxFor(frame, 0.47, 0.67, 0.53, 0.73, 0.88);
      return WallPassFrameObservationSchema.parse({
        kind: "verified-wall-pass" as const,
        frameIndex: frame.index,
        timestampMs: frame.timestampMs,
        sourceWidth: frame.sourceWidth,
        sourceHeight: frame.sourceHeight,
        athlete: boxFor(frame, 0.25, 0.16, 0.7, 0.92, 0.93),
        ball,
        feet,
        fiducialCorners: corners,
        wallFloorEdge: {
          x1: 0,
          y1: frame.sourceHeight * 0.27,
          x2: frame.sourceWidth,
          y2: frame.sourceHeight * 0.27,
          confidence: 0.94,
        },
      });
    },
  });
}

export type RoboflowVisionConfig = Readonly<{
  apiUrl: string;
  workspaceId: string;
  apiKey?: string;
  freeModelBundleId: string;
  verifiedModelBundleId: string;
  freeProviderVersion: string;
  verifiedProviderVersion: string;
}>;

export function createRoboflowVisionProvider(
  input: Readonly<{
    config: RoboflowVisionConfig;
    fetch: ProviderFetch;
    transformer: FrameTransformer;
  }>,
): VisionProvider {
  const config = validateRoboflowConfig(input.config);
  const freeProvenance = Object.freeze({
    kind: "roboflow" as const,
    workspaceId: config.workspaceId,
    workflowId: "revelai-free-training-v1" as const,
    workflowVersion: "1.0.0" as const,
    modelBundleId: config.freeModelBundleId,
    providerVersion: config.freeProviderVersion,
  });
  const verifiedProvenance = Object.freeze({
    kind: "roboflow" as const,
    workspaceId: config.workspaceId,
    workflowId: "revelai-wall-pass-geometry-v1" as const,
    workflowVersion: "1.0.0" as const,
    modelBundleId: config.verifiedModelBundleId,
    providerVersion: config.verifiedProviderVersion,
  });
  return Object.freeze({
    freeProvenance,
    verifiedProvenance,
    async analyzeFree(inputRequest, signal) {
      const request = FreeVisionFrameRequestSchema.parse(inputRequest);
      const normalized = await runWorkflow({
        request,
        config,
        fetch: input.fetch,
        transformer: input.transformer,
        signal,
        workflowId: "revelai-free-training-v1",
        modelBundleId: config.freeModelBundleId,
        providerVersion: config.freeProviderVersion,
      });
      if (normalized.kind !== "free-training-v1")
        throw new VisionProviderError("provider_output_invalid");
      return normalized.observation;
    },
    async analyzeVerified(inputRequest, signal) {
      const request = VerifiedVisionFrameRequestSchema.parse(inputRequest);
      const normalized = await runWorkflow({
        request,
        config,
        fetch: input.fetch,
        transformer: input.transformer,
        signal,
        workflowId: "revelai-wall-pass-geometry-v1",
        modelBundleId: config.verifiedModelBundleId,
        providerVersion: config.verifiedProviderVersion,
      });
      if (normalized.kind !== "wall-pass-geometry-v1")
        throw new VisionProviderError("provider_output_invalid");
      return normalized.observation;
    },
  });
}

export class VisionProviderError extends Error {
  public constructor(
    public readonly code:
      | "provider_configuration_invalid"
      | "provider_temporary_unavailable"
      | "provider_output_invalid",
  ) {
    super(code);
    this.name = "VisionProviderError";
  }
}

export async function analyzeBatch(
  provider: VisionProvider,
  requests: readonly VisionFrameRequest[],
  scheduler: VisionBatchScheduler = new VisionBatchScheduler(),
): Promise<FreeVisionObservationBatch | VerifiedVisionObservationBatch> {
  const first = requests[0];
  if (!first) throw new VisionProviderError("provider_output_invalid");
  const attemptId = first.attemptId;
  if (
    requests.some(
      (request) =>
        request.kind !== first.kind || request.attemptId !== attemptId,
    )
  )
    throw new VisionProviderError("provider_output_invalid");
  if (first.kind === "free-training") {
    const frames = await scheduler.run(requests, (request, signal) => {
      const parsed = FreeVisionFrameRequestSchema.parse(request);
      return provider.analyzeFree(parsed, signal);
    });
    assertFrameCorrelation(requests, frames);
    return FreeVisionObservationBatchSchema.parse({
      attemptId,
      kind: first.kind,
      frames,
      provenance: provider.freeProvenance,
    });
  }
  const frames = await scheduler.run(requests, (request, signal) => {
    const parsed = VerifiedVisionFrameRequestSchema.parse(request);
    return provider.analyzeVerified(parsed, signal);
  });
  assertFrameCorrelation(requests, frames);
  return VerifiedVisionObservationBatchSchema.parse({
    attemptId,
    kind: first.kind,
    frames,
    provenance: provider.verifiedProvenance,
  });
}

function assertFrameCorrelation(
  requests: readonly VisionFrameRequest[],
  observations: readonly Readonly<{
    frameIndex: number;
    timestampMs: number;
    sourceWidth: number;
    sourceHeight: number;
  }>[],
): void {
  if (requests.length !== observations.length)
    throw new VisionProviderError("provider_output_invalid");
  for (const [index, request] of requests.entries()) {
    const observation = observations[index]!;
    const frame = request.frame;
    if (
      observation.frameIndex !== frame.index ||
      observation.timestampMs !== frame.timestampMs ||
      observation.sourceWidth !== frame.sourceWidth ||
      observation.sourceHeight !== frame.sourceHeight
    )
      throw new VisionProviderError("provider_output_invalid");
  }
}

async function runWorkflow(
  input: Readonly<{
    request: VisionFrameRequest;
    config: Required<RoboflowVisionConfig>;
    fetch: ProviderFetch;
    transformer: FrameTransformer;
    signal?: AbortSignal;
    workflowId: "revelai-free-training-v1" | "revelai-wall-pass-geometry-v1";
    modelBundleId: string;
    providerVersion: string;
  }>,
): Promise<
  | Readonly<{ kind: "free-training-v1"; observation: FreeFrameObservation }>
  | Readonly<{
      kind: "wall-pass-geometry-v1";
      observation: WallPassFrameObservation;
    }>
> {
  const transform = createLetterboxTransform(input.request.frame);
  const jpeg = await input.transformer.transform(
    input.request.frame,
    transform,
  );
  if (!(jpeg instanceof Uint8Array) || jpeg.byteLength === 0)
    throw new VisionProviderError("provider_output_invalid");
  const controller = new AbortController();
  const abort = () => controller.abort();
  input.signal?.addEventListener("abort", abort, { once: true });
  try {
    const body = {
      ...(input.config.apiKey ? { api_key: input.config.apiKey } : {}),
      inputs: {
        image: { type: "base64", value: Buffer.from(jpeg).toString("base64") },
      },
    };
    const response = await input.fetch(
      `${input.config.apiUrl}/infer/workflows/${encodeURIComponent(input.config.workspaceId)}/${input.workflowId}`,
      {
        method: "POST",
        headers: Object.freeze({
          "content-type": "application/json",
          accept: "application/json",
        }),
        body: JSON.stringify(body),
        signal: controller.signal,
      },
    );
    if (response.status < 200 || response.status > 299)
      throw new VisionProviderError(
        retryableHttpStatus(response.status)
          ? "provider_temporary_unavailable"
          : "provider_output_invalid",
      );
    let responseBody: unknown;
    try {
      responseBody = await response.json();
    } catch {
      throw new VisionProviderError("provider_output_invalid");
    }
    const envelope = WorkflowEnvelopeSchema.safeParse(responseBody);
    if (!envelope.success)
      throw new VisionProviderError("provider_output_invalid");
    const output = envelope.data.outputs[0];
    if (
      output.kind !== expectedOutputKind(input.workflowId) ||
      output.workflow.id !== input.workflowId ||
      output.workflow.version !== "1.0.0" ||
      output.workflow.modelBundleId !== input.modelBundleId ||
      output.workflow.providerVersion !== input.providerVersion
    )
      throw new VisionProviderError("provider_output_invalid");
    return normalizeWorkflowOutput(input.request.frame, transform, output);
  } catch (error) {
    if (error instanceof VisionProviderError) throw error;
    throw new VisionProviderError("provider_temporary_unavailable");
  } finally {
    input.signal?.removeEventListener("abort", abort);
  }
}

function normalizeWorkflowOutput(
  frame: SourceFrame,
  transform: LetterboxTransform,
  output: ReturnType<typeof WorkflowEnvelopeSchema.parse>["outputs"][0],
):
  | Readonly<{ kind: "free-training-v1"; observation: FreeFrameObservation }>
  | Readonly<{
      kind: "wall-pass-geometry-v1";
      observation: WallPassFrameObservation;
    }> {
  const detections = uniqueByClass(output.detections, "detection");
  const athlete = detections.get("athlete");
  const ball = detections.get("ball");
  const common = {
    frameIndex: frame.index,
    timestampMs: frame.timestampMs,
    sourceWidth: frame.sourceWidth,
    sourceHeight: frame.sourceHeight,
    ...(athlete ? { athlete: mapBox(athlete, transform) } : {}),
    ...(ball ? { ball: mapBox(ball, transform) } : {}),
  };
  if (output.kind === "free-training-v1")
    return Object.freeze({
      kind: output.kind,
      observation: FreeFrameObservationSchema.parse({
        kind: "free-training",
        ...common,
      }),
    });
  const feet = uniqueByClass(output.keypoints, "foot");
  const corners = uniqueByClass(output.fiducials, "fiducial");
  if (
    !feet.has("left_foot") ||
    !feet.has("right_foot") ||
    FIDUCIAL_CORNER_IDS.some((id) => !corners.has(id))
  )
    throw new VisionProviderError("provider_output_invalid");
  const edgeStart = inverseInferencePoint(
    {
      x: output.geometry.wallFloorEdge.x1,
      y: output.geometry.wallFloorEdge.y1,
    },
    transform,
  );
  const edgeEnd = inverseInferencePoint(
    {
      x: output.geometry.wallFloorEdge.x2,
      y: output.geometry.wallFloorEdge.y2,
    },
    transform,
  );
  return Object.freeze({
    kind: output.kind,
    observation: WallPassFrameObservationSchema.parse({
      kind: "verified-wall-pass",
      ...common,
      feet: [
        mapPoint(feet.get("left_foot")!, transform, { side: "left" }),
        mapPoint(feet.get("right_foot")!, transform, { side: "right" }),
      ],
      fiducialCorners: FIDUCIAL_CORNER_IDS.map((id) =>
        mapPoint(corners.get(id)!, transform, { id }),
      ),
      wallFloorEdge: {
        x1: edgeStart.x,
        y1: edgeStart.y,
        x2: edgeEnd.x,
        y2: edgeEnd.y,
        confidence: output.geometry.wallFloorEdge.confidence,
      },
    }),
  });
}

function mapBox(
  box: Readonly<{
    xMin: number;
    yMin: number;
    xMax: number;
    yMax: number;
    confidence: number;
  }>,
  transform: LetterboxTransform,
) {
  const topLeft = inverseInferencePoint(
    { x: box.xMin, y: box.yMin },
    transform,
  );
  const bottomRight = inverseInferencePoint(
    { x: box.xMax, y: box.yMax },
    transform,
  );
  return Object.freeze({
    xMin: topLeft.x,
    yMin: topLeft.y,
    xMax: bottomRight.x,
    yMax: bottomRight.y,
    confidence: box.confidence,
  });
}

function mapPoint<T extends Record<string, string>>(
  point: Readonly<{ x: number; y: number; confidence: number }>,
  transform: LetterboxTransform,
  extras: T,
) {
  return Object.freeze({
    ...extras,
    ...inverseInferencePoint(point, transform),
    confidence: point.confidence,
  });
}

function uniqueByClass<T extends Readonly<{ class: string }>>(
  values: readonly T[],
  label: string,
): ReadonlyMap<string, T> {
  const result = new Map<string, T>();
  for (const value of values) {
    if (result.has(value.class))
      throw new VisionProviderError("provider_output_invalid");
    result.set(value.class, value);
  }
  if (result.size !== values.length)
    throw new VisionProviderError("provider_output_invalid");
  void label;
  return result;
}

function validateRoboflowConfig(
  config: RoboflowVisionConfig,
): Required<RoboflowVisionConfig> {
  const apiUrl = new URL(config.apiUrl);
  const loopback =
    apiUrl.hostname === "127.0.0.1" ||
    apiUrl.hostname === "localhost" ||
    apiUrl.hostname === "::1";
  if (
    (apiUrl.protocol !== "https:" && (!loopback || config.apiKey)) ||
    apiUrl.search ||
    apiUrl.hash
  )
    throw new VisionProviderError("provider_configuration_invalid");
  const values = [
    config.workspaceId,
    config.freeModelBundleId,
    config.verifiedModelBundleId,
    config.freeProviderVersion,
    config.verifiedProviderVersion,
  ];
  if (values.some((value) => value.trim().length === 0))
    throw new VisionProviderError("provider_configuration_invalid");
  return Object.freeze({
    ...config,
    apiUrl: config.apiUrl.replace(/\/$/, ""),
    apiKey: config.apiKey ?? "",
  });
}

function retryableHttpStatus(status: number): boolean {
  return [408, 429, 500, 502, 503, 504].includes(status);
}

function expectedOutputKind(
  workflowId: string,
): "free-training-v1" | "wall-pass-geometry-v1" {
  return workflowId === "revelai-free-training-v1"
    ? "free-training-v1"
    : "wall-pass-geometry-v1";
}

function boxFor(
  frame: SourceFrame,
  xMin: number,
  yMin: number,
  xMax: number,
  yMax: number,
  confidence: number,
) {
  return Object.freeze({
    xMin: frame.sourceWidth * xMin,
    yMin: frame.sourceHeight * yMin,
    xMax: frame.sourceWidth * xMax,
    yMax: frame.sourceHeight * yMax,
    confidence,
  });
}

function pointFor(
  frame: SourceFrame,
  side: "left" | "right",
  x: number,
  y: number,
  confidence: number,
) {
  return Object.freeze({
    side,
    x: frame.sourceWidth * x,
    y: frame.sourceHeight * y,
    confidence,
  });
}

function cornerPoints(frame: SourceFrame) {
  const locations = [
    [0.2, 0.26],
    [0.28, 0.26],
    [0.28, 0.36],
    [0.2, 0.36],
    [0.72, 0.26],
    [0.8, 0.26],
    [0.8, 0.36],
    [0.72, 0.36],
  ] as const;
  return Object.freeze(
    FIDUCIAL_CORNER_IDS.map((id, index) =>
      Object.freeze({
        id,
        x: frame.sourceWidth * locations[index]![0],
        y: frame.sourceHeight * locations[index]![1],
        confidence: 0.92,
      }),
    ),
  );
}
