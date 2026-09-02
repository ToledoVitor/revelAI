import { z } from "zod";
import { RequiredGatesSchema } from "./challenges.js";
import {
  isExactDurationAfter,
  NonEmptyStringSchema,
  UtcIsoTimestampSchema,
} from "./primitives.js";

export const MAX_UPLOAD_BYTES = 250 * 1024 * 1024;
export const MAX_MULTIPART_ENVELOPE_BYTES = MAX_UPLOAD_BYTES + 65_536;

export const AttemptModeSchema = z.enum(["free", "verified"]);
export const AttemptStatusSchema = z.enum([
  "awaiting-upload",
  "uploaded",
  "processing",
  "valid",
  "invalid",
  "failed",
]);

export const AthleteIdentityHeaderSchema = z
  .object({
    "x-revelai-athlete-id": z.string().uuid(),
  })
  .passthrough();

export const IdempotencyKeyHeaderSchema = z
  .object({
    "idempotency-key": z.string().uuid(),
  })
  .passthrough();

export const CreateAttemptInputSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("free") }).strict(),
  z
    .object({
      mode: z.literal("verified"),
      challengeId: z.literal("wall-pass"),
      challengeVersion: z.literal(1),
      calibrationSessionId: z.string().min(1),
    })
    .strict(),
]);

export const CalibrationSessionCreateInputSchema = z
  .object({
    challengeId: z.literal("wall-pass"),
    challengeVersion: z.literal(1),
  })
  .strict();

export const CalibrationSessionReadyInputSchema = z
  .object({
    requiredGates: RequiredGatesSchema,
  })
  .strict();

const CalibrationNonceSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{43}$/, "Expected a 32-byte base64url nonce");

export const CalibrationSessionSchema = z
  .object({
    id: NonEmptyStringSchema,
    challengeId: z.literal("wall-pass"),
    challengeVersion: z.literal(1),
    state: z.enum(["issued", "ready"]),
    nonce: CalibrationNonceSchema,
    issuedAt: UtcIsoTimestampSchema,
    expiresAt: UtcIsoTimestampSchema,
    requiredGates: RequiredGatesSchema,
  })
  .strict()
  .superRefine((session, context) => {
    if (
      !isExactDurationAfter(session.issuedAt, session.expiresAt, 15 * 60_000)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Calibration expiry must be exactly fifteen minutes after issue",
        path: ["expiresAt"],
      });
    }
  });

export const AttemptListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(50).optional().default(20),
    cursor: NonEmptyStringSchema.optional(),
  })
  .strict();

export const AttemptIdPathParamsSchema = z
  .object({ id: NonEmptyStringSchema })
  .strict();

export const CalibrationSessionIdPathParamsSchema = z
  .object({ id: NonEmptyStringSchema })
  .strict();

const NormalizedDeclaredMimeSchema = z
  .string()
  .trim()
  .transform((value) => value.split(";", 1)[0]?.trim().toLowerCase() ?? "")
  .pipe(z.enum(["video/mp4", "video/quicktime", "video/webm"]));

export const MediaUploadPartSchema = z
  .object({
    kind: z.literal("file"),
    fieldName: z.literal("media"),
    filename: NonEmptyStringSchema,
    declaredMime: NormalizedDeclaredMimeSchema,
    fileBytes: z.number().int().min(1).max(MAX_UPLOAD_BYTES),
  })
  .strict()
  .superRefine((part, context) => {
    const extension = part.filename.toLowerCase().split(".").at(-1);
    const expectedMime =
      extension === "mp4"
        ? "video/mp4"
        : extension === "mov"
          ? "video/quicktime"
          : extension === "webm"
            ? "video/webm"
            : undefined;
    if (expectedMime === undefined || part.declaredMime !== expectedMime) {
      context.addIssue({
        code: "custom",
        message: "Filename extension and declared MIME must match",
        path: ["declaredMime"],
      });
    }
  });

export const MediaUploadRequestSchema = z
  .object({
    parts: z.tuple([MediaUploadPartSchema]),
    multipartBytes: z.number().int().min(1).max(MAX_MULTIPART_ENVELOPE_BYTES),
  })
  .strict()
  .superRefine((request, context) => {
    if (request.multipartBytes < request.parts[0].fileBytes) {
      context.addIssue({
        code: "custom",
        message: "Multipart bytes cannot be lower than emitted file bytes",
        path: ["multipartBytes"],
      });
    }
  });

const UploadAcceptedOutcomeSchema = z
  .object({
    state: z.literal("pending"),
    attemptId: NonEmptyStringSchema,
    mode: AttemptModeSchema,
    status: z.literal("uploaded"),
  })
  .strict();

export const MediaUploadAcceptedSchema = z
  .object({
    kind: z.literal("media-upload-accepted"),
    attemptId: NonEmptyStringSchema,
    mode: AttemptModeSchema,
    acceptedStatus: z.literal("uploaded"),
    outcome: UploadAcceptedOutcomeSchema,
  })
  .strict()
  .superRefine((accepted, context) => {
    if (accepted.outcome.attemptId !== accepted.attemptId) {
      context.addIssue({
        code: "custom",
        message: "Accepted outcome must belong to the accepted attempt",
        path: ["outcome", "attemptId"],
      });
    }

    if (accepted.outcome.mode !== accepted.mode) {
      context.addIssue({
        code: "custom",
        message: "Accepted outcome mode must match the accepted attempt",
        path: ["outcome", "mode"],
      });
    }
  });

export type AthleteIdentityHeader = z.infer<typeof AthleteIdentityHeaderSchema>;
export type IdempotencyKeyHeader = z.infer<typeof IdempotencyKeyHeaderSchema>;
export type CreateAttemptInput = z.infer<typeof CreateAttemptInputSchema>;
export type AttemptMode = z.infer<typeof AttemptModeSchema>;
export type AttemptStatus = z.infer<typeof AttemptStatusSchema>;
export type CalibrationSessionCreateInput = z.infer<
  typeof CalibrationSessionCreateInputSchema
>;
export type CalibrationSessionReadyInput = z.infer<
  typeof CalibrationSessionReadyInputSchema
>;
export type CalibrationSession = z.infer<typeof CalibrationSessionSchema>;
export type AttemptListQuery = z.infer<typeof AttemptListQuerySchema>;
export type AttemptIdPathParams = z.infer<typeof AttemptIdPathParamsSchema>;
export type CalibrationSessionIdPathParams = z.infer<
  typeof CalibrationSessionIdPathParamsSchema
>;
export type MediaUploadPart = z.infer<typeof MediaUploadPartSchema>;
export type MediaUploadRequest = z.infer<typeof MediaUploadRequestSchema>;
export type MediaUploadAccepted = z.infer<typeof MediaUploadAcceptedSchema>;
