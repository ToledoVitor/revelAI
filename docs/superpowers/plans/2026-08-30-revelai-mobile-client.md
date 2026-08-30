# RevelAI Mobile Client Implementation Plan

**Goal:** Deliver the approved Expo mobile experience for truthful Free Training and verified wall-pass flows using the same public contracts as web.

**Dependencies:** See `2026-08-30-revelai-delivery-dag.md`. M0 requires C1+A1; M1 requires C8+M0; M2 requires M1+C8; M3 requires M2+C8; M4 requires M3+C8; M5 requires M4+M1+C8; M6 requires C10. Mobile may not copy score/ranking/integrity logic, provider transforms, or publish any server secret through `EXPO_PUBLIC_*`.

**Pinned runtime:** Expo SDK `54.0.18`; React Native `0.81.4`; React/React DOM/react-test-renderer `19.1.0`; React Native Web `0.21.0`; Jest `29.7.0`; `jest-expo` `54.0.18`; Metro `0.82.x` supplied by `expo/metro-config` and locked by pnpm. Use Expo Router, TanStack Query, Expo Camera, Expo Document Picker, `phosphor-react-native@2.1.0`, its `react-native-svg@15.12.1` peer, and `expo-secure-store` installed only through `rtk pnpm --filter @revelai/mobile exec expo install expo-secure-store`. The SDK-selected SecureStore version is lockfile/`expo-doctor` verified. Configure Metro with `expo/metro-config`, workspace watch folders, and Expo's package-export resolution; do not install or override a mismatched standalone Metro.

## Non-negotiable mobile truth and access rules

- `EXPO_PUBLIC_API_URL` is the only backend environment value permitted in the client. Roboflow keys, policy records, raw provider response, integrity evidence, media paths, and local identity must never be rendered/logged/shared.
- Free Training permanently says `Treino livre — análise aproximada` and has no score, rank, percentile, `topPercent`, verified label, or leaderboard action. Valid verified screens say exactly demo/not-ranked, experimental/not-ranked, or validated/ranked beside the result heading.
- Every control has an accessible label/hint, 44×44-point minimum target, predictable enabled/disabled/loading/error/cancel state, WCAG-AA-compatible contrast, reduced-motion equivalent, and non-colour state cue. Visual reference does not excuse inaccessible or misleading control.
- `CameraAdapter`, `DocumentPickerAdapter`, and `UploadAdapter` isolate Expo/native modules. Features receive only typed local media, preview/controller state, upload progress, cancellation, retry, and `AttemptOutcome`.
- Server processing can outlive a closed app, but the app only refreshes while foregrounded, on resume, or after the athlete presses refresh. No UI promises closed-app completion notification or push.
- Review scenarios are **not** Expo Router pages: `apps/mobile/src/review-harness/**` is outside `apps/mobile/app/**`, exports only the named test scenarios below, and is never imported by a production route/layout. It has no pathname, URL, or deep-link registration. Native and Expo-web test harnesses may import it with injected fake ports; a production router must resolve every former review candidate to `+not-found` without mounting a simulated screen or evaluating a fake port.
- Start every task with a failing component/router contract test and end with focused test, typecheck, Expo web export, and `rtk git diff --check`. Stage named paths only; never `git add .`; reviewer acceptance precedes commit/push.

## M0 — Expo runtime, pin verification, home, and visual harness

**Depends on:** C1 and A1.

**Files:** mobile package/app config, Metro/Babel config, Expo Router layout, theme, home feature/test, assets, screenshot test utility.

- [ ] Create exact package declarations/overrides and a test that asserts the runtime matrix, including Expo SecureStore installed by Expo; run `expo-doctor` in CI after install to reject a drifted Expo/RN/React/Jest/Metro/Phosphor/SVG/SecureStore set.
- [ ] Configure `expo/metro-config` for pnpm workspace packages and ensure `@revelai/contracts` resolves once. Test native and `export:web` bundling.
- [ ] Consume only A1-approved reference assets and standalone hero/crop; asset checksum verification precedes render. Implement accessible home controls: `Treino livre`, `Desafio verificado`, `Analisar treino`, history, and ranking. Before M1/M5 owns each feature, non-home controls route only to an accessible `Disponível após ativação do fluxo` shell, make no API call, and contain no placeholder feature logic; both production `Treino livre` and `Desafio verificado` stay unavailable until M5 owns their complete tracers. Disabled future sports retain an accessible `Em breve` explanation.
- [ ] Create deterministic reference capture metadata for 390×844: route, fixture, state, DPR, font-load state, and timestamp.

**Review slice:** boot/home/theme only.

## M1 — Shared API client, local identity, history, and union rendering seam

**Depends on:** C8 and M0.

**Files:** typed API client, local identity store, history screens/tests.

