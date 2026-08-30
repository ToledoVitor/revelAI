import { describe, expect, it } from "vitest";
import {
  MAX_MULTIPART_ENVELOPE_BYTES,
  MAX_UPLOAD_BYTES,
  MediaUploadFixtureDescriptorSchema,
  MediaUploadPartSchema,
  mediaFilenameMimeFixtures,
  mediaUploadFixtures,
  RouteErrorSchema,
  routeErrorFixtures,
} from "./index.js";

describe("shared upload transport fixtures", () => {
  it("provides a complete, typed wire/state descriptor for the accepted upload", () => {
    const fixture = mediaUploadFixtures.accepted;

    expect(MediaUploadFixtureDescriptorSchema.parse(fixture)).toStrictEqual(
      fixture,
    );
    expect(fixture.expected).toMatchObject({ kind: "accepted", status: 202 });
    expect(fixture.request.parts).toStrictEqual([
      {
        kind: "file",
        fieldName: "media",
        filename: "attempt.mp4",
        declaredMime: "video/mp4",
        fileBytes: MAX_UPLOAD_BYTES,
      },
    ]);
    expect(fixture.request.multipartBytes).toBe(MAX_MULTIPART_ENVELOPE_BYTES);
    expect(fixture.postcondition).toStrictEqual({
      attemptStatus: "uploaded",
      mediaAttached: true,
      responseCommitted: true,
    });
  });

  it("covers each multipart, authorization, state, queue, and cancellation branch", () => {
    const names = mediaUploadFixtures.rejected.map((fixture) => fixture.name);
    expect(new Set(names)).toHaveLength(names.length);
    expect(names).toEqual(
      expect.arrayContaining([
        "missing-media-part",
        "zero-byte-media",
        "repeated-media-part",
        "wrong-file-field-name",
        "extra-file-part",
        "extra-text-part",
        "filename-mime-mismatch",
        "media-byte-limit-exceeded",
        "multipart-envelope-limit-exceeded",
        "container-not-allowed",
        "probe-failed",
        "media-requirements-not-met",
        "attempt-not-found",
        "attempt-owned-by-another-athlete",
        "duplicate-media-upload",
        "invalid-attempt-transition",
        "queue-unavailable-before-body",
        "queue-enqueue-failed-after-attach-rolls-back",
        "client-abort-before-commit",
        "client-cancellation-after-commit-keeps-accepted-state",
      ]),
    );

    for (const fixture of mediaUploadFixtures.rejected) {
      expect(MediaUploadFixtureDescriptorSchema.parse(fixture)).toStrictEqual(
        fixture,
      );
      if (fixture.expected.kind === "route-error") {
        expect(RouteErrorSchema.parse(fixture.expected.body)).toStrictEqual(
          fixture.expected.body,
        );
      }
    }

    expect(
      mediaUploadFixtures.rejected.find(
        (fixture) =>
          fixture.name === "queue-enqueue-failed-after-attach-rolls-back",
      )?.postcondition,
    ).toStrictEqual({
      attemptStatus: "awaiting-upload",
      mediaAttached: false,
      responseCommitted: false,
    });
    expect(
      mediaUploadFixtures.rejected.find(
        (fixture) => fixture.name === "client-abort-before-commit",
      )?.expected,
    ).toStrictEqual({ kind: "no-response" });
  });

  it("normalizes accepted MIME metadata and rejects non-matching wire media", () => {
    for (const fixture of mediaFilenameMimeFixtures.accepted) {
      expect(
        MediaUploadPartSchema.safeParse({
          kind: "file",
          fieldName: "media",
          fileBytes: 1,
          ...fixture,
        }).success,
      ).toBe(true);
    }
    for (const fixture of mediaFilenameMimeFixtures.rejected) {
      expect(
        MediaUploadPartSchema.safeParse({
          kind: "file",
          fieldName: "media",
          fileBytes: 1,
          ...fixture,
        }).success,
      ).toBe(false);
    }
  });

  it("is deeply frozen so consumers cannot mutate shared transport fixtures", () => {
    expect(Object.isFrozen(mediaUploadFixtures)).toBe(true);
    expect(Object.isFrozen(mediaUploadFixtures.accepted.request.parts)).toBe(
      true,
    );
    expect(Object.isFrozen(mediaUploadFixtures.rejected[0])).toBe(true);
  });

  it("covers every typed route error with its allowlisted retryability", () => {
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
