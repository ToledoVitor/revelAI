import { createHash } from "node:crypto";
import { chmod, link, mkdir, open, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  WorkflowBenchmarkReceiptSchema,
  workflowBenchmarkReceiptDigest,
  type WorkflowBenchmarkReceipt,
  type WorkflowBenchmarkReceiptPayload,
} from "@revelai/contracts";
import {
  VerifiedVisionFrameRequestSchema,
  VisionBatchScheduler,
  type SchedulerClock,
  type VerifiedVisionFrameRequest,
  type VisionProvider,
} from "@revelai/vision";

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60_000;
const RECEIPT_DIRECTORY_MODE = 0o700;
const RECEIPT_FILE_MODE = 0o600;

export type BenchmarkManifestIdentity = Readonly<{
  id: string;
  sha256: string;
}>;

export type CompletedBenchmarkRun = Readonly<{
  manifestId: string;
  batchDurationMs: number;
  completedFrameRequests: 640;
}>;

export type CreateWorkflowBenchmarkReceiptInput = Readonly<{
  id: string;
  runAt: string;
  workflow: Readonly<{
    workspaceId: string;
    modelBundleId: string;
    providerVersion: string;
  }>;
  manifests: readonly BenchmarkManifestIdentity[];
  runs: readonly CompletedBenchmarkRun[];
  pooledDispatchToObservationP95Ms: number;
}>;

export type VerifiedBenchmarkManifest = Readonly<{
  id: string;
  sha256: string;
  frames: readonly VerifiedVisionFrameRequest[];
}>;

export type WorkflowBenchmarkClock = Pick<SchedulerClock, "now">;

export type RunWorkflowBenchmarkInput = Readonly<{
  id: () => string;
  provider: VisionProvider;
  scheduler: VisionBatchScheduler;
  clock: WorkflowBenchmarkClock;
  manifests: readonly VerifiedBenchmarkManifest[];
}>;

/**
 * Creates an operator handoff receipt only. It deliberately does not make a
 * policy or eligibility decision; consumers must re-parse this strict record.
 */
export function createWorkflowBenchmarkReceipt(
  input: CreateWorkflowBenchmarkReceiptInput,
): WorkflowBenchmarkReceipt {
  const manifests = exactFive(input.manifests, "benchmark manifests");
  const runs = exactFive(input.runs, "benchmark runs");
  const manifestIds = manifests.map((manifest) => manifest.id);
  if (new Set(manifestIds).size !== manifestIds.length)
    throw new Error("benchmark manifest IDs must be distinct");
  if (runs.some((run, index) => run.manifestId !== manifestIds[index]))
    throw new Error("benchmark runs must match ordered manifest IDs");
  const runAtEpoch = Date.parse(input.runAt);
  if (!Number.isFinite(runAtEpoch))
    throw new Error("invalid benchmark run time");
  const status =
    input.pooledDispatchToObservationP95Ms <= 900 &&
    runs.every((run) => run.batchDurationMs <= 165_000)
      ? "passed"
      : "failed";
  const payload = {
    schemaVersion: "workflow-benchmark-receipt-v1" as const,
    id: input.id,
    workflow: {
      workspaceId: input.workflow.workspaceId,
      workflowId: "revelai-wall-pass-geometry-v1" as const,
      workflowVersion: "1.0.0" as const,
      modelBundleId: input.workflow.modelBundleId,
      providerVersion: input.workflow.providerVersion,
    },
    scheduler: {
      id: "verified-wall-pass-image-scheduler-v1" as const,
      maxInFlight: 4 as const,
      requestTimeoutMs: 8000 as const,
      batchDeadlineMs: 180_000 as const,
      retryDelaysMs: [250, 1000] as const,
    },
    sampling: {
      id: "wall-pass-v1-10fps-640-v1" as const,
      inferenceWidth: 1280 as const,
      inferenceHeight: 720 as const,
      preRollFrames: 40 as const,
      activeFrames: 600 as const,
      totalFramesPerBatch: 640 as const,
    },
    manifestSet: {
      sha256: manifestSetDigest(manifests),
      manifestIds: exactTuple(manifestIds),
    },
    runs: exactTuple(
      runs.map((run) => ({
        manifestId: run.manifestId,
        batchDurationMs: run.batchDurationMs,
        completedFrameRequests: run.completedFrameRequests,
      })),
    ),
    pooledDispatchToObservationP95Ms: input.pooledDispatchToObservationP95Ms,
    runAt: input.runAt,
    validUntil: new Date(runAtEpoch + THIRTY_DAYS_MS).toISOString(),
    status,
    invalidatedAt: null,
    invalidationReason: null,
  } as const;
  const receipt = {
    ...payload,
    receiptSha256: workflowBenchmarkReceiptDigest(
      payload as WorkflowBenchmarkReceiptPayload,
    ),
  };
  return WorkflowBenchmarkReceiptSchema.parse(receipt);
}

/**
 * The only live-facing operator seam. It runs each complete manifest through
 * the injected production scheduler and provider, retaining only durations
 * and tuple identities after every parsed observation has settled.
 */
