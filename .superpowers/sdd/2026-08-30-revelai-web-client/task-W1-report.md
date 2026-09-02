# W1 report — schema-parsed API client and attempt history

## Outcome

Functional implementation commit: `29d0a3490592dd0e658e03f42dbaed5205442954` (`feat(web): add schema-parsed history client`). No push was made.

W1 adds the contract-parsed browser API client, locally persisted device UUID header identity, and the only active W1 product route: `/training/history` / “Meus treinos neste dispositivo”. Existing production controls for Ranking, Treino livre, Desafio verificado, and Analisar treino remain unavailable and make no API call.

## Implementation and files

- `apps/web/src/lib/api/client.ts`: `createRevelApiClient` validates all public inputs and parses every public success/error with exported `@revelai/contracts` schemas. It implements challenge list, attempt/calibration creation, calibration ready, media upload, attempt/outcome/history reads, leaderboard, and delete. It injects only `X-RevelAI-Athlete-Id`; parsed errors retain only `code`, `message`, `retryable`, and HTTP `status`; abort without a response is `{ kind: "aborted" }`.
- `apps/web/src/lib/api/identity.ts`: one browser-local UUID at `revelai.device-athlete-id`, validated before reuse or replacement. It is never rendered or logged.
- `apps/web/src/history/history.tsx`: TanStack infinite query preserving API order, explicit loading/empty/initial-error/cursor-error/cursor-retry states, deletion success removal, deletion retry, semantic controls, and heading focus after navigation.
- `apps/web/src/app.tsx`, `apps/web/src/styles.css`: client/query lifecycle, active history route/navigation link, focus/disabled/history presentation.
- `apps/web/src/lib/api/client.test.ts`, `identity.test.ts`, `history/history.test.tsx`: MSW boundary tests for the client, identity, and history behavior.
- `apps/web/src/home/home.test.tsx`, `apps/web/src/visual/home.visual.spec.ts`: preserve W0 unavailable coverage while asserting the active, keyboard-focusable history link.
- `apps/web/package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`: direct contracts and MSW test dependencies. `allowBuilds.msw: true` is explicit because MSW requires build-script approval during install; lock formatting reduced earlier quote-only churn to the substantive MSW graph/peer snapshot changes.

## TDD evidence

RED commands and relevant expected output:

1. `rtk pnpm --filter @revelai/web exec vitest run src/lib/api/client.test.ts` → `Failed to resolve import "./client"`; expected before the client existed.
2. The same focused client run after only the first minimal client shape → `client.createAttempt is not a function` / missing calibration and read methods; expected before adding the remaining contract routes.
3. The malformed/error matrix initially failed on unparsed RouteErrors, abort, and 204 parsing; expected until the common response parser reduced errors and handled transport aborts.
4. `rtk pnpm --filter @revelai/web exec vitest run src/lib/api/identity.test.ts` → identity module missing; expected before local UUID persistence was implemented.
5. `rtk pnpm --filter @revelai/web exec vitest run src/history/history.test.tsx` first failed because “Meus treinos” still led to the W0 unavailable shell; later REDs covered absent list rendering, retries, cursor handling, and deletion.
6. `rtk pnpm --filter @revelai/web exec vitest run src/home/home.test.tsx` → two assertions still expected “Meus treinos” to be unavailable; this was the intentional W1 activation change.
7. `rtk pnpm check` initially failed four Playwright tests waiting for a `button` named “Meus treinos”. Those legacy W0 expectations were updated to keep only the W0 controls unavailable and to exercise the history link.

GREEN focused iterations:

- `rtk pnpm --filter @revelai/web exec vitest run src/lib/api/client.test.ts src/lib/api/identity.test.ts src/history/history.test.tsx src/home/home.test.tsx` → 4 files, 72 tests passed.
- `rtk pnpm --filter @revelai/web run test:visual:structural:run` → 17 passed, 7 structural skips after the W1 route assertion.
- Client test runs in Vitest’s Node environment: MSW request-body consumption for multipart timed out in jsdom, while the same real request boundary passes in Node. History/DOM tests remain in jsdom and the browser route is covered by Playwright.

