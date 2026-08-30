import { z } from "zod";
import { NonEmptyStringSchema } from "./primitives.js";

export const InvalidRetryCodeSchema = z.enum([
  "capture_requirements_not_met",
  "video_not_continuous",
  "calibration_not_verified",
  "tracking_insufficient",
]);

export const FailureCodeSchema = z.enum([
  "analysis_temporary_unavailable",
  "analysis_configuration_invalid",
  "analysis_internal_error",
]);

export const RouteErrorCodes = [
  "invalid_request",
  "invalid_athlete_identity",
  "attempt_not_found",
  "calibration_session_not_found",
  "calibration_session_expired",
  "calibration_session_not_ready",
  "calibration_session_consumed",
  "calibration_session_challenge_mismatch",
  "invalid_attempt_transition",
  "media_part_missing",
  "media_part_count_invalid",
  "multipart_extra_part_forbidden",
  "media_filename_mime_mismatch",
  "media_empty",
  "media_too_large",
  "multipart_body_too_large",
  "media_container_not_allowed",
  "media_probe_failed",
  "media_requirements_not_met",
  "duplicate_media_upload",
  "queue_unavailable",
  "service_not_ready",
] as const;

export const RouteErrorCodeSchema = z.enum(RouteErrorCodes);

const SafeRouteErrorMessageSchema = NonEmptyStringSchema.refine(
  (message) =>
    !/(?:\/(?:Users|tmp|var|home)\b|[A-Za-z]:[\\/]|api[_ -]?key|authorization|roboflow|provider)/i.test(
      message,
    ),
  "Route error messages must not expose paths, credentials, or provider details",
);

export const RouteErrorStatusByCode = {
  invalid_request: 400,
  invalid_athlete_identity: 400,
  attempt_not_found: 404,
  calibration_session_not_found: 404,
  calibration_session_expired: 410,
  calibration_session_not_ready: 409,
  calibration_session_consumed: 409,
  calibration_session_challenge_mismatch: 409,
  invalid_attempt_transition: 409,
  media_part_missing: 400,
  media_part_count_invalid: 400,
  multipart_extra_part_forbidden: 400,
  media_filename_mime_mismatch: 400,
  media_empty: 422,
  media_too_large: 413,
  multipart_body_too_large: 413,
  media_container_not_allowed: 415,
  media_probe_failed: 422,
  media_requirements_not_met: 422,
  duplicate_media_upload: 409,
  queue_unavailable: 503,
  service_not_ready: 503,
} as const satisfies Record<z.infer<typeof RouteErrorCodeSchema>, number>;

export const RouteErrorRetryabilityByCode = {
  invalid_request: false,
  invalid_athlete_identity: false,
  attempt_not_found: false,
  calibration_session_not_found: false,
  calibration_session_expired: false,
  calibration_session_not_ready: false,
  calibration_session_consumed: false,
  calibration_session_challenge_mismatch: false,
  invalid_attempt_transition: false,
  media_part_missing: false,
  media_part_count_invalid: false,
  multipart_extra_part_forbidden: false,
  media_filename_mime_mismatch: false,
  media_empty: false,
  media_too_large: false,
  multipart_body_too_large: false,
  media_container_not_allowed: false,
  media_probe_failed: false,
  media_requirements_not_met: false,
  duplicate_media_upload: false,
  queue_unavailable: true,
  service_not_ready: true,
} as const satisfies Record<z.infer<typeof RouteErrorCodeSchema>, boolean>;

export const RouteErrorSchema = z
  .object({
    code: RouteErrorCodeSchema,
    message: SafeRouteErrorMessageSchema,
    retryable: z.boolean(),
  })
  .strict()
  .superRefine((error, context) => {
    if (error.retryable !== RouteErrorRetryabilityByCode[error.code]) {
      context.addIssue({
        code: "custom",
        message: "Route error retryability must match its code",
        path: ["retryable"],
      });
    }
  });

export type InvalidRetryCode = z.infer<typeof InvalidRetryCodeSchema>;
export type FailureCode = z.infer<typeof FailureCodeSchema>;
export type RouteErrorCode = z.infer<typeof RouteErrorCodeSchema>;
export type RouteError = z.infer<typeof RouteErrorSchema>;
