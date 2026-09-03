# W6 implementation report — browser integration and Web acceptance evidence

## Status

`DONE_WITH_CONCERNS`

The required browser/HTTP, contract-fixture, capture, structural, and CI wiring are implemented and verified. This was the initial record before pre-review remediation; the five historical P0 visual findings below are superseded by the closed remediation record appended on 2026-09-02. Final visual acceptance remains deliberately pending independent Sol review.

## Baseline and commits

- Base: `8cb14d5ab04edd880cc03adb4aa011783328315d`.
- Functional W6 commit: `eabf3ff84e6ed4a4b7f976a91f9fc4a0c8ccd048` (`test(web): add W6 browser acceptance coverage`).
- This report and the W6 QA record are committed separately as evidence after the functional commit.

## Files changed

| Path                                                                | Why                                                                                                                                                                                               |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.github/workflows/ci.yml`                                          | Runs the new secret-free production demo browser trace before the immutable canonical Linux visual gate.                                                                                          |
| `apps/api/scripts/start-local-demo.mjs`                             | Adds private `--serve-check` lifecycle support so an HTTP server can use the existing deterministic C10 check probe/extraction seam. The default demo command is unchanged.                       |
| `apps/web/package.json`                                             | Adds `test:demo:e2e`, building the API workspace and the production Web client before Playwright.                                                                                                 |
| `apps/web/playwright.demo.config.ts`                                | Dedicated production-client/demo-API test config; it enables the suite only there so W0–W5's development visual run does not collect it.                                                          |
| `apps/web/scripts/start-demo-e2e-server.mjs`                        | Starts a static production client, proxies `/v1` to the real local Fastify demo server, creates deterministic C10 check media bytes, and cleans its private scratch/media state.                  |
| `apps/web/src/visual/demo-api.e2e.visual.spec.ts`                   | Visible-control Free and Verified browser traces against the real API HTTP boundary, with request/body/truth assertions and no API mocks.                                                         |
| `apps/web/src/visual/ranked-policy-fixture.ts` and `.test.ts`       | Isolated schema-parsed competitive fixture for the positive ranked rendering capture; it performs no policy or ranking calculation.                                                               |
| `apps/web/src/visual/approved-reference.visual.spec.ts`             | Deterministically drives and records the six mobile approved-reference states through the extended W0 artifact pipeline.                                                                          |
| `apps/web/src/visual/visual-harness.ts`, `.node.ts`, and `.test.ts` | Registers route/state/reference metadata and writes normalized reference, candidate, 50% overlay, unmasked diff, and metadata for each W6 state. Existing W0 home budgets/masks remain unchanged. |
| `apps/web/design-qa.md`                                             | Preserves W0 history and records the complete W6 inspection, findings, truth rulings, risks, and pending independent acceptance.                                                                  |

## Test-first evidence

### RED

- `rtk pnpm --filter @revelai/web exec vitest run src/visual/visual-harness.test.ts` initially reported `TypeError: getVisualReference is not a function`: **1 failed, 3 passed (4)**. The test was added before the state/reference registration API.
- `rtk pnpm --filter @revelai/web exec vitest run src/visual/ranked-policy-fixture.test.ts` initially failed module resolution for `./ranked-policy-fixture`: **1 failed**. The fixture did not exist yet.
- The first production-demo attempts exposed a missing server/config path and the unavailable host `ffmpeg` executable. This was a genuine environment/runner red result, not converted into a mock API pass. The final runner instead uses the existing deterministic C10 check probe/extraction seam while retaining Fastify, C4/C5 storage, queue, worker, and demo provider boundaries.
- A preserved-suite red run caught the initial scope error where the new demo specs were collected by the development structural runner: **4 failed, 25 passed, 9 skipped**. The two dedicated demo tests were each collected for desktop and mobile without their required production server. `REVELAI_DEMO_E2E` now limits them to `playwright.demo.config.ts`; no W0–W5 test was weakened.

### GREEN

- `rtk pnpm --filter @revelai/web exec vitest run src/visual/visual-harness.test.ts`: **4 passed**.
- `rtk pnpm --filter @revelai/web exec vitest run src/visual/ranked-policy-fixture.test.ts`: **1 passed**.
- `rtk pnpm --filter @revelai/web exec playwright test src/visual/approved-reference.visual.spec.ts --project mobile-home --config playwright.config.ts`: **1 passed**.
- `rtk pnpm --filter @revelai/web run test:demo:e2e`: **2 passed (6.0s)** after API workspace build and production Web build.
- `rtk pnpm --filter @revelai/web run test:visual:structural -- --reporter=line`: **25 passed, 13 skipped (12.9s)**. The four intentionally dedicated demo test/project combinations and pixel-only paths are skipped.
- `rtk pnpm --filter @revelai/web run test:visual:darwin -- --reporter=line`: **29 passed, 9 skipped (16.4s)**, including the two existing local-pixel comparison/negative-proof cases per project.
- `rtk pnpm check`: exit **0**. Formatting passed; lint was **7/7** successful; typecheck was **12/12** successful; test was **12/12** successful; build was **7/7** successful.
- `rtk git diff --check 8cb14d5ab04edd880cc03adb4aa011783328315d`: exit **0**.

## Real demo browser evidence

`apps/web/src/visual/demo-api.e2e.visual.spec.ts` does not install a Playwright route handler and does not call client/API helpers to simulate application work. `apps/web/scripts/start-demo-e2e-server.mjs` serves `apps/web/dist`, proxies public `/v1` requests to `apps/api/scripts/start-local-demo.mjs --serve-check`, and cleans test-only media/scratch state after the server terminates.

- Free Training: the browser clicks visible `Treino livre`, the observed public request body is exactly `{ "mode": "free" }`, an actual multipart upload occurs, pending is visible, terminal `FreeInsight` text is server-generated, and the device-local history entry is visible. The terminal owner text has no `score`, `ranking`, `rank`, `percentil`, `top percent`, `verified`, or `leaderboard` term.
- Verified Challenge: the browser drives all five visible gates, observes calibration issue/ready and the verified attempt creation payload, uploads multipart bytes, sees pending, waits for the real demo terminal, sees persistent `Demo — não vale para ranking`, and queries the normal live leaderboard. The demo report has no position/rank/percentile/top-percent/snapshot claim and the normal leaderboard explicitly remains empty.
- Both traces assert no browser console error or `pageerror`; the real default path is noncompetitive.

The host lacks FFmpeg, so the test media uses deterministic C10-compatible check bytes and the existing check probe/extraction fact seam. It does **not** replace HTTP, storage, queue, worker, demo provider, or UI transitions. A codec-provisioned CI host must still run the host-codec media variant before final release acceptance.

## Ranked-fixture isolation

`policyApprovedRankedOutcome` and `policyApprovedRankedLeaderboard` are schema-parsed from existing `@revelai/contracts` shapes. The fixture is only attached inside `approved-reference.visual.spec.ts` for the ranked capture after the pending state. It supplies `competitiveStatus: "ranked"`, a frozen snapshot (`rank: 3`, `cohortSize: 24`, `percentile: 87.5`, `topPercent: 12.5`), and one live entry. No Web source derives score, rank, eligibility, ties, policy, or receipts. The real demo suite uses no ranked fixture and asserts the opposite truth.

## Approved-reference capture matrix and visual inspection

All state artifacts use CSS screenshots, normalized density `1`, and equal-dimension nearest-neighbour normalized references. Every named reference, candidate capture, 50% overlay, and diff was opened and inspected from the fresh run; no blank, loading, wrong-route, or artificially cropped capture was accepted. The non-home comparisons have `regions: []`: no masking or candidate-derived budget.

| ID     | Route / state / fixture                                               | CSS viewport / DPR / reference             | Artifact stem under `apps/web/coverage/playwright/visual-artifacts/`           | Diff result and inspection                                                                                                                                                                               |
| ------ | --------------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| W6-D01 | `/` / `ready` / `home-default`                                        | `1440×1024`, DPR 1, `desktop-home.png`     | `home-default--1440x1024--dpr-1--root--ready`                                  | Existing W0 capture pipeline and its narrow photo mask/independent ink proof stayed unchanged; desktop visual checks passed in the Darwin run.                                                           |
| W6-V01 | `/` / `ready` / `home-default`                                        | `390×844`, DPR 2, `mobile-home.png`        | `home-default--390x844--dpr-2--root--ready`                                    | 114,561 / 329,160 changed pixels = **34.804%** unmasked. Opened all artifacts. Known runtime photo/crop variance remains governed by the accepted W0 mask/ink proof; P3 confirmation only.               |
| W6-V02 | `/verified` / `challenge-choice` / `verified-challenge-default`       | `390×844`, DPR 2, `mobile-challenge.png`   | `verified-challenge-default--390x844--dpr-2--verified--challenge-choice`       | 90,855 / 329,160 = **27.602%**. Complete but visibly divergent capture; P0 remains open.                                                                                                                 |
| W6-V03 | `/verified` / `calibration-guidance` / `verified-calibration-default` | `390×844`, DPR 2, `mobile-calibration.png` | `verified-calibration-default--390x844--dpr-2--verified--calibration-guidance` | 105,417 / 329,160 = **32.026%**. Complete but visually divergent; P0 remains open.                                                                                                                       |
| W6-V04 | `/verified` / `recording-capture` / `verified-record-default`         | `390×844`, DPR 2, `mobile-record.png`      | `verified-record-default--390x844--dpr-2--verified--recording-capture`         | 127,122 / 329,160 = **38.620%**. Complete visible requirements/capture controls, but the approved composition is absent; P0 remains open.                                                                |
| W6-V05 | `/verified` / `processing-pending` / `verified-processing-demo`       | `390×844`, DPR 2, `mobile-processing.png`  | `verified-processing-demo--390x844--dpr-2--verified--processing-pending`       | 64,207 / 329,160 = **19.506%**. The reference notification promise is intentionally not copied: visible copy truthfully requires foreground/manual refresh. Composition still diverges; P0 remains open. |
| W6-V06 | `/verified` / `ranked-report` / `verified-ranked-policy-approved`     | `390×844`, DPR 2, `mobile-report.png`      | `verified-ranked-policy-approved--390x844--dpr-2--verified--ranked-report`     | 61,144 / 329,160 = **18.576%**. Isolated ranked result visibly says `Resultado validado — vale para ranking`; it is not a demo result. Compact reference composition remains P0-open.                    |

Each stem above has `.png`, `.reference-normalized.png`, `.overlay.png`, `.diff.png`, and `.metadata.json`. The metadata contains the stable route/state/fixture, viewport, DPR, CSS capture scale, normalized density, capture dimensions, reference, comparison threshold, count, and mask declaration. The six W6 non-home/matrix captures were inspected at exact `390×844` CSS dimensions and DPR `2`; W0 preserves the exact desktop home `1440×1024`, DPR `1` pipeline.

## Findings, truth rulings, and risks

- **P0, W6-V02 through W6-V06:** current public Verified states do not achieve the approved mobile visual compositions (diffs above). These are explicit acceptance blockers, not waived P3s. No screenshot image was copied into runtime and no invented asset/design was introduced.
- **P3, W6-V01:** the home unmasked comparison includes the pre-existing approved runtime hero/crop variance. The existing W0 narrow photo-only mask, tight thresholds, focused UI-ink diff, and deliberate-removal proof remain authoritative; Sol must confirm the disposition.
- **Truth ruling — processing:** `mobile-processing.png` promises a closed-app notification. The browser instead presents truthful foreground/manual-refresh guidance and never makes that promise.
- **Truth ruling — report:** `mobile-report.png` is used only with the isolated policy-approved ranked fixture. The real demo report retains `Demo — não vale para ranking` and no ranking claim.
- **Accessibility and UX evidence:** structural coverage retains semantic labels, focus landing, keyboard operation, disabled/enabled states, responsive bounds, reduced motion, and console/page-error assertions. W6 adds visible upload state, pending/refresh, terminal/empty-history checks. This is not a full WCAG conformance claim; W6-V04's long mobile capture instructions remain a scanning risk.
- **Open P3 backlog:** none beyond Sol's confirmation of W6-V01's documented W0 photo-variance disposition.

`apps/web/design-qa.md` deliberately ends with `final result: pending independent Sol acceptance; W6-V01 through W6-V06 remain open.` It does not claim the prohibited `final result: passed`.

## Renderer, CI, and platform limits

- Host: `Darwin arm64`; local pixel runner: `darwin-arm64-local`.
- `rtk pnpm --filter @revelai/web run test:visual:canonical` exits **1** by design with `Canonical visual pixels require linux/x64.` No local canonical acceptance was manufactured.
- The unchanged pinned CI canonical command uses `mcr.microsoft.com/playwright@sha256:dcc5531e97840b9b5e794f2814476b21571c5124a3fca2267d73041f56e7580e`, `--platform linux/amd64`, and `--network none`, selecting `playwright-1.62.1-noble-linux-amd64`. The workflow now runs `pnpm --filter @revelai/web run test:demo:e2e` before it. Hosted CI owns final canonical pixels.

## Self-review

I manually reviewed the full W6 diff against the brief and repository conventions after the required `code-review` workflow was found to require subagents; the W6 brief explicitly prohibits subagents. The review found and fixed the only regression: demo-only specs were being collected by the normal visual suite. No destructive Git operation, broad staging, push, unapproved visual asset, API mock in a real-demo trace, altered W0 budget, or production review route was introduced.

Remaining concerns are the five real P0 visual gaps, required independent Sol acceptance, hosted Linux/x64 canonical pixels, and the host's absent FFmpeg executable for a true codec-backed C10 media run.

## Remediation after pre-review — 2026-09-02

### Status

`DONE_WITH_CONCERNS` — all pre-review actionable W6 P0/P1/P2 findings are remediated in the production Web owner. Independent Sol acceptance and hosted Linux/x64 canonical pixels remain intentionally pending. Remaining P3 evidence is limited to the approved runtime hero/crop and the required truthful removal of the source's closed-app notification promise.

### Additional commit

- Remediation functional commit: `b20bf023c56038194eeb980c9434cad1b243cc01` (`feat(web): complete verified state acceptance`).

### Changed files and why

| Path                                                                                              | Why                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/src/verified/tracer.tsx`                                                                | Adds the public challenge-choice state before setup ownership; provides the styled real calibration, capture, pending, and ranked-report states while preserving existing HTTP, setup, upload, polling, and result boundaries.                    |
| `apps/web/src/verified/production-capture.tsx`                                                    | Adds the approved hero fallback only while a real camera stream is absent, preserves the real `<video>`, and makes requirements semantic disclosure.                                                                                              |
| `apps/web/src/styles.css`                                                                         | Uses existing tokens and bundled Bebas/Arimo faces for editorial layout, normal borders, real-control states, progress, timeline, metrics, and responsive presentation. No screenshot, new raster, CSS illustration, or custom SVG is introduced. |
| `apps/web/src/verified/{tracer,production-capture}.test.tsx`                                      | Covers choice-before-owner ordering, camera fallback controls, ranked-only fields, and the real passed-device calibration rail.                                                                                                                   |
| `apps/web/src/{home/home.test.tsx,production-router-harness.test.ts}`                             | Updates direct public-route assertions to the new real choice boundary.                                                                                                                                                                           |
| `apps/web/src/visual/{approved-reference,demo-api.e2e,production-route-isolation}.visual.spec.ts` | Drives choice explicitly before calibration in production/demo paths and verifies `/verified` has no calibration mutation before the player prepares wall pass.                                                                                   |
| `apps/web/design-qa.md`                                                                           | Records the before/fix/after remediation comparison and pending independent acceptance.                                                                                                                                                           |

