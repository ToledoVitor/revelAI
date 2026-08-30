# RevelAI MVP specification

- Status: Ready for agent
- Date: 2026-08-30
- Scope: Futsal wall-pass vertical slice across web, mobile, API, and vision-provider seam
- Tracker: https://github.com/ToledoVitor/revelAI/issues/1

## Problem Statement

Young athletes with limited access to scouts and professional measurement tools cannot easily turn phone-recorded futsal practice into structured feedback or a trustworthy competitive comparison. Unconstrained video is accessible but not comparable. Strict capture can be comparable but becomes difficult without clear guidance. RevelAI needs one honest vertical slice that supports both needs without presenting approximate computer-vision output as physical truth.

## Solution

RevelAI provides two entry modes. Free Training accepts loosely captured video and returns clearly labeled approximate personal insights without score or leaderboard. Verified Challenge guides a calibrated, uninterrupted wall-pass attempt, processes it asynchronously, performs internal validation, computes deterministic metrics and score, and publishes a normal leaderboard result only when the result is both valid and competitively eligible.

Mobile and web clients share one backend contract. MVP includes a fixture-backed demo Vision Provider for reliable local use and a server-only Roboflow Inference adapter for real-model experiments. Every analysis result exposes provenance; every `VerifiedResult` additionally exposes challenge/version and `ruleVersion`.

## User Stories

1. As an athlete, I want to understand difference between Free Training and Verified Challenge, so that I choose correct confidence level.
2. As an athlete, I want Free Training labeled approximate, so that I do not mistake it for competitive measurement.
3. As an athlete, I want Free Training excluded from scoring, so that leaderboard remains fair.
4. As an athlete, I want to see available challenges, so that I know what can be measured.
5. As an athlete, I want wall-pass rules before capture, so that I can prepare required space and equipment.
6. As an athlete, I want a 60-second wall-pass challenge using both feet, so that first challenge measures repeatable technique.
7. As an athlete, I want phone orientation validated, so that recording geometry is usable.
8. As an athlete, I want camera stability validated, so that tracking quality is not undermined by camera motion.
9. As an athlete, I want wall and floor reference detected, so that spatial calibration is credible.
10. As an athlete, I want two guided square fiducial boards at the documented three-metre ground positions, so that attempts use the same physical scale.
11. As an athlete, I want full body and ball inside safe frame, so that relevant motion stays observable.
12. As an athlete, I want a short tracking rehearsal, so that failure is caught before full attempt.
13. As an athlete, I want capture blocked while a gate fails, so that I do not waste an invalid attempt.
14. As an athlete, I want specific gate correction feedback, so that I can fix setup alone.
15. As an athlete, I want a countdown, so that I can move from phone to challenge position.
16. As an athlete, I want to record in-app, so that capture follows challenge requirements.
17. As an athlete, I want to upload an eligible continuous video, so that existing recordings remain usable.
18. As an athlete, I want upload requirements shown before selection, so that rejection is predictable.
19. As an athlete, I want submission progress, so that weak connectivity does not look frozen.
20. As an athlete, I want processing to continue on the server after leaving the screen, so that I need not wait with the screen open.
21. As an athlete, I want the app to refresh status when it returns to the foreground or I reopen it, so that I know when report is ready without a push-notification promise.
22. As an athlete, I want invalid submission explained in user-actionable terms, so that I can retry.
23. As an athlete, I do not want integrity-detection mechanics exposed, so that competitive safeguards remain harder to game.
24. As an athlete, I want valid passes, accuracy, cadence, and left/right balance, so that report reflects challenge performance.
25. As an athlete, I want deterministic score with version, so that same evidence produces same result.
26. As an athlete, I want a leaderboard percentile only for a competitively eligible verified attempt, so that I do not mistake demo or experimental comparison for a ranking.
27. As an athlete, I want metric units and definitions, so that report is interpretable.
28. As an athlete, I want demo results labeled demo, so that mock analysis is never mistaken for real measurement.
29. As an athlete, I want to retry challenge, so that I can track improvement.
30. As an athlete, I want a consistent attempt history on the device where I created it, so that I can revisit the same local MVP session without an unsupported cross-device promise.
31. As a developer, I want one versioned API contract, so that mobile and web clients evolve together.
32. As a developer, I want pure score rules, so that metrics can be tested without media or network.
33. As a developer, I want provider-normalized observations, so that model/vendor changes do not leak through product code.
34. As a developer, I want local demo mode without secrets, so that contributors and CI can run full flow.
35. As a developer, I want optional Roboflow Inference configuration, so that real-model experiments use same analysis seam.
36. As an operator, I want startup configuration validation, so that broken deployments fail early.
37. As an operator, I want health and readiness endpoints, including negative dependency behavior, so that deploy environments can distinguish process from dependency health.
38. As an operator, I want structured logs without secrets or raw media paths, so that processing can be diagnosed safely.
39. As an operator, I want independent app builds, so that web, mobile, and API deploy separately from one monorepo.
40. As a reviewer, I want automated contract, domain, API, and client-flow tests, so that functional commits can be trusted.

## Implementation Decisions

### Runtime, ownership, and version baseline

