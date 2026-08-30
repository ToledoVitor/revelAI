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

export const RouteErrorMessageByCode = {
  invalid_request: "Não foi possível entender esta solicitação.",
  invalid_athlete_identity: "A identidade local do atleta é inválida.",
  attempt_not_found: "Esta tentativa não está disponível.",
  calibration_session_not_found: "A sessão de calibração não está disponível.",
  calibration_session_expired: "A sessão de calibração expirou.",
  calibration_session_not_ready: "Conclua a calibração antes de continuar.",
  calibration_session_consumed: "Esta sessão de calibração já foi usada.",
  calibration_session_challenge_mismatch:
    "A sessão de calibração não corresponde a este desafio.",
  invalid_attempt_transition: "Esta tentativa não pode avançar agora.",
  media_part_missing: "Envie um arquivo de vídeo.",
  media_part_count_invalid: "Envie somente um arquivo de vídeo.",
  multipart_extra_part_forbidden: "Envie somente o arquivo de vídeo.",
  media_filename_mime_mismatch:
    "O tipo declarado não corresponde ao arquivo de vídeo.",
  media_empty: "O arquivo de vídeo está vazio.",
  media_too_large: "O arquivo de vídeo excede o tamanho permitido.",
  multipart_body_too_large: "O envio excede o tamanho permitido.",
  media_container_not_allowed: "O formato de vídeo não é permitido.",
  media_probe_failed: "Não foi possível verificar este vídeo.",
  media_requirements_not_met:
    "O vídeo não atende aos requisitos desta tentativa.",
  duplicate_media_upload: "Esta tentativa já possui um vídeo.",
  queue_unavailable: "O processamento está temporariamente indisponível.",
  service_not_ready: "O serviço está temporariamente indisponível.",
} as const satisfies Record<z.infer<typeof RouteErrorCodeSchema>, string>;

export const InvalidRetryMessageByCode = {
  capture_requirements_not_met: "A captura não atende aos requisitos.",
  video_not_continuous: "Grave um vídeo contínuo para tentar novamente.",
  calibration_not_verified: "Refaça a calibração antes de tentar novamente.",
  tracking_insufficient: "Não foi possível acompanhar a atividade no vídeo.",
} as const satisfies Record<z.infer<typeof InvalidRetryCodeSchema>, string>;

export const FailureMessageByCode = {
  analysis_temporary_unavailable:
    "A análise está indisponível temporariamente.",
  analysis_configuration_invalid: "A análise não está disponível agora.",
  analysis_internal_error: "A análise não pôde ser concluída.",
} as const satisfies Record<z.infer<typeof FailureCodeSchema>, string>;

export const RouteErrorSchema = z
  .object({
    code: RouteErrorCodeSchema,
    message: NonEmptyStringSchema,
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

    if (error.message !== RouteErrorMessageByCode[error.code]) {
      context.addIssue({
        code: "custom",
        message: "Route error messages must use the allowlisted safe message",
        path: ["message"],
      });
    }
  });

export type InvalidRetryCode = z.infer<typeof InvalidRetryCodeSchema>;
export type FailureCode = z.infer<typeof FailureCodeSchema>;
export type RouteErrorCode = z.infer<typeof RouteErrorCodeSchema>;
export type RouteError = z.infer<typeof RouteErrorSchema>;
