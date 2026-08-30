# ADR 0001: Monorepo and runtime boundaries

- Status: Accepted
- Date: 2026-08-30

## Context

RevelAI needs mobile and web clients, one backend contract, asynchronous analysis, shared visual language, independent deployments, and predictable local development. Initial repository contains no implementation constraints.

## Decision

Use one TypeScript monorepo managed by pnpm workspaces and Turborepo.

- `apps/web`: responsive React web client built with Vite.
- `apps/mobile`: Expo React Native client.
- `apps/api`: Fastify HTTP API and in-process development worker.
- `packages/contracts`: Zod schemas and transport types shared by every client and server.
- `packages/domain`: pure attempt lifecycle, metric aggregation, scoring, and ranking rules.
- `packages/design-system`: shared design tokens and platform-neutral naming; platform components remain close to each client.
- `packages/vision`: provider boundary that returns canonical observations and provenance from demo fixtures or Roboflow image inference.

API owns credentials, persistence, streamed uploads, FFmpeg probing/frame extraction, analysis orchestration, `IntegrityEvaluator`, competitive-eligibility policy, and result/leaderboard writes. Clients never receive Roboflow credentials, raw provider payloads, or integrity implementation details.

MVP persistence uses SQLite behind repository interfaces. Uploaded media uses a storage interface backed by local disk in development. Analysis uses an `AnalysisQueue` backed by an in-process runner in development and tests. `AnalysisQueue` owns only job enqueue, delivery subscription, and availability; it never reserves attempts, opens SQLite transactions, finalizes results, or tombstones records. `AttemptRepository` owns attachment state, processing lease/generation reservation, `finalizeTerminalResult`, and `tombstoneAttempt` behind SQLite. `AttemptService` coordinates attach → repository state → queue enqueue, while `AnalysisWorker` coordinates delivered job → repository claim → processing → repository finalization. These interfaces are deployment seams, not promises of a production storage or queue vendor.

Environment configuration is validated at process startup. A readiness check proves SQLite queryability, media-storage writability, and queue availability; `/ready` is `503` when any of those checks fails. Root commands orchestrate lint, typecheck, test, build, and development. Each deployable app also exposes independent commands and container configuration where appropriate.

### Media and operator boundary

- The API accepts a streamed body only after extension/MIME preflight and then enforces the byte limit while reading. It sniffs magic bytes, probes the completed temporary file with FFprobe, and uses opaque UUID keys; client names and absolute paths never become storage keys or responses.
- Local media directories are created with mode `0700`; files and temporary files use `0600`, are opened with exclusive/no-follow semantics, atomically renamed only after validation, and are removed on abort/error. `RetentionScavenger` has an injected clock, runs once at API startup and every 60 minutes, and retries failures on its next run with redacted attempt/media IDs only. Originals and extracted frames receive a deletion deadline at upload time of `uploadedAt + 23 hours`, so the hourly sweep enforces deletion no later than 24 hours; terminal cleanup attempts deletion immediately. Abandoned temporary files expire after one hour; canonical observations expire 30 days after terminalization. `DELETE /v1/attempts/:id` tombstones the attempt and schedules immediate media/observation deletion. A crash/restart therefore cannot leave media outside a scheduled deletion path.
- Logs must redact authorization headers, API keys, multipart bodies, provider payloads, and absolute paths. Tests prove redaction. A provider URL using an API key must be HTTPS unless its host is loopback. Production `PUBLIC_BASE_URL` must be HTTPS; an intentionally unauthenticated non-loopback MVP server requires `ALLOW_UNAUTHENTICATED_PUBLIC=true` and emits a startup warning.

## Consequences

- Web and mobile share contracts, domain rules, and visual tokens without forcing one UI runtime.
- Computer-vision provider can evolve separately from score semantics.
- Local and CI runs need no cloud account or Roboflow API key.
- In-process queue and local media storage are explicitly development-grade and must be replaced before multi-instance production deployment.
- The API remains the only layer that may make integrity or competitive writes, so a provider implementation cannot accidentally promote demo or unvalidated observations to a leaderboard.
- A retention guarantee is operational rather than best-effort cleanup: tests advance an injected clock, restart the process, and cover originals, frames, terminal observations, abandoned temporaries, and failed-delete retry logging.
