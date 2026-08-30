import { z } from "zod";
import { NonEmptyStringSchema, UtcIsoTimestampSchema } from "./primitives.js";

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const sha256InitialHash = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
  0x1f83d9ab, 0x5be0cd19,
];
const sha256RoundConstants = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

function rightRotate(value: number, amount: number): number {
  return (value >>> amount) | (value << (32 - amount));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type DeepReadonly<T> = T extends readonly unknown[]
  ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
  : T extends object
    ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
    : T;

function canonicalizeJson(value: unknown): string {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    const serialized = JSON.stringify(value);

    if (serialized === undefined) {
      throw new Error("Canonical JSON cannot serialize this value");
    }

    return serialized;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("Canonical JSON requires finite numbers");
    }

    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(canonicalizeJson).join(",")}]`;
  }

  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalizeJson(value[key])}`)
      .join(",")}}`;
  }

  throw new Error("Canonical JSON accepts only JSON values");
}

export function sha256Hex(value: string): string {
  const bytes = new TextEncoder().encode(value);
  const bitLength = bytes.length * 8;
  const paddingLength = (64 - ((bytes.length + 9) % 64)) % 64;
  const padded = new Uint8Array(bytes.length + 1 + paddingLength + 8);
  padded.set(bytes);
  padded[bytes.length] = 0x80;

  const dataView = new DataView(padded.buffer);
  dataView.setUint32(
    padded.length - 8,
    Math.floor(bitLength / 0x1_0000_0000) >>> 0,
  );
  dataView.setUint32(padded.length - 4, bitLength >>> 0);

  const hash = Uint32Array.from(sha256InitialHash);
  const words = new Uint32Array(64);

  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      words[index] = dataView.getUint32(offset + index * 4);
    }

    for (let index = 16; index < 64; index += 1) {
      const sigma0 =
        rightRotate(words[index - 15], 7) ^
        rightRotate(words[index - 15], 18) ^
        (words[index - 15] >>> 3);
      const sigma1 =
        rightRotate(words[index - 2], 17) ^
        rightRotate(words[index - 2], 19) ^
        (words[index - 2] >>> 10);
      words[index] =
        (words[index - 16] + sigma0 + words[index - 7] + sigma1) >>> 0;
    }

    let [a, b, c, d, e, f, g, h] = hash;

    for (let index = 0; index < 64; index += 1) {
      const sum1 = rightRotate(e, 6) ^ rightRotate(e, 11) ^ rightRotate(e, 25);
      const choice = (e & f) ^ (~e & g);
      const temporary1 =
        (h + sum1 + choice + sha256RoundConstants[index] + words[index]) >>> 0;
      const sum0 = rightRotate(a, 2) ^ rightRotate(a, 13) ^ rightRotate(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temporary2 = (sum0 + majority) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temporary1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temporary1 + temporary2) >>> 0;
    }

    hash[0] = (hash[0] + a) >>> 0;
    hash[1] = (hash[1] + b) >>> 0;
    hash[2] = (hash[2] + c) >>> 0;
    hash[3] = (hash[3] + d) >>> 0;
    hash[4] = (hash[4] + e) >>> 0;
    hash[5] = (hash[5] + f) >>> 0;
    hash[6] = (hash[6] + g) >>> 0;
    hash[7] = (hash[7] + h) >>> 0;
  }

  return Array.from(hash, (word) => word.toString(16).padStart(8, "0")).join(
    "",
  );
}

export function workflowBenchmarkReceiptDigest(
  receipt: WorkflowBenchmarkReceiptPayload,
): string {
  return sha256Hex(canonicalizeJson(receipt));
}
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

export const WorkflowBenchmarkInvalidationReasonSchema = z.enum([
  "tuple_changed",
  "manifest_set_changed",
  "operator_revoked",
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
    invalidationReason: WorkflowBenchmarkInvalidationReasonSchema.nullable(),
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

    const { receiptSha256, ...receiptPayload } = receipt;

    if (receiptSha256 !== workflowBenchmarkReceiptDigest(receiptPayload)) {
      context.addIssue({
        code: "custom",
        message: "Benchmark receipt hash must match canonical receipt content",
        path: ["receiptSha256"],
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

const passingReceiptPayload = {
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
} as const;

const passingReceipt = {
  ...passingReceiptPayload,
  receiptSha256: workflowBenchmarkReceiptDigest(passingReceiptPayload),
} as const;

const failedReceiptPayload = {
  ...passingReceiptPayload,
  id: "1dce8f39-20b2-4b06-aec4-8fba70a535f8",
  pooledDispatchToObservationP95Ms: 901,
  status: "failed",
} as const;

const failedReceipt = {
  ...failedReceiptPayload,
  receiptSha256: workflowBenchmarkReceiptDigest(failedReceiptPayload),
} as const;

const staleReceiptPayload = {
  ...passingReceiptPayload,
  id: "41cfd9b0-8830-4644-9b45-77c5e381e0a7",
  runAt: "2020-01-01T00:00:00.000Z",
  validUntil: "2020-01-31T00:00:00.000Z",
} as const;

const staleReceipt = {
  ...staleReceiptPayload,
  receiptSha256: workflowBenchmarkReceiptDigest(staleReceiptPayload),
} as const;

export const passingWorkflowBenchmarkReceiptFixture =
  deepFreeze(passingReceipt);

export const failedWorkflowBenchmarkReceiptFixture = deepFreeze(failedReceipt);

export const staleWorkflowBenchmarkReceiptFixture = deepFreeze(staleReceipt);

export const missingWorkflowBenchmarkReceiptFixture = undefined;

export type WorkflowBenchmarkReceipt = z.infer<
  typeof WorkflowBenchmarkReceiptSchema
>;
export type WorkflowBenchmarkInvalidationReason = z.infer<
  typeof WorkflowBenchmarkInvalidationReasonSchema
>;
export type WorkflowBenchmarkReceiptPayload = DeepReadonly<
  Omit<WorkflowBenchmarkReceipt, "receiptSha256">
>;
