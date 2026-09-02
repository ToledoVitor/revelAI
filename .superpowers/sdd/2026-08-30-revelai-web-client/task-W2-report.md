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

## Review fix round 2 (commit `c06b978`)

The second review found that the first production graph test needed a separate, behaviour-level production transform proof; the artifact builder needed to work with no pre-existing workspace outputs; process cancellation needed the same lifecycle protection as the existing Playwright tooling; and the new selection/completion buttons needed the app's action styling. This round resolves those concerns without adding a second route switch or any real capture/API behaviour.

### Changes made

- `apps/web/src/production-router-harness.test.ts` creates a normal Vite application build from a small test-only entry while `NODE_ENV=production` is set before Vite transforms modules. It imports the resulting entry into a JSDOM document and mounts the emitted `App`; it is therefore distinct from both a unit JSX render and served Playwright. Direct and history-driven navigation for setup and capture each assert the normal unavailable boundary, the route-specific safe copy, zero `fetch`, zero fake-port calls, and no review evaluation marker.
- `apps/web/src/app.test.tsx` now uses that same pre-transform production environment for its graph-level build. It proves the actual review source module is absent from `moduleIds` and its evaluation marker is absent from emitted code; it does not mutate an already evaluated router environment.
- `apps/web/scripts/production-router-build.mjs` owns the isolated-artifact workflow. Before compiling the web app it builds every workspace dependency of `@revelai/web` through the filtered dependency graph (contracts and design system), rather than assuming their `dist` folders exist. It removes/recreates only `apps/web/coverage/production-router-dist`, builds into it, then asserts the result. The artifact assertion rejects a review `setup-*.js` chunk as well as the existing review-content marker scan.
- `apps/web/scripts/production-router-build.check.mjs` uses the existing Chromium-runner lifecycle pattern to prove `SIGINT`, `SIGTERM`, and `SIGHUP` are forwarded to the active pnpm child, every listener is removed after one settlement, and child errors, non-zero exits, and child signals reject. `runPnpm` protects settlement with one cleanup path.
- `apps/web/scripts/production-router-clean-dist.check.mjs` temporarily moves only the contracts and design-system output directories aside, runs the normal `test:production-router` command, verifies those outputs were rebuilt, and restores the exact original outputs in `finally`. It is wired into the normal web test command, so the clean-install property cannot silently regress.
- The review setup challenge-selection, continuation, and completion-return controls use the shared `setup-action` treatment. The selected challenge and primary continuation/return states use design tokens for normal, selected, disabled, hover, and inherited visible-focus behaviour; no new icon or custom visual asset was introduced.

### RED → GREEN evidence

1. The first production-transform harness test was RED before its browser entry existed (Vite could not resolve the entry). After adding the entry, it exposed the real test environment issue: a Vite build invoked while the test process still had `NODE_ENV=test` treated the review import as development even with `mode: "production"`. Setting `NODE_ENV=production` before `build()` starts transforming modules made the production harness GREEN: 4 cases for direct/in-app setup/capture navigation.
2. The isolated builder lifecycle test was RED before the extracted builder module existed. The minimal builder module then made the two Node lifecycle tests GREEN, including all three forwarded terminal signals and single-settlement failure paths.
3. The clean-output probe first failed when invoked as a bare Node runner because the project deliberately requires `npm_execpath` to run pnpm safely. Running it through its durable package script is the real contract and was GREEN: it removed both dependency outputs, rebuilt the artifact/served proof, checked new outputs, and restored the prior folders. The first full web run then caught the Node lifecycle file being collected by Vitest because of its `.test.mjs` suffix; renaming it to the repository's established `.check.mjs` convention was the single runner-isolation fix. The full suite then passed.
4. The button-structure assertions were RED because challenge selection, initial Continue, and completion Return had no action classes. The minimal classes/styles made the focused setup suite GREEN: 11 tests.

### Fix-round verification

