# RevelAI Core Platform Implementation Plan

**Goal:** Build the tested monorepo/API vertical slice for Free Training and the verified wall-pass challenge without allowing demo or unvalidated analysis to write competitive facts.

**Authoritative behavior:** `CONTEXT.md`, ADR 0001, ADR 0002, and `docs/specs/2026-08-30-revelai-mvp.md`. Cross-plan dependency order is in `2026-08-30-revelai-delivery-dag.md`; this plan owns nodes C0–C10 and asset gate A1.

**Boundaries:** TypeScript/pnpm/Turborepo; Fastify API; Zod single-source transport schemas; pure domain package; SQLite/repository interfaces; local development media/queue adapters; FFprobe/FFmpeg plus image HTTP inference. No client, provider, fixture, or worker chooses integrity outcome or `competitiveEligible`.

## Global implementation rules

- Keep the default path demo-only. Provider output has required discriminated provenance only; API policy evaluates demo provenance to `competitiveEligible: false`; default MVP has no approved Roboflow policy record.
- Implement the exact `CreateAttemptInput`, `AttemptOutcome`, media, scoring, ranking, retention, and security rules in the MVP specification. Do not create an alternative API shape in a client.
- Public errors use `{ code, message, retryable }`; only `IntegrityEvaluator` maps private evidence to safe invalid retry codes.
- Every task begins with a focused failing test and ends with its focused test, typecheck, and an inspection of `git diff --check` and `git status --short`.
- Commit only after the task's verification passes and reviewer accepts it. Stage only named paths with `rtk git add <paths>`; never use `git add .`. Planning artifacts are staged before implementation artifacts. A human/release workflow, not this plan, decides whether to push.

## C0 — Land the planning baseline first

**Depends on:** none.

**Files:** `AGENTS.md`, `CONTEXT.md`, `docs/agents/*`, ADRs, MVP specification, all plan files, `docs/design/asset-manifest.md`, and `docs/reviews/revelai-planning-fix-report.md`.

- [ ] Review the accepted docs together and confirm no contradiction about demo ranking, identity, or notification behavior.
- [ ] Run `rtk git diff --check` and inspect the documentation-only change set.
- [ ] Confirm `docs/reviews/revelai-planning-fix-report.md` matches the accepted final external fix report before staging; reviewer source reports that remain `CHANGES_REQUIRED` stay outside this commit. Do not name a sibling `work/` path in Git scope.
- [ ] Stage exactly `AGENTS.md CONTEXT.md docs/agents docs/adr docs/specs docs/superpowers/plans docs/design/asset-manifest.md docs/reviews/revelai-planning-fix-report.md` and create the documentation-baseline commit: `docs: make RevelAI MVP contracts buildable`.

**Acceptance:** the documentation commit precedes code work; no source/dependency/lockfile change is mixed into it.

## A1 — Approved design-reference import and hero acceptance

**Depends on:** C1. **Blocks:** W0 and M0.

**Files:** `docs/design/asset-manifest.md`, `docs/design/references/*.png`, `docs/design/assets/revelai-hero-master.png`, `docs/design/assets/a1-asset-receipt.json`, `apps/web/public/assets/futsal-hero.png`, `apps/mobile/assets/futsal-hero.png`, `packages/design-system/scripts/import-approved-design-assets.mjs`, `packages/design-system/scripts/verify-design-assets.mjs`, and their tests.

