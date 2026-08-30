import { MAX_MULTIPART_ENVELOPE_BYTES, MAX_UPLOAD_BYTES } from "./attempts.js";
import {
  RouteErrorCodes,
  RouteErrorRetryabilityByCode,
  RouteErrorStatusByCode,
} from "./errors.js";

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    Object.freeze(value);

    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
  }

  return value;
}

const routeErrorMessages = {
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
} as const;

export const routeErrorFixtures = deepFreeze(
  RouteErrorCodes.map((code) => ({
    status: RouteErrorStatusByCode[code],
    body: {
      code,
      message: routeErrorMessages[code],
      retryable: RouteErrorRetryabilityByCode[code],
    },
  })),
);

export const mediaFilenameMimeFixtures = deepFreeze({
  accepted: [
    { filename: "attempt.mp4", declaredMime: "video/mp4" },
    { filename: "attempt.mov", declaredMime: "video/quicktime" },
    { filename: "attempt.webm", declaredMime: "video/webm" },
  ],
  rejected: [
    { filename: "attempt.mp4", declaredMime: "video/webm" },
    { filename: "attempt.mov", declaredMime: "video/mp4" },
    { filename: "attempt.webm", declaredMime: "video/quicktime" },
    { filename: "attempt.avi", declaredMime: "video/mp4" },
  ],
} as const);

export const mediaUploadFixtures = deepFreeze({
  accepted: {
    name: "exactly-one-media-file-at-the-byte-limit",
    status: 202,
    request: {
      parts: [
        {
          kind: "file",
          fieldName: "media",
          filename: "attempt.mp4",
          declaredMime: "video/mp4",
          fileBytes: MAX_UPLOAD_BYTES,
        },
      ],
      multipartBytes: MAX_MULTIPART_ENVELOPE_BYTES,
    },
    response: {
      kind: "media-upload-accepted",
      attemptId: "attempt-upload-1",
      mode: "free",
      acceptedStatus: "uploaded",
      outcome: {
        state: "pending",
        attemptId: "attempt-upload-1",
        mode: "free",
        status: "uploaded",
      },
    },
  },
  rejected: [
    {
      name: "missing-media-part",
      expected: { status: 400, code: "media_part_missing", retryable: false },
      request: { parts: [], multipartBytes: 1 },
    },
    {
      name: "repeated-media-part",
      expected: {
        status: 400,
        code: "media_part_count_invalid",
        retryable: false,
      },
      request: { parts: ["media", "media"], multipartBytes: 2 },
    },
    {
      name: "wrong-media-field-name",
      expected: {
        status: 400,
        code: "multipart_extra_part_forbidden",
        retryable: false,
      },
      request: { parts: ["video"], multipartBytes: 1 },
    },
    {
      name: "extra-file-part",
      expected: {
        status: 400,
        code: "multipart_extra_part_forbidden",
        retryable: false,
      },
      request: { parts: ["media", "thumbnail"], multipartBytes: 2 },
    },
    {
      name: "extra-text-part",
      expected: {
        status: 400,
        code: "multipart_extra_part_forbidden",
        retryable: false,
      },
      request: { parts: ["media", "comment"], multipartBytes: 2 },
    },
    {
      name: "filename-mime-mismatch",
      expected: {
        status: 400,
        code: "media_filename_mime_mismatch",
        retryable: false,
      },
      request: {
        parts: ["media"],
        filename: "attempt.mp4",
        declaredMime: "video/webm",
      },
    },
    {
      name: "media-byte-limit-exceeded",
      expected: { status: 413, code: "media_too_large", retryable: false },
      request: { fileBytes: MAX_UPLOAD_BYTES + 1 },
    },
    {
      name: "multipart-envelope-limit-exceeded",
      expected: {
        status: 413,
        code: "multipart_body_too_large",
        retryable: false,
      },
      request: { multipartBytes: MAX_MULTIPART_ENVELOPE_BYTES + 1 },
    },
    {
      name: "duplicate-media-upload",
      expected: {
        status: 409,
        code: "duplicate_media_upload",
        retryable: false,
      },
      state: "media-attached",
    },
    {
      name: "invalid-attempt-transition",
      expected: {
        status: 409,
        code: "invalid_attempt_transition",
        retryable: false,
      },
      state: "processing",
    },
    {
      name: "attempt-not-found",
      expected: { status: 404, code: "attempt_not_found", retryable: false },
      state: "wrong-owner-or-tombstoned",
    },
    {
      name: "queue-unavailable",
      expected: { status: 503, code: "queue_unavailable", retryable: true },
      state: "queue-not-ready-before-consume",
    },
    {
      name: "client-abort-before-commit",
      expected: { response: "none", attemptStatus: "awaiting-upload" },
      state: "aborted-before-commit",
    },
  ],
} as const);
