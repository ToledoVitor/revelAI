import { describe, expect, it } from "vitest";
import {
  createStoredMediaAttachment,
  isStoredMediaAttachment,
  type StoredMedia,
  type StoredMediaAttachment,
} from "./attempt-repository.js";

const canonicalMedia: StoredMedia = Object.freeze({
  id: "11111111-1111-4111-8111-111111111111",
  contentType: "video/mp4",
  bytes: 16,
  uploadedAt: "2030-01-15T12:00:00.000Z",
  deleteAt: "2030-01-16T12:00:00.000Z",
  transition: Object.freeze({
    kind: "upload-transition" as const,
    resourceId: "11111111-1111-4111-8111-111111111111",
    deleteAt: "2030-01-15T13:00:00.000Z",
  }),
});

describe("StoredMediaAttachment capability", () => {
  it("rejects canonical-but-unbranded media at both the type and runtime boundaries", () => {
    // @ts-expect-error Only C5's factory can issue the opaque attachment brand.
    const unbrandedAttachment: StoredMediaAttachment = canonicalMedia;
    void unbrandedAttachment;
    expect(isStoredMediaAttachment(canonicalMedia)).toBe(false);

    const issued = createStoredMediaAttachment(canonicalMedia);
    expect(isStoredMediaAttachment(issued)).toBe(true);
    expect(JSON.stringify(issued)).toBe(JSON.stringify(canonicalMedia));
  });
});
