# CI SQLite migration-startup lock report

## Status

`IMPLEMENTED_WITH_UNRELATED_STATIC_GATE_BLOCKER`

Functional commit: `2c169d91023d23523cafbe13056cc3fd5d77353a`
(`fix(api): close SQLite WAL startup race`). No push was made.

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

`openSqliteDatabaseInternal` now resolves the migration target and performs
the existing read-only migration validation before it changes the durable
journal mode. It then activates WAL before `applyMigrations` can release its
writer transaction. `applyMigrations` retains its own under-lock validation,
so a concurrent starter cannot rely on the first read and migration safety is
unchanged.

The prior invalid-predecessor gate continues to prove that a malformed history
fails without changing the predecessor's journal mode or durable bytes. The
change neither retries migration failures nor relaxes corruption handling.

## Verification

- RED: focused new regression failed with the exact lock error before the
  production change.
- GREEN: the regression passed after the production change in 200 ms.
- Combined migration coverage passed: invalid predecessor bytes unchanged,
  four-child fresh/v20 startup, and the deterministic WAL-window regression
  (3 passed).
- The original four-child fresh/v20 contention test passed 10 consecutive
  isolated runs after the fix.
- `pnpm run lint` in `apps/api` passed.
- `pnpm run test` in `apps/api` passed: 41 files, 499 passed, 1 expected
  local FFmpeg skip.
- `git diff --check` and `git diff --cached --check` passed before the
  functional commit.

`pnpm run typecheck` currently exits 2 only because the concurrent,
uncommitted FFmpeg work in `apps/api/src/storage/local-frame-extraction.test.ts`
has `ProcessChild` incompatibility at line 1214 and an implicit `any` at line
1235. This SQLite change does not modify that file; rerun the API static gates
after that work is corrected.

## Remaining concern

The local deterministic and repeated-concurrency evidence covers the known
failure. A fresh hosted CI run remains necessary to confirm the full
Linux-host scheduler path after the controller pushes the combined candidate.