- [ ] Generate/persist one opaque athlete UUID with `expo-secure-store`; pass it only as `X-RevelAI-Athlete-Id`. It is an MVP local-history key, not an account or cross-device synchronization feature.
- [ ] Parse every API request/response with `@revelai/contracts`. Implement create/calibration/ready-calibration/exact single-part media upload/attempt/outcome/list/live-leaderboard/delete methods and normalized `RouteError` transport errors. Upload constructs only C2's `media` field and parses `202 MediaUploadAccepted`; JSON request bodies never contain athlete identity.
- [ ] Implement history as `Meus treinos neste dispositivo` with cursor, refresh, loading, empty/error, delete, and accessibility announcements. Never show identifier value.
- [ ] Test malformed schemas, all `AttemptOutcome` discriminants, header injection, C2 shared upload success/rejection/retryability/abort fixtures, cursor states, delete success/failure, and no secrets/identity in rendered/error text.

**Review slice:** API/identity/history only.

## M2 — Verified challenge choice, preview/controller, and calibration

**Depends on:** C8 and M1.

**Files:** `apps/mobile/src/review-harness/VerifiedSetupReviewScenario.tsx`, `review-ports.ts`, calibration state machine/screen, `CameraAdapter`, component/router tests. Nothing in this review slice is placed under `apps/mobile/app/**`.

- [ ] Request camera permission through the adapter and render all controller states: requesting, denied, unavailable, preview loading, live preview, gate checking, corrective message, ready, and fallback-to-upload. Permission denied never leaves a disabled unexplained screen.
- [ ] Implement the named component-harness scenario `review:verified-setup` in `apps/mobile/src/review-harness/VerifiedSetupReviewScenario.tsx`, injected with a fake setup port. It is rendered only by native/Jest and Expo-web component/router harness tests, never by Expo Router; do not create `app/(test)/**`, `app/_test/**`, or any other review page. Each phase exposes title, progress, visible preview/overlay label, checklist, one correction, back, retry, and disabled/enabled continue rule. It may simulate the ordered gate/ready response but must not call real CalibrationSession `/ready`, create an Attempt, or activate production verified navigation; M5 owns those mutations after the full tracer exists.
- [ ] The preview has an accessible `Prévia da câmera` label plus text equivalent for framing/grid/marker overlays. It uses rear-camera guidance; UI does not claim technical validity before server review.
- [ ] Development/test simulated gates are visibly labelled. Test sequential transitions, correction, cancellation, denied/unavailable device, reduced motion, screen-reader labels, fake-port isolation, and zero production API calls/Attempts from M2. In a native production-linking harness and an Expo-web production export/router harness, open each former review deep link (`revelai://verified/setup`, `revelai://verified/capture`, `revelai://verified/upload-pending`; and their Expo-web `/verified/setup`, `/verified/capture`, `/verified/upload-pending` forms): each must reach `+not-found`, evaluate no `review-harness`/fake-port module, and make no API call.

**Review slice:** setup/calibration only.

## M3 — Native capture and existing video adapters

**Depends on:** C8 and M2.

**Files:** `apps/mobile/src/review-harness/VerifiedCaptureReviewScenario.tsx`, camera/document adapters, local-media types, component tests. Nothing in this review slice is placed under `apps/mobile/app/**`.

- [ ] Expose `CameraAdapter.record({ durationSeconds: 60, calibrationPreRollSeconds: 4, countdownSeconds: 5 })` only through the named non-router component-harness scenario `review:verified-capture` in `apps/mobile/src/review-harness/VerifiedCaptureReviewScenario.tsx`, with injected draft/upload fake; it has no URL/deep link and cannot call `POST /v1/attempts` or attach media. Render countdown, recording, stop/error, post-record preview, discard, and select actions. UI describes the 64–65-second continuous asset shape, 60-second scored interval, and two 0.20 m square fiducial boards at the documented positions.
- [ ] Expose `DocumentPickerAdapter.pickVideo()` with explicit verified MP4/MOV/WebM, size, landscape/minimum resolution, continuous-video, calibration pre-roll, and fiducial requirements before the picker opens.
- [ ] `LocalMedia` is only `{ uri, name, mime, size? }`; no Expo module object escapes. Selection cancel returns to actionable capture state without error; unsupported/unknown size yields actionable preflight text but final authority remains server probe.
- [ ] Test permission denial, five-second countdown, capture cancel/discard, picker cancel, C2 media-wire client preflight, non-router fake-harness zero server mutations, and all visible button/accessibility states. The shared production-link fixture proves this scenario is unreachable on native and Expo web rather than merely harmless after mounting.

**Review slice:** adapter/capture only.

## M4 — Progress-capable upload and processing recovery

**Depends on:** C8 and M3.

**Files:** `apps/mobile/src/review-harness/VerifiedUploadPendingReviewScenario.tsx`, multipart upload adapter/hook, processing screen, component tests. Nothing in this review slice is placed under `apps/mobile/app/**`.

