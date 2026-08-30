# ADR 0002: Vision observations and deterministic scoring

- Status: Accepted
- Date: 2026-08-30

## Context

Computer-vision predictions are probabilistic, while competitive results must be explainable, versioned, repeatable, and testable. Free Training must remain useful without accidentally inheriting the verified challenge's calibration or score rules. MVP must work without pretending fixture data came from real inference.

## Decision

The API owns four stages. The provider owns only the second one.

1. `MediaPipeline` probes a verified or Free asset, extracts JPEGs, and supplies per-frame bytes plus source dimensions. It never passes an original-video path to a provider.
2. A `VisionProvider` accepts either a verified wall-pass frame or a Free Training frame and returns canonical observations plus provenance only. It has no integrity verdict, retry code, score, ranking, eligibility, result, or policy field.
3. API-owned assemblers make tracks/evidence. `WallPassObservationAssembler` derives calibrated contacts and wall impacts; `FreeInsightAssembler` derives approximate visibility/activity observations. `IntegrityEvaluator` maps verified evidence to safe public invalid codes.
4. Versioned domain rules score verified evidence. API-owned `CompetitiveEligibilityPolicy` may then write a leaderboard fact. Free Analysis is structurally unable to import score, ranking, policy, or leaderboard repositories.

### Canonical request, provenance, and observation types

All transport implementations use equivalent Zod schemas and inferred types. The conceptual types are:

```ts
type FreeAnalysisProvenance =
  | {
      kind: "demo";
      fixtureId: "free-well-framed-active-v1" | "free-limited-ball-v1";
      providerVersion: "demo-observations-v1";
    }
  | {
      kind: "roboflow";
      workspaceId: string;
      workflowId: "revelai-free-training-v1";
      workflowVersion: "1.0.0";
      modelBundleId: string;
      providerVersion: string;
    };

type VerifiedAnalysisProvenance =
  | {
      kind: "demo";
      fixtureId: "wall-pass-balanced-v1" | "wall-pass-insufficient-v1";
      providerVersion: "demo-observations-v1";
    }
  | {
      kind: "roboflow";
      workspaceId: string;
      workflowId: "revelai-wall-pass-geometry-v1";
      workflowVersion: "1.0.0";
      modelBundleId: string;
      providerVersion: string;
    };

type AnalysisProvenance = FreeAnalysisProvenance | VerifiedAnalysisProvenance;

type SourceFrame = {
  index: number;
  timestampMs: number;
  sourceWidth: number;
  sourceHeight: number;
  jpeg: Uint8Array;
};

type VerifiedVisionFrameRequest = {
  kind: "verified-wall-pass";
  attemptId: string;
  challenge: { id: "wall-pass"; version: 1 };
  frame: SourceFrame;
};

type FreeVisionFrameRequest = {
  kind: "free-training";
  attemptId: string;
  frame: SourceFrame;
};

type VisionFrameRequest = VerifiedVisionFrameRequest | FreeVisionFrameRequest;

type Box = { xMin: number; yMin: number; xMax: number; yMax: number; confidence: number };

type FreeFrameObservation = {
  kind: "free-training";
  frameIndex: number;
  timestampMs: number;
  sourceWidth: number;
  sourceHeight: number;
  athlete?: Box;
  ball?: Box;
};

type FiducialCornerId =
  | "a-top-left" | "a-top-right" | "a-bottom-right" | "a-bottom-left"
  | "b-top-left" | "b-top-right" | "b-bottom-right" | "b-bottom-left";

type WallPassFrameObservation = {
  kind: "verified-wall-pass";
  frameIndex: number;
  timestampMs: number;
  sourceWidth: number;
  sourceHeight: number;
  athlete?: Box;
  ball?: Box;
  feet: Array<{ side: "left" | "right"; x: number; y: number; confidence: number }>;
  fiducialCorners: Array<{ id: FiducialCornerId; x: number; y: number; confidence: number }>;
  wallFloorEdge?: { x1: number; y1: number; x2: number; y2: number; confidence: number };
};

type FreeVisionObservationBatch = {
  attemptId: string;
  kind: "free-training";
  frames: FreeFrameObservation[];
  provenance: FreeAnalysisProvenance;
};

type VerifiedVisionObservationBatch = {
  attemptId: string;
  kind: "verified-wall-pass";
  frames: WallPassFrameObservation[];
  provenance: VerifiedAnalysisProvenance;
};

type VisionObservationBatch = FreeVisionObservationBatch | VerifiedVisionObservationBatch;
```

