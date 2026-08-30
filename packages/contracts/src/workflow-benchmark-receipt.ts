import { z } from "zod";
import { NonEmptyStringSchema, UtcIsoTimestampSchema } from "./primitives.js";

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const BenchmarkRunSchema = z
  .object({
    manifestId: NonEmptyStringSchema,
    batchDurationMs: z.number().finite().positive(),
    completedFrameRequests: z.literal(640),
  })
  .strict();

const ManifestIdsSchema = z.tuple([
  NonEmptyStringSchema,
  NonEmptyStringSchema,
  NonEmptyStringSchema,
  NonEmptyStringSchema,
  NonEmptyStringSchema,
]);

const BenchmarkRunsSchema = z.tuple([
  BenchmarkRunSchema,
  BenchmarkRunSchema,
  BenchmarkRunSchema,
  BenchmarkRunSchema,
  BenchmarkRunSchema,
]);

export const WorkflowBenchmarkReceiptSchema = z
  .object({
    schemaVersion: z.literal("workflow-benchmark-receipt-v1"),
    id: z.string().uuid(),
    workflow: z
      .object({
        workspaceId: NonEmptyStringSchema,
        workflowId: z.literal("revelai-wall-pass-geometry-v1"),
        workflowVersion: z.literal("1.0.0"),
        modelBundleId: NonEmptyStringSchema,
        providerVersion: NonEmptyStringSchema,
      })
      .strict(),
    scheduler: z
      .object({
        id: z.literal("verified-wall-pass-image-scheduler-v1"),
        maxInFlight: z.literal(4),
        requestTimeoutMs: z.literal(8000),
        batchDeadlineMs: z.literal(180_000),
        retryDelaysMs: z.tuple([z.literal(250), z.literal(1000)]),
      })
      .strict(),
    sampling: z
      .object({
        id: z.literal("wall-pass-v1-10fps-640-v1"),
        inferenceWidth: z.literal(1280),
        inferenceHeight: z.literal(720),
        preRollFrames: z.literal(40),
        activeFrames: z.literal(600),
        totalFramesPerBatch: z.literal(640),
      })
      .strict(),
    manifestSet: z
      .object({
        sha256: Sha256Schema,
        manifestIds: ManifestIdsSchema,
      })
      .strict(),
    runs: BenchmarkRunsSchema,
    pooledDispatchToObservationP95Ms: z.number().finite().min(0),
    runAt: UtcIsoTimestampSchema,
    validUntil: UtcIsoTimestampSchema,
    status: z.enum(["passed", "failed"]),
    invalidatedAt: UtcIsoTimestampSchema.nullable(),
    invalidationReason: z
      .enum(["tuple_changed", "manifest_set_changed", "operator_revoked"])
      .nullable(),
    receiptSha256: Sha256Schema,
  })
  .strict()
  .superRefine((receipt, context) => {
    const manifestIds = receipt.manifestSet.manifestIds;
    const distinctManifestIds = new Set(manifestIds);

    if (distinctManifestIds.size !== manifestIds.length) {
      context.addIssue({
        code: "custom",
        message: "Benchmark manifest IDs must be distinct",
        path: ["manifestSet", "manifestIds"],
      });
    }

    for (const [index, run] of receipt.runs.entries()) {
      if (run.manifestId !== manifestIds[index]) {
        context.addIssue({
          code: "custom",
          message: "Benchmark run IDs must match the ordered manifest IDs",
          path: ["runs", index, "manifestId"],
        });
      }
    }

    if (
      Date.parse(receipt.validUntil) - Date.parse(receipt.runAt) !==
      30 * 24 * 60 * 60_000
    ) {
      context.addIssue({
        code: "custom",
        message: "Benchmark receipt validity must be exactly thirty days",
        path: ["validUntil"],
      });
    }

    if (
      (receipt.invalidatedAt === null) !==
      (receipt.invalidationReason === null)
    ) {
      context.addIssue({
        code: "custom",
        message: "Benchmark invalidation time and reason must appear together",
        path: ["invalidationReason"],
      });
    }

    const passesThresholds =
      receipt.pooledDispatchToObservationP95Ms <= 900 &&
      receipt.runs.every((run) => run.batchDurationMs <= 165_000) &&
      receipt.invalidatedAt === null &&
      receipt.invalidationReason === null;

    if ((receipt.status === "passed") !== passesThresholds) {
      context.addIssue({
        code: "custom",
        message: "Benchmark pass status must match thresholds and invalidation",
        path: ["status"],
      });
    }
  });

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    Object.freeze(value);

    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
  }

  return value;
}