## Complete verification

All completed after the final pagination self-review adjustment:

- `rtk pnpm --filter @revelai/web run test` → Vitest 11 files / 92 tests passed; structural Playwright passed with its 7 intentional renderer-specific skips.
- `rtk pnpm --filter @revelai/web run lint` → passed.
- `rtk pnpm --filter @revelai/web run typecheck` → passed.
- `rtk pnpm --filter @revelai/web run build` → passed.
- `rtk pnpm check && rtk git diff --check` → exit 0; format, lint, typecheck, tests, build, and whitespace checks all passed.

## Self-review against W1 brief

- Every exposed client route uses an exported response/error schema; no local wire union, status mapping, score/rank logic, or provider detail was invented.
- The MSW tests mutate a required/discriminant/value response field for every public method, iterate every exported RouteError fixture including retryability/status, assert the one-part C2 multipart request and accepted body, cover every rejected media fixture, and cover the shared no-response abort fixture.
- Tests prove the header is present, JSON creation bodies contain no identity, the history DOM/log/warn/error outputs contain no local UUID, and API order is not re-sorted.
- History explicitly covers loading, empty, populated, initial retry, next-page loading/error/retry, deletion error recovery, and disappearance after deletion. The pagination logic distinguishes a next-page error from an initial-load error even when the first page is empty.
- The only activated W1 UI entry is “Meus treinos”; W0 unavailable/no-call behavior remains asserted for all other product controls.

## Concerns

No known functional concerns. The Node test environment selection for client multipart inspection is intentional and documented above; browser behavior is separately validated through jsdom history tests and structural Playwright.

## Fix round 1/5 — important review findings

Follow-up functional commit: `dcb68bf375acc42e9406ed88845174c59d01ef8a` (`fix(web): harden history interactions`). This round fixes only the three open Important findings. The deferred Minor request-descriptor item was not changed.

### Implementation and coverage

- `apps/web/src/lib/api/client.test.ts`: adds negative RouteError boundary cases for unknown code, non-allowlisted message, retryability mismatch, extra transport field, and a valid RouteError at the wrong HTTP status. Each malformed response must reject as a `ZodError`; the status mismatch must reject with the contract-mismatch error. Neither path may emit the normalized `RevelApiError` shape.
- `apps/web/src/history/history.tsx` and `history.test.tsx`: deletion clears any old completion message on mutation, gives the pending control the accessible name “Excluindo treino”, announces “Treino excluído.” via `role="status"` on success, and moves focus to the retained history heading. The new test uses two attempts and a deferred DELETE to prove pending name, announcement, removal, and focus recovery.
- `apps/web/src/app.tsx`, `home/home.test.tsx`, and `visual/home.visual.spec.ts`: place the mobile toggle before its navigation in DOM order, add Escape close with toggle-focus restoration, and test a real browser Tab sequence through Início, Meus treinos, and Ranking. Existing jsdom keyboard tests were aligned to that visible DOM order.

### RED → GREEN evidence

1. New RouteError tests were first added while the existing parser was correct. To prove the regression test was not vacuous, `client.ts` was temporarily and only locally mutated from `const parsed = RouteErrorSchema.parse(value);` to `const parsed = value as RouteError;`. `rtk pnpm --filter @revelai/web exec vitest run src/lib/api/client.test.ts` then produced `4 failed | 59 passed`: malformed message/retryability/extra-field values were normalized and the unknown code reached the status branch instead of failing Zod validation. The exact schema parse was restored before any GREEN run or commit.
2. `rtk pnpm --filter @revelai/web exec vitest run src/lib/api/client.test.ts src/history/history.test.tsx` first produced the intended history RED: `Unable to find an accessible element with the role "button" and name "Excluindo treino"`; the pending text was masked by the fixed `aria-label`, and no completion/focus behavior existed.
3. `rtk pnpm --filter @revelai/web run test:visual:structural:run` first produced the intended mobile navigation RED: after opening the menu with real keyboard input, `Início` was inactive after Tab because the toggle followed the nav in DOM order. The test also proves Escape restoration after the fix.
4. GREEN focused runs: `rtk pnpm --filter @revelai/web exec vitest run src/lib/api/client.test.ts src/history/history.test.tsx` → 69 passed; `rtk pnpm --filter @revelai/web run test:visual:structural:run` → 18 passed, 8 intentional structural skips.