### RED/GREEN evidence added in this remediation

- **RED:** `rtk pnpm --filter @revelai/web exec vitest run src/verified/tracer.test.tsx --reporter=verbose` — **1 failed, 41 passed (42)** before `ChallengeChoice` existed; the expected public choice heading was absent.
- **RED:** `rtk pnpm --filter @revelai/web exec vitest run src/verified/production-capture.test.tsx --reporter=verbose` — **1 failed, 9 passed (10)** before the approved fallback image existed.
- **RED:** `rtk pnpm --filter @revelai/web exec vitest run src/verified/tracer.test.tsx -t 'preserves the gated setup correction' --reporter=dot` — **1 failed, 41 skipped (42)** before `displayedPassedGates` reflected the actually-complete device step; observed `data-passed="false"`.
- **GREEN:** `rtk pnpm --filter @revelai/web exec vitest run src/verified/tracer.test.tsx src/verified/production-capture.test.tsx --reporter=dot` — **52 passed**.
- **GREEN:** `rtk pnpm --filter @revelai/web exec vitest run src/home/home.test.tsx src/production-router-harness.test.ts src/verified/tracer.test.tsx src/verified/production-capture.test.tsx --reporter=dot` — **63 passed**.

### Fresh design-QA remediation matrix

Every item below was captured after `b20bf02`, at `390×844` CSS pixels, DPR 2, CSS scale, normalized density 1. Reference, capture, 50% overlay, and complete unmasked diff were opened and inspected. Artifact directory: `apps/web/coverage/playwright/visual-artifacts/`.

