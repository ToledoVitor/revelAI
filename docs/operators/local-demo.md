# RevelAI local demo and operator path

RevelAI is an unauthenticated MVP prototype. Its demo provider is local and
offline, produces unranked observations, and must not be described as real
inference, accurate scouting, privacy protection, or a production-security
service.

## Install and demo checks

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm --filter @revelai/api run build
pnpm --filter @revelai/api run openapi:check
pnpm --filter @revelai/api exec vitest run src/http/operability-routes.test.ts src/startup.test.ts
```

The C8/C9 API is intentionally exposed as a composed Fastify application for
the local host. A local host starts it only after passing the parsed,
secret-safe environment map through `startConfiguredApi`; the default parsed
configuration is loopback `127.0.0.1`, SQLite/local storage, in-process queue,
and demo vision. It needs no Roboflow key, receipt, or network connection.
`GET /health` answers only process liveness. `GET /ready` concurrently checks
SQLite `SELECT 1`, an opaque restrictive storage sentinel create/delete, and
the queue; it is safe to use as the local startup probe.

Once a local host is listening, its manual demo path is:

```sh
api_base_url=http://127.0.0.1:3000
athlete_id=$(node -e 'console.log(crypto.randomUUID())')
curl --fail-with-body "$api_base_url/health"
curl --fail-with-body "$api_base_url/ready"
curl --fail-with-body -H "X-RevelAI-Athlete-Id: $athlete_id" \
  -H 'content-type: application/json' \
  --data '{"challengeId":"wall-pass","challengeVersion":1}' \
  "$api_base_url/v1/calibration-sessions"
```

Use the returned calibration-session ID only in the next local commands;
do not paste identities, URLs containing private paths, receipts, headers, or
media bytes into tickets or logs. Mark the session ready with the five ordered
gates (`device`, `space`, `athlete`, `rehearsal`, `record`), create a verified
attempt, upload one `media` multipart field, and poll
`GET /v1/attempts/:id/result`. Free attempts omit calibration and use the same
single field. The demo leaderboard starts empty; demo and experimental results
are never normal ranked entries.

## Real Workflow experiment boundary

All real values belong in the server's secret manager, never a client, shell
history, committed environment file, receipt, or log. The complete validated
tuple is `ROBOFLOW_API_URL`, optional `ROBOFLOW_API_KEY`, workspace ID, exact
workflow version `1.0.0`, both named workflow IDs, and both model-bundle IDs.
External URLs and any key-bearing URL use HTTPS; only a keyless loopback URL
may use HTTP.

For every transformed JPEG the Workflow request is:

```text
POST {ROBOFLOW_API_URL}/infer/workflows/{ROBOFLOW_WORKSPACE_ID}/{WORKFLOW_ID}
Content-Type: application/json
Accept: application/json
```

```json
{
  "api_key": "server-only optional value; omit the field when keyless",
  "inputs": {
    "image": { "type": "base64", "value": "base64 JPEG without a data prefix" }
  }
}
```

The verified Workflow is `revelai-wall-pass-geometry-v1`, returning
`wall-pass-geometry-v1`; the Free Workflow is `revelai-free-training-v1`,
returning `free-training-v1`. Both emit parent-image `inference_pixels` on an
exact 1280×720 letterboxed JPEG. The class map is `athlete`, `ball`,
`left_foot`, `right_foot`, the eight fixed fiducial-corner labels, and one
`wallFloorEdge` for the verified Workflow. Source coordinates are recovered
from the same scale/padding transform; do not send an original path, URL, or
multipart body to a provider.

## Benchmark receipt and policy activation

Run the built-in benchmark only against the configured real wall-pass Workflow:

```sh
pnpm --filter @revelai/api run benchmark:roboflow
```

It writes a candidate receipt under
`${REVELAI_BENCHMARK_RECEIPT_DIR:-var/revelai/operator/benchmark-receipts}`.
That directory is an operator handoff, never a public route or runtime source
of truth. Parse and import the candidate with `WorkflowBenchmarkReceiptSchema`;
SQLite persists its canonical JSON, digest, status, expiry, and invalidation
audit. A passing receipt is current only until `validUntil`, becomes invalid on
tuple/manifest changes or operator revocation, and must exactly match the
workspace/workflow/model/provider/scheduler/sampling/manifest tuple before an
operator may activate a real competitive policy. Default demo operation never
reads a receipt or activates policy.

If the five-batch p95 exceeds 900 ms or any batch exceeds 165 seconds, do not
bypass the receipt gate. Reduce verified sampling with new calibration/pass
fixtures, adopt an exact batched Workflow contract, or widen the deadline and
pending-state UI expectation; then rerun the benchmark. The default demo CI
does not call a real Workflow or benchmark.

## Lifecycle and exposure limits

Retention runs once at startup and every hour. Originals/frames are scheduled
for upload plus 23 hours, temporary uploads for one hour, and terminal
observations for 30 days; terminal and deletion cleanup are attempted
immediately, while failed deletion retries on a later hourly sweep. Shutdown
must close worker subscriptions and retention schedules before its SQLite,
storage, and process resources.

Loopback is the default. A non-loopback bind requires exactly
`ALLOW_UNAUTHENTICATED_PUBLIC=true` and emits the persistent warning that this
is not a production-security boundary. RevelAI does not currently claim
production authentication, privacy, retention/deletion governance, biometric
compliance, anti-cheat protection, model accuracy, or scouting suitability.
