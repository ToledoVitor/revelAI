# Design QA — RevelAI web home

## Audit record

- Audited route/state: `/`, `ready` / `home-default`.
- Source captures: `docs/design/references/desktop-home.png` (native `1487×1058`) and `docs/design/references/mobile-home.png` (native `853×1844`).
- Implementation captures: `apps/web/coverage/playwright/visual-artifacts/home-default--1440x1024--dpr-1--root--ready.png` and `apps/web/coverage/playwright/visual-artifacts/home-default--390x844--dpr-2--root--ready.png`.
- Desktop compare: source is normalized nearest-neighbour to `1440×1024` CSS pixels; the implementation capture is `1440×1024` CSS pixels at DPR `1`, with normalized pixel density `1`.
- Mobile compare: source is normalized nearest-neighbour to `390×844` CSS pixels; the implementation capture is `390×844` CSS pixels at DPR `2`, captured at CSS scale and normalized pixel density `1`.
- The source DPR is not embedded in the approved PNGs, so their native raster dimensions are recorded above; the comparison always uses the stated CSS dimensions and density-normalized files.

## Evidence reviewed

The full-view comparison input combines the approved reference and the implementation capture at equal dimensions:

- Desktop full: `apps/web/coverage/playwright/visual-artifacts/home-default--1440x1024--dpr-1--root--ready.overlay.png`.
- Mobile full: `apps/web/coverage/playwright/visual-artifacts/home-default--390x844--dpr-2--root--ready.overlay.png`.

The focused comparison input combines the same approved reference and implementation after only the variable runtime photo is hidden. It checks ink in the UI that sits over that photo:

- Desktop focused navigation: `apps/web/coverage/playwright/visual-artifacts/home-default--1440x1024--dpr-1--root--ready.ui-ink-overlay.png`.
- Mobile focused brand/headline/description: `apps/web/coverage/playwright/visual-artifacts/home-default--390x844--dpr-2--root--ready.ui-ink-overlay.png`.

The artifacts include each normalized reference, capture, overlay, diff, focused ink reference/capture/overlay/diff, and JSON metadata with viewport, DPR, route, state, fixture, CSS capture scale, and normalized density.

## Visual assessment

| Area               | Desktop 1440×1024                                                                                                                                                                                                                             | Mobile 390×844                                                                                                                                                 |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Typography         | Bundled Bebas Neue 400 provides the deliberately heavy condensed uppercase display treatment. Body copy uses bundled Arimo 400/700, an Arial-metric-compatible face that keeps the approved reference geometry stable across macOS and Linux. | Same bundled body and display faces; mobile scales and compresses the heading without truncation.                                                              |
| Layout and spacing | Header is 82px; photo begins at x=668 (46.4% width), matching the approved ~46% composition. Copy, decisions, and CTA remain within the warm-white panel.                                                                                     | Header is 58px; full ready state is exactly 844px tall. Brand, heading, description, both choices, and CTA all remain in viewport with no horizontal clipping. |
| Color and rules    | Shared tokens are warm white `#F7F5F0`, near black `#10110F`, deep emerald `#006B3C`, muted gray `#686B67`, and border gray `#CDD1CC`. Borders/rules are square and restrained, with no gradients.                                            | Same token palette; the mobile CTA uses deep emerald with warm-white type to preserve contrast over the compact decision area.                                 |
| Image and crop     | Approved runtime `public/assets/futsal-hero.png` is contained in the 53.6% right photo field with `object-fit: cover` / 57% horizontal crop. The source screenshot photo is intentionally different at runtime.                               | The same approved runtime asset occupies the upper 33.5rem field and remains intentionally variable from the source screenshot.                                |
| Copy and icons     | Approved visible Portuguese copy is present; unavailable destinations retain the exact unavailable message when activated. Choice and CTA arrows use `@phosphor-icons/react` `ArrowRight`.                                                    | Copy remains readable at 390px; the menu uses the approved Phosphor navigation icon rather than a custom glyph.                                                |