| Finding                 | Exact code fix                                                                                                             | Fresh artifact stem                                                            | Full unmasked ratio / outcome                                                                                                                        |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| W6-V02 challenge choice | `ChallengeChoice` + `TracerStage` `challenge`; move setup only from `Preparar desafio`.                                    | `verified-challenge-default--390x844--dpr-2--verified--challenge-choice`       | **23.596%**. Card/disabled rows/CTA/headline are present; approved hero subject/crop is P3 only.                                                     |
| W6-V03 calibration      | `SetupProgress`, `CalibrationGuidance`, `displayedPassedGates` use actual gate/camera state.                               | `verified-calibration-default--390x844--dpr-2--verified--calibration-guidance` | **38.174%**. Rail, passed device, active correction, truthful blocked guidance and hero region are present; unavailable source court art is P3 only. |
| W6-V04 capture          | real camera conditional plus `capture-fallback-image`, semantic requirements disclosure and control layout.                | `verified-record-default--390x844--dpr-2--verified--recording-capture`         | **34.494%**. Actual camera remains primary when present; approved fallback/crop difference is P3 only.                                               |
| W6-V05 pending          | semantic `processing-timeline`, foreground/manual refresh copy, no closed-app promise/control.                             | `verified-processing-demo--390x844--dpr-2--verified--processing-pending`       | **25.132%**. Timeline hierarchy is present; removed notification/image-strip source content is required truth/asset P3 only.                         |
| W6-V06 ranked report    | `VerifiedReport` scorecard/metrics/insight; ranked branch is isolated and demo/experimental structurally lack rank fields. | `verified-ranked-policy-approved--390x844--dpr-2--verified--ranked-report`     | **16.812%**. Persistent exact competitive truth and report hierarchy are present.                                                                    |

Fidelity surfaces reviewed in every row: Bebas/Arimo typography and wrapping; spacing/rhythm at 390px; warm-white/deep-emerald/border tokens and contrast; approved image quality/crop; Portuguese copy, truth, controls, and Phosphor icon affordance. Focused state comparisons were performed for challenge controls, passed calibration status, live/fallback camera boundary, manual refresh, and rank-field isolation. No P0/P1/P2 remains actionable.

### Verification after remediation

- `rtk pnpm --filter @revelai/web run lint` — exit 0.
- `rtk pnpm --filter @revelai/web run typecheck` — exit 0.
- `rtk pnpm run test:production-router` — **23 passed**.
- `rtk pnpm run test:demo:e2e` — **2 passed**, production build with real local demo HTTP boundary.
- `rtk pnpm run test:visual:structural` — **25 passed, 13 skipped** (the dedicated demo production tests and inapplicable pixel-only paths are skipped by design).
- `rtk pnpm run test:visual:darwin` — **29 passed, 9 skipped**; fresh artifact matrix emitted and inspected.
- `rtk pnpm run test:visual:canonical` — expected exit **1** on Darwin/arm64: `Canonical visual pixels require linux/x64.`
- `rtk pnpm check` — exit **0**: format, 7 lint tasks, 12 typecheck tasks, 12 test tasks, 7 build tasks successful; Web suite **27 files / 283 tests** passed, structural browser run **25 passed / 13 skipped**.
- `rtk git diff --check` — exit 0 before functional commit.

### Self-review and concerns

Manual review confirms that the new choice screen has no request-producing effect; the calibration session starts only after all true gates and the existing next owner boundary. Capture displays a real stream when available, falls back only to the approved asset, and retains accessible source/video controls. Pending makes no notification promise. Ranked presentation comes only from the existing isolated policy-approved fixture; demo and experimental DOM never contain ranking snapshot or top-percent fields.

Do not mark `apps/web/design-qa.md` as passed: its final line remains `final result: pending independent Sol acceptance.` Concerns: final Sol review, hosted Linux/x64 canonical pixel gate, and the pre-existing lack of a host FFmpeg codec run remain external acceptance work; no functional P0/P1/P2 remains.

## Round-1 reviewer remediation — 2026-09-02

### Status

`DONE_WITH_CONCERNS`. The code/test fixes for every round-1 Critical/Important finding are committed. The implementation is intentionally not self-accepted: hosted codec-backed browser acceptance, the unchanged Linux/x64 canonical visual gate, and independent Sol review remain pending.

This section supersedes earlier statements that the local `test:demo:e2e` check-fact runtime was a real-media acceptance. It is now strictly a separate smoke path.

### Commit ledger

| Commit                                     | Role                                                                                             |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `8cb14d5ab04edd880cc03adb4aa011783328315d` | Required W6 base.                                                                                |
| `eabf3ff84e6ed4a4b7f976a91f9fc4a0c8ccd048` | Initial W6 functional/browser coverage.                                                          |
| `5e46a75`                                  | Initial W6 evidence/report commit (recorded here to repair the previously omitted ledger entry). |
| `b20bf023c56038194eeb980c9434cad1b243cc01` | Prior verified-state remediation.                                                                |
| `b71abc2`                                  | Round-1 review base.                                                                             |
| `94a13e68d65482f1d9d66ad0ab939c07124223a1` | Round-1 functional/test/CI remediation: enforce W6 visual acceptance.                            |

### Files changed in this round