- Use pnpm workspaces and Turborepo as accepted in ADR 0001. Node.js is `>=22.19.0`; pnpm is exactly `11.20.0`.
- Build web with React, TypeScript, Vite, React Router, and TanStack Query. Build API with Fastify and TypeScript.
- Mobile is pinned as one compatible set: Expo SDK `54.0.18`, React Native `0.81.4`, React/React DOM/react-test-renderer `19.1.0`, React Native Web `0.21.0`, Jest `29.7.0`, `jest-expo` `54.0.18`, and Metro `0.82.x` solely through the Expo SDK's `expo/metro-config`. The lockfile records the exact resolved `0.82.x` Metro patch; no separate incompatible Metro configuration is allowed. `expo install --fix` is the only permitted way to change Expo-owned version ranges.
- Mobile declares `phosphor-react-native@2.1.0` and its required `react-native-svg@15.12.1` peer, installed at Expo-compatible versions and verified by `expo-doctor`. It also declares `expo-secure-store` only via `rtk pnpm --filter @revelai/mobile exec expo install expo-secure-store`; the Expo SDK 54-selected version is committed in the lockfile and verified by `expo-doctor`, never manually range-pinned. Web uses `@phosphor-icons/react`; neither client draws substitute icons with SVG/CSS/emoji.
- API owns persistence, media storage, FFmpeg/FFprobe invocation, analysis orchestration, integrity evaluation, competitive-policy evaluation, score/result writes, and leaderboard writes. `packages/vision` owns observations/provenance only; `packages/domain` owns pure transitions, metrics, score, and ranking calculations.

### Identity, create, retrieval, and outcome contracts

- MVP identity is a locally generated UUID in `X-RevelAI-Athlete-Id`; it partitions history but is not authentication. Web persists it in local storage and mobile in secure local storage. No screen or documentation promises cross-device history. The API creates it as an athlete record on first use and scopes individual reads, attempt lists, deletion, and retry to the supplied UUID.
- `POST /v1/attempts` parses this exact discriminated input through Zod:

```ts
type CreateAttemptInput =
  | { mode: "free" }
  | {
      mode: "verified";
      challengeId: "wall-pass";
      challengeVersion: 1;
      calibrationSessionId: string;
    };
```

  `X-RevelAI-Athlete-Id` is the sole athlete identifier: it is a required UUID header, parsed before the body and never duplicated in JSON. Missing/malformed header is typed `400 invalid_athlete_identity`; an ID whose record cannot be created/read is `404 attempt_not_found` for scoped reads. A free Attempt starts `awaiting-upload`; a verified Attempt requires a ready, non-expired calibration-session ID.
- `POST /v1/calibration-sessions` accepts `{ challengeId: "wall-pass", challengeVersion: 1 }` under the identity header and returns:

```ts
type CalibrationSession = {
  id: string;
  challengeId: "wall-pass";
  challengeVersion: 1;
  state: "issued" | "ready";
  nonce: string; // 32 random bytes, base64url
  issuedAt: string;
  expiresAt: string; // exactly issuedAt + 15 minutes
  requiredGates: ["device", "space", "athlete", "rehearsal", "record"];
};
```

  `POST /v1/calibration-sessions/:id/ready` accepts the same five gate IDs in that exact order and atomically changes an owned, unexpired `issued` session to `ready`. This records that the client completed capture guidance; it is not integrity proof. `POST /v1/attempts` atomically creates the verified Attempt and changes that same `ready` session to internal state `consumed`; one session creates at most one Attempt. Unknown/wrong-owner IDs return `404 calibration_session_not_found`; expired sessions transition to internal `expired` and return `410 calibration_session_expired`; duplicate readiness, consumed use, or challenge/version mismatch returns typed `409` (`calibration_session_not_ready`, `calibration_session_consumed`, or `calibration_session_challenge_mismatch`). These internal terminal session states are not returned as reusable sessions.
- `GET /v1/attempts?limit=20&cursor=<opaque>` returns `{ items: AttemptSummary[], nextCursor: string | null }` in reverse `createdAt` order for the current local identity. `limit` is an integer 1–50. An item contains `id`, `mode`, `status`, `createdAt`, `challenge` when verified, and public outcome summary only; it never contains media locations, raw observations, provider responses, or hidden integrity evidence.
- A public `AttemptOutcome` Zod discriminated union is the single result type for `GET /v1/attempts/:id/result`, list summaries, and both clients:

