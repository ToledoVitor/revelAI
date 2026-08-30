# RevelAI Web Client Implementation Plan

**Goal:** Deliver the approved responsive web identity and a truthful Free Training / verified wall-pass journey using only the Core API contracts.

**Dependencies:** See `2026-08-30-revelai-delivery-dag.md`. W0 requires C1+A1; W1 requires C8+W0; W2 requires W1+C8; W3 requires W2+C8; W4 requires W3+C8; W5 requires W4+W1+C8; W6 requires C10. This plan must not invent transport types, score logic, eligibility rules, integrity reasons, or visual assets.

**Tech baseline:** React, TypeScript, Vite, React Router, TanStack Query, React Hook Form, MSW, Vitest/Testing Library, Playwright, `@phosphor-icons/react`. The shared contracts parse every response. The web app stores the opaque local athlete UUID and puts it in `X-RevelAI-Athlete-Id`; it must never imply authenticated or cross-device history.

## Non-negotiable UI truth and access rules

- Free Training is always headed `Treino livre — análise aproximada`; it exposes insight/provenance only. Score, percentile, `topPercent`, rank, verified state, and leaderboard controls are structurally absent.
- A verified result has one persistent truth treatment adjacent to its heading: `Demo — não vale para ranking`, `Experimental — não vale para ranking`, or `Resultado validado — vale para ranking`. Demo/experimental states never render a rank/percentile or a leaderboard insertion claim.
- Every visible interactive control has an accessible name, clear enabled/disabled condition, focus indication, keyboard operation, loading state, failure state, and empty state. Semantic controls beat reference-image mimicry. Text/actions meet WCAG AA; animations respect reduced-motion.
- Screens may show only safe invalid/failure messages received from `AttemptOutcome`; never infer or explain integrity thresholds. No browser capability (camera, media recorder, local preview) is presented as server certification.
- Use approved reference assets and Phosphor icons only; no custom SVG/CSS/emoji icon substitutes. `Em breve` items are disabled buttons with an accessible explanation, not navigable dead links.
- Each task starts with failing user-facing tests. After every accepted task run focused tests/typecheck/build and `rtk git diff --check`; stage named paths only. Never use `git add .`; commit/push only after reviewer approval.

## W0 — Runtime, shell, responsive home, and visual test harness

**Depends on:** C1 and A1.

**Files:** web package/runtime/config, app providers/router/shell, global tokens/styles, home feature/test, reference-asset wiring, visual test utilities.

- [ ] Consume only the A1-approved manifest references and standalone hero/crop; asset verification must pass before the home can render. Do not use a UI screenshot as a hero.
- [ ] Implement `/` with named controls: `Início`, `Meus treinos`, `Ranking`, `Treino livre`, `Desafio verificado`, and `Analisar treino`. Before their owner nodes are accepted, non-home controls render an accessible unavailable shell saying `Disponível após ativação do fluxo`, make no API call, and do not contain placeholder feature state. W1 activates history, W4 alone activates the full production verified tracer and ranking, and W5 the entire Free tracer; production `Desafio verificado` stays unavailable through W2–W3 and `Treino livre` through W2–W4.
- [ ] Test desktop 1440×1024 and mobile 390×844 semantics/layout, focus, reduced motion, asset checksum gate, and unavailable-shell targets.
- [ ] Set up deterministic fixture selection, screenshot naming, and an overlay/diff utility that captures viewport, DPR, route, state, and fixture in its metadata.

**Review slice:** runtime/home/style/test-harness only.

## W1 — Schema-parsed API client and attempt history

**Depends on:** C8 and W0.

**Files:** `src/lib/api/*`, identity/history feature/tests, router.

- [ ] Write MSW tests that malformed every public response is rejected by `@revelai/contracts`, and that errors retain only `code`, `message`, `retryable`, and status.
- [ ] Implement header injection, `listChallenges`, `createAttempt`, `createCalibrationSession`, `readyCalibrationSession`, exact streamed multipart `uploadAttemptMedia`, `getAttempt`, `getAttemptOutcome`, `listAttempts`, `getLeaderboard`, and `deleteAttempt` from the generated contract. `uploadAttemptMedia` builds only the C2 `media` part and parses `202 MediaUploadAccepted`/every `RouteError`; the header is the sole athlete identity and a JSON `athleteId` field is forbidden.
- [ ] Implement `/training/history` list with explicit empty/loading/error/cursor-retry states. Call it `Meus treinos neste dispositivo`; do not advertise cross-device sync.
- [ ] Test cursor ordering, a deleted item disappearing, no local athlete UUID in rendered text/logs, and shared C2 upload fixtures for accepted body, every media rejection, retryability, and abort-without-response behavior.

**Review slice:** API/identity/history only; no challenge visuals required.

## W2 — Mode choice, challenge list, and calibration setup

**Depends on:** C8 and W1.

**Files:** verified challenge list and calibration feature/state machine/tests.

