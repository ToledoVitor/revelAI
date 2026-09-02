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