export async function runWorkflowBenchmark(
  input: RunWorkflowBenchmarkInput,
): Promise<WorkflowBenchmarkReceipt> {
  const manifests = exactFive(input.manifests, "benchmark manifests");
  if (input.provider.verifiedProvenance.kind !== "roboflow")
    throw new Error("benchmark requires a configured Roboflow provider");
  const samples: number[] = [];
  const runs: CompletedBenchmarkRun[] = [];
  for (const manifest of manifests) {
    assertBenchmarkManifest(manifest);
    const batchStartedAt = input.clock.now();
    const observations = await input.scheduler.run(
      manifest.frames,
      async (request, signal) => {
        const dispatchedAt = input.clock.now();
        const observation = await input.provider.analyzeVerified(
          request,
          signal,
        );
        const duration = input.clock.now() - dispatchedAt;
        if (!Number.isFinite(duration) || duration < 0)
          throw new Error("invalid benchmark dispatch duration");
        samples.push(duration);
        return observation;
      },
    );
    const batchDuration = input.clock.now() - batchStartedAt;
    if (!Number.isFinite(batchDuration) || batchDuration <= 0)
      throw new Error("invalid benchmark batch duration");
    if (observations.length !== 640)
      throw new Error("benchmark batch did not complete every frame request");
    runs.push({
      manifestId: manifest.id,
      batchDurationMs: batchDuration,
      completedFrameRequests: 640,
    });
  }
  if (samples.length !== 3200)
    throw new Error(
      "benchmark did not capture every dispatch observation sample",
    );
  const provenance = input.provider.verifiedProvenance;
  return createWorkflowBenchmarkReceipt({
    id: input.id(),
    runAt: new Date(input.clock.now()).toISOString(),
    workflow: {
      workspaceId: provenance.workspaceId,
      modelBundleId: provenance.modelBundleId,
      providerVersion: provenance.providerVersion,
    },
    manifests,
    runs,
    pooledDispatchToObservationP95Ms: percentile95(samples),
  });
}

/**
 * Publishes a finished, strict receipt with an exclusive hard-link step: an
 * existing handoff is never overwritten and no partially-written final file is
 * observable. The output directory is operator-only, not application state.
 */
export async function writeWorkflowBenchmarkReceipt(
  input: Readonly<{
    directory: string;
    receipt: WorkflowBenchmarkReceipt;
  }>,
): Promise<string> {
  const receipt = WorkflowBenchmarkReceiptSchema.parse(input.receipt);
  const content = `${JSON.stringify(receipt)}\n`;
  const directory = input.directory;
  const finalPath = join(directory, `${receipt.id}.json`);
  const temporaryPath = join(directory, `.${receipt.id}.${process.pid}.tmp`);
  await mkdir(directory, { recursive: true, mode: RECEIPT_DIRECTORY_MODE });
  await chmod(directory, RECEIPT_DIRECTORY_MODE);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporaryPath, "wx", RECEIPT_FILE_MODE);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.chmod(RECEIPT_FILE_MODE);
    await handle.close();
    handle = undefined;
    try {
      await link(temporaryPath, finalPath);
    } catch (error) {
      if (isAlreadyExists(error))
        throw new Error("benchmark receipt already exists");
      throw error;
    }
    await chmod(finalPath, RECEIPT_FILE_MODE);
    await rm(temporaryPath, { force: true });
    return finalPath;
  } finally {
    await handle?.close();
    await rm(temporaryPath, { force: true });
  }
}

/** Canonical ordered identity digest; frame bytes, paths, and credentials stay out. */
export function manifestSetDigest(
  manifests: readonly BenchmarkManifestIdentity[],
): string {
  const normalized = exactFive(manifests, "benchmark manifests").map(
    (manifest) => ({ id: manifest.id, sha256: manifest.sha256 }),
  );
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

export function percentile95(samples: readonly number[]): number {
  if (samples.length === 0) throw new Error("cannot calculate an empty p95");
  if (samples.some((sample) => !Number.isFinite(sample) || sample < 0))
    throw new Error("invalid benchmark sample");
  const ordered = [...samples].sort((left, right) => left - right);
  return ordered[Math.ceil(ordered.length * 0.95) - 1]!;
}

function assertBenchmarkManifest(manifest: VerifiedBenchmarkManifest): void {
  if (manifest.frames.length !== 640)
    throw new Error("benchmark manifest must contain 640 frames");
  for (const request of manifest.frames) {
    const parsed = VerifiedVisionFrameRequestSchema.parse(request);
    if (parsed.frame.sourceWidth !== 1280 || parsed.frame.sourceHeight !== 720)
      throw new Error("benchmark frame must be 1280x720");
  }
}

function exactFive<T>(
  values: readonly T[],
  label: string,
): readonly [T, T, T, T, T] {
  if (values.length !== 5)
    throw new Error(`${label} must contain exactly five items`);
  return exactTuple(values);
}

function exactTuple<T>(values: readonly T[]): readonly [T, T, T, T, T] {
  if (values.length !== 5) throw new Error("expected exactly five values");
  return [values[0]!, values[1]!, values[2]!, values[3]!, values[4]!];
}

function isAlreadyExists(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "EEXIST"
  );
}