| Path                                                                                                   | Reason                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.github/workflows/ci.yml`                                                                             | Provisions FFmpeg before the normal demo-browser command so the hosted acceptance path generates and probes actual C10 media.                                                           |
| `apps/web/{package.json,vitest.config.ts,playwright.demo.smoke.config.ts}`                             | Includes the Node codec-fixture test in the standard Web test command, prevents Vitest from miscollecting it, and isolates check-fact smoke from normal demo acceptance.                |
| `apps/web/scripts/{demo-media-fixtures.mjs,demo-media-fixtures.test.mjs,start-demo-e2e-server.mjs}`    | Generates FFmpeg MP4s, validates them with FFprobe, starts normal API runtime by default, and retains `--serve-check` only for smoke.                                                   |
| `apps/web/src/{app.tsx,styles.css}`                                                                    | Adds durable visual landmark hooks and compact mobile layout without changing W0 budgets.                                                                                               |
| `apps/web/src/verified/{tracer,production-capture}.{tsx,test.tsx}`                                     | Restores `3 metros`, uses native disabled upcoming buttons, prevents focus scroll, makes file selection keyboard-operable, and adds regression coverage.                                |
| `apps/web/src/visual/{visual-harness,visual-harness.node,approved-reference.visual.spec}.{ts,node.ts}` | Adds fixed W6 per-state visual thresholds, landmark/crop/mismatch rejection, capture metadata, reset-scroll assertion, and 390px browser semantics/keyboard/focus/state/error evidence. |
| `apps/web/design-qa.md` and this report                                                                | Separate evidence record, after-artifact inspection, exact tests, and pending acceptance disposition.                                                                                   |

### Critical 1 — non-home visual acceptance is now enforceable

`captureReferenceVisualArtifacts` does not set all non-home limits to `1` any more. `referenceVisualGates` is an independent static reference policy: challenge `0.25`, calibration `0.40`, capture `0.36`, pending `0.30`, report `0.20`. Its source/rationale is the selected W6 references, unmasked whole-screen comparison, and only the documented approved-media or truth deltas. The values are code-owned, stable before a capture is evaluated, and not serialized from the candidate. Existing W0 home metrics, photo mask, renderer baselines, and budgets are untouched.

For every `/verified` screenshot the runner first collects `[data-visual-landmark]` boxes, rejects missing/zero-size/outside-viewport landmarks, writes reference/capture/overlay/diff/metadata, then rejects a mismatch over the corresponding policy. `visual-harness.test.ts` proves that three mutations fail: a ratio over the calibration cap, absent `setup-confirm`, and a cropped `setup-cancel`. This is a negative proof that compared pixels alone cannot make a missing control acceptable.

### Critical 2 — V03/V04 viewport and scroll evidence

The calibration view now fits required UI at `390×844`: header, rail, heading, truth, confirm/continue, back/cancel all record within the viewport at `scrollY=0`; the last bottom is `651.42`. V04 similarly records its submit bottom at `686.59`; required capture controls are higher: preview bottom `469.63`, record bottom `546.42`, file-selection bottom `592.81`. `focusHeading` uses `preventScroll`, and the capture helper resets/polls page scroll before each artifact. This fixes the previous V04 `scrollY=113` crop without removing focused heading behavior.

### Important 1 — actual codec media, normal runtime, hosted acceptance

Normal `apps/web/scripts/start-demo-e2e-server.mjs` now starts `apps/api/scripts/start-local-demo.mjs` without `--serve-check`. Before startup it creates two valid MP4s through FFmpeg and validates FFprobe JSON:

- Free: portrait `720×1280`, `3` seconds, `24` fps.
- Verified: landscape `1280×720`, `64` seconds, `24` fps.

The normal `test:demo:e2e` therefore drives C10 media sniff/probe/extraction through the production demo runtime when codecs are present. `--serve-check` has a separate smoke config and command; it no longer constitutes required media acceptance. Local normal-run evidence is an honest expected red (`Error: spawn ffmpeg ENOENT`); no fake probe/extractor facts were substituted. CI now installs FFmpeg and executes the normal command. Hosted output is pending.

### Important 2 — observed browser access evidence

The final mobile W6 browser suite covers all five states at `390×844`, DPR 2: semantic names, Tab/Enter/Space, visible outline focus, disabled/enabled controls, capture submit state, pending `aria-busy` loading state, leaderboard loading/failure/empty states, reduced motion, no horizontal overflow, no happy-path console/page errors, and no unexpected errors during the intentional 503 failure. It does not claim complete WCAG AA conformance beyond these observed seams.

### Important 3 and 4 — truthful native controls and 3m requirement

`Em breve` is now a native disabled button with `aria-describedby` explanation, not an `article aria-disabled`. Existing-video selection is a named native button that invokes the retained file input, receives the global focus ring, and works with Space. The selected wall-pass card now shows exactly `3 metros` with the Phosphor `ArrowsLeftRight` icon. Focused browser coverage proves those interaction semantics and compact V02/V04 visual composition.

### Fresh after artifacts and inspection

The final `pnpm check` structural run wrote all matrix artifacts. I opened every fresh normalized reference, capture, 50% overlay, and diff for home plus V02–V06. They were nonblank, at the expected route/state, and contained the required landmarks. Artifact directory: `apps/web/coverage/playwright/visual-artifacts/`.

| State / artifact stem                                                              |      Ratio / fixed cap | Inspection conclusion                                                              |
| ---------------------------------------------------------------------------------- | ---------------------: | ---------------------------------------------------------------------------------- |
| home `home-default--390x844--dpr-2--root--ready`                                   | W0 governed separately | Existing home photo/crop variance remains W0 P3 only.                              |
| V02 `verified-challenge-default--390x844--dpr-2--verified--challenge-choice`       |        21.188% / 25.0% | Card, `3 metros`, disabled rows, CTA and bounds are present.                       |
| V03 `verified-calibration-default--390x844--dpr-2--verified--calibration-guidance` |        31.839% / 40.0% | Rail, real blocking correction, truth panel, controls and bounds are present.      |
| V04 `verified-record-default--390x844--dpr-2--verified--recording-capture`         |        33.405% / 36.0% | Actual/fallback preview boundary, record/file controls and disclosure are present. |
| V05 `verified-processing-demo--390x844--dpr-2--verified--processing-pending`       |        25.132% / 30.0% | Manual-refresh timeline is present; false notification promise is absent.          |
| V06 `verified-ranked-policy-approved--390x844--dpr-2--verified--ranked-report`     |        16.812% / 20.0% | Isolated ranked truth, scorecard and metrics are present; demo is never used.      |

Required fidelity surfaces inspected across those comparisons: Bebas/Arimo typography/wrapping, 390px spacing/rhythm, warm-white/deep-emerald/border tokens and contrast, approved hero boundary, Portuguese truth copy, semantic control states, and Phosphor icons. Focused comparisons covered V02 card/CTA, V03 passed/current gate, V04 live/fallback and file focus, V05 refresh loading, and V06 ranked-only DOM. Only source hero/court subject variance or required notification-truth replacement remains P3; no P0/P1/P2 is left actionable.

### RED/GREEN evidence

| Phase                   | Command / exact outcome                                                                                                                                                                                                           |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RED                     | `rtk pnpm --filter @revelai/web exec vitest run src/visual/visual-harness.test.ts --reporter=dot` — **1 failed, 4 passed (5)**; missing gate export/enforcement.                                                                  |
| RED                     | `rtk pnpm --filter @revelai/web exec vitest run src/verified/tracer.test.tsx -t 'states the three-metre' --reporter=dot` — **1 failed, 42 skipped (43)**.                                                                         |
| RED                     | `rtk pnpm --filter @revelai/web exec vitest run src/verified/production-capture.test.tsx -t 'uses a focusable button' --reporter=dot` — **1 failed, 10 skipped (11)**.                                                            |
| RED                     | `rtk node --test apps/web/scripts/demo-media-fixtures.test.mjs` — **1 failed** before fixture module creation.                                                                                                                    |
| RED                     | First `rtk pnpm check` after adding the Node test — **1 failed suite, 286 passed tests**; Vitest incorrectly collected the Node suite.                                                                                            |
| GREEN                   | `rtk pnpm --filter @revelai/web exec vitest run src/visual/visual-harness.test.ts src/verified/tracer.test.tsx src/verified/production-capture.test.tsx --reporter=dot` — **59 passed**.                                          |
| GREEN                   | `rtk node --test apps/web/scripts/demo-media-fixtures.test.mjs` — **1 passed**.                                                                                                                                                   |
| GREEN                   | `rtk pnpm --filter @revelai/web exec playwright test src/visual/approved-reference.visual.spec.ts --project mobile-home --config playwright.config.ts --reporter=line` — **2 passed**.                                            |
| GREEN                   | `rtk pnpm --filter @revelai/web run test:production-router` — **23 passed**.                                                                                                                                                      |
| GREEN                   | `rtk pnpm --filter @revelai/web run test:demo:e2e:smoke` — **2 passed**.                                                                                                                                                          |
| GREEN                   | `rtk env CI=1 pnpm --filter @revelai/web run test:visual:structural -- --reporter=line` — **26 passed, 14 skipped**.                                                                                                              |
| GREEN                   | `rtk env CI=1 pnpm --filter @revelai/web run test:visual:darwin -- --reporter=line` — **30 passed, 10 skipped**.                                                                                                                  |
| Expected platform limit | `rtk env CI=1 pnpm --filter @revelai/web run test:visual:canonical -- --reporter=line` — exit **1**, `Canonical visual pixels require linux/x64.`                                                                                 |
| GREEN                   | Final `rtk pnpm check` — exit **0**: format; **7/7 lint**, **12/12 typecheck**, **12/12 test tasks**, **7/7 build**. Web recorded **12 Node checks**, **27 Vitest files / 286 tests**, and structural **26 passed / 14 skipped**. |
| GREEN                   | `rtk git diff --check` — exit **0** before functional commit.                                                                                                                                                                     |

### Self-review and concerns

I reviewed the staged functional diff, preserved every W0 home budget, and used no screenshot/runtime artwork, invented visual assets, or non-Phosphor icons. Owner ordering remains unchanged: selecting a challenge has no calibration/attempt side effect until `Preparar desafio` mounts the next owner. Free/demo/ranked truth boundaries are retained.

Concerns are limited and explicit: this macOS host lacks FFmpeg, so it cannot produce a local normal-runtime green result; CI provisioning is present but its hosted run is pending. Canonical comparison remains Linux/x64-only and is intentionally unchanged. Final independent Sol acceptance is pending. Deferred reviewer P3 cleanup (duplicate/superseded CSS/tracer seams and historical report-table style cleanup) was not changed in this round.

## Round-2 reviewer remediation — 2026-09-02

Review base: `c63dada1d066a572f76d1c803dc3b7ecd0140438`. Functional/test work is committed separately as `726ffc6`, before this evidence update. This is not an acceptance verdict: it corrects the record so V02–V06 and every P0/P1/P2 disposition remain pending independent Sol acceptance.

### Implemented fixes

- V02 now has the mobile verified header treatment, visible back control, selected wall-pass composition, and tightened heading/card/CTA rhythm. The selected-card requirements retain the real `3 metros` value and Phosphor icon; upcoming rows remain native disabled buttons.
- V03 keeps the real five-gate calibration state but now has a source-relative compact one-line heading, full-width approved runtime hero crop, correction rows, truthful blocker, and four real controls inside `390×844` at `scrollY=0`.
- V04 keeps the actual camera when available and the approved runtime hero only as fallback; its compact rail, heading, preview and accessible record/file actions match the selected hierarchy. The native file input is `tabIndex={-1}` and `aria-hidden="true"`; it is opened only by the visible named button, and the next Tab reaches the visible requirements disclosure.
- The static W6 policy adds source-relative landmark rectangles for V02 heading/card/CTA, V03 heading/visual/actions, and V04 heading/preview/actions. W0 masks and budgets are unchanged. The stale node-harness wording now correctly says non-home budgets are enforced.
- Desktop navigation is preserved. The verified navigation is only visually suppressed at the mobile reference breakpoint; the named back control supplies the V02 mobile return affordance.

### Fresh artifact evidence and measured bounds

The final `CI=1` approved-reference matrix regenerated and I inspected the normalized reference, candidate, 50% overlay, and complete diff for home plus V02–V06. Each verified comparison is full-screen and unmasked.

| State | Artifact stem                                                                  | Measured mismatch / stored cap | Key source-relative bounds at 390×844                                                                                       |
| ----- | ------------------------------------------------------------------------------ | -----------------------------: | --------------------------------------------------------------------------------------------------------------------------- |
| V02   | `verified-challenge-default--390x844--dpr-2--verified--challenge-choice`       |            **21.153% / 25.0%** | heading `27.30–129.12 × 114.19–359.15`; card `27.30–362.70 × 462.39–581.22`; CTA `27.30–362.70 × 755.94–807.13`             |
| V03   | `verified-calibration-default--390x844--dpr-2--verified--calibration-guidance` |            **29.236% / 40.0%** | heading `27.30–282.19 × 125.17–173.05`; visual `0–390 × 236.75–454.34`; actions `27.30–362.69 × 741.08–816.25`              |
| V04   | `verified-record-default--390x844--dpr-2--verified--recording-capture`         |            **33.437% / 36.0%** | heading `27.30–295.61 × 137.52–261.42`; preview `27.30–362.69 × 317.42–565.42`; actions `27.30–362.69 × 625.42–727.02`      |
| V05   | `verified-processing-demo--390x844--dpr-2--verified--processing-pending`       |            **24.992% / 30.0%** | manual refresh, truthful foreground copy, and semantic timeline visible; no notification promise/control                    |
| V06   | `verified-ranked-policy-approved--390x844--dpr-2--verified--ranked-report`     |            **16.670% / 20.0%** | persistent exact ranking truth, isolated ranked scorecard/metrics; demo and experimental arms omit rank fields structurally |

The stored limits are independently specified source policy, not candidate-derived tolerances. `visual-harness.test.ts` proves both a position mutation (V02 heading below the allowed top) and a size mutation (V02 card right edge too narrow) fail `assertReferenceVisualLandmarkGeometry`; the existing missing/cropped/over-budget negative proofs remain in place.

### Round-2 RED/GREEN commands

| Phase | Exact command / output                                                                                                                                                                                                                                           |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RED   | `rtk pnpm --filter @revelai/web exec vitest run src/visual/visual-harness.test.ts src/verified/production-capture.test.tsx --reporter=dot` initially failed: no `referenceGeometry` policy and focus landed on the clipped file input.                           |
| RED   | `rtk env CI=1 pnpm --filter @revelai/web exec playwright test src/visual/approved-reference.visual.spec.ts --project=mobile-home --reporter=line` — **1 failed, 1 passed** while each V02–V04 source-relative landmark correction was deliberately out of range. |
| GREEN | `rtk pnpm --filter @revelai/web exec vitest run src/app.test.tsx src/visual/visual-harness.test.ts src/verified/production-capture.test.tsx --reporter=dot` — **3 files, 19 passed**.                                                                            |
| GREEN | `rtk pnpm --filter @revelai/web exec vitest run src/visual/visual-harness.test.ts src/verified/production-capture.test.tsx src/verified/tracer.test.tsx --reporter=dot` — **3 files, 60 passed**.                                                                |
| GREEN | `rtk env CI=1 pnpm --filter @revelai/web exec playwright test src/visual/approved-reference.visual.spec.ts --reporter=line` — **2 passed, 2 skipped**.                                                                                                           |
| GREEN | `rtk env CI=1 pnpm --filter @revelai/web run test:visual:structural -- --reporter=line` — **26 passed, 14 skipped**; `rtk env CI=1 pnpm --filter @revelai/web run test:visual:darwin -- --reporter=line` — **30 passed, 10 skipped**.                            |
| GREEN | `rtk pnpm check` — exit **0**: format; **7/7** lint; **12/12** typecheck; **12/12** test tasks; **7/7** build.                                                                                                                                                   |
| GREEN | `rtk git diff --check` — exit **0** before `726ffc6`.                                                                                                                                                                                                            |

### Current acceptance and codec limit

The browser assertions cover named controls, Tab/Enter/Space, visible focus, disabled/enabled/loading states, reduced motion, responsive bounds, and console/page errors at `390×844`; this is observed browser evidence, not a full WCAG certification. No screenshot, copied court art, invented asset, custom SVG art, or non-Phosphor icon was added.

This machine still lacks FFmpeg, so the normal codec-backed C10 demo acceptance cannot produce a local green. The check-fact smoke remains separate and is not substituted. The codec-provisioned hosted CI normal-runtime run is **pending hosted green after controller push**. Canonical visual pixels remain Linux/x64-only. Final result remains pending independent Sol acceptance.

## Round-3 reviewer remediation — 2026-09-02

### Status and commit ledger

`DONE_WITH_CONCERNS`. Review base: `168f16a`. Functional/test remediation is committed separately as `62f1072` (`fix(web): tighten W6 mobile visual gates`); this report/evidence update follows in its own documentation commit. No push was made.

| Path                                                    | Change and reason                                                                                                                                                                    |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/web/src/styles.css`                               | Restored V02's three-line white-column paragraph; calibrated V03/V04 headline scale, line-height, offset, and the V03 visual/V04 preview rhythm against the selected mobile sources. |
| `apps/web/src/visual/visual-harness.ts`                 | Added independent headline-height and sibling-gap policy for V03/V04, with runtime enforcement before accepted capture evidence is returned. W0 remains untouched.                   |
| `apps/web/src/visual/visual-harness.test.ts`            | Added state-specific negative mutations for wrong V03/V04 headline height, bottom, and inter-landmark gap.                                                                           |
| `apps/web/src/visual/approved-reference.visual.spec.ts` | Passes the per-state stored gap policy into browser landmark verification.                                                                                                           |
| `apps/web/src/visual/visual-harness.node.ts`            | Corrected the harness contract comment: artifacts are recorded, the independently approved non-home budget is enforced, and no candidate UI is hidden.                               |
| `apps/web/design-qa.md` and this report                 | Recorded reviewer findings, exact fixes, complete fresh capture/inspection evidence, RED/GREEN outcomes, limits, and pending acceptance.                                             |

