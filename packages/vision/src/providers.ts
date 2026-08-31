import type {
  FreeAnalysisProvenance,
  VerifiedAnalysisProvenance,
} from "@revelai/contracts";
import { createHash } from "node:crypto";
import {
  assertInferenceJpeg,
  createLetterboxTransform,
  encodeInferenceFrame,
  inverseInferencePoint,
  sameLetterboxTransform,
  type EncodedInferenceFrame,
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
    signal?: AbortSignal,
  ): Promise<EncodedInferenceFrame>;
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

const defaultFrameTransformer: FrameTransformer = Object.freeze({
  async transform(frame, expected, signal) {
    const encoded = encodeInferenceFrame(frame, signal);
    if (!sameLetterboxTransform(encoded.transform, expected))
      throw new VisionProviderError("provider_output_invalid");
    return encoded;
  },
});

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

/**
 * Opaque factory-owned receipt for the operator-only benchmark runner. Its
 * identity is registered in a module-private WeakMap; a structural
 * VisionProvider or caller-authored observation cannot manufacture one.
 */
export type OwnedRoboflowBenchmarkFrame = Readonly<{
  observation: WallPassFrameObservation;
}>;

export type OwnedRoboflowBenchmarkFrameIdentity = Readonly<{
  frameIndex: number;
  sourceSha256: string;
  encodedSha256: string;
}>;

type OwnedBenchmarkRunner = (
  request: VerifiedVisionFrameRequest,
  signal?: AbortSignal,
) => Promise<OwnedRoboflowBenchmarkFrame>;

const ownedBenchmarkRunners = new WeakMap<
  VisionProvider,
  OwnedBenchmarkRunner
>();
const ownedBenchmarkFrameIdentities = new WeakMap<
  OwnedRoboflowBenchmarkFrame,
  OwnedRoboflowBenchmarkFrameIdentity
>();

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
      const phase = request.frame.index % 10;
      const athlete = boxFor(
        request.frame,
        0.08 + phase * 0.06,
        0.18,
        0.28 + phase * 0.06,
        0.9,
        0.91,
      );
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
      if (selection.verified === "wall-pass-insufficient-v1")
        return WallPassFrameObservationSchema.parse({
          kind: "verified-wall-pass" as const,
          frameIndex: frame.index,
          timestampMs: frame.timestampMs,
          sourceWidth: frame.sourceWidth,
          sourceHeight: frame.sourceHeight,
          feet: [],
          fiducialCorners: [],
        });
      const activeIndex = frame.index - 40;
      const active = activeIndex >= 0 && activeIndex < 600;
      const phase = activeIndex >= 0 ? activeIndex % 5 : 0;
      const contact =
        active && activeIndex < 597 && (phase === 0 || phase === 1);
      const ballY =
        !active || activeIndex >= 597
          ? undefined
          : phase === 0 || phase === 1
            ? 530
            : phase === 2
              ? 100
              : phase === 3
                ? 10
                : 40;
      const side = Math.floor(activeIndex / 5) % 2 === 0 ? "left" : "right";
      const feet =
        contact && ballY !== undefined
          ? [pointAt(frame, side, 515, ballY, 0.9)]
          : [];
      return WallPassFrameObservationSchema.parse({
        kind: "verified-wall-pass" as const,
        frameIndex: frame.index,
        timestampMs: frame.timestampMs,
        sourceWidth: frame.sourceWidth,
        sourceHeight: frame.sourceHeight,
        athlete: boxAt(frame, 400, 100, 800, 650, 0.93),
        ...(ballY === undefined
          ? {}
          : {
              ball: boxAt(
                frame,
                500,
                Math.max(0, ballY - 15),
                530,
                ballY,
                0.88,
              ),
            }),
        feet,
        fiducialCorners: calibratedCornerPoints(),
        wallFloorEdge: {
          x1: 0,
          y1: 0,
          x2: 800,
          y2: 0,
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
    transformer?: FrameTransformer;
  }>,
): VisionProvider {
  const config = validateRoboflowConfig(input.config);
  const validatedEncodedJpegs = new Set<string>();
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
  const runFree = async (
    inputRequest: FreeVisionFrameRequest,
    signal?: AbortSignal,
  ) => {
    const request = FreeVisionFrameRequestSchema.parse(inputRequest);
    const normalized = await runWorkflow({
      request,
      config,
      fetch: input.fetch,
      transformer: input.transformer ?? defaultFrameTransformer,
      validatedEncodedJpegs,
      signal,
      workflowId: "revelai-free-training-v1",
      modelBundleId: config.freeModelBundleId,
      providerVersion: config.freeProviderVersion,
    });
    if (normalized.kind !== "free-training-v1")
      throw new VisionProviderError("provider_output_invalid");
    return normalized;
  };
  const runVerified = async (
    inputRequest: VerifiedVisionFrameRequest,
    signal?: AbortSignal,
  ) => {
    const request = VerifiedVisionFrameRequestSchema.parse(inputRequest);
    const normalized = await runWorkflow({
      request,
      config,
      fetch: input.fetch,
      transformer: input.transformer ?? defaultFrameTransformer,
      validatedEncodedJpegs,
      signal,
      workflowId: "revelai-wall-pass-geometry-v1",
      modelBundleId: config.verifiedModelBundleId,
      providerVersion: config.verifiedProviderVersion,
    });
    if (normalized.kind !== "wall-pass-geometry-v1")
      throw new VisionProviderError("provider_output_invalid");
    return normalized;
  };
  const provider: VisionProvider = {
    freeProvenance,
    verifiedProvenance,
    async analyzeFree(inputRequest, signal) {
      return (await runFree(inputRequest, signal)).observation;
    },
    async analyzeVerified(inputRequest, signal) {
      return (await runVerified(inputRequest, signal)).observation;
    },
  };
  const frozenProvider = Object.freeze(provider);
  ownedBenchmarkRunners.set(frozenProvider, async (request, signal) => {
    const normalized = await runVerified(request, signal);
    const receipt: OwnedRoboflowBenchmarkFrame = Object.freeze({
      observation: normalized.observation,
    });
    ownedBenchmarkFrameIdentities.set(
      receipt,
      Object.freeze({
        frameIndex: request.frame.index,
        sourceSha256: createHash("sha256")
          .update(request.frame.jpeg)
          .digest("hex"),
        encodedSha256: normalized.encoded.sha256,
      }),
    );
    return receipt;
  });
  return frozenProvider;
}

export async function analyzeOwnedRoboflowBenchmarkFrame(
  provider: VisionProvider,
  request: VerifiedVisionFrameRequest,
  signal?: AbortSignal,
): Promise<OwnedRoboflowBenchmarkFrame> {
  const runner = ownedBenchmarkRunners.get(provider);
  if (!runner) throw new VisionProviderError("provider_output_invalid");
  return runner(VerifiedVisionFrameRequestSchema.parse(request), signal);
}

export function ownedRoboflowBenchmarkFrameIdentity(
  frame: OwnedRoboflowBenchmarkFrame,
): OwnedRoboflowBenchmarkFrameIdentity {
  const identity = ownedBenchmarkFrameIdentities.get(frame);
  if (!identity) throw new VisionProviderError("provider_output_invalid");
  return identity;
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
  signal?: AbortSignal,
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
    const frames = await scheduler.run(
      requests,
      (request, requestSignal) => {
        const parsed = FreeVisionFrameRequestSchema.parse(request);
        return provider.analyzeFree(parsed, requestSignal);
      },
      signal,
    );
    assertFrameCorrelation(requests, frames);
    return parseFreeObservationBatch({
      attemptId,
      kind: first.kind,
      frames,
      provenance: provider.freeProvenance,
    });
  }
  const frames = await scheduler.run(
    requests,
    (request, requestSignal) => {
      const parsed = VerifiedVisionFrameRequestSchema.parse(request);
      return provider.analyzeVerified(parsed, requestSignal);
    },
    signal,
  );
  assertFrameCorrelation(requests, frames);
  return parseVerifiedObservationBatch({
    attemptId,
    kind: first.kind,
    frames,
    provenance: provider.verifiedProvenance,
  });
}

