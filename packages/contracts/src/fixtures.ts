import { z } from "zod";
import {
  AttemptStatusSchema,
  MAX_MULTIPART_ENVELOPE_BYTES,
  MAX_UPLOAD_BYTES,
  MediaUploadAcceptedSchema,
} from "./attempts.js";
import {
  RouteErrorCodes,
  RouteErrorMessageByCode,
  RouteErrorRetryabilityByCode,
  RouteErrorSchema,
  RouteErrorStatusByCode,
  type RouteErrorCode,
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

export const routeErrorFixtures = deepFreeze(
  RouteErrorCodes.map((code) => ({
    status: RouteErrorStatusByCode[code],
    body: RouteErrorSchema.parse({
      code,
      message: RouteErrorMessageByCode[code],
      retryable: RouteErrorRetryabilityByCode[code],
    }),
  })),
);

export const MediaUploadWirePartFixtureSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("file"),
      fieldName: z.string(),
      filename: z.string(),
      declaredMime: z.string(),
      fileBytes: z.number().int().min(0),
    })
    .strict(),
  z
    .object({
      kind: z.literal("text"),
      fieldName: z.string(),
      value: z.string(),
    })
    .strict(),
]);

export const MediaUploadWireRequestDescriptorSchema = z
  .object({
    headers: z
      .object({
        "x-revelai-athlete-id": z.string().uuid(),
        "content-type": z.literal("multipart/form-data"),
      })
      .strict(),
    parts: z.array(MediaUploadWirePartFixtureSchema),
    multipartBytes: z.number().int().min(0),
  })
  .strict();

export const MediaUploadAttemptStateSchema = z
  .object({
    exists: z.boolean(),
    owned: z.boolean(),
    status: AttemptStatusSchema,
    mediaAttached: z.boolean(),
    queueAvailable: z.boolean(),
    commitState: z.enum([
      "before-body",
      "before-commit",
      "after-commit",
      "enqueue-failed-after-attach",
    ]),
  })
  .strict();

export const MediaUploadExpectedSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("accepted"),
      status: z.literal(202),
      body: MediaUploadAcceptedSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("route-error"),
      status: z.number().int().min(400).max(599),
      body: RouteErrorSchema,
    })
    .strict(),
  z.object({ kind: z.literal("no-response") }).strict(),
]);

export const MediaUploadPostconditionSchema = z
  .object({
    attemptStatus: AttemptStatusSchema,
    mediaAttached: z.boolean(),
    responseCommitted: z.boolean(),
  })
  .strict();

export const MediaUploadFixtureDescriptorSchema = z
  .object({
    name: z.string().min(1),
    request: MediaUploadWireRequestDescriptorSchema,
    attempt: MediaUploadAttemptStateSchema,
    expected: MediaUploadExpectedSchema,
    postcondition: MediaUploadPostconditionSchema,
  })
  .strict();

function expectedRouteError(code: RouteErrorCode) {
  return {
    kind: "route-error" as const,
    status: RouteErrorStatusByCode[code],
    body: {
      code,
      message: RouteErrorMessageByCode[code],
      retryable: RouteErrorRetryabilityByCode[code],
    },
  };
}