const passingReceipt = {
  schemaVersion: "workflow-benchmark-receipt-v1",
  id: "e4798abd-7126-4b96-8915-24e4366986f3",
  workflow: {
    workspaceId: "revelai-workspace",
    workflowId: "revelai-wall-pass-geometry-v1",
    workflowVersion: "1.0.0",
    modelBundleId: "wall-pass-bundle-v1",
    providerVersion: "roboflow-inference-v1",
  },
  scheduler: {
    id: "verified-wall-pass-image-scheduler-v1",
    maxInFlight: 4,
    requestTimeoutMs: 8000,
    batchDeadlineMs: 180_000,
    retryDelaysMs: [250, 1000],
  },
  sampling: {
    id: "wall-pass-v1-10fps-640-v1",
    inferenceWidth: 1280,
    inferenceHeight: 720,
    preRollFrames: 40,
    activeFrames: 600,
    totalFramesPerBatch: 640,
  },
  manifestSet: {
    sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    manifestIds: [
      "wall-pass-benchmark-a",
      "wall-pass-benchmark-b",
      "wall-pass-benchmark-c",
      "wall-pass-benchmark-d",
      "wall-pass-benchmark-e",
    ],
  },
  runs: [
    {
      manifestId: "wall-pass-benchmark-a",
      batchDurationMs: 120_000,
      completedFrameRequests: 640,
    },
    {
      manifestId: "wall-pass-benchmark-b",
      batchDurationMs: 121_000,
      completedFrameRequests: 640,
    },
    {
      manifestId: "wall-pass-benchmark-c",
      batchDurationMs: 122_000,
      completedFrameRequests: 640,
    },
    {
      manifestId: "wall-pass-benchmark-d",
      batchDurationMs: 123_000,
      completedFrameRequests: 640,
    },
    {
      manifestId: "wall-pass-benchmark-e",
      batchDurationMs: 124_000,
      completedFrameRequests: 640,
    },
  ],
  pooledDispatchToObservationP95Ms: 850,
  runAt: "2030-01-01T00:00:00.000Z",
  validUntil: "2030-01-31T00:00:00.000Z",
  status: "passed",
  invalidatedAt: null,
  invalidationReason: null,
  receiptSha256:
    "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
} as const;

export const passingWorkflowBenchmarkReceiptFixture =
  deepFreeze(passingReceipt);

export const failedWorkflowBenchmarkReceiptFixture = deepFreeze({
  ...passingReceipt,
  id: "1dce8f39-20b2-4b06-aec4-8fba70a535f8",
  pooledDispatchToObservationP95Ms: 901,
  status: "failed",
  receiptSha256:
    "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
} as const);

export const staleWorkflowBenchmarkReceiptFixture = deepFreeze({
  ...passingReceipt,
  id: "41cfd9b0-8830-4644-9b45-77c5e381e0a7",
  runAt: "2020-01-01T00:00:00.000Z",
  validUntil: "2020-01-31T00:00:00.000Z",
  receiptSha256:
    "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
} as const);

export const missingWorkflowBenchmarkReceiptFixture = undefined;

export type WorkflowBenchmarkReceipt = z.infer<
  typeof WorkflowBenchmarkReceiptSchema
>;