- [ ] `UploadAdapter` accepts local URI/FormData and reports `{ sentBytes, totalBytes?, phase }`, cancellation, retry, and C2 typed route error. Render percentage only with known total; otherwise render an accessible indeterminate progress state. Never show a local/server path.
- [ ] M4 is the named non-router component-harness scenario `review:verified-upload-pending` in `apps/mobile/src/review-harness/VerifiedUploadPendingReviewScenario.tsx`, with an injected fake attempt/upload port and prebuilt `VerifiedDraft`. It has no URL/deep link, never creates a real CalibrationSession/Attempt, never calls real attach media, and never activates Free. Render prepare/upload/cancel/retry, C2 server-media-error fixture, queued, processing, refresh-now, and back-to-history states. Cancel models the C2 abort race; no production mutation occurs.
- [ ] Poll strictly while public outcome is `pending` with 1–5-second capped backoff. Subscribe to AppState: pause polling in background; immediate refetch on foreground; no timer/push claim when terminated.
- [ ] Test byte progress, missing total, cancellation, C2 upload/pre-terminal route-error fixtures, app background/foreground transition, pending polling stop, fake-port isolation, and zero production API calls/Attempts from M4. Assert a production route/layout import-graph check rejects every `review-harness/**` import. Terminal invalid/failed text and assertions belong only to M5.

**Review slice:** upload/processing only.

## M5 — Result, Free Training, ranking, and delete states

**Depends on:** C8 and M1/M4.

**Files:** `apps/mobile/app/verified.tsx` (the sole production verified pathname), production verified tracer/report/free/leaderboard routes and features/tests; history integration.

- [ ] This is the first and only production activation slice for both modes. It registers exactly one production verified Expo Router pathname, `/verified`, through `apps/mobile/app/verified.tsx`; this M5 `ProductionVerifiedTracer` owns setup, capture, upload, pending, and terminal stages internally. No `/verified/setup`, `/verified/capture`, `/verified/upload-pending`, `/(test)`, `/_test`, or alternate verified tracer is registered below `app/**`. It composes accepted M2/M3/M4 components only with production ports and, in M5 only, calls `POST /v1/calibration-sessions`, `POST /:id/ready`, `POST /v1/attempts`, and `POST /v1/attempts/:id/media` for verified; it mounts local preview/upload/pending/terminal ownership before each mutation. It also activates Free and creates `{ mode: "free" }`, immediately routing to its owned select/upload/pending/failed/valid path. The Free feature reuses adapter/upload only after that creation and shows its distinct requirements (3–180 seconds, 480-px short edge, portrait/landscape, no fiducial/pre-roll/continuity). It renders API-provided Free observations and exact one/two ordered tips only through parsed `FreeInsight.tips`; static/test assertions prohibit score/rank/percentile/topPercent/verified/leaderboard nodes.
- [ ] Render verified metrics with units, score, rule version, provenance, and retry/share actions. Only ranked schema branch renders frozen percentile, top-percent phrase, cohort snapshot, and rank; live leaderboard response is separately labelled `Ranking atual`. Share uses a human-readable result summary without a media URL, local UUID, secret, or hidden evidence.
- [ ] Render invalid (`retryable: true`) with the safe message, explanation to retry capture, and new-attempt action; render failed with retry button only when `retryable`. No internal detection wording appears.
- [ ] Define deletion confirmation/cancel/loading/success/error. Success removes the item, announces outcome, and moves focus to history; it does not promise recovery.
- [ ] Test M2–M4 production controls make zero server mutations; the native and Expo-web production route manifests have exactly one `/verified` match owned by `ProductionVerifiedTracer`; and every former review URL/deep link reaches `+not-found` without loading a review scenario/fake port. These route-isolation assertions are the evidence accepted by `GM` after M5; `GM` never blocks M5 itself. Verify `revelai://verified` and the Expo-web `/verified` entry mount that M5 tracer only after this slice is accepted, and every M5 session/create/attach has its next owner state mounted. Cover C2 upload success/error/abort fixtures; Free control makes no call before M5 and M5's Free fixtures receive tips only through parsed response (including two-tip order); verified invalid safe text and retryable/non-retryable failure render only here; demo/experimental labels, empty normal leaderboard in default demo flow, exact ranked branch only, all states/accessibility, and delete/retry/share behavior.

**Review slice:** report/free/leaderboard only.

## M6 — Expo web visual diff and independent mobile acceptance

**Depends on:** C10 and M0–M5.

- [ ] Run component/router tests plus an Expo web preview integration flow against demo API: Free insight works; verified demo report is non-ranked; normal leaderboard remains empty. Include a separate mocked policy-approved ranked fixture.
- [ ] Capture home/challenge/calibration/capture/processing/report at 390×844 using same fixture, route/state, DPR, and font state as references. Overlay/diff captures with the approved image rather than judging by memory.
- [ ] Record `docs/mobile-design-qa.md` with route/state/viewport/reference/capture/severity/reviewer evidence. Fix every P0/P1/P2 and obtain independent acceptance before exact text `final result: passed`; P3 remains explicit backlog only.
- [ ] Run mobile test, typecheck, `export:web`, full repository check/build, `expo-doctor`, and `rtk git diff --check`; stage only named mobile/QA/CI paths after approval.

**Exit criteria:** all native controls have a truthful accessible state; adapter capability limits lead to usable fallback; no Free/demo/experimental state can be mistaken for a competitive verified ranking.