- `rtk pnpm --dir apps/web exec vitest run src/app.test.tsx src/production-router-harness.test.ts src/verified/setup.test.tsx` → 3 files / 16 tests passed.
- `rtk node --test apps/web/scripts/production-router-build.check.mjs` → 2/2 lifecycle tests passed.
- `rtk pnpm --dir apps/web run test:production-router:clean` → clean dependency-output probe passed and restored original outputs.
- `rtk pnpm --dir apps/web run build:production-router` → filtered dependency build plus a fresh isolated production artifact passed; the graph/file assertion found no review source/chunk/marker.
- `rtk pnpm --dir apps/web run test:production-router` → 4/4 served artifact tests passed for direct and in-app setup/capture.
- `rtk pnpm --dir apps/web exec playwright test --config playwright.config.ts src/visual/review-setup-lazy-import.visual.spec.ts --project desktop-home` → an actual served DEV browser loaded the review heading without console or review-module 4xx errors.
- `rtk pnpm --dir apps/web run lint`, `typecheck`, and `build` → all passed.
- `rtk pnpm --dir apps/web run test` → 6 Node checks, 14 Vitest files / 114 tests, and 20 structural browser checks passed (8 established visual skips).
- `rtk pnpm check` → root format, lint, typecheck, test, and build passed (exit 0).
- `rtk git diff --check` and cached diff check passed before the functional commit.

### Final self-review

- No `reviewModeEnabled` or other injectable router switch was reintroduced. The only production-route test seams are erased type imports and a fake port that the transformed production router does not evaluate or call.
- The harness mutates `NODE_ENV` only around Vite's module transformation and restores its previous value in `finally`; it does not fake an environment after router evaluation.
- The clean probe targets two explicit workspace `dist` folders, not a broad workspace path, and restores their prior contents. The artifact itself remains scoped to the ignored web coverage folder.
- No known functional concern remains. No push was made.

## Review fix round 3 (commit `fe3f9bb`)

Reviewer verdict: the clean-output probe was `CHANGES_REQUIRED`. Its original staging loop could move the first dependency and then throw while staging the second without returning recovery state; it also deleted a deterministic backup name before using it, and parent termination could bypass restoration. This round narrows the fix to the clean production-router probe. W3 capture/timer work and the review router are unchanged.

### Changes made

- `apps/web/scripts/production-router-clean-dist.mjs` separates the executable recovery logic from its Node check. It stages only the two explicit web dependency outputs into collision-safe, unique `mkdtemp` directories under the operating system temporary directory. Staging never removes an existing backup: every planned backup is checked first, and a collision fails closed before either source is moved.
- A failed second `lstat`/rename rolls back already staged outputs immediately. When that rollback itself partially fails, the error retains the mutable staged state; the outer cleanup retries only entries that have not already been restored. Recovery checks that a backup exists before deleting a rebuilt source, so it never deletes the only recoverable original.
- The clean probe owns `SIGINT`, `SIGTERM`, and `SIGHUP` listeners from staging through cleanup. A first parent signal is forwarded once to the spawned production-router child; the async flow waits for that child to settle, restores outputs, removes its own temporary directory after successful recovery, removes every listener, and only then rejects with the signal. No path calls `process.exit`.
- The production child runner also has one-settlement handling for spawn errors, child signals, and normal exits. A non-zero completed check remains an error, and the command verifies that its dependency outputs exist after the real rebuild and before originals are restored.

### RED → GREEN evidence

1. The new narrow check suite was RED while the imported recovery module did not exist (`ERR_MODULE_NOT_FOUND`). The extracted module made the initial rollback, collision, signal, and real clean-build scenarios GREEN.
2. The real clean-build probe then exposed an additional production boundary: staging below `apps/web/coverage` left `dependency-0` absent after the Playwright production command, before restoration. The command uses that coverage space for its own artifacts. Moving the unique staging root to `mkdtemp(tmpdir())` was the minimal isolation change; the same real probe became GREEN while still rebuilding and restoring both dependency outputs.
3. A further RED test injected a first rollback failure after the second dependency staging error. Before the fix, the outer cleanup received an empty staged list and the original contracts output was missing. The staged-state error payload plus per-entry `restored` state lets the outer cleanup retry the unfinished rollback. GREEN restores the original marker exactly and leaves no backup residue.

### Deterministic recovery checks

- Second dependency staging failure after the first move: exact first output is rolled back and both planned backup paths are absent.
- Pre-existing backup collision: the source outputs remain intact and the collision contents are preserved; no backup is deleted.
- Parent `SIGTERM` after staging: only one signal is forwarded to the child, its exit settles the flow, exact original outputs return, and `SIGINT`/`SIGTERM`/`SIGHUP` listeners are all removed.
- A real `test:production-router` run from staged outputs still builds the dependencies, serves the isolated production artifact, and restores the pre-existing dependency output directories afterward.