- [ ] Define one `reviewRoutesEnabled = import.meta.env.DEV || import.meta.env.MODE === "test"` router switch. Register `/_test/verified/setup` only when it is `true`, with an injected fake setup port. When it is `false`, the production router must omit the review route rather than render/redirect its component; initial navigation or an in-app link to that URL resolves through the normal unavailable/not-found boundary without evaluating a review component or fake port. The review route may exercise gates but never calls the real API, creates a CalibrationSession, or creates an Attempt. Production `Desafio verificado` remains an accessible unavailable/no-call control until W4 owns the whole tracer. `Treino livre` likewise remains unavailable/no-call until W5. The client sends opaque identity only in the header and does not render/log it.
- [ ] Implement the visible gates in exact order: device, space, athlete, rehearsal, record. For each show name, progress, one current corrective message, retry/continue condition, camera-preview region with labelled status, and back action. Continue is disabled until that gate passes.
- [ ] In development/test only, provide clearly labelled simulated gate input and direct-route fixture data; production UI says setup guidance is unavailable until the complete capture/result flow activates and never claims technical validity before server review.
- [ ] Test denied camera/browser support, remediation/fallback to existing video, sequential gate completion, back/cancel, and direct-route fake-port isolation. Build the router with production values (`DEV:false`, `MODE:"production"`) and prove both direct initial navigation and in-app navigation to `/_test/verified/setup` and `/_test/verified/capture` cannot mount a review screen/evaluate a fake port or make an API call. Repeat that assertion against a served `vite build --mode production` artifact in Playwright, rather than accepting an environment-mocked unit test as production proof. Also prove production verified and Free controls make zero API calls/created attempts, and make no assertion that client calibration makes a result verified.

**Review slice:** selection/calibration only.

## W3 — Verified capture, existing-video upload, and progress recovery

**Depends on:** C8 and W2.

**Files:** capture/upload feature, upload transport, tests.

- [ ] Register capture/upload UI as `/_test/verified/capture` only behind that exact same `reviewRoutesEnabled = import.meta.env.DEV || import.meta.env.MODE === "test"` switch from W2, injected with `VerifiedDraft`/upload fake. A production router omits this route before route matching: it cannot mount/evaluate the review component or fake port on direct URL entry or client navigation. In review builds it may create a local preview and test the exact wire but never calls production `POST /attempts` or `POST /attempts/:id/media`; production verified control stays unavailable through W3. Show verified requirements before file selection: supported formats, maximum size, landscape 1280×720 minimum, required four-second calibration pre-roll plus 60-second active interval, continuous recording, and two 0.20 m square fiducial boards at the documented world positions.
- [ ] Provide a `BrowserCaptureAdapter` that owns only `idle | requesting-permission | countdown | pre-roll | active | stopping | preview | error | unavailable`. It first requests `getUserMedia` with `facingMode: { ideal: "environment" }` and `audio: false`; a browser-selected non-rear camera is an announced graceful fallback, while denied/unavailable capture exposes existing-video upload. `Prévia da câmera`, current state, countdown, pre-roll, active duration, and each recovery action have accessible text.
- [ ] Provide distinct working controls: `Iniciar gravação`, `Enviar vídeo existente`, `Cancelar envio`, and `Tentar novamente`. Select the first `MediaRecorder.isTypeSupported` candidate in this exact order: `video/mp4;codecs=avc1.42E01E,mp4a.40.2` → `wall-pass.mp4`/declared `video/mp4`; `video/mp4` → `wall-pass.mp4`/`video/mp4`; `video/webm;codecs=vp9` → `wall-pass.webm`/`video/webm`; `video/webm;codecs=vp8` → `wall-pass.webm`/`video/webm`; `video/webm` → `wall-pass.webm`/`video/webm`. Do not start a recorder if none is supported; expose the uploader instead. The chosen declared MIME/name must be accepted by the server's extension/MIME/container rules.
- [ ] Preview runs during a five-second countdown without recording. At zero, start the recorder; record the four-second calibration pre-roll, then exactly 60 seconds active, and automatically stop at 64 seconds of recorder time. A manual/system stop before automatic completion, recorder error, permission failure, or an empty Blob yields actionable error/discard state and never hands an ineligible asset to upload. On successful stop, stop every stream track, create a typed `{ file, name, mime, size }` preview, and offer `Descartar` or handoff to the verified uploader. Discard, route unmount, recorder error, and post-handoff cleanup clear timers/listeners, stop tracks, revoke preview URLs, and clear local media.
- [ ] Render fake-port byte progress, indeterminate preparation, cancellation, C2 byte-limit/media-error mapping, connection retry, and preserved selected-file metadata without exposing server paths.
- [ ] Test fake-timer five-second countdown, four-second pre-roll, 60-second active recording, and automatic 64-second stop; mock streams/MediaRecorder for MIME-name agreement, no-supported-MIME fallback, rear preference/fallback, denied permission, early stop, recorder error, empty Blob, track/timer/listener/preview cleanup, discard/handoff, accessible state announcements, C2 FormData fixture parity, and direct-route zero real-server mutations. Reuse the W2 production-router navigation fixture to prove both review URLs are absent with no fake-port module evaluation; a test-only review build proves the guarded capture route still renders.

