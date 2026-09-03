# CI SQLite migration-startup lock report

## Status

`IMPLEMENTED_WITH_UNRELATED_STATIC_GATE_BLOCKER`

Initial functional commit: `2c169d91023d23523cafbe13056cc3fd5d77353a`
(`fix(api): close SQLite WAL startup race`).

TOCTOU correction: `69d5d00` (`fix(api): make SQLite WAL startup atomic`).
No push was made.

## Incident and root cause

One fresh full API run failed the existing `SQLiteAttemptRepository` child
startup coverage with `SqliteError: database is locked` at
`openSqliteDatabaseInternal`'s `journal_mode = WAL` pragma. The immediately
preceding migration-startup change (`01c0814`) intentionally moved WAL
activation after `applyMigrations`: an invalid predecessor must fail before
startup changes its durable journal mode.

That ordering introduced an uncovered cross-process interval:

1. Starter A validates and applies migrations under `BEGIN IMMEDIATE`.
2. A commits the migration transaction.
3. Starter B acquires SQLite's single write transaction.
4. A then runs its separate, durable `journal_mode = WAL` transition and can
   receive `SQLITE_BUSY`.

`busy_timeout` is configured before startup, but it does not make that
post-commit ordering safe: a newly acquired writer can still occupy the exact
journal-transition boundary. The focused existing contention test passed in
two earlier isolated runs and in ten additional pre-fix repetitions because
the scheduler did not necessarily land in that small window.

## Deterministic RED

The new public-boundary test, `enables WAL before releasing the migration
startup writer`, creates a real v22 predecessor in DELETE journal mode. Its
worker waits for the production migration `COMMIT`, immediately takes
`BEGIN IMMEDIATE`, and holds it briefly. A `SharedArrayBuffer` synchronizes
only that timing; the test continues to run real `better-sqlite3` migration
and journal code. It sets its opening connection's busy timeout to zero only
inside the test interception, making the invalid ordering deterministic
instead of waiting for a timing-dependent retry.

Before the fix, the test failed in 46 ms with:

```text
expected [Function] to not throw an error but 'SqliteError: database is locked' was thrown
```

Restoring the old production ordering—moving `journal_mode = WAL` back below
`applyMigrations`—is the intentional mutation that makes this regression fail.

## Fix and migration safety

For a non-WAL database, `openSqliteDatabaseInternal` now uses a temporary,
private bootstrap connection. It switches that connection to
`locking_mode = EXCLUSIVE`, completes the existing read-only migration
validation, performs the durable WAL transition, closes the bootstrap handle,
and only then opens the regular repository connection. The regular connection
runs `applyMigrations`, which revalidates under its migration writer as
before. An already-WAL database skips the bootstrap transition.

The exclusive bootstrap closes the review-identified TOCTOU interval: another
starter cannot alter the validated history before WAL is durable. It also does
not leak exclusive locking into a repository handle. A history mutation that
begins after the bootstrap closes is caught by the regular connection's
validation and fails closed without a second journal transition or repair.

An attempted alternative restored the original journal mode after a post-WAL
validation error. SQLite did restore `DELETE`, but its WAL-to-DELETE operation
advanced database-header counters, so the invalid predecessor bytes were not
identical. That approach was rejected; the non-interleavable bootstrap avoids
the durable mutation instead.

The prior invalid-predecessor gate continues to prove that a malformed history
fails without changing the predecessor's journal mode or durable bytes. The
change neither retries migration failures nor relaxes corruption handling.

## Deterministic TOCTOU regressions

Both regressions use a real `better-sqlite3` worker and
`SharedArrayBuffer` rendezvous, with no production sleep or retry. At the
exact `journal_mode = WAL` boundary, a worker tries to set
`user_version = 24` after preflight. The exclusive bootstrap makes that real
write fail with `database is locked`, proving it cannot interleave before WAL.

A second regression waits for the intentional bootstrap close, then performs
the real invalidating `user_version = 24` write. The normal handoff connection
fails with `sqlite migration history is invalid`. The worker closes before it
captures the file; the test proves that the final journal mode is WAL, the
invalid user version remains 24, and the exact durable database bytes equal
that post-write snapshot. Thus the failure path performs no later durable
startup mutation.

## Verification

- Initial RED: the post-commit WAL-window regression failed with the exact
  lock error before the initial production change.
- TOCTOU RED: before `69d5d00`, the boundary writer changed history between
  preflight and WAL; the protection test observed `invalidated` rather than
  `blocked`, and a post-handoff invalidation let startup succeed unexpectedly.
- GREEN: the five focused migration cases passed: invalid predecessor bytes,
  four-child fresh/v20 startup, the original WAL-window lock, no-interleaving
  history write, and post-bootstrap invalidation preservation.
- The original four-child fresh/v20 contention test passed five more
  consecutive isolated runs after the TOCTOU correction.
- `pnpm run lint` in `apps/api` passed.
- Prettier write/check passed for `sqlite-database.ts` and
  `sqlite-attempt-repository.test.ts`.
- `pnpm run test` in `apps/api` passed: 41 files, 502 passed, 1 expected
  local FFmpeg skip.
- `git diff --check` and `git diff --cached --check` passed before the
  functional commit.

`pnpm run typecheck` currently exits 2 only because the concurrent,
uncommitted FFmpeg work in `apps/api/src/storage/local-frame-extraction.test.ts`
has a `ProcessChild` incompatibility at line 1261 and an implicit `any` at
line 1282. This SQLite change does not modify that file; rerun the API static
gates after that work is corrected.

## Remaining concern

The local deterministic and repeated-concurrency evidence covers the known
failure. A fresh hosted CI run remains necessary to confirm the full
Linux-host scheduler path after the controller pushes the combined candidate.
