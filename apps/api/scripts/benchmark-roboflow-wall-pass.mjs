import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import process from "node:process";
import {
  createRoboflowVisionProvider,
  VisionBatchScheduler,
} from "@revelai/vision";
import {
  runWorkflowBenchmark,
  writeWorkflowBenchmarkReceipt,
} from "../dist/processing/workflow-benchmark.js";

/**
 * Operator-only command. The adapter lives in an access-controlled local
 * module and supplies opaque C5-derived manifests plus the JPEG transformer;
 * it never passes a media path or credential into the receipt.
 */
async function main() {
  const adapterPath = required("REVELAI_BENCHMARK_ADAPTER");
  const adapter = await import(pathToFileURL(resolve(adapterPath)).href);
  if (
    typeof adapter.loadVerifiedBenchmarkManifests !== "function" ||
    !adapter.transformer ||
    typeof adapter.transformer.transform !== "function"
  )
    throw new Error("invalid benchmark adapter");

  const provider = createRoboflowVisionProvider({
    config: {
      apiUrl: required("ROBOFLOW_API_URL"),
      workspaceId: required("ROBOFLOW_WORKSPACE_ID"),
      ...(process.env.ROBOFLOW_API_KEY
        ? { apiKey: process.env.ROBOFLOW_API_KEY }
        : {}),
      freeModelBundleId: required("ROBOFLOW_FREE_MODEL_BUNDLE_ID"),
      verifiedModelBundleId: required("ROBOFLOW_VERIFIED_MODEL_BUNDLE_ID"),
      freeProviderVersion: required("ROBOFLOW_FREE_PROVIDER_VERSION"),
      verifiedProviderVersion: required("ROBOFLOW_VERIFIED_PROVIDER_VERSION"),
    },
    transformer: adapter.transformer,
    fetch: async (url, init) => {
      const response = await fetch(url, init);
      return {
        status: response.status,
        json: () => response.json(),
      };
    },
  });
  const receipt = await runWorkflowBenchmark({
    id: crypto.randomUUID,
    provider,
    scheduler: new VisionBatchScheduler(),
    clock: { now: Date.now },
    manifests: await adapter.loadVerifiedBenchmarkManifests(),
  });
  await writeWorkflowBenchmarkReceipt({
    directory:
      process.env.REVELAI_BENCHMARK_RECEIPT_DIR ??
      "var/revelai/operator/benchmark-receipts",
    receipt,
  });
  // Do not include a receipt path, error body, credential, or raw observation.
  console.log("Roboflow workflow benchmark receipt written.");
}

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error("missing benchmark configuration");
  return value;
}

void main().catch(() => {
  // Keep operator logs redacted even when a provider or adapter fails.
  console.error(
    "Roboflow workflow benchmark failed without emitting provider details.",
  );
  process.exitCode = 1;
});