### RED/GREEN evidence

| Phase | Exact command / observed result                                                                                                                                                                                                                                                                    |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RED   | `rtk pnpm --filter @revelai/web exec vitest run src/visual/visual-harness.test.ts --reporter=dot` — **1 file failed; 2 failed, 6 passed (8)** because V03/V04 gate policy lacked required height/bottom/gap values.                                                                                |
| GREEN | The same command — **1 file passed; 8 passed** after independent stored ranges and runtime enforcement.                                                                                                                                                                                            |
| RED   | The same command after tightening expected source-relative values — **1 file failed; 2 failed, 6 passed (8)** until the policy was updated.                                                                                                                                                        |
| GREEN | The same command — **1 file passed; 8 passed** after final calibrated ranges.                                                                                                                                                                                                                      |
| RED   | `rtk pnpm --filter @revelai/web exec playwright test src/visual/approved-reference.visual.spec.ts --reporter=line` — **1 failed, 1 passed, 2 skipped** while the denser V04 line-height moved preview top to `314.9375`, below stored `320–334`. This identified flow-height, not a capture flake. |
| GREEN | The same browser command — **2 passed, 2 skipped** after setting the existing production-capture top margin to retain preview y=`326.14`.                                                                                                                                                          |
| GREEN | `rtk pnpm --filter @revelai/web exec vitest run src/app.test.tsx src/visual/visual-harness.test.ts src/verified/production-capture.test.tsx --reporter=dot` — **3 files, 21 passed**.                                                                                                              |
| GREEN | `rtk pnpm --filter @revelai/web run test:visual:structural:run` — **26 passed, 14 skipped**.                                                                                                                                                                                                       |
| GREEN | `rtk pnpm check` — exit **0**: format; **7/7 lint**, **12/12 typecheck**, **12/12 test**, and **7/7 build** tasks successful.                                                                                                                                                                      |
| GREEN | `rtk git diff --check` — exit **0** before the functional commit.                                                                                                                                                                                                                                  |

### Fresh visual matrix and inspection

The final approved-reference run regenerated and I individually opened the reference-normalized PNG, candidate PNG, 50% overlay, and complete diff for every V02–V06 state at `390×844`, DPR 2, CSS scale, normalized density 1. All five comparisons are unmasked; the home-only W0 mask and budget were not changed.

| State                | Artifact stem                                                                  | Mismatch / independently stored cap | Inspection conclusion                                                                                                                                        |
| -------------------- | ------------------------------------------------------------------------------ | ----------------------------------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| V02 challenge choice | `verified-challenge-default--390x844--dpr-2--verified--challenge-choice`       |                 **21.154% / 25.0%** | The source-like three-line paragraph stays wholly within the white column; card, `3 metros`, disabled rows, and CTA remain visible.                          |
| V03 calibration      | `verified-calibration-default--390x844--dpr-2--verified--calibration-guidance` |                 **27.834% / 40.0%** | The heading's raster ink matches source rows y=`134–188`; rail, real visual region, blocker, corrections, and controls remain present.                       |
| V04 capture          | `verified-record-default--390x844--dpr-2--verified--recording-capture`         |                 **31.061% / 36.0%** | Headline and preview now hold the selected source-relative height/rhythm; real-camera/approved-fallback, accessible controls, and disclosure remain visible. |
| V05 pending          | `verified-processing-demo--390x844--dpr-2--verified--processing-pending`       |                 **24.992% / 30.0%** | Truthful foreground/manual refresh timeline remains; no notification promise/control appears.                                                                |
| V06 ranked           | `verified-ranked-policy-approved--390x844--dpr-2--verified--ranked-report`     |                 **16.670% / 20.0%** | Isolated ranked truth, scorecard, and metrics remain; demo/experimental arms structurally lack ranking fields.                                               |

Required fidelity surfaces inspected: Bebas/Arimo family, weight, scale, wrap, and hierarchy; margins, borders, card/rail/CTA rhythm; warm-white/deep-emerald/border tokens; approved runtime hero quality/crop and its intentionally variable subject; Portuguese truth copy; semantic native controls and Phosphor-only icons. Focused review covered V02 paragraph/image boundary, V03 heading/visual gap, V04 heading/preview gap, V05 manual refresh truth, and V06 rank-only fields.