- [ ] Run the one-time `rtk pnpm import:design-assets` only on a workstation with the manifest's approved external source paths. `import-approved-design-assets.mjs` verifies each external source hash/dimensions before byte-for-byte copying it to the named repository destination; external paths remain manifest provenance and are never required after this import. Screenshots are documentation references only, never runtime hero images.
- [ ] Implement portable `packages/design-system/scripts/verify-design-assets.mjs`; the root `rtk pnpm verify:design-assets` command created in C1 invokes it under Node 22. It reads only repository destinations, manifest destination hashes/dimensions, hero/crops, and receipt; it must never stat/open an external source path. It fails on missing/mutated repository file, wrong dimensions, or missing/false/malformed receipt field.
- [ ] Generate one standalone, text-free, logo-free, sponsor-free, licensed/generated `1600×1200` editorial hero master. Prompt: `young futsal athlete in a black kit training alone on a bright indoor court; warm-white editorial light; ball fully visible; athlete right of centre; calm clean wall/negative space left; no text, brand, logo, sponsor, UI, or device chrome`. Do not crop an approved UI screenshot to make this asset.
- [ ] Have a reviewer record source/generator run ID, SHA-256, dimensions, license/generated status, and acceptance against the no-text/no-logo/full-ball checklist in the required `docs/design/assets/a1-asset-receipt.json`. Create deterministic approved web/mobile crops from the accepted master and test their dimensions/checksums before use. Mutation tests operate only on a temporary copy. A clean post-A1 checkout with the external source directory absent passes `verify:design-assets`; temporary missing/false receipt, destination hash drift, and dimension drift fail it. The importer separately has source-present/source-hash-negative tests.

**Review slice:** assets/manifest only. A1 is accepted before either client renders a visual reference or hero.

## C1 — Reproducible workspace and safe configuration

**Depends on:** C0.

**Files:** root workspace config, `.nvmrc`, `.gitignore`, `.env.example`, `packages/config`, `packages/design-system`, CI scaffold, `README.md`.

- [ ] Test `parseApiEnv({})` defaults to demo/local paths and rejects incomplete Roboflow configuration, non-HTTPS key-bearing provider URLs, production non-HTTPS `PUBLIC_BASE_URL`, and non-loopback unauthenticated bind without `ALLOW_UNAUTHENTICATED_PUBLIC=true`.
- [ ] Configure Node `>=22.19.0`, pnpm `11.20.0`, root `format`, `format:check`, `lint`, `typecheck`, `test`, `build`, `check`, one-time `import:design-assets` (external-source-only), portable `verify:design-assets` (repository-only) that invokes `packages/design-system/scripts/verify-design-assets.mjs`, and a CI demo-only baseline. `check` does not invoke the asset verifier until A1 commits the required assets/receipt.
- [ ] Document env names only. Startup warning must name unauthenticated MVP mode but never print a secret/value.
- [ ] Verify the config and token tests plus root check.

**Review slice:** configuration/test files only. Stage explicit root/config/design-system/CI/README paths.

## C2 — Contracts: identity, creation, outcomes, and history

**Depends on:** C1.

**Files:** `packages/contracts/src/{attempts,results,challenges,errors,workflow-benchmark-receipt,index}.ts` and contract/fixture tests.

- [ ] Write schema tests for header-only UUID identity (no body `athleteId` is accepted), the `free` and `verified` CreateAttempt discriminants, six public lifecycle statuses plus internal tombstone behavior, all four `AttemptOutcome` states, safe retry/failure codes, cursor bounds, and structural omission of competitive fields from `FreeInsight`. Add positive/negative `FreeInsightTip` Zod tests: only the four literal strings, one/two entries, exact athlete-then-ball ordering, and no unparsed client fallback.
- [ ] Define/test `CalibrationSession` creation, exact gate ordering, nonce, 15-minute expiry, owner/challenge/version binding, atomic ready/consume, one-use semantics, and 404/409/410 response codes before any Attempt service work.
- [ ] Export one Zod schema/type for every request and response: challenge list, calibration session, create, exact media-upload request/accepted response, attempt list, attempt read, outcome/result, leaderboard, delete, health, ready, and complete `RouteError`/`InvalidRetryCode`/`FailureCode` unions with retryability.
- [ ] Add shared positive/negative contract fixtures for the exact one-part media wire: field cardinality/name, extension/MIME, file-byte and multipart-envelope limits, success `202`, duplicate/transition/ownership/queue/abort states, and all route errors. Web/Mobile/MSW/Fastify tests import these fixtures rather than restating literals.
- [ ] Define strict `WorkflowBenchmarkReceiptSchema` and fixture set (missing, stale, failed, passing) with schema version, tuple/scheduler/sampling/manifest-set hash/five runs/p95/runAt/invalidation. It is an internal parsed seam: C2 does not require a live Workflow or policy record.
- [ ] Encode `AnalysisProvenance` and `VerifiedResult` as discriminated Zod unions. Only `ranked` permits frozen `rank`, percentile/topPercent/rankingSnapshot; export the independent live `LeaderboardResponse` with cursor/tie fields. `competitiveEligible` is a required API-supplied result field, never provider/create/upload data.
- [ ] Verify contracts tests and typecheck.

