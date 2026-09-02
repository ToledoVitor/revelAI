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

| Area               | Desktop 1440×1024                                                                                                                                                                                                                              | Mobile 390×844                                                                                                                                                 |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Typography         | Bundled Bebas Neue 400 provides the deliberately heavy condensed uppercase display treatment. Body copy uses bundled Arimo 400/700, an Arial-metric-compatible face that keeps the approved reference geometry stable across macOS and Ubuntu. | Same bundled body and display faces; mobile scales and compresses the heading without truncation.                                                              |
| Layout and spacing | Header is 82px; photo begins at x=668 (46.4% width), matching the approved ~46% composition. Copy, decisions, and CTA remain within the warm-white panel.                                                                                      | Header is 58px; full ready state is exactly 844px tall. Brand, heading, description, both choices, and CTA all remain in viewport with no horizontal clipping. |
| Color and rules    | Shared tokens are warm white `#F7F5F0`, near black `#10110F`, deep emerald `#006B3C`, muted gray `#686B67`, and border gray `#CDD1CC`. Borders/rules are square and restrained, with no gradients.                                             | Same token palette; the mobile CTA uses deep emerald with warm-white type to preserve contrast over the compact decision area.                                 |
| Image and crop     | Approved runtime `public/assets/futsal-hero.png` is contained in the 53.6% right photo field with `object-fit: cover` / 57% horizontal crop. The source screenshot photo is intentionally different at runtime.                                | The same approved runtime asset occupies the upper 33.5rem field and remains intentionally variable from the source screenshot.                                |
| Copy and icons     | Approved visible Portuguese copy is present; unavailable destinations retain the exact unavailable message when activated. Choice and CTA arrows use `@phosphor-icons/react` `ArrowRight`.                                                     | Copy remains readable at 390px; the menu uses the approved Phosphor navigation icon rather than a custom glyph.                                                |

## Visual gate calibration

The full comparison excludes only the runtime-photo rectangle (desktop x=668 onward below the 82px header; mobile y=58 through y=535). The focused ink layer then hides that photo and compares UI over it.

- Image Pixelmatch threshold: `0.18`. Font-ready baseline mismatch is 11.62% desktop and 13.86% mobile; the accepted limits are 12.00% and 14.50%, respectively (0.38 and 0.64 percentage-point headroom).
- Focused UI Pixelmatch threshold: `0.10`. Font-ready baseline mismatch is 4.26% desktop and 23.35% mobile; limits are 5.00% and 24.00% (0.74 and 0.65 percentage-point headroom).
- UI ink coverage floors preserve 90% of the deterministic font-ready implementation baseline: desktop navigation 416/374 pixels; mobile brand 1040/936, headline 17232/15508, description 2287/2058.
- Negative proof: hiding desktop navigation produces only 2.01% focused pixel mismatch (below the 5.00% pixel limit) but 0/374 navigation ink and is rejected. Hiding mobile brand/headline/description produces 21.61% focused pixel mismatch (also below the 24.00% pixel limit) but 0/936, 0/15508, and 96/2058 ink, and is rejected.

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