## Visual gate calibration

The full comparison excludes only the runtime-photo rectangle (desktop x=668 onward below the 82px header; mobile y=58 through y=535). The focused ink layer then hides that photo and compares UI over it.

- Image Pixelmatch threshold: `0.18`. The pinned Linux renderer baseline is 11.75% desktop and 14.26% mobile; the accepted limits remain 12.00% and 14.50%, respectively (0.25 and 0.24 percentage-point headroom).
- Focused UI Pixelmatch threshold: `0.10`. The same pinned baseline is 2.81% desktop and 23.19% mobile; limits remain 5.00% and 24.00% (2.19 and 0.81 percentage-point headroom).
- UI ink coverage retains the existing 90% rule, with independent versioned raster baselines: Darwin desktop navigation 416/374 pixels and mobile brand/headline/description 1040/936, 17232/15508, 2287/2058; pinned Linux desktop 165/148 and mobile 865/778, 15673/14105, 1578/1420.
- Negative proof in pinned Linux: hiding desktop navigation produces 0/148 navigation ink and is rejected; hiding mobile brand/headline/description produces 0/778, 0/14105, and 96/1420 ink and is rejected. The static source oracle is never derived from the same capture, so an already-missing normal control cannot establish its own floor.

### CI renderer architecture

`pnpm check` runs the browser’s structural checks on every supported host: font readiness, viewport bounds, console cleanliness, layout, interaction, keyboard, and reduced-motion behavior. Those scripts select their mode through the portable Node runner rather than shell environment-assignment syntax, and invoke the validated lifecycle `npm_execpath` through Node on every platform, so Windows still receives the structural suite without spawning a `.cmd` shim. Pixel comparison is explicit: local pixels require the named `darwin-arm64-local` renderer on Darwin/arm64, while CI pixels require exactly `playwright-1.62.1-noble-linux-amd64` on Linux/x64. Missing, unknown, mismatched, or host-incompatible modes fail before any pixel comparison; the harness receives that renderer identity as data and never infers a coverage baseline from `process.platform`.

The canonical CI step uses the immutable `mcr.microsoft.com/playwright@sha256:dcc5531e97840b9b5e794f2814476b21571c5124a3fca2267d73041f56e7580e` image with `--platform linux/amd64` and `--network none`. It mounts the pnpm/action-setup runtime read-only and invokes its pinned `pnpm.cjs`, avoiding a mutable image tag, Corepack activation, and a package-manager download in the visual container. This keeps pixel rasterization deterministic without loosening a threshold or masking any UI. Unsupported renderers receive the structural suite rather than an uncalibrated pixel baseline.

## Interaction and console checks

- Both approved viewports verify visible keyboard focus (3px outline) and Enter activation for every unavailable destination; focus lands on the unavailable heading.
- Mobile navigation remains keyboard-operable through its named toggle.
- The mobile `390×844` test asserts exact document height `844` and records no browser console warnings, console errors, or page errors.
- Unavailable interactions issue no follow-up browser requests after the initial asset/font load.

## Findings history

| Priority   | Finding                                                                                                                                     | Resolution                                                                                                              |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| P0 (fixed) | The pre-fix mobile page was 1919px high, leaving choices and CTA outside the 390×844 viewport.                                              | Responsive sizing was recalibrated and an exact-height/bounds Playwright test now protects the complete decision set.   |
| P1 (fixed) | The old visual mask covered mobile brand/headline/description and desktop navigation; 24–33% mismatch limits allowed deliberate UI removal. | Photo-only full mask is paired with focused UI ink diff and coverage floors; two deliberate removals now fail the gate. |
| P1 (fixed) | Desktop photo began at x=504 (35% width), invading the copy panel instead of the approved ~46% split.                                       | Hero width is 53.6%, moving the start to x=668; the desktop composition test accepts x=655–691.                         |
| P2         | No remaining P2 visual issue after the final full and focused comparisons.                                                                  | Not applicable.                                                                                                         |

final result: passed
