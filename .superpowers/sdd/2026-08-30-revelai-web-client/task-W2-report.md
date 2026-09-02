# W2 report — review-only verified setup gates

## Outcome

Functional candidate: `7975c59` (`feat(web): add review calibration setup gates`). No push was made.

W2 adds a review-only setup route for the futsal `wall-pass-v1` challenge. It is guarded by the single exported router value `reviewRoutesEnabled = import.meta.env.DEV || import.meta.env.MODE === "test"`. The review route is lazily imported and is registered only when the switch is true. A production build emits no review setup chunk; direct and in-app navigation to both `/_test/verified/setup` and future `/_test/verified/capture` reach the existing unavailable boundary without review-module evaluation, fake-port use, or `/v1/*` traffic.

No real `CalibrationSession`, `Attempt`, or API call is introduced. Production `Desafio verificado` and `Treino livre` remain the existing unavailable/no-call controls, and no athlete identity is rendered or logged.

## Implementation and files

- `apps/web/src/app.tsx`: owns the exact, single review-route switch and conditionally registers the lazy review setup route. The `reviewModeEnabled`/fake-port inputs are test seams; a production bundle still has no `ReviewSetupRoute` value, even if an input were supplied.
- `apps/web/src/verified/setup.tsx`: injected fake setup port and fixture, semantic camera-preview region/status, user-facing five-gate state machine in immutable `device → space → athlete → rehearsal → record` order, explicit correction/condition simulation, disabled Continue, remediation retry, existing-video fallback, Back, Cancel, and a setup-only completion message. It makes no transport calls and never says preparation produces a verified/validated/rankable result.
- `apps/web/src/verified/setup.test.tsx`: public UI/port tests for entry, disabled/enabled gates, the full exact sequence, three camera error modes, retry, fallback, completion guidance, Back, and Cancel.
- `apps/web/src/app.test.tsx`: production-valued route configuration tests for direct/in-app setup and capture URLs. Injected fake-port methods and `fetch` remain unused.
- `apps/web/playwright.production.config.ts` and `apps/web/src/visual/production-route-isolation.visual.spec.ts`: real served production-artifact proof for direct/in-app setup and capture navigation. The proof asserts the unavailable main, absent review heading, undefined review-module evaluation marker, and zero `/v1/*` requests.
- `apps/web/package.json` and `apps/web/playwright.config.ts`: add the production router proof command and exclude it from the development structural visual suite.
- `apps/web/src/styles.css`: responsive, token-based setup presentation, semantic preview treatment, disabled/enabled controls, visible focus inherited from the app, and reduced-motion compatibility inherited from the existing global rule.

## RED → GREEN evidence

1. Initial review-route RED:
   `rtk pnpm --filter @revelai/web exec vitest run src/verified/setup.test.tsx --config vitest.config.ts`
   failed with `Unable to find role="heading" and name "Preparação para passe na parede"`; the direct test URL rendered the normal unavailable shell before W2 registration existed.
   The first minimal guarded route/setup implementation made the same focused run pass: 1 test.
2. Device-gate RED: the next focused run failed with `Unable to find ... button ... "Simular câmera pronta"`. The minimal simulation/status/disabled-Continue code made the focused run pass: 2 tests.
3. Ordered-gate RED: the focused run then failed at `Unable to find ... "Etapa 2 de 5 — Espaço"` after the device gate. The public state machine was added for exactly the five required gates and completion guidance. The GREEN run passed: 3 tests.
4. Camera remediation RED: injected denied, unsupported, and unavailable fixture tests each failed to find their required user-facing status/fallback; the retry-port test also failed before the retry button existed. `cameraMessage`, fake-port retry, and existing-video fallback were then added. GREEN: 7 focused tests passed.
5. Back/Cancel RED: the focused run failed on the missing accessible `Voltar` button. The deterministic previous-gate and `/` cancellation actions were added. GREEN: 8 focused setup tests passed.
6. Production-route integration coverage was then added for direct and in-app setup/capture URLs. The finished focused suite was:
   `rtk pnpm --filter @revelai/web exec vitest run src/app.test.tsx src/verified/setup.test.tsx --config vitest.config.ts` → 2 files / 12 tests passed.

## Final verification

All commands below completed successfully after the functional code was finished:

- `rtk pnpm --filter @revelai/web run lint` → passed.
- `rtk pnpm --filter @revelai/web run typecheck` → passed.
- `rtk pnpm --filter @revelai/web run build` → passed; production build listed only the application bundle and no review setup chunk.
- `rtk pnpm --filter @revelai/web run test` → 13 Vitest files / 110 tests passed; structural Playwright 18 passed with 8 existing intentional skips.
- `rtk pnpm --filter @revelai/web run test:production-router` → 4/4 served production artifact tests passed: direct and in-app navigation for setup and capture.
- `rtk pnpm check` → all root format, lint, typecheck, test, and build gates passed.
- `rtk git diff --check` → passed before staging and before the functional commit.

## Self-review against W2 brief

- One exact exported switch controls the existing review setup route and is designed for W3 to reuse for capture; it is false in `vite build --mode production`, removing the lazy import/route before matching. The proof covers both required URLs in a served artifact, not an environment-mocked browser.
- The fake port contains only static review fixture/retry behavior. It never reaches the W1 client, all direct/repeated gate behavior is local state, and every isolation test asserts zero API calls; no calibration or attempt mutation is present.
- Every gate has a visible name/progress, current correction, an explicit condition represented by its disabled Continue control and review-only simulation, labelled preview status, and Back. The fallback announces that later guidance still applies; it does not imply it bypasses any rule.
- The completion copy says only that capture/result activation is still unavailable. It makes no server-validity, score, ranking, or verification claim. Existing production unavailable controls are preserved by the existing W0 tests plus W2 zero-fetch tests.
- Styles reuse design-system variables and Phosphor icons; no custom SVG or unapproved visual asset was introduced. Keyboard-native buttons, visible global focus indication, live statuses, disabled conditions, and the existing reduced-motion rule are retained.
- Manual diff review found no scope outside W2. No subagent/reviewer was dispatched, per the task instruction.