const athleteHeaders = {
  "x-revelai-athlete-id": "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
  "content-type": "multipart/form-data",
} as const;
const validMediaPart = {
  kind: "file",
  fieldName: "media",
  filename: "attempt.mp4",
  declaredMime: "video/mp4",
  fileBytes: MAX_UPLOAD_BYTES,
} as const;
const awaitingUploadState = {
  exists: true,
  owned: true,
  status: "awaiting-upload",
  mediaAttached: false,
  queueAvailable: true,
  commitState: "before-body",
} as const;
const unchangedPostcondition = {
  attemptStatus: "awaiting-upload",
  mediaAttached: false,
  responseCommitted: false,
} as const;
const regularRequest = {
  headers: athleteHeaders,
  parts: [validMediaPart],
  multipartBytes: MAX_UPLOAD_BYTES,
} as const;
const acceptedExpected = {
  kind: "accepted",
  status: 202,
  body: {
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
} as const;

const acceptedUploadFixture = {
  name: "exactly-one-media-file-at-the-byte-limit",
  request: { ...regularRequest, multipartBytes: MAX_MULTIPART_ENVELOPE_BYTES },
  attempt: awaitingUploadState,
  expected: acceptedExpected,
  postcondition: {
    attemptStatus: "uploaded",
    mediaAttached: true,
    responseCommitted: true,
  },
} as const;

const rejectedUploadFixtures = [
  {
    name: "missing-media-part",
    request: { headers: athleteHeaders, parts: [], multipartBytes: 1 },
    attempt: awaitingUploadState,
    expected: expectedRouteError("media_part_missing"),
    postcondition: unchangedPostcondition,
  },
  {
    name: "zero-byte-media",
    request: {
      ...regularRequest,
      parts: [{ ...validMediaPart, fileBytes: 0 }],
    },
    attempt: awaitingUploadState,
    expected: expectedRouteError("media_empty"),
    postcondition: unchangedPostcondition,
  },
  {
    name: "repeated-media-part",
    request: {
      ...regularRequest,
      parts: [validMediaPart, { ...validMediaPart, filename: "retry.mp4" }],
      multipartBytes: MAX_MULTIPART_ENVELOPE_BYTES,
    },
    attempt: awaitingUploadState,
    expected: expectedRouteError("media_part_count_invalid"),
    postcondition: unchangedPostcondition,
  },
  {
    name: "wrong-file-field-name",
    request: {
      ...regularRequest,
      parts: [{ ...validMediaPart, fieldName: "video" }],
    },
    attempt: awaitingUploadState,
    expected: expectedRouteError("multipart_extra_part_forbidden"),
    postcondition: unchangedPostcondition,
  },
  {
    name: "extra-file-part",
    request: {
      ...regularRequest,
      parts: [
        validMediaPart,
        {
          kind: "file",
          fieldName: "thumbnail",
          filename: "thumb.mp4",
          declaredMime: "video/mp4",
          fileBytes: 1,
        },
      ],
    },
    attempt: awaitingUploadState,
    expected: expectedRouteError("multipart_extra_part_forbidden"),
    postcondition: unchangedPostcondition,
  },
  {
    name: "extra-text-part",
    request: {
      ...regularRequest,
      parts: [
        validMediaPart,
        { kind: "text", fieldName: "comment", value: "x" },
      ],
    },
    attempt: awaitingUploadState,
    expected: expectedRouteError("multipart_extra_part_forbidden"),
    postcondition: unchangedPostcondition,
  },
  {
    name: "filename-mime-mismatch",
    request: {
      ...regularRequest,
      parts: [{ ...validMediaPart, declaredMime: "video/webm" }],
    },
    attempt: awaitingUploadState,
    expected: expectedRouteError("media_filename_mime_mismatch"),
    postcondition: unchangedPostcondition,
  },
  {
    name: "media-byte-limit-exceeded",
    request: {
      ...regularRequest,
      parts: [{ ...validMediaPart, fileBytes: MAX_UPLOAD_BYTES + 1 }],
    },
    attempt: awaitingUploadState,
    expected: expectedRouteError("media_too_large"),
    postcondition: unchangedPostcondition,
  },
  {
    name: "multipart-envelope-limit-exceeded",
    request: {
      ...regularRequest,
      multipartBytes: MAX_MULTIPART_ENVELOPE_BYTES + 1,
    },
    attempt: awaitingUploadState,
    expected: expectedRouteError("multipart_body_too_large"),
    postcondition: unchangedPostcondition,
  },
  {
    name: "container-not-allowed",
    request: regularRequest,
    attempt: { ...awaitingUploadState, commitState: "before-commit" },
    expected: expectedRouteError("media_container_not_allowed"),
    postcondition: unchangedPostcondition,
  },
  {
    name: "probe-failed",
    request: regularRequest,
    attempt: { ...awaitingUploadState, commitState: "before-commit" },
    expected: expectedRouteError("media_probe_failed"),
    postcondition: unchangedPostcondition,
  },
  {
    name: "media-requirements-not-met",
    request: regularRequest,
    attempt: { ...awaitingUploadState, commitState: "before-commit" },
    expected: expectedRouteError("media_requirements_not_met"),
    postcondition: unchangedPostcondition,
  },
  {
    name: "attempt-not-found",
    request: regularRequest,
    attempt: { ...awaitingUploadState, exists: false },
    expected: expectedRouteError("attempt_not_found"),
    postcondition: unchangedPostcondition,
  },
  {
    name: "attempt-owned-by-another-athlete",
    request: regularRequest,
    attempt: { ...awaitingUploadState, owned: false },
    expected: expectedRouteError("attempt_not_found"),
    postcondition: unchangedPostcondition,
  },
  {
    name: "duplicate-media-upload",
    request: regularRequest,
    attempt: { ...awaitingUploadState, mediaAttached: true },
    expected: expectedRouteError("duplicate_media_upload"),
    postcondition: { ...unchangedPostcondition, mediaAttached: true },
  },
  {
    name: "invalid-attempt-transition",
    request: regularRequest,
    attempt: { ...awaitingUploadState, status: "processing" },
    expected: expectedRouteError("invalid_attempt_transition"),
    postcondition: { ...unchangedPostcondition, attemptStatus: "processing" },
  },
  {
    name: "queue-unavailable-before-body",
    request: regularRequest,
    attempt: { ...awaitingUploadState, queueAvailable: false },
    expected: expectedRouteError("queue_unavailable"),
    postcondition: unchangedPostcondition,
  },
  {
    name: "queue-enqueue-failed-after-attach-rolls-back",
    request: regularRequest,
    attempt: {
      ...awaitingUploadState,
      commitState: "enqueue-failed-after-attach",
    },
    expected: expectedRouteError("queue_unavailable"),
    postcondition: unchangedPostcondition,
  },
  {
    name: "client-abort-before-commit",
    request: regularRequest,
    attempt: { ...awaitingUploadState, commitState: "before-commit" },
    expected: { kind: "no-response" },
    postcondition: unchangedPostcondition,
  },
  {
    name: "client-cancellation-after-commit-keeps-accepted-state",
    request: regularRequest,
    attempt: { ...awaitingUploadState, commitState: "after-commit" },
    expected: acceptedExpected,
    postcondition: {
      attemptStatus: "uploaded",
      mediaAttached: true,
      responseCommitted: true,
    },
  },
] as const;

export const mediaUploadFixtures = deepFreeze({
  accepted: MediaUploadFixtureDescriptorSchema.parse(acceptedUploadFixture),
  rejected: rejectedUploadFixtures.map((fixture) =>
    MediaUploadFixtureDescriptorSchema.parse(fixture),
  ),
});

export const mediaFilenameMimeFixtures = deepFreeze({
  accepted: [
    { filename: "attempt.mp4", declaredMime: "video/mp4" },
    {
      filename: "ATTEMPT.MOV",
      declaredMime: "Video/QuickTime; charset=binary",
    },
    { filename: "attempt.webm", declaredMime: "video/webm; codecs=vp9" },
  ],
  rejected: [
    { filename: "attempt.mp4", declaredMime: "video/webm" },
    { filename: "attempt.mov", declaredMime: "video/mp4" },
    { filename: "attempt.webm", declaredMime: "video/quicktime" },
    { filename: "attempt.avi", declaredMime: "video/mp4" },
  ],
} as const);

export type MediaUploadWirePartFixture = z.infer<
  typeof MediaUploadWirePartFixtureSchema
>;
export type MediaUploadWireRequestDescriptor = z.infer<
  typeof MediaUploadWireRequestDescriptorSchema
>;
export type MediaUploadAttemptState = z.infer<
  typeof MediaUploadAttemptStateSchema
>;
export type MediaUploadExpected = z.infer<typeof MediaUploadExpectedSchema>;
export type MediaUploadPostcondition = z.infer<
  typeof MediaUploadPostconditionSchema
>;
export type MediaUploadFixtureDescriptor = z.infer<
  typeof MediaUploadFixtureDescriptorSchema
>;