```ts
type AttemptOutcome =
  | { state: "pending"; attemptId: string; mode: "free" | "verified"; status: "awaiting-upload" | "uploaded" | "processing" }
  | { state: "valid"; result: FreeInsight | VerifiedResult }
  | { state: "invalid"; attemptId: string; mode: "verified"; code: InvalidRetryCode; message: string; retryable: true }
  | { state: "failed"; attemptId: string; mode: "free" | "verified"; code: "analysis_temporary_unavailable"; message: string; retryable: true }
  | { state: "failed"; attemptId: string; mode: "free" | "verified"; code: "analysis_configuration_invalid" | "analysis_internal_error"; message: string; retryable: false };

type InvalidRetryCode =
  | "capture_requirements_not_met"
  | "video_not_continuous"
  | "calibration_not_verified"
  | "tracking_insufficient";

type FailureCode =
  | "analysis_temporary_unavailable"
  | "analysis_configuration_invalid"
  | "analysis_internal_error";

type RouteError = {
  code:
    | "invalid_request"
    | "invalid_athlete_identity"
    | "attempt_not_found"
    | "calibration_session_not_found"
    | "calibration_session_expired"
    | "calibration_session_not_ready"
    | "calibration_session_consumed"
    | "calibration_session_challenge_mismatch"
    | "invalid_attempt_transition"
    | "media_part_missing"
    | "media_part_count_invalid"
    | "multipart_extra_part_forbidden"
    | "media_filename_mime_mismatch"
    | "media_empty"
    | "media_too_large"
    | "multipart_body_too_large"
    | "media_container_not_allowed"
    | "media_probe_failed"
    | "media_requirements_not_met"
    | "duplicate_media_upload"
    | "queue_unavailable"
    | "service_not_ready";
  message: string;
  retryable: boolean;
};
```

  No public route emits a code outside `RouteError` (framework/Zod failures normalize to `invalid_request`). `InvalidRetryCode` always has `retryable:true`; only `analysis_temporary_unavailable` is retryable among `FailureCode`. The exact route-error status/retryability matrix is: `invalid_request`, `invalid_athlete_identity`, `media_part_missing`, `media_part_count_invalid`, `multipart_extra_part_forbidden`, and `media_filename_mime_mismatch` are `400/false`; `attempt_not_found` and `calibration_session_not_found` are `404/false`; `calibration_session_expired` is `410/false`; `calibration_session_not_ready`, `calibration_session_consumed`, `calibration_session_challenge_mismatch`, `invalid_attempt_transition`, and `duplicate_media_upload` are `409/false`; `media_too_large` and `multipart_body_too_large` are `413/false`; `media_container_not_allowed` is `415/false`; `media_empty`, `media_probe_failed`, and `media_requirements_not_met` are `422/false`; `queue_unavailable` and `service_not_ready` are `503/true`. Messages are safe, localized action text; they never include filesystem/provider/integrity details.

  Public `AttemptStatus` is exactly `awaiting-upload | uploaded | processing | valid | invalid | failed`; `created` is not persisted or observable. `GET /result` returns `202` for `pending`, `200` for the other three states. The full lifecycle is:

| Event | Required prior state | New public state | Atomic guard |
| --- | --- | --- | --- |
| create Free | none | `awaiting-upload` | identity active |
| create verified | ready owned session | `awaiting-upload` | consume session in same transaction |
| accept media | `awaiting-upload` | `uploaded` | active, non-tombstoned attempt |
| claim queue job | `uploaded` | `processing` | unique processing lease/generation |
| finalize valid/invalid/failed | `processing` | terminal value | matching lease and active attempt |
| retry | any terminal | none | creates a new Attempt; no terminal mutation |
| delete | any active state | not returned | tombstone/cancel; subsequent reads are scoped `404` |

  All other transitions return typed `409 invalid_attempt_transition`. A tombstone is an internal deletion state, not a seventh public status.
- `POST /v1/attempts/:id/media` requires `X-RevelAI-Athlete-Id` and `multipart/form-data` with **exactly one** file part named `media`, no text parts, no other file parts, and no repeated `media`. The filename is non-empty and ends case-insensitively in `.mp4`, `.mov`, or `.webm`; after stripping MIME parameters, its declared part MIME must respectively be `video/mp4`, `video/quicktime`, or `video/webm`. A wrong name/type pair is `400 media_filename_mime_mismatch`; only server magic-byte/FFprobe validation decides actual container/codec eligibility.
- `MAX_UPLOAD_BYTES` (default `250 MiB`) counts only emitted `media` file bytes. A file of exactly that many bytes is accepted; the first file byte above it aborts stream/storage and returns `413 media_too_large`. Independently the multipart parser caps total request bytes at `MAX_UPLOAD_BYTES + 65536`; an envelope over that cap returns `413 multipart_body_too_large`. Missing/zero/multiple `media` parts map to `media_part_missing`/`media_empty`/`media_part_count_invalid`; any extra part maps to `multipart_extra_part_forbidden`; unsupported magic/container and failed FFprobe map to `media_container_not_allowed` and `media_probe_failed`; a successfully probed asset failing the documented mode eligibility maps to `media_requirements_not_met`.
- The route first scopes `:id` to the identity header. Wrong/unknown/deleted attempts return `404 attempt_not_found`; only an owned active `awaiting-upload` Attempt without media may attach. If media is already attached it returns `409 duplicate_media_upload`; another state returns `409 invalid_attempt_transition`. Queue readiness is checked before body consumption; unavailable queue returns `503 queue_unavailable` without attaching media. On successful validate/store/attach/enqueue, it returns `202` with this parsed snapshot, even if a worker subsequently advances the Attempt:

```ts
type MediaUploadAccepted = {
  kind: "media-upload-accepted";
  attemptId: string;
  mode: "free" | "verified";
  acceptedStatus: "uploaded";
  outcome: { state: "pending"; attemptId: string; mode: "free" | "verified"; status: "uploaded" };
};
```

  Client cancellation aborts the HTTP request. If the server observes it before commit, it stops reading, removes the temporary file, and leaves the Attempt `awaiting-upload`, with no response body to parse; the client may query and retry. If commit/`202` won the race, the accepted snapshot/current `GET /v1/attempts/:id` is authoritative and the client must not assume cancellation removed media. A queue-enqueue failure after storage rolls the attachment back to `awaiting-upload`, removes the stored media, and returns `503 queue_unavailable`, so a same-attempt retry is safe.