**Review slice:** contracts only; reviewers can identify every client-visible field before service code exists.

## C3 — Pure challenge rules, attempt reducer, and score/rank fixtures

**Depends on:** C2.

**Files:** `packages/domain/src/{attempt-machine,wall-pass-v1,scoring,ranking,index}.ts` and tests.

- [ ] Add reducer tests for allowed transitions and terminal immutability; create/import `wall-pass-v1` plus `wall-pass-v1-score-1` constants exactly as specified.
- [ ] Add score fixtures for perfect, asymmetric, low accuracy, zero opportunity, one pass/no cadence interval, threshold equality, `C_i → W_i → C_(i+1)` continuous alternating-foot sequences, missed return, end-of-window outbound contact, and deterministic replay. Verify side attributes to `C_i` and the adjacent return/start contact is not double-lost.
- [ ] Add ranking fixtures for same-score ties, tie-break order, version isolation, one-member cohort, frozen rank/snapshot, live-list mutation after snapshot, and distinction between percentile and topPercent.
- [ ] Verify domain test/typecheck with no network, filesystem, or provider dependency.

**Review slice:** pure domain only; no Zod/HTTP/media imports beyond allowed validation utilities.

## C4 — Repository, anonymous identity scope, and queue seam

**Depends on:** C2 and C3.

**Files:** API app/config/database schema/repositories/queue interface and isolated tests.

- [ ] Test first-use local UUID athlete creation, scope every attempt/list/read/delete query by `X-RevelAI-Athlete-Id`, cursor pagination, one-use calibration-session consume, idempotent processing reservation/lease generation, and tombstone visibility.
- [ ] Create migrations for athletes, calibration sessions (owner/nonce/state/expiry), attempts (public status/deletion state/processing generation), processing events, canonical observations, media-retention records, results, leaderboard entries, `workflow_benchmark_receipts` (canonical parsed receipt/hash/run/expiry/status/invalidation), and approved competitive model policies with receipt ID/hash/schema-version references. Enforce `UNIQUE(result.attempt_id)` and `UNIQUE(leaderboard_entry.result_id)`.
- [ ] Publish the exact separate interfaces in the MVP specification. `AnalysisQueue` has only `isAvailable`, `enqueue(AnalysisJob)`, and `subscribe(deliver)`; it owns at-least-once identifier delivery, not dedupe/reservation/SQLite/finalization/tombstone. `AttemptRepository` owns `attachValidatedMedia`, rollback, `claimProcessing` lease/generation, `finalizeTerminalResult`, and `tombstoneAttempt`; no route accesses SQLite directly. `CompetitivePolicyRepository` separately imports immutable parsed benchmark receipts and activates policies. `AttemptService` coordinates attach → repository → queue, and `AnalysisWorker` coordinates queue delivery → repository claim → processing → repository finalization.
- [ ] Add isolated SQLite repository tests for attach rollback, lease/generation, duplicate-job, concurrent competitive completion, same-score tie, delete-versus-finalize, stale lease, and tombstone; add in-process queue tests only for enqueue/delivery/availability; add coordinator tests using distinct fake queue/repository/policy seams, never one combined mock.
- [ ] Verify persistence tests, missing/stale/failed/passing receipt import/activation fixtures, and a queue-unavailable negative unit test.