`AnalysisProvenance` and `VisionObservationBatch` are nested Zod discriminated unions, not independently unioned fields: a Free batch may contain only Free frames and either a Free demo fixture or `revelai-free-training-v1` provenance; a verified batch may contain only wall-pass frames and either a wall-pass demo fixture or `revelai-wall-pass-geometry-v1` provenance. The parsed Workflow output kind and ID must match that selected branch before batch construction. Demo requires `fixtureId` and forbids Roboflow fields; Roboflow requires `workspaceId`, workflow ID/version, `modelBundleId`, and `providerVersion`, and forbids `fixtureId`. `workflowVersion` and `modelBundleId` are configuration values checked against the response, never nullable/optional guesses. Compile-time `satisfies` fixtures and Zod tests reject mixed frame arrays, a cross-kind frame, or Free/verified provenance or Workflow-output IDs on the wrong branch. The API evaluates demo provenance as ineligible; a provider never emits `competitiveEligible`.

### Concrete Roboflow Workflow HTTP dialect

Real inference uses named Workflows, not a generic object-detection endpoint:

| Analysis kind | Required workflow ID | Required output kind | Required model bundle config |
| --- | --- | --- | --- |
| verified wall pass | `revelai-wall-pass-geometry-v1` | `wall-pass-geometry-v1` | `ROBOFLOW_WALL_PASS_MODEL_BUNDLE_ID` |
| Free Training | `revelai-free-training-v1` | `free-training-v1` | `ROBOFLOW_FREE_MODEL_BUNDLE_ID` |

The server configuration also requires `ROBOFLOW_API_URL`, `ROBOFLOW_WORKSPACE_ID`, the selected workflow ID, and exact workflow version `1.0.0`. A real configuration is rejected at startup until all values exist. The endpoint is exactly:

```text
POST {ROBOFLOW_API_URL}/infer/workflows/{ROBOFLOW_WORKSPACE_ID}/{WORKFLOW_ID}
Content-Type: application/json
Accept: application/json
```

For every transformed JPEG, the JSON body is exactly the following. `api_key` is omitted, not set to null, for a keyless local public workflow. There is no `Authorization` header and no query-string credential.

```json
{
  "api_key": "<server-only optional key>",
  "inputs": {
    "image": { "type": "base64", "value": "<base64 JPEG without data: prefix>" }
  }
}
```

This is the documented Workflow HTTP shape for the Roboflow Inference server/hosted API. The API is allowed to use loopback HTTP only for a keyless local server; an external/key-bearing endpoint follows ADR 0001's HTTPS rule. It never sends URLs, multipart bodies, original paths, or client credentials. The adapter logs only attempt ID, frame index, status class, and elapsed time.

Before encoding, `MediaPipeline` rotates the decoded source into display orientation then letterboxes it to an inference JPEG of exactly `1280×720`. For source `W×H`, it uses `s = min(1280/W, 720/H)`, `scaledW = roundHalfUp(W×s)`, `scaledH = roundHalfUp(H×s)`, `padLeft = floor((1280-scaledW)/2)`, and `padTop = floor((720-scaledH)/2)`; right/bottom receive the remainder. The Workflow response is always in `inference_pixels` on that `1280×720` image. The adapter maps every point back to source-display coordinates by `(x-padLeft)/s, (y-padTop)/s`, rejects a required point more than one pixel outside the scaled content rectangle, then clips the accepted result to the source image. Box corners use that same inverse transform. Fixtures cover 1920×1080 (no pad) and 1440×1080 (left/right padding).

The Workflow response is parsed before normalization by this exact discriminated Zod shape (numeric coordinates are finite; boxes require `0 <= xMin < xMax <= 1280`, `0 <= yMin < yMax <= 720`; points/line endpoints are within those inclusive bounds):