The only remaining visible deltas are named P3 candidates: approved runtime hero/court subject variance, required removal of the source notification promise, and a 3–5px V04 type-raster offset. They do not change truth, layout bounds, interaction, or capture gating. No actionable P0/P1/P2 remains in implementation; independent Sol must decide acceptance.

### Acceptance limits and concerns

The V03/V04 policy is stored before candidate evaluation and is not derived from a candidate artifact. V03 accepts heading height `64–74`, bottom `195–207`, and heading→visual gap `28–38`; V04 accepts heading height `166–180`, bottom `303–317`, and heading→preview gap `10–22`. The added negative proofs make current-style underscaling, wrong bottom, or excessive gap fail. Full-screen caps, required semantic landmarks, scroll reset, viewport overflow checks, and W0 budgets remain in force.

Concerns remain external: FFmpeg is unavailable locally, so normal codec-backed C10 demo acceptance is pending CI after controller push; canonical pixels are Linux/x64-only; final independent Sol acceptance remains pending. `apps/web/design-qa.md` intentionally ends with `final result: pending independent Sol acceptance.`

## CI fix round 4 — asynchronous capture-heading focus evidence — 2026-09-02

Functional/test commit: `c497535` (`test(web): await verified capture focus`). This is a narrowly scoped CI-stability correction. It does not alter production rendering, W0, the verified state machine, or any approved visual artifact; the round-3 individual V02–V06 reference/candidate/overlay/diff inspection remains the applicable visual evidence.

### Hosted RED, root cause, and minimal correction

Hosted run `33689431803` failed only Web Vitest at the capture-focus assertion in `apps/web/src/verified/tracer.test.tsx:297` from the submitted revision. Its diagnostic showed the capture heading was present while `document.body` retained focus. Hosted quality lint/typecheck passed and the probe gates were green.

The browser product contract was already correct: `VerifiedTracer` has one passive effect that focuses `headingRef` whenever `gateIndex`, `stage`, `terminal`, or `rankingView` changes, with `preventScroll: true`. Capture is reached only after two asynchronous client effects transition `creating-session` → `readying-session` → `capture`. `findByRole` resolves as soon as the capture DOM exists; on slower hosted scheduling that DOM observation can precede the passive focus effect. The old immediate `toHaveFocus()` assertion therefore tested an invalid synchronous ordering, not the eventual user-visible focus contract.

The regression now stores the real capture heading returned by `findByRole` and waits for that same element to receive focus with Testing Library's condition retry. It introduces neither an application delay nor a custom timeout, and it keeps the actual component, route, effects, and fetch lifecycle in place. A deliberate mutation that skipped the production focus effect only for `stage === "capture"` failed at the new condition with exactly the captured heading expected and `body` focused; the mutation was restored before the functional commit. This proves the regression will catch a real loss of capture focus rather than merely waiting for DOM presence.

### Round-4 RED/GREEN record

| Phase                | Exact command / observed output                                                                                                                                                                                                                                                        |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- | ----------------------------------------------------------------- |
| Hosted RED           | Run `33689431803`: Web Vitest failed at the old immediate capture focus assertion; capture heading existed, `body` had focus. Quality lint/typecheck passed and probes were green.                                                                                                     |
| Local baseline       | `rtk env CI=1 pnpm --filter @revelai/web exec vitest run src/verified/tracer.test.tsx -t 'mounts the verified owner before running the exact session-ready-attempt-media sequence' --reporter=dot` — **1 passed, 42 skipped (43)**. This did not reproduce the scheduler race locally. |
| Mutation RED         | The same command with the temporary capture-only focus-effect skip — **1 failed, 42 skipped (43)** at `await waitFor(() => expect(captureHeading).toHaveFocus())`; expected capture heading was mounted and `body` was focused.                                                        |
| Fresh repeated GREEN | `rtk zsh -c 'for run in {1..10}; do CI=1 pnpm --filter @revelai/web exec vitest run src/verified/tracer.test.tsx -t "mounts the verified owner before running the exact session-ready-attempt-media sequence" --reporter=dot                                                           |     | exit 1; done'` — **10 fresh processes × (1 passed, 42 skipped)**. |
| Full tracer GREEN    | `rtk env CI=1 pnpm --filter @revelai/web exec vitest run src/verified/tracer.test.tsx --reporter=dot` — **1 file, 43 passed**.                                                                                                                                                         |
| Root GREEN           | `rtk pnpm check` — exit **0**: formatting clean; **7/7 lint**, **12/12 typecheck**, **12/12 test tasks**, and **7/7 build** successful.                                                                                                                                                |

No visual capture was regenerated for this test-only synchronization: no visual surface or artifact-producing code changed. The normal codec-backed hosted acceptance and canonical Linux/x64 execution remain controller-hosted gates, and final independent Sol acceptance remains pending.

final result: pending independent Sol acceptance.

## CI fix round 5 — normal demo E2E startup boundary — 2026-09-02

Functional/test commit: `ef2ff28` (`fix(web): isolate demo e2e runtime boundary`). This round changes neither W0–W6 rendering nor an approved asset. No fresh reference/candidate/overlay/diff artifact is claimed: the browser evidence below concerns the normal demo runtime boundary and its real-media lifecycle. Existing visual evidence remains authoritative; final result remains pending independent Sol acceptance.

### Hosted RED, diagnosis, and correction

Hosted run `33703583459` passed `pnpm check` and production-router, then failed `test:demo:e2e` before API readiness. The outer server reported that the local demo API exited; before this fix the API child reduced every non-preflight failure to that same generic sentence.

- The explicit FFmpeg preflight message was absent. A clean Ubuntu 24.04 + FFmpeg direct normal API start reached health readiness (`ubuntu-normal-demo-start=ready`), excluding ordinary codec preflight/parser and SQLite bootstrap in that codec-equipped environment.
- A controlled occupied-port probe reproduced the former generic output exactly. It proves a `4174` namespace collision can be masked, but does **not** prove a hosted orphan.
- The exact strict-config probe `rtk node --input-type=module -e '…parseApiEnv({ REVELAI_DEMO_E2E: "true" })…'` returned `{"name":"Error","message":"Unrecognized key: REVELAI_DEMO_E2E"}`. `playwright.demo.config.ts` intentionally sets that runner-private marker; `start-demo-e2e-server.mjs` had copied it into strict API validation. This is the direct pre-bind cause.

`createDemoApiEnvironment` now removes **only** `REVELAI_DEMO_E2E` before spawning the normal API. It preserves normal values including `CI` and an ordinary non-`REVELAI_` runner setting, then applies existing host/port/data/media values. `parseApiEnv` remains strict for unknown production `REVELAI_*`; no production rule was relaxed.

The runner smoke server now owns `4176` and the normal demo API retains `4174`. Browser-runner regressions prove both simultaneous port separation and post-run ownership by binding `4174` while the runner listens, then binding `4176` after `runPlaywrightRunner` exits. The startup diagnostic now reports `RevelAI local demo startup failed: address_in_use.` only for `EADDRINUSE`; other failures retain non-sensitive `runtime_initialization_failed`/`server_bind_failed` phase labels. The occupied-port API regression asserts exactly that safe output, with no path, environment value, or secret.

The normal browser trace also corrected a harness-only ordering error: after clicking upload it observes the real accessible progressbar, then the distinct pending owner (`Processando tentativa`) and its visible `Atualizar agora` action, before awaiting terminal report. Progress alone is not treated as pending evidence. Its finite terminal budget is named: 30 s upload + C5's existing 30 s extraction cap + 30 s durable reconstruction/analysis + one 5 s capped pending poll + 25 s CI scheduling margin = 120 s. Playwright allows 150 s only for teardown/reporting room. This changes no runtime delay, retry, provider, or media fact.

### RED/GREEN evidence and hosted gate

| Phase             | Exact command / observed result                                                                                                                                                                                                                                                                                                                                                                    |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hosted RED        | Run `33703583459`: `pnpm check` and production-router passed; `test:demo:e2e` failed because the local demo API exited before ready.                                                                                                                                                                                                                                                               |
| RED               | In the Ubuntu Playwright image, `CI=true pnpm --filter @revelai/web run test:demo:e2e` previously classified the child as `runtime_initialization_failed`; the direct strict-config probe identified the rejected marker.                                                                                                                                                                          |
| RED               | Before diagnostic classification, `rtk pnpm --filter @revelai/api run demo:smoke` failed its new occupied-port assertion after normal check passed; old child text was generic.                                                                                                                                                                                                                    |
| GREEN             | `rtk pnpm --filter @revelai/api run demo:smoke` — normal check and hermetic occupied-port regression passed.                                                                                                                                                                                                                                                                                       |
| GREEN             | `rtk node --test apps/web/scripts/demo-e2e-environment.test.mjs` — **1/1 passed**: private marker removed; `CI`, ordinary runner setting, host, port, data, and media settings preserved.                                                                                                                                                                                                          |
| GREEN             | `rtk pnpm --filter @revelai/web run test` — **13 Node checks**, **27 Vitest files / 291 tests**, structural Playwright **26 passed / 14 skipped**; includes all **6** runner ownership/separation tests.                                                                                                                                                                                           |
| GREEN             | `rtk pnpm --filter @revelai/web run lint`; `rtk pnpm --filter @revelai/web run typecheck`; focused `rtk pnpm exec prettier --check …`; and `rtk git diff --check` — all exit **0**.                                                                                                                                                                                                                |
| Ubuntu diagnostic | With codec-provisioned Ubuntu, corrected normal startup and real upload reach V05 `main "Processando tentativa"` with truthful timeline/manual refresh. It does not terminalize within the local budget. `docker top` shows no FFmpeg child and API Node around 90% CPU under `/run/rosetta/rosetta … node --no-opt`; that is Apple amd64 emulation throughput, not native hosted Ubuntu behavior. |

