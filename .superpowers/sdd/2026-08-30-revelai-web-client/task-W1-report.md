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
