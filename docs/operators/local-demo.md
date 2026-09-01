# RevelAI local demo and operator path

RevelAI is an unauthenticated MVP prototype. Its demo provider is local and
offline, produces unranked observations, and must not be described as real
inference, accurate scouting, privacy protection, or a production-security
service.

## Install and demo checks

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm --filter @revelai/api run demo:smoke
pnpm --filter @revelai/api run openapi:check
pnpm --filter @revelai/api run operator:receipt-smoke
```

Start the executable local-only profile in one terminal. It parses the actual
environment before binding, defaults to loopback `127.0.0.1:3000`, composes
SQLite/local storage/an in-process queue, both Free and Verified workers, and
the empty local competitive-policy lookup. It prints only redacted startup
messages. Demo mode needs no Roboflow key, receipt, or network connection.

Normal `demo:start` uses real local FFprobe and FFmpeg. Install both before
starting; FFprobe must be executable, and FFmpeg must provide the `showinfo`
and `metadata` filters plus the MJPEG encoder used by local extraction. The
executable checks those capabilities before binding and, when they are absent,
exits with one operator-safe message without printing command output, paths,
or partial-resource details.

```sh
pnpm --filter @revelai/api run demo:start
```

In a second terminal, run this complete verified demo path. It uses only a
locally generated athlete identifier; replace `./demo.mp4` with a local,
eligible MP4/MOV/WebM. The local demo provider completes a deterministic,
terminal **demo / not ranked** result; it is not live inference or codec proof.

```sh
api_base_url=http://127.0.0.1:3000
athlete_id=$(node -e 'console.log(crypto.randomUUID())')
curl --fail-with-body "$api_base_url/health"
curl --fail-with-body "$api_base_url/ready"
calibration_json=$(curl --fail-with-body -H "X-RevelAI-Athlete-Id: $athlete_id" \
  -H 'content-type: application/json' \
  --data '{"challengeId":"wall-pass","challengeVersion":1}' \
  "$api_base_url/v1/calibration-sessions")
calibration_id=$(node -e 'console.log(JSON.parse(process.argv[1]).id)' "$calibration_json")
curl --fail-with-body -X POST -H "X-RevelAI-Athlete-Id: $athlete_id" \
  -H 'content-type: application/json' \
  --data '{"requiredGates":["device","space","athlete","rehearsal","record"]}' \
  "$api_base_url/v1/calibration-sessions/$calibration_id/ready"
attempt_json=$(curl --fail-with-body -H "X-RevelAI-Athlete-Id: $athlete_id" \
  -H 'content-type: application/json' \
  --data "{\"mode\":\"verified\",\"challengeId\":\"wall-pass\",\"challengeVersion\":1,\"calibrationSessionId\":\"$calibration_id\"}" \
  "$api_base_url/v1/attempts")
attempt_id=$(node -e 'console.log(JSON.parse(process.argv[1]).id)' "$attempt_json")
curl --fail-with-body -X POST -H "X-RevelAI-Athlete-Id: $athlete_id" \
  -F 'media=@./demo.mp4;type=video/mp4' \
  "$api_base_url/v1/attempts/$attempt_id/media"
while :; do
  result_json=$(curl --fail-with-body -H "X-RevelAI-Athlete-Id: $athlete_id" \
    "$api_base_url/v1/attempts/$attempt_id/result")
  result_state=$(node -e 'console.log(JSON.parse(process.argv[1]).state)' "$result_json")
  [ "$result_state" != pending ] && break
  sleep 1
done
node -e 'const result = JSON.parse(process.argv[1]); if (result.state !== "valid" || result.result?.kind !== "verified-result" || result.result?.competitiveStatus !== "demo" || result.result?.competitiveEligible !== false) process.exit(1); console.log("terminal demo / not ranked result")' "$result_json"
curl --fail-with-body "$api_base_url/v1/leaderboards/wall-pass?version=1&ruleVersion=wall-pass-v1-score-1"
```

`demo:smoke` runs the same Fastify/C4–C7/worker composition through that HTTP
trace, including the `202` upload and terminal result. To keep CI portable, its
`--check` mode narrowly injects deterministic FFprobe/FFmpeg-edge fixtures;
it does **not** claim that the host has proved a live codec path. Check mode
constructs its own development loopback/demo environment and temporary paths;
it deliberately ignores surrounding API, provider, public-bind, and database
configuration, including any Roboflow configuration. The normal in-process
queue still processes the terminal trace; the check fixture releases only its
deterministic media edge after observing the pending attempt.

`GET /health` answers process liveness only. `GET /ready` checks SQLite
`SELECT 1`, a private restrictive write/delete sentinel, and the queue under
one bounded deadline. Use returned identifiers only in the next local command;
do not paste identities, receipt JSON, headers, private paths, or media bytes
into tickets or logs. The demo leaderboard starts empty; demo and experimental
results are never normal ranked entries.

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
exact 1280×720 letterboxed JPEG. The verified output is one strict envelope:

```text
outputs[0] = {
  kind: "wall-pass-geometry-v1",
  image: { width: 1280, height: 720, coordinateSystem: "inference_pixels" },
  workflow: { id, version: "1.0.0", modelBundleId, providerVersion },
  detections: [athlete?, ball?],
  keypoints: [left_foot, right_foot],
  fiducials: [a-top-left, a-top-right, a-bottom-right, a-bottom-left,
              b-top-left, b-top-right, b-bottom-right, b-bottom-left],
  geometry: { wallFloorEdge: { x1, y1, x2, y2, confidence } }
}
```

Each point/edge coordinate is an inference-pixel number in the 1280×720
parent image and carries confidence. Source coordinates are recovered from the
same scale/padding transform; do not send an original path, URL, or multipart
body to a provider.

## Benchmark receipt and policy activation

Run the built-in benchmark only against the configured real wall-pass Workflow:

```sh
pnpm --filter @revelai/api run benchmark:roboflow
```

It writes a candidate receipt under
`${REVELAI_BENCHMARK_RECEIPT_DIR:-var/revelai/operator/benchmark-receipts}`.
That directory is an operator handoff, never a public route or runtime source
of truth. In an access-controlled shell, import a candidate into the same
configured SQLite database without printing its path, contents, credentials,
or provider output:

```sh
export REVELAI_BENCHMARK_RECEIPT_FILE=/secure/operator/receipt.json
pnpm --filter @revelai/api run operator:receipt-import
```

The command parses `WorkflowBenchmarkReceiptSchema`, persists canonical JSON,
digest, status, expiry, and invalidation audit, but does not activate policy.
After an operator independently verifies a passed/current receipt and the
workspace/workflow/model/provider/scheduler/sampling/manifest tuple, activate
that exact stored receipt explicitly:

```sh
REVELAI_ACTIVATE_COMPETITIVE_POLICY=true \
  pnpm --filter @revelai/api run operator:receipt-import
```

A passing receipt is current only until `validUntil` and becomes invalid on
tuple/manifest changes or operator revocation. Default demo operation never
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
