# W0 — Web runtime, shell, home, and visual harness report

## Scope delivered

Added `@revelai/web` as an independently buildable Vite/React/TypeScript workspace package. Its build first verifies the approved design assets and builds `@revelai/design-system`, then compiles the web package and produces the Vite artifact.

The `/` route now renders the approved responsive RevelAI home treatment using only `apps/web/public/assets/futsal-hero.png`, the shared design tokens, and Phosphor icons. It exposes the required named controls:

- `Início` remains on `/`.
- `Meus treinos`, `Ranking`, `Treino livre`, `Desafio verificado`, and `Analisar treino` each route to the accessible unavailable shell with the exact message `Disponível após ativação do fluxo`.
- No client/API module was added and every unavailable interaction is covered as producing zero `/v1/` requests.

The shell has semantic landmarks, visible keyboard focus, an accessible mobile navigation control, explicit accessible names/descriptions for the choice controls, AA token colors, and a reduced-motion media query.

## Files changed

- `apps/web/package.json`, TypeScript/Vite/Vitest/Playwright configuration, entry HTML, and startup script.
- `apps/web/src/app.tsx`, `src/main.tsx`, `src/home/home.tsx`, and `src/styles.css` for the router, providers, responsive home, unavailable shell, tokens, and accessibility treatment.
- `apps/web/src/home/home.test.tsx` for home semantics, viewport coverage, keyboard activation, unavailable routing, and no-network assertions.
- `apps/web/src/visual/*` for the asset gate, deterministic fixture selection, screenshot metadata/naming, portable overlay/diff pixels, and real-browser desktop/mobile checks.
- `pnpm-lock.yaml` for the web runtime and test dependencies.

No API, domain, vision, contracts, or approved asset content was modified.

## TDD evidence

Each production seam was introduced only after an observed failing test or build reproduction:

1. Initial home and harness tests failed because `../app` and `./visual-harness` did not exist. The expected import-resolution errors were observed before the React shell or harness implementation. The focused suite then passed.
2. The checksum-gate test failed because `apps/web/scripts/verify-design-assets.mjs` did not exist. The added build/dev gate now executes the approved portable design verifier and the test passes.
3. The accessible description test failed with `Expected element to have accessible description` while choice buttons used only `aria-label`. The controls now use `aria-labelledby` plus `aria-describedby`, preserving both concise names and their visible descriptions.
4. The overlay test failed because `blendOverlayPixels` was absent. The harness now returns deterministic RGBA overlays and pixel diffs.
5. The Playwright suite first failed for its absent local browser, then for the missing base URL/web server. Chromium was installed locally for verification only; the Playwright config now starts Vite on the configured loopback URL. It subsequently passed at both required viewports.
6. The root check caught Playwright's `.visual.spec.ts` being collected by Vitest. `vitest.config.ts` now retains Vitest's default exclusions and adds only `**/*.visual.spec.ts`; the root check passed afterward.

## Verification evidence

- `rtk pnpm --filter @revelai/web test` — 3 files, 11 tests passed.
- `rtk pnpm --filter @revelai/web lint` — passed.
- `rtk pnpm --dir apps/web run typecheck` — passed.
- `rtk pnpm --filter @revelai/web build` — passed; asset gate verified 10 assets and Vite built the production artifact.
- `rtk pnpm --dir apps/web run test:visual` — 6 Playwright checks passed: desktop and mobile layout/control semantics, reduced motion, unavailable targets, and zero `/v1/` requests.
- `rtk pnpm verify:design-assets` — `Design assets verified: 10 assets.`
- `rtk pnpm check` — passed all root format, lint, typecheck, test, and build tasks; web was included in every Turbo phase.
- `rtk git diff --check` — passed.

## Self-review

### Standards

- The workspace package uses `pnpm`, participates through the existing `apps/*` workspace glob, and provides the standard `lint`, `typecheck`, `test`, and `build` scripts.
- Production routing has no API client, fetch call, temporary feature state, or Core import. The non-home controls only navigate locally to a static unavailable boundary.
- The hero is the approved runtime crop; all UI icons come from `@phosphor-icons/react`; there are no custom SVGs, CSS icon substitutions, emoji, gradients, or CSS art.
- The visual helpers are browser/Node-portable typed-array operations, use deterministic fixture lookup and filename construction, and put generated Playwright output under the repository's already-ignored `coverage/` tree.

### Brief alignment

- Required controls, exact unavailable copy, desktop 1440×1024 and mobile 390×844 coverage, keyboard focus, reduced motion, checksum gating, zero API calls, and visual metadata fields are all implemented and tested.
- The W0 scope remains a runtime/home/harness slice. Future history, ranking, calibration, capture, result, and Free workflow state remains structurally absent.

No blocking findings remain from this self-review. Independent review remains with the controller as required.

## Commit

- Application-shell candidate: `0a173f338c87dc34a91dd56d314417fc2fcc21b3` — `feat(web): add responsive application shell`

## Concerns

- Playwright's Chromium binary was installed in the local user cache to execute the browser suite. It is not tracked or committed.
- W0 prepares deterministic overlay/diff primitives and browser viewport checks. Pixel-perfect reference capture/overlay acceptance remains W6's designated QA slice.