### Fix-round verification

- `rtk pnpm --dir apps/web run test:production-router:clean` → 5/5 recovery and real clean-build checks passed.
- `rtk pnpm --dir apps/web run test:production-router` → 4/4 served production setup/capture isolation checks passed.
- `rtk pnpm --dir apps/web run lint`, `typecheck`, `build`, and `test` → all passed; the web test includes 10 Node checks, 14 Vitest files / 114 tests, and 20 structural browser checks with 8 established skips.
- `rtk pnpm check` → root format, lint, typecheck, test, and build completed with exit 0.
- `rtk git diff --check` and cached diff check passed before the functional commit.

### Final self-review

- The cleanup scope is limited to explicit contracts/design-system `dist` sources and a fresh, validated temporary staging directory; it does not delete a workspace, coverage root, or a pre-existing backup.
- If recovery cannot safely complete, the process rejects and leaves a remaining backup rather than deleting it. If it can complete, it restores the original directory identity via rename before removing only the temporary staging directory it created.
- Production graph/harness, served artifact proof, development lazy-import smoke, W1 production unavailability, and W2's no-session/no-attempt boundaries are unaffected. No push was made.

## Review fix round 4 (commit `a75fa2d`)

Reviewer verdict: `CHANGES_REQUIRED` on the round-3 signal proof. The production module used `processRef.once(...)`; when a first termination signal started child settlement/recovery, that listener removed itself. A second same or mixed terminal signal could therefore reach Node's default signal behavior and terminate the parent before it restored the staged dependency outputs. The earlier `EventEmitter` check could not observe that operating-system behavior. This round changes only the W2 clean production-router recovery lifecycle and its tests; capture, timers, session/attempt behavior, and production route isolation are unchanged.

### Changes made

- `runCleanProductionRouterCheck` now registers persistent `processRef.on(...)` handlers for `SIGINT`, `SIGTERM`, and `SIGHUP` before staging. The existing `parentSignal` guard still records and forwards only the first signal to the production-router child. Repeated and mixed signals remain consumed/no-op until the final recovery cleanup removes every handler in `finally`.
- The existing fake-process check now also emits a mixed `SIGHUP` and `SIGINT` after repeated `SIGTERM`; the child still records precisely one forwarded `SIGTERM`, and all three listeners are removed after recovery.
- A real subprocess integration probe starts from an explicit temporary root and creates two marker output directories. Its controlled nested child reports the forwarded signal, while a custom exact-path `rename` barrier intentionally pauses restoration of the first marker.
- The parent Node check waits for the nested child readiness, sends the initial `SIGTERM`, waits for the probe's restoration barrier, then sends two more `SIGTERM`s during that barrier. Before release it asserts the probe has neither exited normally nor with a signal. After writing the explicit release token and closing only its pipe, it requires a normal `{ code: 0, signal: null }` exit, exactly one forwarded `SIGTERM`, and the sentinel written only after exact-marker recovery and zero listeners.
- Both the outer check and probe have bounded waits and explicit cleanup. If the probe test fails, its `after` hook kills/waits for only that probe before removing only its exact temporary root; the probe itself removes only its validated `work` child directory. The nested child exits after its first forwarded signal, so failed probes do not leave child processes or staged outputs behind.

### RED → GREEN evidence

1. With the new real subprocess test and the old `processRef.once` implementation, the focused check was RED deterministically: output reached `child-ready`, `forwarded:SIGTERM`, and `restoration-held`, then the second `SIGTERM` ended the probe with `signalCode = SIGTERM` before the release token and restoration. This demonstrates the actual OS signal defect that the fake `EventEmitter` missed.
2. Replacing only `.once` with persistent `.on` made the second signal stay intercepted. The first green execution then showed a test-harness lifecycle issue: the parent had released the barrier but retained the probe's stdin pipe, which kept the probe event loop open. Tracing the probe's input listener established that this was the harness, not recovery behavior. Ending that one pipe immediately after the release token produced the expected normal exit.
3. The finished focused proof passed 6/6: staged rollback, collision safety, retry recovery, fake-process/mixed-signal lifecycle, the real repeated-`SIGTERM` subprocess lifecycle, and the real clean dependency rebuild/restoration.

### Fix-round verification

