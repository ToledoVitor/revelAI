# W6 implementation report — browser integration and Web acceptance evidence

## Status

`DONE_WITH_CONCERNS`

The required browser/HTTP, contract-fixture, capture, structural, and CI wiring are implemented and verified. This was the initial record before pre-review remediation; the five historical P0 visual findings below are superseded by the closed remediation record appended on 2026-09-02. Final visual acceptance remains deliberately pending independent Sol review.

## Baseline and commits

- Base: `8cb14d5ab04edd880cc03adb4aa011783328315d`.
- Functional W6 commit: `eabf3ff84e6ed4a4b7f976a91f9fc4a0c8ccd048` (`test(web): add W6 browser acceptance coverage`).
- This report and the W6 QA record are committed separately as evidence after the functional commit.

## Files changed

| Path | Why |
| --- | --- |
| `.github/workflows/ci.yml` | Runs the new secret-free production demo browser trace before the immutable canonical Linux visual gate. |
| `apps/api/scripts/start-local-demo.mjs` | Adds private `--serve-check` lifecycle support so an HTTP server can use the existing deterministic C10 check probe/extraction seam. The default demo command is unchanged. |
| `apps/web/package.json` | Adds `test:demo:e2e`, building the API workspace and the production Web client before Playwright. |
| `apps/web/playwright.demo.config.ts` | Dedicated production-client/demo-API test config; it enables the suite only there so W0–W5's development visual run does not collect it. |
| `apps/web/scripts/start-demo-e2e-server.mjs` | Starts a static production client, proxies `/v1` to the real local Fastify demo server, creates deterministic C10 check media bytes, and cleans its private scratch/media state. |
| `apps/web/src/visual/demo-api.e2e.visual.spec.ts` | Visible-control Free and Verified browser traces against the real API HTTP boundary, with request/body/truth assertions and no API mocks. |
| `apps/web/src/visual/ranked-policy-fixture.ts` and `.test.ts` | Isolated schema-parsed competitive fixture for the positive ranked rendering capture; it performs no policy or ranking calculation. |
| `apps/web/src/visual/approved-reference.visual.spec.ts` | Deterministically drives and records the six mobile approved-reference states through the extended W0 artifact pipeline. |
| `apps/web/src/visual/visual-harness.ts`, `.node.ts`, and `.test.ts` | Registers route/state/reference metadata and writes normalized reference, candidate, 50% overlay, unmasked diff, and metadata for each W6 state. Existing W0 home budgets/masks remain unchanged. |
| `apps/web/design-qa.md` | Preserves W0 history and records the complete W6 inspection, findings, truth rulings, risks, and pending independent acceptance. |

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

| ID | Route / state / fixture | CSS viewport / DPR / reference | Artifact stem under `apps/web/coverage/playwright/visual-artifacts/` | Diff result and inspection |
| --- | --- | --- | --- | --- |
| W6-D01 | `/` / `ready` / `home-default` | `1440×1024`, DPR 1, `desktop-home.png` | `home-default--1440x1024--dpr-1--root--ready` | Existing W0 capture pipeline and its narrow photo mask/independent ink proof stayed unchanged; desktop visual checks passed in the Darwin run. |
| W6-V01 | `/` / `ready` / `home-default` | `390×844`, DPR 2, `mobile-home.png` | `home-default--390x844--dpr-2--root--ready` | 114,561 / 329,160 changed pixels = **34.804%** unmasked. Opened all artifacts. Known runtime photo/crop variance remains governed by the accepted W0 mask/ink proof; P3 confirmation only. |
| W6-V02 | `/verified` / `challenge-choice` / `verified-challenge-default` | `390×844`, DPR 2, `mobile-challenge.png` | `verified-challenge-default--390x844--dpr-2--verified--challenge-choice` | 90,855 / 329,160 = **27.602%**. Complete but visibly divergent capture; P0 remains open. |
| W6-V03 | `/verified` / `calibration-guidance` / `verified-calibration-default` | `390×844`, DPR 2, `mobile-calibration.png` | `verified-calibration-default--390x844--dpr-2--verified--calibration-guidance` | 105,417 / 329,160 = **32.026%**. Complete but visually divergent; P0 remains open. |
| W6-V04 | `/verified` / `recording-capture` / `verified-record-default` | `390×844`, DPR 2, `mobile-record.png` | `verified-record-default--390x844--dpr-2--verified--recording-capture` | 127,122 / 329,160 = **38.620%**. Complete visible requirements/capture controls, but the approved composition is absent; P0 remains open. |
| W6-V05 | `/verified` / `processing-pending` / `verified-processing-demo` | `390×844`, DPR 2, `mobile-processing.png` | `verified-processing-demo--390x844--dpr-2--verified--processing-pending` | 64,207 / 329,160 = **19.506%**. The reference notification promise is intentionally not copied: visible copy truthfully requires foreground/manual refresh. Composition still diverges; P0 remains open. |
| W6-V06 | `/verified` / `ranked-report` / `verified-ranked-policy-approved` | `390×844`, DPR 2, `mobile-report.png` | `verified-ranked-policy-approved--390x844--dpr-2--verified--ranked-report` | 61,144 / 329,160 = **18.576%**. Isolated ranked result visibly says `Resultado validado — vale para ranking`; it is not a demo result. Compact reference composition remains P0-open. |

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

