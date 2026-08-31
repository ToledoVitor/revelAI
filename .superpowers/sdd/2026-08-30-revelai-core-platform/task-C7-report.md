# Task C7 report — integrity evaluation and competitive policy

## Status and commits

- C6 carry: `55076e3c5ffbe2d695e90cf11087f0b5200f6073`
  (`fix(vision): resolve computed alias bindings`)
- C4 receipt prerequisite: `f64144b`
  (`fix(api): bind competitive policy receipts`)
- C7 correction: `a3932a2cfcef70c5f654d6bf15ea484fb59c91cb`
  (`fix(api): bind verified integrity candidates`)
- Status: round-1 correction ready for independent review; not pushed.

## Decision and valid-only seam

`evaluateVerifiedIntegrity` accepts an exact expected verified attempt, a strict
C5 manifest, and a module-owned C6 evidence object. C6 registers its frozen
output in a private capability set, so cloned/hand-authored JSON cannot produce
a valid result. The valid result contains an opaque `VerifiedAttemptCandidate`.
Only `scoreVerifiedCandidate(candidate)` can pass its canonical ordered C6
events to C3; `evaluateCompetitiveEligibility({ candidate, repository, clock })`
requires the same candidate and reads no caller-authored provenance.

Public serialization remains only `{ state: "valid" }` for valid evidence. It
does not contain candidate facts, hashes, nonce, frame data, confidence, drift,
geometry, source references, or provider payloads.

Precedence is deterministic:

1. malformed/non-admissible C5 probe or C5/C6 extraction binding →
   `video_not_continuous`;
2. C6 capability, calibration/reference/geometry/event fault →
   `calibration_not_verified`;
3. post-calibration usable track count below 480 → `tracking_insufficient`;
4. infrastructure failures are created only through the retryable temporary
   decision and never make a candidate.

## Binding and policy matrix

The candidate binds attempt, generation, media ID/SHA, raw pre-roll SHA,
session/nonce, C5 extraction version and deterministic path-free extraction
identity. C6's discriminated observation batch continues to require inference
binding for every Roboflow frame and forbids it for demo frames. C6 supplies the
ordered track/H_t-bound event graph and canonical C3 contact/impact rows.

| Requirement                                      | Ranked result                                          |
| ------------------------------------------------ | ------------------------------------------------------ |
| candidate provenance                             | Roboflow only; demo is `demo` without a lookup         |
| C4 workspace/workflow/model/provider tuple       | exact candidate → policy → parsed receipt              |
| challenge/calibration/rule tuple                 | exact policy query and returned activation             |
| receipt identity                                 | exact ID, canonical SHA, schema and strict parsed JSON |
| trusted time                                     | `runAt <= clock.now() < validUntil`                    |
| absent/mismatch/failed/stale/invalidated receipt | `experimental`                                         |
| repository outage                                | retryable `analysis_temporary_unavailable`             |

Free has no candidate constructor and cannot reach either C3 or policy lookup.

## RED → GREEN evidence

- RED: the former structural integrity parser accepted cloned evidence and let
  demo integrity be paired with an independent Roboflow policy input. GREEN:
  cloned evidence and forged candidates are rejected before score/policy; an
  actual C5 → C6 → C7 demo candidate is valid but never looks up a policy.
- RED: C4 activation had no workspace or strict parsed receipt return. GREEN:
  migration 14 derives workspace only from strict stored receipt JSON, scopes
  activation/query by workspace, and returns the strict receipt. Adapter tests
  cover exact workspace, null/mismatch, corruption, and expiry boundary.
- RED: policy trusted input `now` and allowed future receipts. GREEN: the
  injected clock is outside candidate input and tests cover `runAt` after now
  and `validUntil === now`.
- RED: C7 duplicated weaker C5/C6 schemas and lost event identity. GREEN: the
  large parser was removed; C7 consumes C5 parser/C6 capability, validates C5
  probe, geometry/stability thresholds, canonical graph uniqueness/H_t binding,
  and delegates scoring to C3.
- AST guard now requires the valid-only candidate/C3 topology while continuing
  to reject provider, storage, route, SQLite, and leaderboard dependencies.

## Verification

```text
rtk pnpm --filter @revelai/api test -- sqlite-attempt-repository.test.ts
  21 files, 142 tests passed

rtk pnpm --filter @revelai/vision build
  passed

rtk pnpm --filter @revelai/api test -- integrity-evaluator.test.ts competitive-policy.test.ts c7-boundary.test.ts
  21 files, 138 tests passed

rtk pnpm --filter @revelai/vision test -- public-entry.test.ts geometry.test.ts
  6 files, 73 tests passed

rtk pnpm --filter @revelai/api lint
rtk pnpm --filter @revelai/vision lint
rtk pnpm --filter @revelai/api typecheck
rtk git diff --check
  passed
```

## Full gates and concern

`rtk pnpm install --frozen-lockfile`, root `rtk pnpm check`, root
`rtk pnpm build`, and `rtk git diff --check` passed at the main checkout. A
fresh `git archive HEAD` with no `dist/`, followed by frozen install and root
`pnpm check`, also passed.

C6 now carries the extraction identity and canonical event graph; a future
evidence-contract revision should make per-source encoded-frame digest identity
an explicit public C6 field rather than relying on the existing provider-owned
inference binding.

---

## Round 2 correction — `11ead24` and `bb66668`

### Status and commits

- Carry remains `55076e3c5ffbe2d695e90cf11087f0b5200f6073`
  (`fix(vision): resolve computed alias bindings`), separately preserved.