- `rtk pnpm --dir apps/web run test:production-router:clean` → 6/6 Node checks passed, including the OS-signal subprocess probe and a real rebuild/restoration run.
- `rtk pnpm --dir apps/web run test:production-router` → 4/4 served production setup/capture unavailable-boundary checks passed.
- `rtk pnpm --dir apps/web run lint`, `typecheck`, `build`, and `test` → all passed; web test includes 11 Node checks, 14 Vitest files / 114 tests, and 20 structural browser checks with 8 established skips.
- `rtk pnpm check` → root format, lint, typecheck, test, and build passed.
- `rtk git diff --check` → passed before committing the functional change and will be rerun for this documentation commit.

### Final self-review

- A repeated signal now cannot regain Node's default process termination while any staged output may still need restoration. The one first-signal guard preserves the previous controlled child-stop behavior and avoids multiple `kill` calls or multiple completion paths.
- The subprocess proof uses genuine operating-system `SIGTERM`, rather than an emitter fake, and verifies the critical order: first forwarding, recovery held, repeated signals ignored, exact restoration/listener cleanup, then sentinel and normal exit.
- Cleanup remains narrowly scoped to explicit temporary test paths and the pre-existing recovery module's two validated dependency-output paths. No W1 production request path, W2 review runtime state, W3 capture behavior, or production artifact boundary was expanded. No push was made.

## Hosted CI regression fix (commit `98dd490`)

Hosted run `33611887462` failed the Ubuntu `pnpm check` after the W2 review candidate. The only failing test was the real production Vite graph assertion in `apps/web/src/app.test.tsx`: it timed out at 5,304 ms against Vitest's implicit 5,000 ms test budget while awaiting `buildWithProductionEnvironment()`. Its sibling production-router harness completed and passed in 9,357 ms, confirming that the CI worker was executing real production transformations under contention rather than reporting a graph assertion failure.

### Root-cause evidence

- CI-mode isolated app-graph runs were finite and passed in 1,711 ms, 1,700 ms, and 1,564 ms. The same app/harness pair with ordinary local file parallelism passed in 1,658 ms, 1,655 ms, and 1,653 ms, so local parallelism alone was not sufficient to reproduce the hosted failure.
- A deterministic guarded CPU-contention loop started 24 short-lived `yes` workers with a `trap` that kills and waits for every recorded PID. Under the original implicit budget, it reproduced the exact timeout deterministically: app/harness runs failed at 5,086 ms, 5,043 ms, and 5,015 ms; the app graph test alone also failed at 5,073 ms. Thus file parallelism can increase pressure but is not required for the failure.
- Under the same contention with a temporary CLI 15-second budget, the original graph build completed at 6,651 ms and 6,906 ms. This ruled out a hidden hang or unfinished Vite handle: the assertions execute and complete once the legitimate build is given a finite integration budget.
- The clean dependency-output probe passed 6/6, including its real rebuild/restoration, and an immediate focused graph build passed in 1,518 ms with a clean worktree. Clean-dist prior state was therefore falsified.
- The exact pinned Linux/amd64 Playwright image was not usable as a fast reproduction on the Apple host because emulation produced no useful output; the hosted log plus the deterministic local stress loop are the evidence basis.

### Minimal fix and RED → GREEN

- `apps/web/src/app.test.tsx` now declares `productionGraphIntegrationTimeoutMs = 15_000` and passes it only as the third argument of the existing production-graph `it`. This matches the repository's named, finite real-browser integration budget pattern. It does not change the test name, the production environment setup/restoration, graph/module/marker assertions, routing behavior, or global Vitest configuration.
- RED was the pre-fix guarded contention loop above, which failed at the same implicit 5-second boundary as hosted CI. After the scoped change, that exact loop was GREEN twice: 6,557 ms and 6,227 ms, with the review-module graph and evaluation-marker assertions still passing.

### Verification and review status

- `rtk pnpm --dir apps/web exec vitest run src/app.test.tsx src/production-router-harness.test.ts src/verified/setup.test.tsx --config vitest.config.ts` → 3 files / 16 tests passed.
- `rtk pnpm --dir apps/web run lint`, `typecheck`, `build`, and `test` → all passed; web test has 11 Node checks, 14 Vitest files / 114 tests, and 20 structural browser checks with 8 established skips.
- `rtk pnpm check` → root format, lint, typecheck, test, and build passed.
- Stress workers and temporary diagnosis artifacts were removed; `git diff --check` passed before the functional commit.
- Sol review is pending. No push was made.
