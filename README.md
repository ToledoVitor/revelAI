# RevelAI

RevelAI is a digital scouting and athlete-development experiment for futsal.
Its first vertical slice will distinguish approximate Free Training feedback from
the calibrated Verified Challenge. Demo analysis is deliberately local and
never creates a competitive result, ranking, percentile, or leaderboard entry.

## Requirements

- Node.js `>=22.19.0` (the repository pins `22.19.0` in `.nvmrc`)
- pnpm `11.20.0` (declared in `packageManager`)

## Install and verify

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm check
pnpm build
```

`pnpm check` runs formatting, linting, TypeScript checks, tests, and package
builds. The focused foundation tests are also available with:

```sh
pnpm --filter @revelai/config test
pnpm --filter @revelai/design-system test
```

## Demo/local configuration

Copy `.env.example` only when an override is needed. With no environment
variables, API configuration uses a loopback bind, local data/media paths, and
the secret-free demo vision provider.

Roboflow is an optional server-only experiment. Set all documented
`ROBOFLOW_*` variables together through a secret manager; partial configuration
is rejected. External key-bearing provider URLs and production
`PUBLIC_BASE_URL` values must use HTTPS. A non-loopback unauthenticated MVP
bind requires the exact `ALLOW_UNAUTHENTICATED_PUBLIC=true` opt-in and emits a
safe startup warning. It is not a production security mode.

The default configuration and CI are demo-only: they do not require a Roboflow
key, video service, or any real-provider network access. Verified demo output
is never competitive and must not be presented as ranked output.

## Workspace layout

```text
apps/
  api/       Future Fastify API and local worker
  web/       Future Vite web client
  mobile/    Future Expo client
packages/
  config/         Zod-validated server environment configuration
  design-system/  Shared platform-neutral design tokens
```

The workspace is managed with pnpm and Turborepo so deployable apps can remain
independent while sharing contracts, domain rules, configuration, and visual
tokens.

## Design assets

`pnpm import:design-assets` and `pnpm verify:design-assets` are reserved for
the A1 approved-asset task. They intentionally point to A1-owned scripts and
are not part of `pnpm check` until the approved asset receipt exists.
