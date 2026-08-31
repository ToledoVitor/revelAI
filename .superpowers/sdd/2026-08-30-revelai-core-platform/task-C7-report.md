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