- `FreeInsightTip` is the exact literal union `"Mantenha o corpo inteiro visível." | "Mantenha a bola visível durante a sequência." | "Grave uma sequência com mais movimento contínuo." | "Boa cobertura para uma análise aproximada."`. `FreeInsight` is `{ kind: "free-insight", attemptId, provenance, approximate: true, observations: FreeObservation[], tips: FreeInsightTip[], generatedAt }`; `tips` has one or two values only. The assembler appends athlete-limited tip, then ball-limited tip; if neither visibility is limited it instead emits exactly one fallback—movement tip when activity is low, otherwise the coverage tip. Its `FreeObservation` values and tips are approximate guidance, not competitive metrics. Its schema structurally forbids `score`, `percentile`, `topPercent`, `leaderboardEntry`, `ruleVersion`, and `verified`.
- A `VerifiedResult` is a Zod discriminated union on `competitiveStatus`. Its shared fields are `{ kind: "verified-result", attemptId, challengeId, challengeVersion, ruleVersion, provenance, metrics, score, completedAt }`. The `ranked` arm requires `competitiveEligible: true` and `rankingSnapshot`; `demo` and `experimental` require `competitiveEligible: false` and structurally forbid rank/percentile/topPercent/snapshot fields. `AnalysisProvenance` is the discriminated union in ADR 0002, not optional provider fields.

### Challenge capture and media eligibility

- `wall-pass-v1` is futsal, requires both feet and two visible three-metre markers, and measures exactly a 60-second active exercise interval. The asset is continuous and 64.0–65.0 seconds long: seconds `[0, 4)` are calibration pre-roll; `[4, 64)` is the scored 60-second interval. Existing video uses exactly the same asset shape and cannot bypass calibration.
- Both modes require an MP4/MOV/WebM filename extension matched to declared MIME, a non-empty body, and configured size at or below `MAX_UPLOAD_BYTES` (default `250 MiB`). The stream reader independently enforces the same byte counter even when `Content-Length` is missing or false. It reads no more bytes after the limit. Verified eligibility adds the stricter rules below; Free Training does not inherit them.
- Server sniffing, not client MIME, is authoritative: ISO BMFF `ftyp` is required for MP4/MOV and must agree with FFprobe's container; WebM requires EBML bytes and a `webm` DocType. FFprobe must find exactly one video stream, no attached-picture stream, decodable video, and no encrypted/unsupported codec. The original filename never becomes a filesystem key.
- For verified wall pass, after rotation metadata is applied, the display image must be landscape (`width > height`), at least `1280×720`, aspect ratio 1.30–2.00, and have a nominal frame rate of at least 24 fps. FFprobe duration must be 64.0–65.0 seconds. The extractor decodes timestamps at 10 fps; an absent/non-monotonic timestamp or a decoded gap greater than 250 ms invalidates continuity.
- Continuity also requires one video timeline and no FFmpeg scene-change sample at or above `0.42` during the active interval. The evaluator treats the internal test as evidence only and reports the safe `video_not_continuous` code, never the signal or threshold to a client.
- Verified wall pass uses two printed square fiducial boards, A and B, each `0.20 m × 0.20 m`, placed flat on the floor. World ground coordinates use wall/floor as `Y=0`, positive `Y` toward the athlete, A centre `(-1.50, 3.00)` m, and B centre `(1.50, 3.00)` m. Printed board top faces wall and left faces negative X: A corners are `(-1.60,2.90)`, `(-1.40,2.90)`, `(-1.40,3.10)`, `(-1.60,3.10)` in top-left/top-right/bottom-right/bottom-left order; B corners are `(1.40,2.90)`, `(1.60,2.90)`, `(1.60,3.10)`, `(1.40,3.10)` in the same order. The Workflow must return all eight named board corners. Every calibration frame estimates a source-image-to-ground homography from at least four non-collinear corners using normalized DLT/RANSAC; accept only when it has at least four inliers, max reprojection error `<=8` source pixels, median error `<=4` source pixels, and a wall-floor edge mean error `<=8` source pixels. The board centres must recover to within `0.05 m` in synthetic projection fixtures.
- C6 deterministically selects one pre-roll reference from accepted `H_i`: for the eight named board-corner world anchors `P`, `d(i,j)` is the median source-pixel distance between `project(inverse(H_i), p)` and `project(inverse(H_j), p)` over `p in P`; select the `H_i` with the smallest `sum_j d(i,j)`, breaking an exact tie by lower decoded frame index. It records the selected index and anchor distances privately. C6 uses `H_ref` only for comparison: each active ball-bottom-centre/foot point maps through its own accepted active-frame `H_t`, never through `H_ref`.
- Calibration is accepted only if frames `[0,4)` contain athlete, all eight fiducial corners, and wall/floor edge at confidence at least `0.80` in at least 32 of 40 sampled frames. A stable active frame among the exactly 600 frames `[4,64)` must have those same geometry detections at confidence `>=0.80`, a valid `H_t` under all DLT/RANSAC/reprojection/orientation/wall-edge checks, eight-anchor median drift from `H_ref <=6 source pixels`, and maximum drift `<=12 source pixels`. At least 576/600 (96%) active frames must be stable and no run of four consecutive active frames may be unstable or geometry-missing. Unstable-frame detections are never mapped into contact/wall evidence. C5 computes only the raw pre-roll SHA-256 and extraction manifest; C6 derives reference/per-frame homographies and emits the private active-stability evidence; C7 alone evaluates the 32/40, deterministic reference, 576/600/no-four-run, reprojection/drift, session nonce, and same-media hash binding before result finalization. Missing/mismatched evidence—including a camera bump, gradual drift, or active-marker loss that fails these rules—is `calibration_not_verified`.
- Free Training accepts a valid sniffed/probed MP4/MOV/WebM with one decodable video stream, duration `3.0–180.0 s`, display short edge `>=480 px`, nominal frame rate `>=12 fps`, and either portrait or landscape orientation. It has no calibration pre-roll, exact-duration, continuity, rear-camera, fiducial, wall, athlete, or ball visibility requirement. `FreeMediaPipeline` samples `min(180, max(12, ceil(durationSeconds × 2)))` uniformly spaced frames, including first and last; it uses the Free Vision request/assembler and yields only FreeInsight or retryable failure.
- The five client-visible gates are `device`, `space`, `athlete`, `rehearsal`, and `record`. They explain observable corrections but never assert that client controls prove server integrity. In-app recording uses the rear camera and records the required pre-roll/countdown; browser/mobile upload surfaces the same requirements before picker invocation.

