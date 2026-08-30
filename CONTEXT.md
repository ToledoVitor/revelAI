# RevelAI context

RevelAI is a digital scouting and athlete-development experiment. Athletes record futsal training with a phone, receive computer-vision-derived performance metrics, and can compare verified attempts under controlled capture conditions.

## Product modes

- **Free Training** accepts loosely framed uploaded or recorded video. It returns a `FreeInsight`: approximate, personal feedback with its analysis provenance. It never creates a competitive score, percentile, `topPercent`, verified-result label, or leaderboard entry.
- **Verified Challenge** guides phone placement, space calibration, athlete framing, a tracking rehearsal, and uninterrupted capture. A technically valid submission receives a deterministic `VerifiedResult`; it creates a normal leaderboard entry only when `competitiveEligible` is `true`.
- **Competitive eligibility** is a server-owned policy decision. Fixture/demo analysis is always `false`. Roboflow analysis is `true` only when the exact model/workflow, provider version, calibration evidence version, and score `ruleVersion` are in an approved and empirically validated policy record. An unapproved real-model result can be shown as **experimental / not ranked**, never as normal leaderboard data.

## Core flow

1. Athlete chooses Free Training or a Verified Challenge.
2. Verified Challenge walks through device, space, athlete, rehearsal, and recording gates.
3. Free Training uploads a loosely captured eligible video. Verified Challenge records in-app or uploads an eligible continuous video with a four-second calibration pre-roll followed by the 60-second exercise window.
4. Backend stores submission and processes it asynchronously.
5. Internal integrity checks accept or invalidate submission without exposing detection mechanics.
6. A valid Verified Challenge yields deterministic metrics and score. It receives a leaderboard placement only when it is competitively eligible.
7. Later AI narration may summarize deterministic results, but cannot invent or override measurements.

## MVP sport and challenge

- Sport: futsal.
- First verified challenge: wall passing for 60 seconds, both feet, calibrated three-metre setup.
- MVP metrics: valid passes, accuracy, mean cadence, and left/right usage balance.
- Camera-derived ball speed may later act as a power proxy. Video alone does not claim physical impact force.

## Vocabulary

- **Athlete**: person submitting training video.
- **Challenge Definition**: versioned rules, capture requirements, scoring formula, and metric schema for a repeatable exercise.
- **Attempt**: one athlete submission. A `free` Attempt has no challenge or score; a `verified` Attempt targets one Challenge Definition version and a calibration session.
- **Capture Gate**: client-visible requirement that must pass before verified recording starts.
- **Integrity Review**: server-side validation performed after upload; details remain internal.
- **Analysis**: asynchronous extraction and aggregation of observations into deterministic metrics.
- **Verified Result**: accepted, deterministic metrics and score for one verified Attempt. It contains a `ruleVersion`, provenance, and `competitiveEligible` flag.
- **Free Insight**: approximate, non-competitive output from Free Training.
- **Free Observation**: one deterministic, approximate observation about athlete visibility, ball visibility, or movement activity in a loosely captured video; it is not a competitive metric.
- **Leaderboard Entry**: an immutable ranking fact derived only from a competitively eligible Verified Result, challenge version, and rule version. It may be retracted only by the explicit attempt-deletion lifecycle.
- **Attempt Outcome**: the public tagged result of processing: `pending`, `valid`, `invalid`, or `failed`.
- **Percentile**: a score's position in a frozen, same-challenge/same-rule cohort at result completion; it is not the UI phrase `topPercent`.

## Expansion

Futsal precedes field football. Volleyball, basketball, and handball remain future sports. Each sport adds versioned Challenge Definitions rather than branching product semantics.

## MVP identity and history

MVP has no production account, authentication, or cross-device synchronization. Each client creates one opaque UUID `athleteId` locally and sends it in `X-RevelAI-Athlete-Id`; it is a history partition key, not proof of identity or authorization. Web stores it in local storage and mobile in secure local storage. `GET /v1/attempts` returns only records for that same local identity. The product may say that web and mobile use the same result semantics, but must not promise a shared history across devices. Non-loopback deployment with this unauthenticated MVP mode requires an explicit operator opt-in and warning.