### Final verification and self-review

- `rtk pnpm --filter @revelai/web run lint`, `typecheck`, and `build` → passed.
- `rtk pnpm --filter @revelai/web run test` → 11 files / 98 Vitest tests passed; structural Playwright 18 passed / 8 intentional skips.
- `rtk pnpm check && rtk git diff --check` → exit 0 before the functional commit.
- Self-review verified: RouteError schema and status branch are now both negatively covered without changing the client implementation; delete success preserves the API order/cache behavior while giving an accessible pending name, live completion, and deterministic heading focus; the desktop nav remains visually unchanged while mobile keyboard navigation follows its actual DOM order and Escape returns focus to the toggle. No request-descriptor changes were included.

No new functional concerns identified.

## Fix round 2 — hosted Linux Chromium timeout recovery

Follow-up functional commit: `cf1b306005590bbdc51967deb7b16a40d335be8a` (`test(web): budget cold Chromium startup`). This round changes only `apps/web/src/visual/playwright-runner.test.ts`; no W2 code, runner behavior, Playwright command, browser proof, or visual assertion was changed.

### Diagnosis and narrow fix

Hosted run `33600218015` failed only the Linux quality `pnpm check` gate. Its first real-browser integration test at `playwright-runner.test.ts:50` reached Vitest's default 5,000 ms deadline at 5,011 ms while starting Chromium on a cold Linux worker. The remaining 97 web tests passed; the macOS controller run passed the same proof in about 1.2 s. This is cold-start scheduling/launch variance at a boundary with an unambiguous five-second default, not a runner or browser assertion failure.

The real Chromium test now has the test-local `realBrowserIntegrationTimeoutMs = 15_000` third `it` argument. Fifteen seconds is approximately three times the observed hosted cold start, retains a finite diagnostic deadline, and avoids relaxing Vitest's global timeout or changing runner behavior. The test still spawns the real runner, launches Chromium, requires `1 passed`, and proves `NO_COLOR` sanitation.

### TDD and verification evidence

- RED is the hosted Linux log itself: run `33600218015` reported the integration at 5,011 ms against Vitest's default 5,000 ms. It is a real CI reproduction of exactly the test and package-script path being fixed, so no synthetic slowdown was introduced.
- A direct `rtk pnpm --filter @revelai/web exec vitest run src/visual/playwright-runner.test.ts` was intentionally rejected as a focused harness because it does not pass `npm_execpath`; this test correctly rejects direct Node invocation before Chromium starts. The relevant production-like focused evidence is the package script below.
- GREEN: `rtk pnpm --filter @revelai/web run test` → 11 files / 98 Vitest tests passed; the real browser integration passed in 1.417 s locally; structural Playwright 18 passed / 8 intentional skips.
- `rtk pnpm --filter @revelai/web run lint`, `typecheck`, and `build` → passed.
- `rtk pnpm check && rtk git diff --check` → exit 0 before the functional commit; all root format, lint, typecheck, test, build, and whitespace gates completed.

### Self-review and concerns

The timeout is scoped only to the cold real-browser integration, remains finite, and is grounded in the hosted 5.011 s observation. It does not hide assertion failures, remove the Chromium launch, alter runner command/child environment behavior, or change unrelated test budgets. No new functional concerns identified; hosted CI remains the final proof of its slower cold-worker envelope.