### Video observations, integrity, and scoring

- FFmpeg extracts verified JPEG frames at 10 fps (40 pre-roll plus 600 active frames) and Free frames by the sampled-count rule. The API sends only transformed JPEGs to the named Roboflow Workflow's JSON/base64 HTTP contract in ADR 0002: maximum concurrency four, eight-second per-frame timeout, one 180-second batch deadline, retries at 250 ms then 1 s only for network errors and 408/429/500/502/503/504. A deterministic injected-clock scheduler test must dispatch the full 640-frame manifest at no more than four concurrent requests and abort at deadline. Before an exact Roboflow tuple may be competitively approved, a redacted five-batch benchmark against that named Workflow must produce a parsed current `WorkflowBenchmarkReceipt` with pooled p95 dispatch-to-Zod-observation `<=900 ms` and every full batch `<=165 s`; otherwise it remains experimental/not ranked until sampling, batching, or the documented deadline/UI expectation is changed and rebenchmarked. Receipt fixtures are used in contracts/C7/C10 only; C8 and demo flow require no live receipt. Its exact Zod response, class map, inference/source coordinate transform, model bundle, and discriminated provenance are ADR 0002 requirements. Provider output is observations/provenance only.
- `WallPassObservationAssembler` makes a ball track across gaps no larger than 300 ms. It accepts ball/athlete detections at confidence `>=0.70` and feet at `>=0.65`; after the accepted homography, a contact is ground distance from ball bbox bottom-centre to foot `<=0.35 m` for at least two frames within 300 ms. Contacts within 300 ms are one contact, with the side of the highest-confidence anatomical foot. A wall impact is a tracked ground point at `Y<=0.25 m` followed by a positive-Y/negative-Y direction reversal within 500 ms.
- Let ordered contacts be `C_1 … C_n`. `C_i` starts an outbound opportunity only when its ball track moves at least `0.25 m` toward the wall within 700 ms. A **valid pass i** is the continuous sequence `C_i → W_i → C_(i+1)`: the next accepted wall impact is 200–2,000 ms after `C_i`, and the next distinct contact is 200–4,000 ms after `W_i`. `C_(i+1)` closes pass i and may also start pass i+1 when it has its own outbound movement; a contact may be shared by those two adjacent sequences but by no non-adjacent sequence. Attribute pass i's left/right side to starting contact `C_i`. An outbound `C_i` is **missed** when no qualifying `W_i → C_(i+1)` sequence completes by 4,000 ms or active-window end. A contact with no outbound movement does not begin/miss a pass. The continuous alternating-foot fixture has `N` complete wall impacts and `N` valid passes, plus separate missed-return and end-window cases. If less than 80% of active frames have usable athlete/ball tracks or calibration is invalid, the result is invalid rather than scored.

| Metric / input | Normative definition | Zero and invalid handling |
| --- | --- | --- |
| `validPasses` | Count of completed valid pass opportunities in `[4,64)`. | `0` when technical tracking is usable but no opportunity completes. |
| `accuracyPercent` | `100 × validPasses / (validPasses + missedPasses)`, rounded to two decimals. | `0.00` when denominator is zero. |
| `meanCadenceSeconds` | Mean timestamp delta in seconds between consecutive valid-pass completions, rounded to two decimals. | `0.00` when fewer than two valid passes. |
| `leftFootPercent` / `rightFootPercent` | `100 × valid passes by anatomical contact side / validPasses`, each rounded to two decimals; reconciliation assigns the remaining hundredth to the larger unrounded side. | both `0.00` when `validPasses = 0`; otherwise they sum to exactly `100.00`. |