- Receipt prerequisite correction: `11ead24e1512ab89185893bbc21ad2b57902b557`
  (`fix(api): harden competitive policy receipts`).
- C7/C5/C6/C3 correction:
  `bb66668c88949caa8799967609fba018c917cf8b`
  (`fix(api): harden verified evidence execution`).
- Status: local commits only; no push.

### Closed review findings and precedence

- C5 issues a non-serializable capability over the exact verified manifest,
  actual ordered active scene records, and every materialized source-frame
  digest. C6 rejects a substituted `OpaqueFrameReader` byte sequence and binds
  each request ordinal to its source digest.
- After the C6 batch is produced, one immutable execution identity joins the
  C5 continuity/source bytes with the ordered inference digest sequence
  (Roboflow requires every digest; demo requires none), scheduler ID, sampling
  ID, and provenance kind. A different inference sequence cannot rebind the
  execution. C7 only accepts C6 evidence registered to that exact execution.
- Candidate provenance and policy facts are fresh frozen copies. Mutating demo
  or Roboflow policy facts throws; demo remains terminally `demo`, while the
  independently C5→C6-produced Roboflow candidate is the only ranked input.
- C3 canonical contacts and impacts now retain their C6 track IDs, evaluate
  return/impact adjacency within one track, and the C7 graph is one-to-one with
  those canonical rows. A marker-loss cross-track sequence yields no false
  complete pass.
- Continuity/capability/probe faults have the first safe outcome
  (`video_not_continuous`); after a bound C5/C6 chain, calibration/geometry
  faults precede insufficient tracking (`calibration_not_verified` before
  `tracking_insufficient`). Only explicitly typed repository availability is
  retryable; corruption, malformed data and tuple mismatches are
  `experimental`.

### Exact policy tuple / receipt matrix

| Candidate / C4 state                                                                                                 | Outcome                                    |
| -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| demo valid candidate                                                                                                 | `demo`, no repository lookup               |
| literal/cloned/Free candidate                                                                                        | `experimental`, no score/policy seam       |
| Roboflow + absent or any workspace/workflow/model/provider/calibration/challenge/rule/receipt ID/SHA/schema mismatch | `experimental`                             |
| Roboflow + failed, stale, invalidated, malformed or expired receipt                                                  | `experimental`                             |
| Roboflow + `runAt > now`                                                                                             | `experimental`                             |
| Roboflow + `runAt === now`, or `runAt < now < validUntil`                                                            | `ranked`                                   |
| Roboflow + `now === validUntil` or later                                                                             | `experimental`                             |
| typed C4 availability error                                                                                          | retryable `analysis_temporary_unavailable` |

Migration 14 now selects all exact receipt-row identity columns and uses the
same strict parser/matcher as C4 lookup before writing `workspace_id`. A
schema-valid replacement receipt with another ID/hash/tuple aborts and rolls
back the migration; reopening the v13 database confirms v14 was not recorded.

### RED → GREEN and adversarial matrix

- RED: a capability could be formed from continuity/reference facts without
  the bytes sent to C6. GREEN: no C7 candidate exists until scene-attested C5
  bytes are read, source-digested, batched, inference-correlated and registered
  through C6. Substitution and manifest replay are terminally rejected.
- RED: a mutable C6 provenance could convert a demo candidate into Roboflow.
  GREEN: deep immutable provenance/execution facts are copied before candidate
  registration and mutation probes leave both score and policy unchanged.
- RED: C3 could join a contact and impact from different tracks. GREEN: the
  track-preserving canonical graph rejects marker-loss false passes.
- RED: four-to-seven valid C6 inliers were rejected. GREEN: actual C5→C6→C7
  fixtures cover 3/4/5/7/8 with 4+ accepted.
- The C5→C6→C7 table covers 31/32/33 pre-roll, calibration confidence
  0.799/0.800/0.801, anatomical foot confidence 0.64/0.65/0.66,
  575/576/577 stable frames, three/four/five consecutive unstable frames, and
  479/480/481 usable tracking frames.
- The C4→C7 integration activates a real SQLite policy, ranks the exact
  Roboflow candidate, then corrupts stored receipt JSON and verifies a stable
  `experimental` result. The TypeScript AST guard scans all API production
  modules: `evaluateWallPassV1` has one call site behind
  `scoreVerifiedCandidate(VerifiedAttemptCandidate)` and policy accepts that
  same opaque candidate type.

### Verification (Round 2)

```text
rtk pnpm --filter @revelai/api test -- integrity-evaluator.test.ts competitive-policy.test.ts frame-extractor.test.ts
  21 API files, 170 tests passed before the final C5/C6 rebind probe

rtk pnpm --filter @revelai/api test -- frame-extractor.test.ts
  21 API files, 171 tests passed (source-byte/inference rebind probe included)

rtk pnpm check
  format, lint, typecheck, all tests, and all six builds passed
  API: 21 files / 171 tests; Domain: 50 tests; Vision: 73 tests

rtk pnpm install --frozen-lockfile && rtk pnpm check (fresh git archive of HEAD)
  passed with uncached format, lint, typecheck, test, and build tasks

rtk git diff --check
  passed before each local correction commit
```

### Remaining scope / concern

C7 intentionally owns no route, provider dispatch, media I/O, persistence
write, terminal-result or leaderboard transition; C8 remains responsible for
the eventual transaction orchestration. The C5/C6 capability APIs are internal
API modules and deliberately not a serialized/public client contract. No
unresolved fail-open policy or evidence path is known from this round.