```ts
type WorkflowEnvelope = {
  outputs: [WorkflowOutput];
};

type WorkflowCommon = {
  image: { width: 1280; height: 720; coordinateSystem: "inference_pixels" };
  workflow: {
    id: "revelai-wall-pass-geometry-v1" | "revelai-free-training-v1";
    version: "1.0.0";
    modelBundleId: string;
    providerVersion: string;
  };
  detections: Array<{
    class: "athlete" | "ball";
    confidence: number;
    xMin: number; yMin: number; xMax: number; yMax: number;
  }>;
};

type FreeWorkflowOutput = WorkflowCommon & {
  kind: "free-training-v1";
  workflow: WorkflowCommon["workflow"] & { id: "revelai-free-training-v1" };
};

type WallPassWorkflowOutput = WorkflowCommon & {
  kind: "wall-pass-geometry-v1";
  workflow: WorkflowCommon["workflow"] & { id: "revelai-wall-pass-geometry-v1" };
  keypoints: Array<{
    class: "left_foot" | "right_foot";
    confidence: number;
    x: number; y: number;
  }>;
  fiducials: Array<{
    class: FiducialCornerId;
    confidence: number;
    x: number; y: number;
  }>;
  geometry: {
    wallFloorEdge: { confidence: number; x1: number; y1: number; x2: number; y2: number };
  };
};

type WorkflowOutput = FreeWorkflowOutput | WallPassWorkflowOutput;
```

`outputs` has exactly one element. The adapter rejects an unexpected output kind, workflow ID/version/model bundle, duplicate `athlete`/`ball`/foot/corner class, unknown class, or missing required output shape; it does not silently choose among duplicates. `athlete` and `ball` are the only allowed detection classes. `left_foot` and `right_foot` are anatomical pose classes supplied by the named Workflow. The wall-pass Workflow has eight fixed fiducial-corner labels and one wall-floor edge; the Free Workflow has neither. Workflow construction is an operator prerequisite: it must expose those class names and parent-image coordinate output before its policy record can be approved. A checked-in HTTP fixture mirrors this envelope byte-for-byte after secret removal.

At most four transformed frames are in flight. A frame times out after eight seconds and a batch after 180 seconds. Retry at 250 ms and one second only for connection reset/timeouts and HTTP 408, 429, 500, 502, 503, or 504. Other 4xx responses fail immediately. Neither raw response nor base64 frame may appear in errors, snapshots, or logs.

The scheduler receives the complete 640-frame verified manifest (40 pre-roll plus 600 active frames at 10 fps), starts at most four requests, starts the next only after one settles, aborts all outstanding work at the single 180-second batch deadline, and produces only retryable `analysis_temporary_unavailable` on deadline exhaustion. An injected-clock scheduler fixture uses 640 deterministic responses to prove the four-request maximum, no hidden serial phase, retry accounting, cancellation, and deadline behavior without calling Roboflow.