The Docker result is a startup/V05 diagnostic only, not terminal acceptance. Definitive terminal proof remains controller-pushed native Linux/x64 hosted codec CI. No hosted orphan is claimed and no check-fact smoke replaces normal media acceptance.

final result: pending independent Sol acceptance.

## CI fix round 6 — owned readiness and observed pending — 2026-09-02

Review base: `be9e864`. Functional/test corrections: `e6aa4fc` (`fix(web): harden demo E2E readiness`) and `e858e51` (`test(web): require enabled pending refresh`). This round changes no W0–W6 visual surface, token, asset, pixel threshold, or capture artifact. It corrects the normal demo acceptance harness and its evidence only; no fresh visual artifact is claimed.

### Reviewed P1 corrections

- The Verified real-API browser trace now requires the ordered visible lifecycle: upload progressbar, then the pending main landmark named `Processando tentativa` and the enabled visible `Atualizar agora` control, then the terminal report within the unchanged named 120-second outcome budget. The local `--serve-check` Playwright command executes this exact browser spec; normal codec media still runs only in hosted acceptance.
- `start-demo-e2e-server.mjs` no longer accepts a generic `GET /health` response as readiness. It pipes the exact post-listen marker from the API child it spawned, then probes only after that marker. Both marker and probe race the owned child exit and one abortable 60-second readiness budget; completion aborts the outstanding probe. This rejects both a foreign health-200 server and a foreign socket that accepts but never responds, rather than waiting for an unrelated fetch.
- The wrapper consumes child streams for its own readiness protocol but does not forward them. Its own setup/readiness catch emits only `RevelAI demo E2E server failed to start.`. A real wrapper-process regression with a temporarily unavailable generated `dist/index.html` proves an absolute local path is absent from its terminal output.

### RED/GREEN evidence

| Phase | Exact command / observed result                                                                                                                                                                                                                                                                                                                         |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RED   | `rtk node --test apps/web/scripts/start-demo-e2e-server.test.mjs` before the correction — **0/3 passed**. A foreign health-200 owner was accepted until the 3 s harness watchdog; a foreign hanging owner left `fetch` stalled until that watchdog; a missing generated index printed an `ENOENT` stack containing the absolute Web path.               |
| GREEN | `rtk pnpm --filter @revelai/web run test:demo:e2e:smoke` — builds API/Web, then real-wrapper regressions **3/3 passed** (foreign health, hanging socket, absolute-path sanitization) and Playwright browser traces **2/2 passed**. The Verified trace visibly observes progress → pending heading/manual refresh → terminal without route interception. |
| GREEN | `rtk pnpm --filter @revelai/api run demo:smoke` — terminal check and hermetic occupied-port regression passed.                                                                                                                                                                                                                                          |
| GREEN | `rtk node --test apps/web/scripts/demo-e2e-environment.test.mjs` — **1/1 passed**: only `REVELAI_DEMO_E2E` is withheld from strict API environment and normal values remain.                                                                                                                                                                            |
| GREEN | `rtk env npm_execpath=/Users/vitortoledo/.nvm/versions/node/v22.19.0/lib/node_modules/corepack/dist/pnpm.js pnpm --filter @revelai/web exec vitest run src/visual/playwright-runner.test.ts --reporter=dot` — **1 file, 6/6 passed**, including 4174/4176 separation and post-run ownership.                                                            |
| GREEN | `rtk pnpm --filter @revelai/web run lint`; `rtk pnpm --filter @revelai/web run typecheck`; focused Prettier; and `rtk git diff --check` — all exit **0**.                                                                                                                                                                                               |

The local codec-limited smoke is proof of the browser state ordering and owned startup boundary, not of native codec terminal throughput. The definitive normal C10 fixture terminal remains the controller-pushed Linux/x64 hosted gate. Independent Sol acceptance remains pending.

final result: pending independent Sol acceptance.

## CI fix round 7 — closed child protocol, teardown, and one outcome budget — 2026-09-02

Review base: `0309dc0`. Functional/test correction: `e99733f` (`fix(web): bound demo E2E lifecycle`). This round changes no rendering, approved asset, visual threshold, or capture artifact. It tightens only the real demo acceptance harness and its evidence; no fresh visual artifact is claimed.

### Reviewed corrections

- The wrapper now drains both owned child streams without printing them. Its only accepted child protocol is one exact post-listen stdout token; all child failure text, including a pre-local-demo stack, absolute fixture path, and test secret sentinel, is discarded. The wrapper's sole external failure text remains `RevelAI demo E2E server failed to start.`. A `--test-api-entry` seam is accepted only under `NODE_ENV=test` and only from the wrapper-owned fixture directory; it cannot select an arbitrary production child.
- Owned-child shutdown uses named `childTerminationGraceMilliseconds = 1_000`: TERM, wait for `close`, SIGKILL only if that owned child remains alive at the grace boundary, then await `close`. The listener is retained until `close`; a child observed between `exit` and `close` is still awaited. No port/PID discovery or kill targets a foreign owner.
- The Verified trace starts one 120-second deadline immediately after the visible upload click. Upload progress, pending main/manual refresh, and terminal report each receive the same decreasing remainder; none receives a fresh 120 seconds. The 150-second Playwright test timeout is explicitly only teardown/reporting backstop room. The 120-second composition is unchanged: 30 s upload + 30 s C5 extraction + 30 s analysis + 5 s capped poll + 25 s CI margin.

### RED/GREEN evidence

| Phase | Exact command / observed result                                                                                                                                                                                                                                                                                                                                                                                            |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RED   | `rtk node --test --test-name-pattern='does not forward a child failure' apps/web/scripts/start-demo-e2e-server.test.mjs` with the temporary raw-stderr forwarding mutation — **1 failed**. Captured output contained the child fixture path, stack frames, and `w6-child-pretry-secret`; restoring the closed protocol removes all three.                                                                                  |
| RED   | `rtk node --test --test-name-pattern='force-stops only its owned resistant child' apps/web/scripts/start-demo-e2e-server.test.mjs` with the temporary former TERM-and-unbounded-exit mutation — **1 failed** after the finite 2 s test limit: `Owned demo wrapper did not close after shutdown.` The descendant was contained in the newly created test-owned process group for cleanup only.                              |
| GREEN | `rtk pnpm --filter @revelai/web run test:demo:e2e:smoke` — API/Web build; real-wrapper regression suite **6/6 passed** (foreign health, hanging socket, setup path, pre-setup child path/stack/sentinel, normal port release, resistant-child port release); Playwright browser traces **2/2 passed**. The Verified trace runs the single post-upload deadline and observes progress → pending/enabled refresh → terminal. |
| GREEN | `rtk pnpm --filter @revelai/api run demo:smoke` — terminal check and occupied-port regression passed. `rtk node --test apps/web/scripts/demo-e2e-environment.test.mjs` — **1/1 passed**.                                                                                                                                                                                                                                   |
| GREEN | `rtk env npm_execpath=/Users/vitortoledo/.nvm/versions/node/v22.19.0/lib/node_modules/corepack/dist/pnpm.js pnpm --filter @revelai/web exec vitest run src/visual/playwright-runner.test.ts --reporter=dot` — **1 file, 6/6 passed**, including cross-port ownership.                                                                                                                                                      |
| GREEN | Web lint, typecheck, focused Prettier, and `rtk git diff --check` — all exit **0**.                                                                                                                                                                                                                                                                                                                                        |

The local smoke proves browser ordering, child-protocol safety, and bounded ownership cleanup; it is not native normal-codec terminal acceptance. The definitive C10 normal fixture terminal remains controller-pushed Linux/x64 hosted CI, and independent Sol acceptance remains pending.

final result: pending independent Sol acceptance.

## CI lifecycle edge-case correction — 2026-09-03

Functional/test commit: `27df4ce555eca77df74c86c95ab2035d6be55dd2` (`fix(web): share demo E2E shutdown lifecycle`). This changes no visual surface, W0 budget, approved asset, or reference capture. It corrects two acceptance-harness lifecycle edges; no new visual artifact is claimed.

### Root cause and correction