| Path | Why |
| --- | --- |
| `apps/web/src/verified/tracer.tsx` | Adds the public challenge-choice state before setup ownership; provides the styled real calibration, capture, pending, and ranked-report states while preserving existing HTTP, setup, upload, polling, and result boundaries. |
| `apps/web/src/verified/production-capture.tsx` | Adds the approved hero fallback only while a real camera stream is absent, preserves the real `<video>`, and makes requirements semantic disclosure. |
| `apps/web/src/styles.css` | Uses existing tokens and bundled Bebas/Arimo faces for editorial layout, normal borders, real-control states, progress, timeline, metrics, and responsive presentation. No screenshot, new raster, CSS illustration, or custom SVG is introduced. |
| `apps/web/src/verified/{tracer,production-capture}.test.tsx` | Covers choice-before-owner ordering, camera fallback controls, ranked-only fields, and the real passed-device calibration rail. |
| `apps/web/src/{home/home.test.tsx,production-router-harness.test.ts}` | Updates direct public-route assertions to the new real choice boundary. |
| `apps/web/src/visual/{approved-reference,demo-api.e2e,production-route-isolation}.visual.spec.ts` | Drives choice explicitly before calibration in production/demo paths and verifies `/verified` has no calibration mutation before the player prepares wall pass. |
| `apps/web/design-qa.md` | Records the before/fix/after remediation comparison and pending independent acceptance. |

### RED/GREEN evidence added in this remediation

- **RED:** `rtk pnpm --filter @revelai/web exec vitest run src/verified/tracer.test.tsx --reporter=verbose` — **1 failed, 41 passed (42)** before `ChallengeChoice` existed; the expected public choice heading was absent.
- **RED:** `rtk pnpm --filter @revelai/web exec vitest run src/verified/production-capture.test.tsx --reporter=verbose` — **1 failed, 9 passed (10)** before the approved fallback image existed.
- **RED:** `rtk pnpm --filter @revelai/web exec vitest run src/verified/tracer.test.tsx -t 'preserves the gated setup correction' --reporter=dot` — **1 failed, 41 skipped (42)** before `displayedPassedGates` reflected the actually-complete device step; observed `data-passed="false"`.
- **GREEN:** `rtk pnpm --filter @revelai/web exec vitest run src/verified/tracer.test.tsx src/verified/production-capture.test.tsx --reporter=dot` — **52 passed**.
- **GREEN:** `rtk pnpm --filter @revelai/web exec vitest run src/home/home.test.tsx src/production-router-harness.test.ts src/verified/tracer.test.tsx src/verified/production-capture.test.tsx --reporter=dot` — **63 passed**.

### Fresh design-QA remediation matrix

Every item below was captured after `b20bf02`, at `390×844` CSS pixels, DPR 2, CSS scale, normalized density 1. Reference, capture, 50% overlay, and complete unmasked diff were opened and inspected. Artifact directory: `apps/web/coverage/playwright/visual-artifacts/`.

| Finding | Exact code fix | Fresh artifact stem | Full unmasked ratio / outcome |
| --- | --- | --- | --- |
| W6-V02 challenge choice | `ChallengeChoice` + `TracerStage` `challenge`; move setup only from `Preparar desafio`. | `verified-challenge-default--390x844--dpr-2--verified--challenge-choice` | **23.596%**. Card/disabled rows/CTA/headline are present; approved hero subject/crop is P3 only. |
| W6-V03 calibration | `SetupProgress`, `CalibrationGuidance`, `displayedPassedGates` use actual gate/camera state. | `verified-calibration-default--390x844--dpr-2--verified--calibration-guidance` | **38.174%**. Rail, passed device, active correction, truthful blocked guidance and hero region are present; unavailable source court art is P3 only. |
| W6-V04 capture | real camera conditional plus `capture-fallback-image`, semantic requirements disclosure and control layout. | `verified-record-default--390x844--dpr-2--verified--recording-capture` | **34.494%**. Actual camera remains primary when present; approved fallback/crop difference is P3 only. |
| W6-V05 pending | semantic `processing-timeline`, foreground/manual refresh copy, no closed-app promise/control. | `verified-processing-demo--390x844--dpr-2--verified--processing-pending` | **25.132%**. Timeline hierarchy is present; removed notification/image-strip source content is required truth/asset P3 only. |
| W6-V06 ranked report | `VerifiedReport` scorecard/metrics/insight; ranked branch is isolated and demo/experimental structurally lack rank fields. | `verified-ranked-policy-approved--390x844--dpr-2--verified--ranked-report` | **16.812%**. Persistent exact competitive truth and report hierarchy are present. |

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