`ruleVersion` is `wall-pass-v1-score-1`. Define `clamp(x) = min(100, max(0, x))`; calculate from unrounded metric values and round the final result half up to an integer:

```text
volume = clamp(100 × validPasses / 40)
accuracy = accuracyPercent
cadence = 0 when validPasses < 2,
          otherwise clamp(100 × (5.00 - meanCadenceSeconds) / (5.00 - 0.75))
balance = 100 - 2 × abs(leftFootPercent - 50)
score = roundHalfUp(0.40 × volume + 0.30 × accuracy + 0.20 × cadence + 0.10 × balance)
```

All-zero, perfect, asymmetric, low-accuracy, single-pass, duration-boundary, threshold-boundary, and deterministic-replay fixtures are mandatory. A technically valid zero-observation performance scores `0`; missing required tracking is invalid and has no score. The domain records the constants above with `ruleVersion`; a rule change requires a new version, never a silent edit.

### Provenance, ranking, transactions, and truth labels

- `DemoVisionProvider` produces only required demo provenance (`kind`, `fixtureId`, `providerVersion`). The API's policy evaluates that provenance to `competitiveEligible: false`; no provider produces the eligibility flag. `RoboflowVisionProvider` produces only its required Roboflow provenance tuple from validated configuration/response. The API may evaluate it as competitive only when its approved policy matches exact `modelBundleId`, workflow ID/version, provider version, calibration-evidence version, challenge version, and `ruleVersion`. Default MVP has no approved Roboflow policy record.
- A valid but ineligible result is visible as `Demo — não vale para ranking` or `Experimental — não vale para ranking`; it has neither rank, percentile, nor `topPercent`. It must never be inserted into, merged with, or read as a normal leaderboard entry.
- A ranked result requires this frozen object:

```ts
type RankingSnapshot = {
  kind: "frozen";
  challengeId: "wall-pass";
  challengeVersion: 1;
  ruleVersion: "wall-pass-v1-score-1";
  rank: number;
  cohortSize: number;
  percentile: number;
  topPercent: number;
  scoreCountAtFinalization: number;
  asOfAttemptId: string;
  calculatedAt: string;
};
```

  The cohort filters active `valid` verified results with `competitiveEligible=true` and exact challenge/version/rule. It orders score descending, then completed time ascending, then attempt UUID ascending. Equal scores share `rank = 1 + count(scores strictly greater)`. At finalization it includes the new result, sets `scoreCountAtFinalization = cohortSize`, and calculates `percentile = 100 × count(scores <= score) / cohortSize`, rounded to two decimals. `topPercent = 100 - percentile`, rounded to two decimals; it is a UI phrase, not a synonym. A cohort of one has rank 1, percentile 100.00, and topPercent 0.00. Frozen values never change.
- `GET /v1/leaderboards/wall-pass?version=1&ruleVersion=wall-pass-v1-score-1&limit=20&cursor=<opaque>` returns a separate live response:

```ts
type LeaderboardResponse = {
  view: "live";
  challengeId: "wall-pass";
  challengeVersion: 1;
  ruleVersion: "wall-pass-v1-score-1";
  calculatedAt: string;
  cohortSize: number;
  entries: Array<{ entryId: string; rank: number; score: number; completedAt: string }>;
  nextCursor: string | null;
};
```

  It applies the same active/cohort/order/tie rule at query time; its `rank` can differ from an older result's frozen rank and UI labels it `Ranking atual`. It contains no athlete ID, media key, or raw result. Demo default returns a live empty list with `cohortSize: 0`.
- `AnalysisQueue` and `AttemptRepository` are distinct interfaces:

```ts
type AnalysisJob = { attemptId: string; generation: number };

interface AnalysisQueue {
  isAvailable(): Promise<boolean>;
  enqueue(job: AnalysisJob): Promise<void>;
  subscribe(deliver: (job: AnalysisJob) => Promise<void>): () => void;
}

interface AttemptRepository {
  attachValidatedMedia(input: { attemptId: string; athleteId: string; media: StoredMedia }): Promise<AnalysisJob>;
  rollbackMediaAttachment(input: { attemptId: string; generation: number }): Promise<void>;
  claimProcessing(job: AnalysisJob): Promise<{ leaseId: string; generation: number } | null>;
  finalizeTerminalResult(input: FinalizeTerminalResultInput): Promise<FinalizedAttempt | null>;
  tombstoneAttempt(input: { attemptId: string; athleteId: string }): Promise<void>;
}
```

  `AnalysisQueue` owns only availability, enqueue, and at-least-once identifier delivery. It has no dedupe, reservation, SQLite, result, or tombstone method. `AttemptRepository` owns media attachment state, generation/lease reservation, terminal writes, and tombstones behind SQLite. `AttemptService` performs identity/state/media validation, calls `attachValidatedMedia`, then `AnalysisQueue.enqueue`; if enqueue fails it calls `rollbackMediaAttachment` and deletes media before replying `queue_unavailable`. `AnalysisWorker` receives a job, calls `claimProcessing`, does nothing for a null/stale claim, then processes and calls `finalizeTerminalResult`. The in-process queue is tested for delivery/availability only; an isolated SQLite repository test suite covers generation, `BEGIN IMMEDIATE`, finalize, and tombstone races; coordinator tests use one fake of each interface rather than a combined queue/repository mock.
