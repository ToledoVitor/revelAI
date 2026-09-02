# W5 — Treino livre web client report

## Commits

- Functional implementation: `60785660b1826e7de317a171350c7f2564067497` (`feat(web): add free training tracer`)
- Review remediation: `1e511742e7a694fc02fec0cffda8d901c7d9dd31` (`fix(web): preserve free training ownership`)
- This updated report is committed separately after this file is written.

## Delivered behavior

- `/free-training` is an isolated owner route, reachable from the active Home `Treino livre` control. It creates exactly one `POST /v1/attempts` body `{ "mode": "free" }`, including under StrictMode; it has no verified-session, selector, calibration, or challenge flow. Trailing/redundant slashes canonicalize before the owner mounts, so the competitive control cannot leak on an equivalent Free URL.
- The owner is durable within the browser session: only an Attempt id and a create timestamp marker are stored (never athlete identity, media, or secret data). Reload/back reconciles a stored id with `getAttempt`; awaiting-upload resumes capture with reselection, uploaded/processing resumes polling, and valid/failed resumes the terminal state. The marker is written before create; after an unobserved response it parses `listAttempts` and adopts exactly one matching Free record after the marker. Ambiguous/mismatched records fail closed rather than being guessed or adopted.
- The media flow gives the intended sport guidance without presenting verified-camera requirements. It rejects only local MIME/extension, empty-file, and size errors, preserves the original source name/type alongside the normalized upload MIME, exposes source and wire sizes, supports replacement/cancellation, and revokes object URLs on replacement, cancellation, accepted upload, and unmount.
- Upload is one abortable `FormData` media part with progress. Abort, transport failure, duplicate/lost responses, and reconciliation use the authoritative attempt outcome while preserving the same retryable Attempt and selected media when safe.
- Pending outcomes poll at 1/2/4/5 seconds. Focus, visibility, and manual refresh coalesce with the scheduled poll; stale requests, old upload completions, stale deletes, and unmount are generation/cancellation-safe. The polling lifecycle and ambiguous-upload decision are neutral modules consumed by both the W4 verified and W5 Free tracers.
- Only a matching Free `valid/free-insight` produces the approximate result. Cross-mode and malformed outcomes fail closed. The report makes approximation explicit, displays server time, provider/demo provenance, Roboflow-safe result fields, all observation confidences/ranges, and the exact one- and two-tip source ordering.
- Free terminal failure remains safe and retryable when appropriate. Starting another Free training invalidates old async work and creates a fresh Free Attempt.
- Delete uses the required native confirmation text, prevents duplicate deletes, supports error retry, removes the record from cached history before navigation, and returns to `/training/history` with the exact confirmation. History labels Free entries as `Treino livre — análise aproximada`; its existing delete now also requires its required native confirmation and synchronously locks same-tick activation before confirmation/mutation.
- The Free route has no competitive/ranking vocabulary or control; the global Ranking control is intentionally hidden only on this route. Accessible headings, named controls, status/progress output, and focus-visible styling are included.

## Tests added/extended

`apps/web/src/free-training/tracer.test.tsx` now has 40 public cases covering the durable W5 matrix: owner/StrictMode/unmount/create retry; requirements and local media checks; source-to-wire contract, preview URL cleanup, upload/progress/cancel/retry/single part; authoritative reconciliation for awaiting-upload/uploaded/processing/valid/failed/mismatch including precommit, post-commit, duplicate, lost, GET failure and stale outcomes; 1/2/4/5 polling, focus/visibility/manual coalescing, stale cleanup; exact approximate report/provenance/Roboflow fields/three observations/tip ordering; all cross-mode arms fail-closed; failed retryability and fresh begin; delete cancel/204/error/retry/stale/duplicate/cache removal; and history return confirmation.

The owner, neutral media, neutral attempt-flow, Home, history, verified tracer, structural visual, and production-route-isolation suites protect W0–W4 behavior and route isolation. The injected owner-XHR test asserts the actual tracer's `loaded/total` DOM progress, rather than only testing the API client in isolation.

## TDD evidence

- The initial W5 owner, upload, reconciliation, polling, result, and deletion behavior was specified in failing tracer tests before implementation, then made green incrementally.
- The history-cache-removal assertion was introduced red (the deleted entry remained rendered) and turned green by sharing the history query key and removing the record from all cached pages before navigation.
- The explicit wire-size assertion was introduced red (only source size was rendered) and turned green by rendering `Tamanho de envio` from the normalized upload file.
- Fixture-only failures encountered while adding the Roboflow assertions were corrected to conform to the contract fixture shape; no production behavior was relaxed.
- Review remediation began RED with a reload-after-unmount/response-lost test: the old owner stayed at creation and never listed/recovered the committed Attempt. It turned green after the durable session marker/strict recovery path.
- The new same-tick history-delete test uses two synchronous `fireEvent.click` calls without rerender and proves one confirmation and one DELETE. The Free terminal test proves its duplicate guard plus an aborted stale delete whose late 204 cannot navigate away from `/free-training`.

## Verification

All commands below were run from the repository root through `rtk`:

- `pnpm --dir apps/web exec vitest run src/free-training/tracer.test.tsx src/free-training/owner.test.ts src/history/history.test.tsx src/verified/tracer.test.tsx src/verified/upload-reconciliation.test.ts src/lib/attempt-flow/pending-polling.test.ts --config vitest.config.ts` — 97 passed.
- `pnpm --dir apps/web run test` — Node contract checks passed; Vitest: 25 files / 241 tests passed.
- `pnpm --dir apps/web run test:visual:structural:run` — 24 passed, 8 expected skips.
- `pnpm --dir apps/web run test:production-router` — 11 passed, including served production canonicalization, persisted-owner reload, and commit-wins/lost-response reload checks.
- `pnpm --dir apps/web run lint` — passed.
- `pnpm --dir apps/web run typecheck` — passed.
- `pnpm --dir apps/web run build` — passed.
- `git diff --check` — passed.
- `pnpm check` — completed with exit code 0: format check, lint, typecheck, tests (including 241 web Vitest cases and browser suites), and build all completed; Turborepo reported 7 successful tasks.

## Self-review

Reviewed the staged remediation diff for route scope, session-storage contents, recovery correlation and ambiguity, slash canonicalization, stale async ownership, history-cache update, media cleanup, cross-mode result validation, deletion error retention, and wording isolation. No blocking issue found. The neutral normalization now lives in `lib/media`; verified capture re-exports it for W4 compatibility, while both tracers consume the shared attempt-flow seams.