function parseFreeObservationBatch(input: unknown): FreeVisionObservationBatch {
  const parsed = FreeVisionObservationBatchSchema.safeParse(input);
  if (!parsed.success) throw new VisionProviderError("provider_output_invalid");
  return parsed.data;
}

function parseVerifiedObservationBatch(
  input: unknown,
): VerifiedVisionObservationBatch {
  const parsed = VerifiedVisionObservationBatchSchema.safeParse(input);
  if (!parsed.success) throw new VisionProviderError("provider_output_invalid");
  return parsed.data;
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

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted)
    throw new VisionProviderError("provider_temporary_unavailable");
}

function assertEncodedInferenceFrame(
  encoded: EncodedInferenceFrame,
  expectedTransform: LetterboxTransform,
  validatedEncodedJpegs: Set<string>,
): void {
  if (
    !encoded ||
    !(encoded.jpeg instanceof Uint8Array) ||
    !/^[a-f0-9]{64}$/.test(encoded.sha256) ||
    encoded.sha256 !==
      createHash("sha256").update(encoded.jpeg).digest("hex") ||
    !sameLetterboxTransform(encoded.transform, expectedTransform)
  )
    throw new VisionProviderError("provider_output_invalid");
  if (!validatedEncodedJpegs.has(encoded.sha256)) {
    try {
      assertInferenceJpeg(encoded.jpeg);
    } catch {
      throw new VisionProviderError("provider_output_invalid");
    }
    rememberValidatedJpeg(validatedEncodedJpegs, encoded.sha256);
  }
}

function rememberValidatedJpeg(cache: Set<string>, sha256: string): void {
  cache.add(sha256);
  if (cache.size > 128) cache.delete(cache.values().next().value!);
}