- `AttemptRepository.finalizeTerminalResult(input)` is the sole terminal-write interface. In one SQLite `BEGIN IMMEDIATE` transaction it verifies attempt state `processing`, matching processing lease/generation, and `deletionState=active`; writes one result (`UNIQUE attempt_id`); for eligible results reads/serializes the exact cohort, computes the snapshot/rank, writes one leaderboard entry (`UNIQUE result_id`); and transitions attempt terminal before commit. SQLite's write transaction serializes concurrent cohort finalizations. Duplicate jobs return the pre-existing terminal result only when the same lease already finalized; stale leases return no write. `DELETE` begins an equally exclusive transaction, tombstones/cancels the attempt, increments its processing generation, removes/retracts result/leaderboard/observations, and queues media deletion. A worker must re-check tombstone and generation inside `finalizeTerminalResult`, so delete-versus-completion cannot resurrect an entry. Tests cover concurrent competitive completions, duplicate jobs, same-score order, and deletion racing finalization.

### Security, operations, and client truth

- Upload storage uses `0700` directories, `0600` files, exclusive/no-follow temporary creation, opaque UUID keys, atomic rename only after validation, and guaranteed temporary-file cleanup on abort/failure. `RetentionScavenger.run(now)` is clock-injected, runs on API startup and every 60 minutes, and processes bounded batches. Originals/frames have `deleteAt = uploadedAt + 23 hours` (terminal cleanup tries immediately, so the hourly schedule guarantees removal by 24 hours); abandoned temporary files have `deleteAt = createdAt + 1 hour`; terminal canonical observations have `deleteAt = completedAt + 30 days`. A failed deletion retains no secret/path in a `retention_cleanup_failed` log and retries on the next run. `DELETE /v1/attempts/:id` tombstones in the same transactional guard as finalization, retracts its leaderboard entry, and queues immediate deletion of original media, frames, observations, and result. Restart/clock-advance tests cover each expiry and retry path. No server response exposes absolute path, media key, raw frame, provider payload, API key, or authorization token.
- Redaction tests must prove that logs/errors never expose `ROBOFLOW_API_KEY`, `Authorization`, media bytes, raw provider payloads, or absolute local paths. A provider URL with a key must use HTTPS unless it resolves to loopback; production `PUBLIC_BASE_URL` must be HTTPS. An unauthenticated API binds loopback by default. Non-loopback use requires `ALLOW_UNAUTHENTICATED_PUBLIC=true` and a persistent startup warning that it is not a production-security mode.
- `/health` answers process liveness. `/ready` returns `200` only after `SELECT 1` succeeds, storage can create/delete a sentinel, and the queue reports available; otherwise it returns typed `503` without a secret/path. Tests cover each independently failing dependency.
- Web and mobile enumerate every visible control with name, purpose, enabled/disabled condition, loading/error/empty state, and focus/screen-reader label. Truth overrides screenshot fidelity: Free Training never shows verified/ranking language; demo/experimental labels are persistent near the result heading and leaderboard action; invalid/failed screens use only safe retry messages; unavailable camera/recording provides a working upload fallback rather than a dead control.
- Mobile has `CameraAdapter` with preview/controller/permission/countdown states and `DocumentPickerAdapter`; `UploadAdapter` reports byte progress, cancellation, retry, and foreground/resume recovery. The server continues processing while the app is closed, but without a push provider the app may only refresh on foreground/resume or manual refresh. It must not promise closed-app notification.
- Accessibility is an acceptance condition: semantic web controls, keyboard route/use, visible focus, screen-reader labels and 44×44-point touch targets on mobile, WCAG AA text/action contrast, reduced-motion alternatives, deterministic loading/error states, and no information conveyed only by color.
- Design QA captures the same route, state, viewport, device scale, and data fixture as each approved reference; it overlays/reference-diffs the captures and records P0–P3 findings. P0/P1/P2 must be fixed and independently accepted by a reviewer before `final result: passed`; P3 may remain as named follow-up only.
- Environment templates document local/test/preview/production names only; no secret value is committed. CI runs install, format check, lint, typecheck, unit/contract/API/client tests, builds, readiness-negative tests, and demo-only integration/visual checks. Real Roboflow inference remains outside default CI.

## Testing Decisions

