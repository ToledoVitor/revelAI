import { describe, expect, it } from "vitest";
import {
  MAX_MULTIPART_ENVELOPE_BYTES,
  MAX_UPLOAD_BYTES,
  mediaUploadFixtures,
  RouteErrorSchema,
  routeErrorFixtures,
} from "./index.js";

describe("shared upload transport fixtures", () => {
  it("documents the exact valid media part and byte limits", () => {
    expect(mediaUploadFixtures.accepted.status).toBe(202);
    expect(mediaUploadFixtures.accepted.request.parts).toStrictEqual([
      {
        kind: "file",
        fieldName: "media",
        filename: "attempt.mp4",
        declaredMime: "video/mp4",
        fileBytes: MAX_UPLOAD_BYTES,
      },
    ]);
    expect(mediaUploadFixtures.accepted.request.multipartBytes).toBe(
      MAX_MULTIPART_ENVELOPE_BYTES,
    );
  });

  it("contains deterministic negative fixtures for multipart and state failures", () => {
    expect(mediaUploadFixtures.rejected.map((fixture) => fixture.name)).toEqual(
      expect.arrayContaining([
        "missing-media-part",
        "repeated-media-part",
        "wrong-media-field-name",
        "extra-text-part",
        "filename-mime-mismatch",
        "media-byte-limit-exceeded",
        "multipart-envelope-limit-exceeded",
        "duplicate-media-upload",
        "invalid-attempt-transition",
        "attempt-not-found",
        "queue-unavailable",
        "client-abort-before-commit",
      ]),
    );
  });

  it("covers every typed route error with its safe retryability", () => {
    expect(routeErrorFixtures).toHaveLength(22);
    for (const fixture of routeErrorFixtures) {
      expect(RouteErrorSchema.safeParse(fixture.body).success).toBe(true);
      expect(fixture.body.message).not.toMatch(
        /\/(Users|tmp)|api[_ -]?key|authorization/i,
      );
    }
    expect(
      routeErrorFixtures.find(
        (fixture) => fixture.body.code === "media_too_large",
      ),
    ).toMatchObject({ status: 413, body: { retryable: false } });
    expect(
      routeErrorFixtures.find(
        (fixture) => fixture.body.code === "queue_unavailable",
      ),
    ).toMatchObject({ status: 503, body: { retryable: true } });
    expect(
      RouteErrorSchema.safeParse({
        code: "invalid_request",
        message: "Falha em /Users/athlete/video.mp4",
        retryable: false,
      }).success,
    ).toBe(false);
  });
});