**Review slice:** database/repository/queue paths only.

## C5 — Streamed media intake, probing, extraction manifests, and retention

**Depends on:** C4.

**Files:** `apps/api/src/media/*`, `storage/local-media-storage.ts`, media tests.

- [ ] Start with shared upload-fixture tests for exactly one `media` multipart file part, no extra/repeated/text parts, extension/declared-MIME matrix, file bytes exactly at/one byte over `MAX_UPLOAD_BYTES`, `MAX_UPLOAD_BYTES + 65536` envelope cap, false/missing Content-Length, MP4/MOV/WebM magic bytes, malformed/extra stream, empty body, traversal/symlink input, write abort, and atomic cleanup.
- [ ] Implement restrictive `0700` directory / `0600` file setup, opaque exclusive no-follow temp keys, atomic rename after validation, and cleanup on every error/abort. Ensure APIs/logs cannot expose paths or keys.
- [ ] Add FFprobe/FFmpeg fixtures for verified duration 64.0–65.0, rotated landscape display, 1280×720 minimum, 1.30–2.00 aspect, 24-fps minimum, one video timeline, 250-ms timestamp continuity, and the 0.42 active-window scene-cut signal. Separately test Free 3.0–180.0 seconds, short edge 480, 12 fps, and portrait/landscape acceptance without verified continuity/calibration requirements.
- [ ] Extract verified pre-roll/active frames and compute only an immutable raw pre-roll SHA-256 plus extraction manifest in C5. Do not inspect athlete/marker/wall confidence, construct a homography, or decide calibration here; C6 assembles visual geometry and C7 validates it.
- [ ] Implement clock-injected `RetentionScavenger`: startup + 60-minute schedule, original/frame deadline uploaded+23h, temporary deadline +1h, terminal-observation deadline +30d, bounded batch, redacted retry log. Add terminal/deletion, crash/restart, clock-advance, expired original/frame/temp/observation, and failed-delete retry tests.

**Review slice:** media/storage only. No provider or score logic appears here.

## C6 — Free/verified frame providers and observation assembly

**Depends on:** C3 and C5.

**Files:** `packages/vision/src/*`, API `processing/frame-extractor.ts`, `processing/observation-assembler.ts`, `processing/workflow-benchmark.ts`, `scripts/benchmark-roboflow-wall-pass.mts`, provider/scheduler/benchmark contract tests.