- Tests assert public behavior at highest practical seam. Avoid snapshots of implementation structure and direct assertions against private helpers.
- Domain tests cover every Attempt transition and tombstone guard, terminal-state immutability, one-time CalibrationSession consume/expiry/conflict behavior, discriminated free/verified creation, metric/confidence boundaries, continuous `C_i → W_i → C_(i+1)` fixtures, all-zero/single-pass handling, left/right reconciliation, ties, frozen rank/percentile/topPercent snapshot, live-versus-frozen ranking, version isolation, competitive-policy gate, Free Training exclusion, and deterministic replay.
- Contract tests parse representative requests/responses for every public route, including header-only identity, CalibrationSession schemas/404/409/410 outcomes, exact one-part media field/MIME/byte/envelope/202/error fixtures, complete `RouteError`/`InvalidRetryCode`/`FailureCode` retryability, `AttemptOutcome`'s four states, provenance/result discriminants, the correlated `VisionObservationBatch` branches, exact one-to-two `FreeInsightTip` literal arrays, live leaderboard response/cursor, attempt-list cursor limits, and structural absence of competitive fields on `FreeInsight`. Positive/negative Zod tests reject cross-mode/mixed batches, invalid/ordered tips, and missing/stale/failed/mismatched/passing `WorkflowBenchmarkReceipt` fixtures.
- Vision-provider contract tests run canonical Free and wall-pass frames against Demo Provider and mocked Roboflow Workflow HTTP. They verify exact JSON/base64 body/API-key omission, Workflow output Zod schema/class map, source/1280×720 letterbox inverse transform, fiducial projection fixtures, deterministic reference-medoid/frame-index tie, active camera-bump/gradual-drift/marker-loss rejection, per-frame active mapping rather than stale-reference mapping, frame identity/timestamps, four-frame concurrency, full 640-frame scheduler/deadline behavior, timeout/retry classification, and redaction; they do not claim model accuracy. The separate real Workflow benchmark is pre-policy only, never demo CI.
- Free-analysis tests cover Free media duration/orientation boundaries, uniform sample count, portrait acceptance, demo fixture selection, confidence filtering, unequal/zero/non-finite timestamp deltas, exact rate threshold, half-up visibility/activity rounding/ranges, one/two-tip ordering, and an import/repository boundary proving `FreeInsightAssembler` cannot call score, policy, or leaderboard modules.
- API tests use Fastify injection and isolated temporary persistence/storage. Cover challenge/calibration-session lifecycle, anonymous-device scoping, exact multipart single-part/extras/name-MIME/file-byte/envelope-limit/202/duplicate/transition/owner/queue/abort behavior, magic-byte/FFprobe rejection, verified orientation/resolution/duration/continuity/reference-calibration/active-stability binding, Free media acceptance, FreeInsight Zod storage/HTTP parity including tips, separate queue/repository/coordinator seams, asynchronous completion, safe invalid integrity result, retryable failure, report retrieval, competitive leaderboard filtering/live response, transactional duplicate/concurrent completion, delete-versus-finalize race, receipt import/staleness/invalidation policy behavior, retention scavenger restart/clock advance, health, and each negative readiness dependency.
- Security tests simulate traversal/symlink names, aborts, failed renames, and provider errors. They assert restrictive file modes, atomic cleanup, no absolute media path, no key/header/raw-payload leak, and HTTPS/unauthenticated-public configuration rejection.
- Web tests cover every named control and disabled/loading/error/empty state: production verified/Free no-call-unavailable until their W4/W5 tracers, W2/W3 direct fake-port isolation, browser capture state/timing/MIME/cleanup, shared upload progress/cancel/retry/error/abort fixtures, processing polling, foreground/resume refresh, safe retry path, parsed-response-only Free tips, result truth labels, and absence of competitive language/data for Free Training or demo/experimental results. One browser flow covers the verified happy path.
- Mobile tests cover the same visible states through component/router boundaries, including production verified/Free no-call-unavailable until M5, M2–M4 direct fake-port isolation, preview/controller permission states, file-picker cancel, shared upload fixtures, M5 terminal states, byte progress, app foreground/resume, parsed-response-only Free tips, and no closed-app notification assertion. Native camera hardware and OS permission behavior are mocked in CI.
- Integration starts API in demo mode and drives web against the real HTTP boundary. It asserts a demo result is reported yet cannot create a normal leaderboard entry without live receipt/workflow; a policy-approved mocked Roboflow fixture with a parsed passing receipt is the separate positive competitive-write test.
- Design QA compares approved references and implementation captures at identical desktop/mobile viewport, scale, route, state, and fixture, using an overlay/diff. P0–P2 mismatches block handoff until independently reviewed; P3 polish may be recorded.
- Full repository verification runs format check, lint, typecheck, tests, build, and integration smoke before final review.

## Out of Scope

- Production athlete authentication, cross-device identity synchronization, guardianship, age verification, consent, billing, or payments.
- Real scout accounts, clubs, recruitment workflows, messaging, or offers.
- Production-grade anti-cheat disclosure or adversarial hardening.
- Multi-instance production queue, cloud object storage, CDN, or deployment vendor binding.
- Training or fine-tuning a custom computer-vision model.
- Claiming validated sports-science measurements or physical impact force.
- LLM summaries, coaching plans, or medical/injury recommendations.
- Field football, volleyball, basketball, handball, or additional challenge types beyond visual placeholders.
- Push-notification provider integration; MVP refreshes processing status only while foregrounded or on resume/manual refresh.
- Production privacy, retention, deletion, biometric governance, or legal compliance program.

## Further Notes

- MVP optimizes learning and architectural honesty, not production readiness.
- Any screen using fixture results must visibly say demo and “não vale para ranking.”
- Real model experiments require a server-approved model/workflow/provider/calibration-policy record and separate accuracy evaluation against labeled video before competitive use.
- A1 copies approved visual references and accepts a separate standalone hero according to `docs/design/asset-manifest.md`; clients cannot begin until the manifest checksum/dimension and hero-acceptance gate passes.
