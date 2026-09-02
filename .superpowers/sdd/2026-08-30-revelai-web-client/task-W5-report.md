# W5 — Treino livre web client report

## Commits

- Functional implementation: `60785660b1826e7de317a171350c7f2564067497` (`feat(web): add free training tracer`)
- This report is committed separately after this file is written.

## Delivered behavior

- `/free-training` is an isolated owner route, reachable from the active Home `Treino livre` control. It creates exactly one `POST /v1/attempts` body `{ "mode": "free" }`, including under StrictMode; it has no verified-session, selector, calibration, or challenge flow.
- The media flow gives the intended sport guidance without presenting verified-camera requirements. It rejects only local MIME/extension, empty-file, and size errors, preserves the original source name/type alongside the normalized upload MIME, exposes source and wire sizes, supports replacement/cancellation, and revokes object URLs on replacement, cancellation, accepted upload, and unmount.
- Upload is one abortable `FormData` media part with progress. Abort, transport failure, duplicate/lost responses, and reconciliation use the authoritative attempt outcome while preserving the same retryable Attempt and selected media when safe.
- Pending outcomes poll at 1/2/4/5 seconds. Focus, visibility, and manual refresh coalesce with the scheduled poll; stale requests, old upload completions, and unmount are generation/cancellation-safe.
- Only a matching Free `valid/free-insight` produces the approximate result. Cross-mode and malformed outcomes fail closed. The report makes approximation explicit, displays server time, provider/demo provenance, Roboflow-safe result fields, all observation confidences/ranges, and the exact one- and two-tip source ordering.
- Free terminal failure remains safe and retryable when appropriate. Starting another Free training invalidates old async work and creates a fresh Free Attempt.
- Delete uses the required native confirmation text, prevents duplicate deletes, supports error retry, removes the record from cached history before navigation, and returns to `/training/history` with the exact confirmation. History labels Free entries as `Treino livre — análise aproximada`; its existing delete now also requires its required native confirmation.
- The Free route has no competitive/ranking vocabulary or control; the global Ranking control is intentionally hidden only on this route. Accessible headings, named controls, status/progress output, and focus-visible styling are included.

## Tests added/extended

`apps/web/src/free-training/tracer.test.tsx` covers the public durable W5 matrix (32 cases): owner/StrictMode/unmount/create retry; requirements and local media checks; source-to-wire contract, preview URL cleanup, upload/progress/cancel/retry/single part; authoritative reconciliation for awaiting-upload/uploaded/processing/valid/failed/mismatch including precommit, post-commit, duplicate, lost, GET failure and stale outcomes; 1/2/4/5 polling, focus/visibility/manual coalescing, stale cleanup; exact approximate report/provenance/Roboflow fields/three observations/tip ordering; all cross-mode arms fail-closed; failed retryability and fresh begin; delete cancel/204/error/retry/stale/duplicate/cache removal; and history return confirmation.

The Home, history, upload-reconciliation, structural visual, and production-route-isolation suites were extended to protect W0–W4 behavior and route isolation.

## TDD evidence

- The initial W5 owner, upload, reconciliation, polling, result, and deletion behavior was specified in failing tracer tests before implementation, then made green incrementally.
- The history-cache-removal assertion was introduced red (the deleted entry remained rendered) and turned green by sharing the history query key and removing the record from all cached pages before navigation.
- The explicit wire-size assertion was introduced red (only source size was rendered) and turned green by rendering `Tamanho de envio` from the normalized upload file.
- Fixture-only failures encountered while adding the Roboflow assertions were corrected to conform to the contract fixture shape; no production behavior was relaxed.

## Verification

All commands below were run from the repository root through `rtk`:

- `pnpm --dir apps/web exec vitest run src/free-training/tracer.test.tsx --config vitest.config.ts` — 32 passed.
- `pnpm --dir apps/web exec vitest run src/free-training/tracer.test.tsx src/history/history.test.tsx src/verified/upload-reconciliation.test.ts --config vitest.config.ts` — 44 passed.
- `pnpm --dir apps/web run test` — Node contract checks passed; Vitest: 21 files / 225 tests passed.
- `pnpm --dir apps/web run test:visual:structural:run` — 24 passed, 8 expected skips.
- `pnpm --dir apps/web run test:production-router` — 8 passed, including real production Free-route ownership/isolation checks.
- `pnpm --dir apps/web run lint` — passed.
- `pnpm --dir apps/web run typecheck` — passed.
- `pnpm --dir apps/web run build` — passed.
- `git diff --check` — passed.
- `pnpm check` — completed with exit code 0: format check, lint, typecheck, tests (including 225 web Vitest cases and browser suites), and build all completed; Turborepo reported 7 successful tasks.

## Self-review

Reviewed the staged functional diff for route scope, stale async ownership, history-cache update, media cleanup, cross-mode result validation, deletion error retention, and wording isolation. No blocking issue found. The only notable implementation seam is reuse of the existing neutral media-normalization helper from the verified capture module; it has no verified behavior, is already covered by shared tests, and keeps source/wire normalization consistent across modes.