async function runWorkflow(
  input: Readonly<{
    request: VisionFrameRequest;
    config: Required<RoboflowVisionConfig>;
    fetch: ProviderFetch;
    transformer: FrameTransformer;
    validatedEncodedJpegs: Set<string>;
    signal?: AbortSignal;
    workflowId: "revelai-free-training-v1" | "revelai-wall-pass-geometry-v1";
    modelBundleId: string;
    providerVersion: string;
  }>,
): Promise<
  | Readonly<{
      kind: "free-training-v1";
      observation: FreeFrameObservation;
      encoded: EncodedInferenceFrame;
    }>
  | Readonly<{
      kind: "wall-pass-geometry-v1";
      observation: WallPassFrameObservation;
      encoded: EncodedInferenceFrame;
    }>
> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (input.signal?.aborted) controller.abort();
  else input.signal?.addEventListener("abort", abort, { once: true });
  try {
    assertNotAborted(controller.signal);
    const transform = createLetterboxTransform(input.request.frame);
    const encoded = await input.transformer.transform(
      input.request.frame,
      transform,
      controller.signal,
    );
    assertNotAborted(controller.signal);
    assertEncodedInferenceFrame(
      encoded,
      transform,
      input.validatedEncodedJpegs,
    );
    const body = {
      ...(input.config.apiKey ? { api_key: input.config.apiKey } : {}),
      inputs: {
        image: {
          type: "base64",
          value: Buffer.from(encoded.jpeg).toString("base64"),
        },
      },
    };
    assertNotAborted(controller.signal);
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
    return Object.freeze({
      ...normalizeWorkflowOutput(input.request.frame, encoded, output),
      encoded,
    });
  } catch (error) {
    if (error instanceof VisionProviderError) throw error;
    if (controller.signal.aborted || isRetryableTransportError(error))
      throw new VisionProviderError("provider_temporary_unavailable");
    throw new VisionProviderError("provider_output_invalid");
  } finally {
    input.signal?.removeEventListener("abort", abort);
  }
}

function isRetryableTransportError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code =
    "code" in error && typeof error.code === "string" ? error.code : error.name;
  return ["ECONNRESET", "ETIMEDOUT", "ECONNABORTED"].includes(code);
}

function normalizeWorkflowOutput(
  frame: SourceFrame,
  encoded: EncodedInferenceFrame,
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
    inference: Object.freeze({
      sha256: encoded.sha256,
      transform: encoded.transform,
    }),
    ...(athlete ? { athlete: mapBox(athlete, encoded.transform) } : {}),
    ...(ball ? { ball: mapBox(ball, encoded.transform) } : {}),
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
    encoded.transform,
  );
  const edgeEnd = inverseInferencePoint(
    {
      x: output.geometry.wallFloorEdge.x2,
      y: output.geometry.wallFloorEdge.y2,
    },
    encoded.transform,
  );
  return Object.freeze({
    kind: output.kind,
    observation: WallPassFrameObservationSchema.parse({
      kind: "verified-wall-pass",
      ...common,
      feet: [
        mapPoint(feet.get("left_foot")!, encoded.transform, { side: "left" }),
        mapPoint(feet.get("right_foot")!, encoded.transform, { side: "right" }),
      ],
      fiducialCorners: FIDUCIAL_CORNER_IDS.map((id) =>
        mapPoint(corners.get(id)!, encoded.transform, { id }),
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

function pointAt(
  frame: SourceFrame,
  side: "left" | "right",
  x: number,
  y: number,
  confidence: number,
) {
  if (x < 0 || x > frame.sourceWidth || y < 0 || y > frame.sourceHeight)
    throw new VisionProviderError("provider_output_invalid");
  return Object.freeze({ side, x, y, confidence });
}

function boxAt(
  frame: SourceFrame,
  xMin: number,
  yMin: number,
  xMax: number,
  yMax: number,
  confidence: number,
) {
  if (
    xMin < 0 ||
    yMin < 0 ||
    xMax > frame.sourceWidth ||
    yMax > frame.sourceHeight
  )
    throw new VisionProviderError("provider_output_invalid");
  return Object.freeze({ xMin, yMin, xMax, yMax, confidence });
}

function calibratedCornerPoints() {
  return Object.freeze(
    FIDUCIAL_CORNER_IDS.map((id) =>
      Object.freeze({
        id,
        x: (DEMO_WORLD_CORNERS[id]!.x + 3) * 100,
        y: DEMO_WORLD_CORNERS[id]!.y * 100,
        confidence: 0.92,
      }),
    ),
  );
}

const DEMO_WORLD_CORNERS = Object.freeze({
  "a-top-left": Object.freeze({ x: -1.6, y: 2.9 }),
  "a-top-right": Object.freeze({ x: -1.4, y: 2.9 }),
  "a-bottom-right": Object.freeze({ x: -1.4, y: 3.1 }),
  "a-bottom-left": Object.freeze({ x: -1.6, y: 3.1 }),
  "b-top-left": Object.freeze({ x: 1.4, y: 2.9 }),
  "b-top-right": Object.freeze({ x: 1.6, y: 2.9 }),
  "b-bottom-right": Object.freeze({ x: 1.6, y: 3.1 }),
  "b-bottom-left": Object.freeze({ x: 1.4, y: 3.1 }),
});