- [ ] Define Zod-parsed `VerifiedVisionFrameRequest | FreeVisionFrameRequest`, correlated Free/verified `AnalysisProvenance`, exact Workflow envelope/output discriminants, `FreeVisionObservationBatch | VerifiedVisionObservationBatch`, and FreeObservation/FreeInsightTip types. Compile-time `satisfies` fixtures and Zod negative tests must reject a mixed array, cross-kind frame, and wrong Workflow output/provenance ID for a branch. Prove provider types have no integrity, score, retry, result, eligibility, or policy fields.
- [ ] Implement deterministic demo fixtures for wall-pass-balanced, wall-pass-insufficient, free-well-framed-active, and free-limited-ball. Fixture selection is injected server/test configuration, never a client field; fixtures emit observations/provenance but no integrity conclusion/eligibility.
- [ ] Implement Roboflow Workflow HTTP adapter exactly as ADR 0002: JSON `inputs.image` base64, optional body `api_key` only, no credential header/query, `POST /infer/workflows/{workspace}/{workflow}`, fixed 1280×720 letterbox/inverse transform, required output kind/class map/fiducial/geometry validation, four in-flight requests, 8-s/180-s deadlines, documented retries, and injected fetch tests. Add an injected-clock 640-frame scheduler test proving no more than four in flight, no hidden serial phase, retry accounting, cancellation, and a single 180-s abort deadline.
- [ ] Add the redacted pre-policy benchmark command for the exact configured wall-pass Workflow. It writes a candidate `WorkflowBenchmarkReceiptSchema` JSON to `REVELAI_BENCHMARK_RECEIPT_DIR` with exact tuple, scheduler/sampling, manifest set/hash, five runs, p95, run/expiry, pass/fail, and canonical hash. Its five 640-frame, four-concurrent runs must report pooled dispatch-to-Zod-observation p95 `<=900 ms` and each batch `<=165 s`; CI stays demo-only. Missing/stale/failed/passing receipts are parsed fixtures, not network dependencies. A real passed receipt blocks only real policy activation until remediation/rebenchmark, never C8/demo.
- [ ] Assemble verified tracks/contacts/wall impacts/sides and construct pre-roll plus active per-frame homographies from eight fiducial corners, source/inference transforms, and wall-floor edge. Select `H_ref` as the named-anchor medoid with frame-index tie; use it only for stability comparison, while contact/wall points use each accepted `H_t`. Emit private selected-reference, 576/600 ratio, no-four-unstable-run, anchor median/max drift evidence for C7. Test synthetic projection/reprojection acceptance/rejection, medoid tie, camera bump, gradual drift, marker loss, non-stale point mapping, continuous pass evidence, normalization, request identity, retries, timeouts, provenance, and redaction.
- [ ] Assemble Free observations independently from athlete/ball visibility and normalized athlete-centre movement. Require positive finite adjacent timestamp delta and compute the explicit rate before the unrounded `>=0.015` comparison. Test sample count, confidence filter, unequal/zero/non-finite deltas, threshold and half-up range boundaries, exact one/two FreeInsightTip order, portrait input, and a dependency guard proving Free assembler cannot import scoring/policy/leaderboard modules.
- [ ] Verify provider/assembler tests without real video service or key.

**Review slice:** provider and assembler files only; raw HTTP dialect cannot leak into domain code.

## C7 — API-owned integrity and competitive policy

**Depends on:** C4, C5, C6.

**Files:** `apps/api/src/processing/integrity-evaluator.ts`, `competitive-policy.ts`, service tests.

- [ ] Evaluate verified evidence from C6 and C5 extraction manifest: require 32/40 pre-roll frames with athlete/eight corners/wall confidence, deterministic named-anchor reference selection, valid active `H_t` evidence, 576/600 stable active frames, no four-frame unstable/marker-loss run, DLT/RANSAC inlier/reprojection/wall/drift thresholds, matching raw pre-roll hash, calibration session nonce, and active-media binding. Map any failure—including camera bump/gradual drift/marker loss—to the safe `calibration_not_verified` code. Assert no threshold/signal appears in serialized response or logs.
- [ ] Implement `CompetitiveEligibilityPolicy` lookup against exact model-bundle/workflow ID/workflow version/provider version/calibration/rule tuple and its parsed exact-tuple `WorkflowBenchmarkReceipt`. It evaluates provenance; it does not accept a provider eligibility field. G5 tests the receipt schema and missing/stale/failed/passing fixtures: demo false, unapproved Roboflow false, missing/stale/failed/mismatched receipt false, parsed passing fixture plus approved tuple true, and every mismatch false. These fixtures unlock C8/demo; only an operator activates a real policy after importing a current live passed receipt.
- [ ] Test temporary provider/queue failures become retryable `analysis_temporary_unavailable`, not invalid/valid or a leaderboard write.
- [ ] Verify integrity and policy unit tests plus a redaction assertion.

**Review slice:** service policy/evaluator only; this is the sole implementation site for public integrity mapping and eligibility.

## C8 — Attempt service and narrow HTTP route slices

**Depends on:** C4–C7.

**Files:** `apps/api/src/services/attempt-service.ts`, route files, Fastify injection tests.