## Concerns

No known functional concerns. The review-only simulation intentionally does not request browser media: W3 owns real camera capture/recording, while W2 needs only safe setup guidance and test fixtures. The production proof command remains intentionally separate from the development visual suite because it must serve a previously built production artifact.

## Review fix round 1 (commit `23781fb`)

The follow-up review identified seven important gaps and one minor copy gap. This round resolves all eight without expanding W2 into capture, timers, sessions, attempts, or result verification.

### Changes made

- The review fixture is now an accessible, review-only challenge list. A user must select the single fake `wall-pass-v1` entry and explicitly continue before any setup gate is shown. The production router never registers or imports this code.
- The visible setup guidance now states the exact future capture timing: a 4-second calibration pre-roll and a 60-second active interval. Existing-video fallback repeats that it retains those same timings; no actual timing/capture behavior was added.
- Each of the five gates derives its one `role="status"` announcement from its current local pass state. Pending gates announce their correction; passed gates announce a ready/prepared state. There is no stale “aguardando simulação” message after a pass. The semantic preview uses that same sole live status.
- The review route focuses its heading at lazy entry, after each gate change, after Back, and at completion. Completion exposes a deterministic `Voltar para Início` action. Keyboard activation/focus behavior is covered.
- Repeated full review completion is exercised twice with a stubbed `fetch`; it records zero requests. The review module does not import or receive the W1 client, so `CalibrationSession` and `Attempt` mutation seams are unreachable by construction as well as by the no-fetch proof.
- `reviewModeEnabled` was removed. The exact exported `reviewRoutesEnabled = import.meta.env.DEV || import.meta.env.MODE === "test"` is the only registration decision: it creates either a lazy review component or `null`, before any route matching. The guarded import uses a Vite-ignored variable path so production compilation cannot graph-discover a review chunk.
- `apps/web/src/app.test.tsx` now runs a real Vite `mode: "production"`, `write: false` build and verifies the review setup source is absent from emitted `moduleIds` and that its evaluation marker is absent from chunks. This was deliberately RED before the import boundary change: production output still contained the setup module in its graph.
- The served production proof no longer previews whatever happens to be in `dist`. `build:production-router` removes and recreates `coverage/production-router-dist`, builds into it with `--mode production`, scans emitted JavaScript for review artifacts, then previews that exact directory. The production Playwright command is wired into CI.
- Both production review URLs now receive route-safe unavailable copy explaining that preparation guidance waits for full capture/result activation. Other unavailable destinations retain the generic boundary copy. The production proof confirms this without review-module evaluation.
- A normal-development Playwright smoke test now opens `/_test/verified/setup` in real Chromium at both project viewports, requires the review selection heading, and fails on a console error or a 4xx review-module response. This verifies the Vite-ignored variable import resolves in an actual served DEV browser, not just through Vitest transforms.

### Additional RED → GREEN evidence

1. The new selection helper first failed against the partial selection state because selecting the challenge immediately changed the screen, leaving no accessible `Continuar para orientação` control. Adding separate `hasStartedSetup` state made focused setup tests GREEN.
2. The new timing/single-live-status test failed RED because the 4-second/60-second guidance was absent. It then exposed the stale pending camera preview until status derivation was changed. GREEN: all five pending→passed states have exactly one live status and no stale waiting copy.
3. The transformed production graph test failed RED with the review setup source path still present in `moduleIds`. After moving the lazy import behind the sole compile-time guard with the Vite-ignored variable path, the same test was GREEN.

### Fix-round verification

- `rtk pnpm --dir apps/web exec vitest run src/app.test.tsx src/verified/setup.test.tsx` → 2 files / 12 tests passed.
- `rtk pnpm --dir apps/web run build:production-router` → fresh isolated production output built and artifact scan passed.
- `rtk pnpm --dir apps/web run test:production-router` → 4/4 served-production direct/in-app setup/capture checks passed, with zero `/v1/*` traffic and no evaluation marker.
- `rtk pnpm --dir apps/web run test:visual:structural:run -- src/visual/review-setup-lazy-import.visual.spec.ts` → normal development Chromium smoke passed at desktop and mobile, with no console or review-module 4xx errors (20 passed / 8 intentional skips in the structural suite).
- `rtk pnpm --dir apps/web test` → 13 Vitest files / 110 tests passed; structural visual suite 20 passed / 8 intentional skips.
- `rtk pnpm --dir apps/web run lint`, `typecheck`, and `build` → all passed.
- `rtk pnpm check` → root format, lint, typecheck, test, and build gates passed after the durable DEV smoke was added.
- `rtk git diff --check` and cached diff check → passed before functional commit.

### Follow-up self-review

- The only remaining review-related runtime input is the fake setup port, which can supply test data only after the compile-time guard has registered the review route. It cannot enable a production route.
- The isolated production output is explicitly scoped under `apps/web/coverage/production-router-dist`; no `dist` contents are reused by its preview command.
- No W1 production flow, real client mutation, capture timer, media request, verification claim, or unapproved visual dependency is introduced.