Before a Roboflow tuple can enter an approved competitive-policy record, the operator runs a redacted pre-policy benchmark against that exact configured `revelai-wall-pass-geometry-v1` Workflow using five representative 640-frame, 1280×720 JPEG manifests, concurrency four, and the production scheduler. The pooled dispatch-to-Zod-observation p95 must be `<=900 ms` and every batch must complete in `<=165 s`; the latter reserves 15 seconds inside the 180-second public processing budget for scheduling/retries. The report records only workflow/model/provider/version tuple, run times, p95, batch times, and pass/fail—never keys or image bytes. If either threshold fails, no policy record may be approved: reduce the documented verified sampling with new calibration/pass fixtures, adopt and document an exact batched Workflow dialect, or widen the batch deadline and pending-state expectation, then rerun the benchmark. Hosted-runtime limits remain checked against [Roboflow's Workflow execution modes](https://inference.roboflow.com/workflows/modes_of_running/); demo CI never calls this benchmark.

`WorkflowBenchmarkReceiptSchema` is a strict internal Zod schema in `packages/contracts/src/workflow-benchmark-receipt.ts`, versioned as `workflow-benchmark-receipt-v1`. It is the only accepted receipt shape:

```ts
type WorkflowBenchmarkReceipt = {
  schemaVersion: "workflow-benchmark-receipt-v1";
  id: string; // UUID
  workflow: {
    workspaceId: string;
    workflowId: "revelai-wall-pass-geometry-v1";
    workflowVersion: "1.0.0";
    modelBundleId: string;
    providerVersion: string;
  };
  scheduler: {
    id: "verified-wall-pass-image-scheduler-v1";
    maxInFlight: 4;
    requestTimeoutMs: 8000;
    batchDeadlineMs: 180000;
    retryDelaysMs: [250, 1000];
  };
  sampling: {
    id: "wall-pass-v1-10fps-640-v1";
    inferenceWidth: 1280;
    inferenceHeight: 720;
    preRollFrames: 40;
    activeFrames: 600;
    totalFramesPerBatch: 640;
  };
  manifestSet: {
    sha256: string; // canonical SHA-256 of ordered manifestIds plus their per-frame hashes
    manifestIds: [string, string, string, string, string]; // five distinct non-secret IDs
  };
  runs: [
    { manifestId: string; batchDurationMs: number; completedFrameRequests: 640 },
    { manifestId: string; batchDurationMs: number; completedFrameRequests: 640 },
    { manifestId: string; batchDurationMs: number; completedFrameRequests: 640 },
    { manifestId: string; batchDurationMs: number; completedFrameRequests: 640 },
    { manifestId: string; batchDurationMs: number; completedFrameRequests: 640 }
  ];
  pooledDispatchToObservationP95Ms: number; // pooled 3,200 request samples
  runAt: string; // ISO-8601 UTC
  validUntil: string; // exactly runAt + 30 days
  status: "passed" | "failed";
  invalidatedAt: string | null;
  invalidationReason: "tuple_changed" | "manifest_set_changed" | "operator_revoked" | null;
  receiptSha256: string; // canonical SHA-256 of this object excluding receiptSha256
};
```

The schema requires five distinct manifest IDs matching the ordered run IDs, finite positive durations, `completedFrameRequests=640`, a 64-character lowercase hash for both hashes, and a finite p95. `status:"passed"` is valid only when p95 is `<=900`, every duration is `<=165000`, all five runs completed 640 requests, `invalidatedAt` and `invalidationReason` are null, and `validUntil` is exactly 30 days after `runAt`; every other benchmark is `failed`. A receipt is stale at `now >= validUntil` and invalid immediately if `invalidatedAt` is set, if a policy's exact workflow/model/provider/scheduler/sampling/manifest-set tuple or receipt hash differs, or if a new representative manifest set changes `manifestSet.sha256`. Receipts are immutable; invalidation creates an audit update, never a rewritten run.

The benchmark command writes a candidate JSON at `${REVELAI_BENCHMARK_RECEIPT_DIR:-var/revelai/operator/benchmark-receipts}/{id}.json`. That path is an operator handoff only, never a public route or runtime source of truth. `CompetitivePolicyRepository.importBenchmarkReceipt` parses it with `WorkflowBenchmarkReceiptSchema`, stores canonical JSON, `receiptSha256`, status, run/expiry/invalidation fields in SQLite `workflow_benchmark_receipts`, and returns its ID. An `approved_competitive_model_policies` record stores `workflowBenchmarkReceiptId`, `workflowBenchmarkReceiptSha256`, and `workflowBenchmarkReceiptSchemaVersion`; policy activation re-parses the stored receipt and requires all three fields plus the exact tuple to match. A missing/stale/failed/mismatched receipt makes only that real tuple ineligible.

Receipt schemas and missing/stale/failed/passing parsed fixtures are ordinary C2/C7/demo-CI tests. C8, the default empty-policy demo, and the normal demo vertical slice never require a live Workflow, receipt file, network, or secret. Only an operator attempting to activate a real competitive-policy record requires a current live `status:"passed"` receipt. C10's approved-policy positive mock uses `WorkflowBenchmarkReceiptSchema.parse(passingReceiptFixture)` for its mocked tuple; it is not a substitute for live policy activation.

### Verified calibrated assembly

Wall-pass v1 uses two distinct, printed square fiducial boards, A and B, on the floor. Each board is `0.20 m × 0.20 m`; its four corners are observed using the labels above. In the challenge's ground coordinate system, wall/floor is `Y=0`, positive `Y` faces the athlete, and the board centres are A `(-1.50, 3.00)` and B `(1.50, 3.00)` metres. Thus boards are 3.00 m apart and 3.00 m from the wall. Boards must be aligned to the printed orientation: the printed `top` edge faces the wall and the printed `left` edge faces negative X. Exact world corners are A top-left `(-1.60,2.90)`, top-right `(-1.40,2.90)`, bottom-right `(-1.40,3.10)`, bottom-left `(-1.60,3.10)`; B top-left `(1.40,2.90)`, top-right `(1.60,2.90)`, bottom-right `(1.60,3.10)`, bottom-left `(1.40,3.10)`. The athlete performs rolling floor passes between the boards; airborne-ball motion is outside the verified wall-pass definition.

For each calibration frame, `WallPassObservationAssembler` uses at least four non-collinear matched corners (normally all eight) to estimate the source-image-to-ground-plane homography by normalized DLT with RANSAC. It rejects a homography with fewer than four inliers, max corner reprojection error above 8 source pixels, median error above 4 source pixels, or wrong projected wall-side orientation. It maps a ball's bbox bottom-centre and each anatomical foot point through the homography; those are the only ground-plane points used for the metre contact/wall rules. The observed wall-floor edge is cross-checked against projected `Y=0` with mean point-to-line error at most 8 source pixels.

The reference homography is deterministic. For every accepted pre-roll homography `H_i`, use the eight named board-corner world anchors `P = [a-top-left, a-top-right, a-bottom-right, a-bottom-left, b-top-left, b-top-right, b-bottom-right, b-bottom-left]`. For two frames define `d(i,j) = median(p in P, euclidean(project(inverse(H_i), p), project(inverse(H_j), p)))` in source-display pixels. Set `S_i = sum(d(i,j) for every accepted pre-roll j)` and choose `H_ref = H_k` with the smallest `S_i`; an equal `S_i` chooses the lower decoded frame index. C6 records every `S_i`, the selected index, and the anchor distances as private calibration evidence.

`H_ref` is a stability reference only: an active ball bottom-centre or foot point is mapped through that frame's own accepted `H_t`, never through a stale `H_ref`. An active frame is stable only when it has all eight named corners and wall-floor edge at confidence `>=0.80`, its `H_t` meets the same inlier/reprojection/orientation/wall-edge tests, and against `H_ref` its eight-anchor median drift is `<=6 source pixels` and maximum drift is `<=12 source pixels`. Of the exactly 600 decoded active frames `[4,64)`, at least 576 (96%) must be stable and there may be no run of four consecutive unstable or geometry-missing frames. Detections in an unstable frame are not mapped or used for contacts/wall impacts. C7 invalidates any failed reference or active-stability requirement as `calibration_not_verified`; it never reports the drift values to the athlete. Required fixtures cover deterministic medoid selection including equal-score frame-index tie, a single camera bump, gradual drift, active marker loss, and the fact that valid active points use `H_t` rather than `H_ref`.

Synthetic projection fixtures use the eight world corners, known homographies, source/inference letterbox transforms, and deliberately perturbed corners. They prove inverse-transform round trips within 1 source pixel and accepted calibration ground reprojection within 0.05 m at the board centres; the above pixel errors are the acceptance/rejection boundary fixtures. This makes the existing `0.35 m` contact and `0.25 m` wall thresholds physically grounded rather than normalized-image approximations.

### Free Training analysis path

Free Training uses the same safe container sniff/probe/storage mechanics but not verified capture eligibility. It accepts MP4/MOV/WebM with valid magic bytes, exactly one decodable video stream, size `>0` and `<=250 MiB`, duration `3.0–180.0 s`, display short edge `>=480 px`, and nominal frame rate `>=12 fps`, in portrait or landscape. It does not require fiducials, a pre-roll, exact duration, scene continuity, rear camera, or wall/ball visibility. Unsupported media is rejected at upload; a later provider outage becomes a retryable `failed` outcome, not a verified-style invalid outcome.

`FreeMediaPipeline` samples `min(180, max(12, ceil(durationSeconds × 2)))` frames uniformly over the full decoded duration, including first and last frame. It sends `FreeVisionFrameRequest` values to the Free Workflow/Demo provider. `FreeInsightAssembler` accepts only athlete/ball boxes at confidence `>=0.55` and emits exactly these deterministic `FreeObservation` values:

```ts
type FreeObservation =
  | { kind: "athlete-visibility"; unit: "percent"; value: number; range: "limited" | "partial" | "consistent" }
  | { kind: "ball-visibility"; unit: "percent"; value: number; range: "limited" | "partial" | "consistent" }
  | { kind: "movement-activity"; unit: "percent"; value: number; range: "low" | "moderate" | "high" };
```

Visibility is `100 × frames containing that accepted class / sampledFrames`, rounded half-up to integer; ranges are limited `0–49`, partial `50–79`, consistent `80–100`. For chronological adjacent accepted athlete boxes `i,j`, let `deltaSeconds = (timestampMs[j] - timestampMs[i]) / 1000`, which must be positive and finite, `normalisedCentreDisplacement = euclidean(centre_j, centre_i) / sourceImageDiagonal`, and `rate = normalisedCentreDisplacement / deltaSeconds`. An eligible movement pair requires accepted athlete boxes at both endpoints and that positive finite delta; a non-positive/non-finite delta is malformed provider data and the Free batch fails retryably as `analysis_temporary_unavailable`, rather than silently changing the denominator. `movement-activity` is `100 × eligible pairs with unrounded rate >=0.015 / eligible adjacent pairs`, rounded half-up to integer; it is `0` if there are no eligible pairs; ranges are low `0–19`, moderate `20–59`, high `60–100`. Fixtures cover unequal deltas, exact `0.015`, zero/non-finite deltas, and half-up percentage/range boundaries.

```ts
type FreeInsightTip =
  | "Mantenha o corpo inteiro visível."
  | "Mantenha a bola visível durante a sequência."
  | "Grave uma sequência com mais movimento contínuo."
  | "Boa cobertura para uma análise aproximada.";
```

`FreeInsightAssembler` always emits one or two `FreeInsightTip` values in this exact order: append `Mantenha o corpo inteiro visível.` when athlete visibility is `limited`; then append `Mantenha a bola visível durante a sequência.` when ball visibility is `limited`. If neither visibility is limited, append exactly one fallback: `Grave uma sequência com mais movimento contínuo.` when movement activity is `low`, otherwise `Boa cobertura para uma análise aproximada.`. Thus both limited returns the two visibility tips in that order; a limited visibility never appends a fallback. It returns observations/tips/provenance only and imports neither `@revelai/domain` scoring nor competitive repositories.

`DemoVisionProvider` selects a fixture from injected server/test configuration, never client input: `free-well-framed-active-v1` is the default Free fixture and `free-limited-ball-v1` is a contract fixture. Both carry required demo provenance. Contract/API tests prove fixture selection, sampling/rounding/ranges/tips, tip union/order, upload acceptance in portrait and landscape, structural absence of score/ranking fields, and an import/repository boundary that prevents Free code from reaching score, policy, or leaderboard writes.

### Integrity and competitive policy

`IntegrityEvaluator` receives only assembled verified evidence. It may return only `capture_requirements_not_met`, `video_not_continuous`, `calibration_not_verified`, or `tracking_insufficient`. It records detailed signals internally and never serializes thresholds or anti-abuse reasoning to a client. Provider/queue outages instead become retryable failure code `analysis_temporary_unavailable`.

`CompetitiveEligibilityPolicy` is evaluated by the API immediately before a leaderboard insert:

```text
competitiveEligible =
  provenance.kind == "roboflow"
  AND exact (modelBundleId, workflowId, workflowVersion, providerVersion) is approved
  AND calibrationEvidenceVersion is approved for that model bundle
  AND result.ruleVersion is approved for that challenge version
  AND approved policy references a current matching passed WorkflowBenchmarkReceipt
  AND integrity outcome is valid
```

The default MVP policy has no approved Roboflow record. Therefore the API evaluates all demo provenance to `false`, and all unapproved real provenance to `false`; both may render labelled reports but cannot write a normal leaderboard entry. No route, worker, repository, or client infers this flag from provider output.

An approved Roboflow policy record additionally references the passing pre-policy benchmark report for its exact workflow/model/provider/version tuple. A missing, stale, or failed report makes the tuple unapproved and therefore `competitiveEligible: false`.

Score formula, rule version, challenge version, provenance, and frozen ranking snapshot are stored with every verified result. Reprocessing the same canonical observations with the same rules returns the same result.

## Consequences

- CI verifies both Free and verified behavior without GPU, network, model weights, or secrets.
- A real Workflow is a named, testable deployment contract instead of a generic detector assumed to infer unavailable geometry.
- Providers cannot silently change score semantics, integrity, or leaderboard eligibility.
- Fixture-backed UI is never presented as measured or competitively ranked athlete performance.
- LLM narration remains out of MVP scoring path. Future narration may summarize final metrics but cannot create or override them.
- Video alone does not claim physical impact force. Verified wall-pass distance rules apply only to the defined ground-plane/rolling-ball exercise.