- [ ] Implement/read-test `POST /v1/calibration-sessions`, `POST /v1/calibration-sessions/:id/ready`, `POST /v1/attempts`, `GET /v1/challenges`, and `GET /v1/attempts` before media upload routes. Prove header-only identity, session expiry/conflict/one-use behavior, and no public `created` status.
- [ ] Implement/read-test `POST /v1/attempts/:id/media` exactly from C2: identity-scoped single `media` part, no extras, filename/MIME rules, file/envelope byte limits, safe probe/eligibility errors, `202 MediaUploadAccepted`, queue-first guard/rollback, duplicate/transition behavior, and client-abort cleanup/race semantics. Then implement `GET /v1/attempts/:id` and `GET /v1/attempts/:id/result` with the one `AttemptOutcome` schema. Fastify injection imports C2's same positive/negative fixture set.
- [ ] Implement Free Training orchestration separately: Free media rule → Free Vision request → FreeInsightAssembler → valid FreeInsight or retryable failure. It cannot call score/ranking/policy persistence. Test sample fixture choice, no calibration required, exact tip storage/HTTP Zod round-trip parity, and absence of prohibited fields in storage/HTTP response.
- [ ] Implement verified orchestration separately: verified media → verified Vision/evidence → IntegrityEvaluator → one transactional finalization. Normal leaderboard insert is policy-guarded; test valid demo report has no leaderboard entry without any receipt, and approved mock provenance plus `WorkflowBenchmarkReceiptSchema.parse(passingReceiptFixture)` produces frozen rank. C8 never reads a live receipt directory or calls a real Workflow.
- [ ] Implement typed live `GET /v1/leaderboards/wall-pass?version=&ruleVersion=&limit=&cursor=` and `DELETE /v1/attempts/:id` with identity scoping, tombstone/finalization race guard, retraction, and retention queue behavior.
- [ ] Verify route contracts, 4xx media errors, async/idempotency behavior, and all outcomes through Fastify injection.

**Review slice:** one route family per review, not a monolithic API commit.

## C9 — Health, readiness, OpenAPI, and local operator path

**Depends on:** C8.

**Files:** health/readiness/openapi modules, operator docs, Docker compose/profile docs, CI tests.

- [ ] Implement `/health` as liveness and `/ready` as database `SELECT 1`, storage create/delete sentinel, and queue availability. Test each failed dependency produces typed `503`.
- [ ] Generate OpenAPI from the same Zod route schemas and test its paths against contracts.
- [ ] Document demo local start; exact named Roboflow Workflow JSON/base64 contract and required output schema; `WorkflowBenchmarkReceiptSchema` candidate path/import/persistence/staleness/invalidation and real-policy-only activation rule; model-bundle/workflow remediation rule; HTTP/HTTPS constraint; loopback default; unauthenticated-public warning; startup/hourly retention scavenger/deadlines; and no production security/privacy claim.
- [ ] Add log-redaction and readiness-negative jobs; default CI remains demo-only and secret-free.

**Review slice:** operators/docs/CI only.

## C10 — Full demo integration and final verification

**Depends on:** C8 and C9.

- [ ] Drive verified demo flow through actual HTTP: calibration session issued/ready/consumed, compliant fiducial fixture upload, pending outcome, valid **demo/not ranked** result, empty normal leaderboard.
- [ ] Drive Free flow through actual HTTP with portrait fixture and prove sniff/probe/sample → deterministic FreeInsight is returned/listed without calibration, score, policy, or leaderboard paths.
- [ ] Exercise separate mocked approved Roboflow Workflow/policy fixture and prove one transactional normal leaderboard insert, frozen rank/snapshot/tie calculation, duplicate-job idempotence, and delete-versus-finalize non-resurrection. The mock policy must consume `WorkflowBenchmarkReceiptSchema.parse(passingReceiptFixture)` matching its mock tuple; C10 performs no live benchmark or receipt-directory read.
- [ ] Run `rtk pnpm check`, `rtk pnpm build`, integration tests, `rtk git diff --check`, and `rtk git status --short`.
- [ ] Stage only the reviewed Core implementation paths and create the final Core commit after reviewer acceptance.

**Exit criteria:** all contract/domain/API/security/readiness/integration tests pass; no fixture/demo or unapproved model can produce a normal leaderboard entry; no incomplete contract remains for web/mobile.