**Review slice:** verified upload only.

## W4 — Processing, outcomes, report truth, and ranking

**Depends on:** C8 and W3.

**Files:** production verified tracer orchestration, processing/report/ranking features/tests.

- [ ] This is the first and only production verified activation slice. It registers the sole production verified route, `/verified`, exactly once and composes accepted W2 setup/W3 capture UI into that public tracer; no `/_test/*` route, review fake port, or review component is in its production route branch. In this owner route only, it calls `POST /v1/calibration-sessions`, `POST /:id/ready`, `POST /v1/attempts`, then `POST /v1/attempts/:id/media`. It routes immediately through its own local preview/upload/pending/terminal states; a create or attach cannot occur before that renderer is mounted. Upload uses the C2 single-part FormData/error fixtures and `202` accepted snapshot.
- [ ] Poll `AttemptOutcome` only while `pending`, with 1–5-second capped backoff; stop on every terminal state. Refresh on `visibilitychange` / window focus and offer `Atualizar agora`. State truthfully says processing continues on the server; it never promises a notification after the browser closes.
- [ ] Implement verified terminal screens only: verified valid ranked/demo/experimental, invalid safe-retry, and failure with retryability. FreeInsight rendering belongs solely to W5. Render exact metric units, score/rule version, provenance, frozen rank/snapshot only where schema allows, and live leaderboard response as `Ranking atual`.
- [ ] Explain percentile and `topPercent` distinctly in the ranked report. Equal score position follows API result; client does not calculate rank/score/percentile.
- [ ] Implement leaderboard only from ranked entries and show its challenge/rule/cohort/snapshot state. It must have an explicit empty state while demo is the default.
- [ ] Test W2/W3 production controls make zero server mutation; the production route manifest has exactly one `/verified` owner and it is W4's tracer; and every W4 session/create/attach has its next owner state mounted. These route-isolation assertions are the evidence accepted by `GW` after W4; `GW` never blocks W4 itself. Cover C2 upload success/error/abort fixtures, verified union arms only, live-versus-frozen rank labels, no competitive terms/fields in demo/experimental DOM, safe invalid text only, retry action creates a new Attempt, and focus lands on each route's heading.

**Review slice:** processing/report/leaderboard only.

## W5 — Free Training end-to-end and destructive action state

**Depends on:** C8, W1, and W4.

**Files:** free-training feature/tests; history integration.

- [ ] This slice alone activates `Treino livre`. One click creates only `{ mode: "free" }` and immediately routes to this slice's owned select/upload/pending/failure/valid UI, so no Free Attempt can be orphaned. Before picker show Free-specific requirements: 3–180 seconds, 480-px short edge, portrait or landscape, no fiducial/pre-roll/continuity requirement. Show approximate label before selection, during processing, in valid insight, and in history.
- [ ] Own the Free `pending`, valid FreeInsight, and failure renderer; derive visibility/activity and the one/two exact tips only from parsed API `FreeInsight.tips`, never client calculation or fallback text. Do not render verified invalid state for a Free attempt.
- [ ] Define each visible control: select/replace/cancel video, submit, retry upload, refresh status, begin another free training, delete attempt, and back to history. Delete asks a native browser confirmation naming that media/insight are removed; after API `204`, return focus to `Meus treinos` and announce completion.
- [ ] Test unavailable Free control makes zero API calls through W2–W4; W5 creation always has an immediately owned route; Free fixtures supply tips only through parsed responses (including ordered two-tip case); score/rank/percentile/verified/leaderboard strings cannot render in any Free Training state; and delete empty/error/retry states.

**Review slice:** free path only.

## W6 — Browser integration, visual diff, and independent acceptance

**Depends on:** C10 and W0–W5.

- [ ] Run Playwright against a real demo API for Free flow and verified demo flow. Assert demo result can be seen but normal leaderboard stays empty; add a mocked policy-approved API fixture for ranked rendering only.
- [ ] Capture desktop home at 1440×1024 and mobile route/state captures at 390×844 with the exact same data fixture and device scale as the approved reference. Use overlay/diff, not visual memory.
- [ ] Write `design-qa.md`: each issue includes route, state, viewport, reference/capture names, severity P0–P3, before/after evidence, and reviewer. Fix P0/P1/P2 and obtain an independent reviewer acceptance before exact line `final result: passed`.
- [ ] Run web test, E2E, typecheck, build, repository check, and `rtk git diff --check`; stage only named web/QA/CI paths after acceptance.

**Exit criteria:** all controls are usable and accessible; visual acceptance does not override truth; no demo, Free, or experimental view can look competitively ranked.