The previous owned-child teardown attached `child.once("error", ...)`. A TERM delivery error consumed that listener, leaving a later grace-triggered SIGKILL error without an owned listener before `close`. Separately, `async stop()` used a `stopping` early return, so a concurrent signal received a distinct already-resolved promise rather than awaiting the active cleanup. The signal handler then used `finally(process.exit)`, which could observe that short promise instead of the real close boundary.

`apps/web/scripts/owned-child-lifecycle.mjs` now owns those two narrow contracts. `createOwnedChildStop` keeps a persistent child `error` listener from TERM through KILL and removes it only from the `close` handler. It applies the named 1-second TERM→SIGKILL grace only to the spawned child and resolves only at that child's `close`. `createSharedStop` caches one cleanup promise; the wrapper's `stop` function and all signal handlers return/await that exact promise. Signal completion uses its fulfilled/rejected branch before calling `process.exit`.

The Verified browser trace's 120-second post-upload deadline is now truly shared by every observable outcome seam: upload progress, pending owner, enabled `Atualizar agora`, and terminal report each pass `remainingVerifiedOutcomeTime(verifiedOutcomeDeadline)` explicitly. This supersedes the previous documentation claim that omitted the enabled-refresh expectation's implicit 5-second Playwright default. The 150-second test timeout remains only a teardown/reporting backstop.

### RED/GREEN evidence

| Phase | Exact command / observed result                                                                                                                                                                                                                                                                                                                                                                  |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| RED   | `rtk node --test apps/web/scripts/owned-child-lifecycle.test.mjs` with temporary mutations `child.on`→`child.once` and cached-stop→new resolved promise — **2 failed**. The first test observed no retained child error listener after TERM; the second rejected the non-identical concurrent promise.                                                                                           |
| GREEN | `rtk node --test apps/web/scripts/owned-child-lifecycle.test.mjs` — **2/2 passed**. Its owned simulated child emits an error for TERM, emits a second error for SIGKILL, then closes; the test awaits the teardown, observes both signals/errors, and verifies listener removal only after close. It also proves concurrent callers receive the same promise and the resource factory runs once. |
| GREEN | `rtk node --test apps/web/scripts/owned-child-lifecycle.test.mjs apps/web/scripts/start-demo-e2e-server.test.mjs` — **8/8 passed**. This includes foreign readiness rejection, sanitization, and both normal/resistant owned-child wrapper runs that bind-check 4174 and 4175 after shutdown.                                                                                                    |
| GREEN | `rtk pnpm --filter @revelai/web run test:demo:e2e:smoke` — build, Node lifecycle/wrapper suite **8/8**, and browser traces **2/2 passed**. The Verified trace executes the explicit remaining-time refresh assertion under the real smoke boundary.                                                                                                                                              |
| GREEN | `rtk pnpm --filter @revelai/api run demo:smoke`; `rtk node --test apps/web/scripts/demo-e2e-environment.test.mjs`; and `rtk env npm_execpath=/Users/vitortoledo/.nvm/versions/node/v22.19.0/lib/node_modules/corepack/dist/pnpm.js pnpm --filter @revelai/web exec vitest run src/visual/playwright-runner.test.ts --reporter=dot` — API smoke passed; environment **1/1**; runner **6/6**.      |
| GREEN | `rtk pnpm --filter @revelai/web run lint`; `rtk pnpm --filter @revelai/web run typecheck`; focused Prettier check; and `rtk git diff --check` — all exit **0**.                                                                                                                                                                                                                                  |

The local smoke remains evidence of ownership, state ordering, and finite timing only; it is not normal codec-backed C10 terminal acceptance. Native Linux/x64 codec completion and canonical pixels remain controller-hosted gates. Independent Sol acceptance remains required.

final result: pending independent Sol acceptance.

## Sol round-4 signal and exit-boundary correction — 2026-09-03

Functional/test commit: `259fd4e` (`fix(web): retain demo E2E shutdown signals`). This correction has no visual, approved-asset, W0, or reference-capture change.

### Corrected lifecycle boundary

Shutdown handlers are now persistent `process.on` listeners installed before the first startup `await`. They stay installed while the shared cleanup promise settles; every SIGINT/SIGTERM calls the same `stop` promise, and only its fulfilled/rejected branch removes the listeners and calls `process.exit`. This prevents a signal during API readiness, or a repeated SIGTERM during the owned child's 1-second TERM grace, from falling through to Node's default signal action.

The prior report's statement that the owned-child grace waited safely for close was incomplete: a native `ChildProcess` can have `exitCode === null` and `signalCode === "SIGTERM"` between `exit` and `close`. `createOwnedChildStop` now treats either non-null exit code or non-null signal code as exited, awaits `close`, and never emits a gratuitous SIGKILL in that interval.

### RED/GREEN evidence

| Phase | Exact command / observed result                                                                                                                                                                                                                                                                                                                                                                                                          |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RED   | `rtk node --test apps/web/scripts/owned-child-lifecycle.test.mjs apps/web/scripts/start-demo-e2e-server.test.mjs` before the correction — **3 failed, 8 passed**: a signal-exited child received SIGKILL; startup SIGTERM exited the wrapper before owned cleanup; repeated SIGTERM during grace default-exited the wrapper.                                                                                                             |
| GREEN | The same command — **11/11 passed**. The unit child receives only SIGTERM after emitting `exit` with `signalCode=SIGTERM`, then is awaited to close. Integration starts an API whose exact readiness token is deliberately delayed, proves Web is not ready, sends SIGTERM, and rebinds 4174/4175 after wrapper close. A resistant owned child receives repeated SIGTERM during grace and releases both ports only after shared cleanup. |
| GREEN | `rtk pnpm --filter @revelai/web run test:demo:e2e:smoke` — build, Node lifecycle/wrapper suite **11/11**, browser traces **2/2**.                                                                                                                                                                                                                                                                                                        |
| GREEN | `rtk pnpm --filter @revelai/web run lint`; `rtk pnpm --filter @revelai/web run typecheck`; focused Prettier check; and `rtk git diff --check` — all exit **0**.                                                                                                                                                                                                                                                                          |

The smoke still proves local lifecycle ownership and browser ordering, not normal codec-backed C10 terminal acceptance. Native Linux/x64 codec/canonical gates and independent Sol acceptance remain pending.

final result: pending independent Sol acceptance.

## Sol round-5 fixture admission and cancellation correction — 2026-09-03

Functional/test commit: `c2816a6` (`fix(web): own demo fixture startup lifecycle`). This changes no visible state, approved asset, W0 budget, reference artifact, or acceptance threshold.

### Corrected startup ownership

The prior lifecycle report did not include normal C10 fixture generation in its owned shutdown boundary. A signal while FFmpeg was active could settle the wrapper's old stop promise before the codec child and fixture continuation were accounted for. Fixture generation now owns an `AbortController`, passes its signal through each FFmpeg/FFprobe invocation, and uses the same owned TERM→KILL/close lifecycle as the API child. Shutdown first closes startup admission, aborts all active codecs, awaits the aggregate fixture generation, then removes media and scratch state.

Fixture generation now uses `Promise.allSettled`, not a short-circuiting `Promise.all`: an initial codec failure is held until every already-admitted codec has closed. Every startup await is followed by an admission guard before API/Web creation; a scratch directory produced after shutdown is explicitly removed rather than admitted. The test-only codec seam remains restricted to `NODE_ENV=test` and the owned fixture directory.

### RED/GREEN evidence

| Phase | Exact command / observed result                                                                                                                                                                                                                                                                                                                                            |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RED   | `rtk node --test apps/web/scripts/demo-media-fixtures.test.mjs` — **1 failed, 1 passed** before signal propagation: the injected owned codec received no abort signal. A second focused run — **1 failed** — showed `Promise.all` surfaced one fixture failure before the other admitted codec finished.                                                                   |
| RED   | `rtk node --test --test-name-pattern='waits for cancelled fixture codecs' apps/web/scripts/start-demo-e2e-server.test.mjs` — **1 failed** before fixture admission/codec ownership: the wrapper exited before the controlled codec began.                                                                                                                                  |
| GREEN | `rtk node --test apps/web/scripts/demo-media-fixtures.test.mjs apps/web/scripts/owned-child-lifecycle.test.mjs apps/web/scripts/start-demo-e2e-server.test.mjs` — **15/15 passed**. The controlled normal-runtime fixture signal records two codec closes before wrapper close, records no API-start marker, removes the media directory, and permits 4174/4175 rebinding. |
| GREEN | `rtk pnpm --filter @revelai/web run test:demo:e2e:smoke` — build, Node suite **15/15**, browser traces **2/2**.                                                                                                                                                                                                                                                            |
| GREEN | `rtk pnpm --filter @revelai/web run lint`; `rtk pnpm --filter @revelai/web run typecheck`; focused Prettier check; and `rtk git diff --check` — all exit **0**.                                                                                                                                                                                                            |

The controlled codec test is lifecycle evidence only; it neither substitutes test codec data for C10 acceptance nor changes the hosted normal-codec/Linux-x64 gate. Independent Sol acceptance remains pending.

final result: pending independent Sol acceptance.
