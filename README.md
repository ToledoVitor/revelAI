# RevelAI

> AI-assisted futsal scouting and athlete development.

RevelAI turns training video into structured feedback for athletes and coaches.
The product intentionally separates approximate **Free Training** insights from
the evidence and integrity path used by **Verified Challenges**, so demo analysis
can never create rankings, percentiles, or leaderboard results.

**Status: functional MVP under active development.** The media-processing
foundation, attempt lifecycle, local worker, provider abstraction, integrity
checks, and competitive safeguards are implemented. The product experience and
model evaluation continue to evolve.

<p align="center">
  <img
    src="./apps/web/public/assets/futsal-hero.png"
    width="900"
    alt="RevelAI — AI-assisted futsal scouting"
  >
</p>

## Product flow

```text
upload attempt
      │
      ▼
validate media → extract frames → run vision analysis
      │                                  │
      └──────────────→ evaluate integrity┘
                                         │
                                         ▼
                              assemble observations
                                         │
                                         ▼
                              produce athlete feedback
```

## What works today

- Media intake, eligibility checks, probing, and FFmpeg-based frame extraction
- Attempt state machine, persistence, processing queue, and local worker
- Local, secret-free demo vision provider for development and CI
- Optional server-side Roboflow provider experiment
- Free Training insight generation and Verified Challenge evidence handling
- Integrity evaluation and policies that keep demo output non-competitive
- Media-retention deadlines and cleanup support
- Shared contracts, domain rules, configuration, vision logic, and design tokens
- Automated formatting, linting, type checks, tests, and builds

## Product modes

| Mode | Purpose | Competitive effect |
| --- | --- | --- |
| **Free Training** | Approximate feedback for practice and iteration | Never creates rankings, percentiles, or leaderboard entries |
| **Verified Challenge** | Evidence and integrity path for calibrated challenges | Ranking eligibility only after the required verification gates pass |

This boundary is a product rule, not merely a UI label. Demo or incomplete
analysis must remain useful without being presented as calibrated performance.

## Architecture

```text
client
  │
  ▼
API ──→ media intake / probe / extraction
  │
  ├──→ queue + analysis worker
  │          │
  │          ├──→ demo provider
  │          └──→ Roboflow provider (optional, server-only)
  │
  ├──→ integrity evaluation + competitive policy
  ├──→ observations + athlete feedback
  └──→ SQLite persistence + local media storage
```

The monorepo uses pnpm and Turborepo so deployable applications can remain
independent while sharing contracts and domain rules.

```text
apps/
  api/             processing foundation, persistence, queue, and worker
  web/             web product experience
  mobile/          mobile product experience

packages/
  config/          validated server configuration
  contracts/       shared application contracts
  design-system/   platform-neutral visual tokens
  domain/          attempt lifecycle, scoring, and ranking rules
  vision/          providers, transforms, geometry, and evidence handling
```

## Install and verify

Requirements:

- Node.js `>=22.19.0`
- pnpm `11.20.0`
- FFmpeg/FFprobe for the real local media path

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm check
pnpm build
```

`pnpm check` runs formatting, linting, TypeScript checks, tests, and package
builds.

## Configuration

With no environment overrides, the project uses loopback networking, local
data/media paths, and the secret-free demo vision provider.

Roboflow is an optional server-only integration. Configure the documented
`ROBOFLOW_*` variables together through a secret manager. Partial configuration
is rejected, provider credentials must never reach a client, and external
key-bearing URLs must use HTTPS.

The default development and CI paths do not require a Roboflow key or
real-provider network access.

## Current focus

- Complete and polish the end-to-end web/mobile product flow
- Replace concept art with real product screenshots and a short demo
- Expand benchmark datasets and evaluate model quality per drill
- Calibrate Verified Challenges before enabling any competitive presentation
- Improve deployment, authentication, and operational observability

## License

Apache-2.0 — see [LICENSE](LICENSE).
