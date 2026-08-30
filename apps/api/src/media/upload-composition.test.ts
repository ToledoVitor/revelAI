import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalMediaStorage } from "../storage/local-media-storage.js";
import {
  acceptSingleMediaPart,
  RawMultipartByteCounter,
  type MultipartPart,
} from "./multipart-intake.js";
import { MediaPipelineError, type MediaProbe } from "./probe.js";

const mediaId = "11111111-1111-4111-8111-111111111111";
const mp4 = Buffer.from([
  0, 0, 0, 16, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 1, 2, 3, 4,
]);
const probe: MediaProbe = {
  container: "mp4",
  durationSeconds: 3,
  displayWidth: 480,
  displayHeight: 853,
  nominalFps: 12,
  codec: "h264",
  sourceRotationDegrees: 0,
};
const retention = {
  schedule: async () => ({ kind: "created" as const }),
  acknowledge: async () => undefined,
};
const retentionInput = {
  repository: retention,
  attemptId: "22222222-2222-4222-8222-222222222222",
  createdAt: "2030-01-15T12:00:00.000Z",
};

describe("media upload composition", () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  it("counts a chunked raw envelope, validates the staged upload, and publishes only after commit", async () => {
    const root = await mkdtemp(join(tmpdir(), "revelai-c5-composition-"));
    roots.push(root);
    const storage = new LocalMediaStorage({
      root,
      ids: { next: () => mediaId },
      prober: { probe: async () => probe },
    });
    const raw = new RawMultipartByteCounter(96);
    const parsedRaw: number[] = [];
    for await (const chunk of raw.stream(
      chunks(
        Buffer.from("--boundary\r\n"),
        mp4,
        Buffer.from("\r\n--boundary--"),
      ),
    ))
      parsedRaw.push(...chunk);

    const session = await storage.createUploadSession({
      maxBytes: mp4.length,
      retention: retentionInput,
    });
    const accepted = await acceptSingleMediaPart({
      parts: parts({
        kind: "file",
        name: "media",
        filename: "training.MP4",
        contentType: "video/mp4",
        body: chunks(mp4.subarray(0, 6), mp4.subarray(6)),
      }),
      maxUploadBytes: mp4.length,
      maxMultipartBytes: 96,
      rawBody: raw,
      createStage: async () => session,
    });
    expect(parsedRaw.length).toBeGreaterThan(mp4.length);
    expect(await readdir(join(root, "originals"))).toEqual([]);
    expect(accepted.stage).toBe(session);
    await expect(session.commit()).resolves.toMatchObject({
      id: mediaId,
      probe,
    });
    await expect(
      readFile(join(root, "originals", mediaId, "payload")),
    ).resolves.toEqual(mp4);
  });

  it("aborts the sole session when raw transport or multipart shape fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "revelai-c5-composition-"));
    roots.push(root);
    const storage = new LocalMediaStorage({
      root,
      ids: { next: () => mediaId },
      prober: { probe: async () => probe },
    });
    const raw = new RawMultipartByteCounter(3);
    await expect(
      (async () => {
        for await (const chunk of raw.stream(
          chunks(Buffer.from([1, 2]), Buffer.from([3, 4])),
        )) {
          // A real parser would receive these bytes; overflow stops before parsing later parts.
          void chunk;
        }
      })(),
    ).rejects.toThrow(new MediaPipelineError("multipart_body_too_large"));

    const session = await storage.createUploadSession({
      maxBytes: mp4.length,
      retention: retentionInput,
    });
    const validRaw = new RawMultipartByteCounter(96);
    validRaw.observe(Buffer.from([1]));
    await expect(
      acceptSingleMediaPart({
        parts: parts({
          kind: "field",
          name: "forbidden",
          body: chunks(Buffer.from([1])),
        }),
        maxUploadBytes: mp4.length,
        maxMultipartBytes: 96,
        rawBody: validRaw,
        createStage: async () => session,
      }),
    ).rejects.toThrow(new MediaPipelineError("multipart_extra_part_forbidden"));
    await session.abort();
    expect(await readdir(join(root, "temporary"))).toEqual([]);
    expect(await readdir(join(root, "originals"))).toEqual([]);
  });
});

async function* chunks(
  ...values: readonly Uint8Array[]
): AsyncIterable<Uint8Array> {
  yield* values;
}

async function* parts(
  ...values: readonly MultipartPart[]
): AsyncIterable<MultipartPart> {
  yield* values;
}
