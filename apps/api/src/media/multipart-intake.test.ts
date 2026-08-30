import { describe, expect, it } from "vitest";
import { MediaPipelineError } from "./probe.js";
import {
  acceptSingleMediaPart,
  type MultipartPart,
} from "./multipart-intake.js";

describe("framework-neutral multipart intake", () => {
  it("accepts exactly one case-insensitive filename/MIME pair after MIME parameters", async () => {
    const staged = new MemoryStage();
    await expect(
      acceptSingleMediaPart({
        parts: parts(
          file("media", "WALL.MP4", "Video/MP4; charset=binary", [
            Buffer.from([1, 2]),
          ]),
        ),
        maxUploadBytes: 2,
        maxMultipartBytes: 9,
        measuredMultipartBytes: 9,
        createStage: async () => staged,
      }),
    ).resolves.toEqual({ filenameExtension: "mp4", bytes: 2, stage: staged });
    expect(staged.bytes).toEqual([1, 2]);
  });

  it("rejects missing, repeated, wrong-name, text, and extra parts while aborting staged bytes", async () => {
    for (const supplied of [
      [],
      [file("other", "x.mp4", "video/mp4", [Buffer.from([1])])],
      [
        file("media", "x.mp4", "video/mp4", [Buffer.from([1])]),
        file("media", "y.mp4", "video/mp4", [Buffer.from([2])]),
      ],
      [
        file("media", "x.mp4", "video/mp4", [Buffer.from([1])]),
        field("note", [Buffer.from([2])]),
      ],
    ]) {
      const staged = new MemoryStage();
      await expect(
        acceptSingleMediaPart({
          parts: parts(...supplied),
          maxUploadBytes: 2,
          maxMultipartBytes: 8,
          measuredMultipartBytes: 8,
          createStage: async () => staged,
        }),
      ).rejects.toBeInstanceOf(MediaPipelineError);
      expect(staged.aborted).toBe(
        supplied[0]?.kind === "file" && supplied[0].name === "media",
      );
    }
  });

  it("enforces exact file and independent envelope limits despite false or missing length", async () => {
    const exact = new MemoryStage();
    await expect(
      acceptSingleMediaPart({
        parts: parts(
          file("media", "x.webm", "video/webm", [
            Buffer.from([1]),
            Buffer.from([2]),
          ]),
        ),
        maxUploadBytes: 2,
        maxMultipartBytes: 3,
        measuredMultipartBytes: 3,
        declaredContentLength: 1,
        createStage: async () => exact,
      }),
    ).resolves.toMatchObject({ bytes: 2 });
    for (const input of [
      { measuredMultipartBytes: 4, chunks: [Buffer.from([1])], aborts: false },
      {
        measuredMultipartBytes: 3,
        chunks: [Buffer.from([1]), Buffer.from([2]), Buffer.from([3])],
        aborts: true,
      },
    ]) {
      const staged = new MemoryStage();
      await expect(
        acceptSingleMediaPart({
          parts: parts(file("media", "x.webm", "video/webm", input.chunks)),
          maxUploadBytes: 2,
          maxMultipartBytes: 3,
          measuredMultipartBytes: input.measuredMultipartBytes,
          createStage: async () => staged,
        }),
      ).rejects.toBeInstanceOf(MediaPipelineError);
      expect(staged.aborted).toBe(input.aborts);
    }
  });

  it("rejects empty bodies and incorrect extension/MIME pair before a stage exists", async () => {
    const stage = new MemoryStage();
    await expect(
      acceptSingleMediaPart({
        parts: parts(file("media", "x.mov", "video/mp4", [Buffer.from([1])])),
        maxUploadBytes: 1,
        maxMultipartBytes: 2,
        measuredMultipartBytes: 2,
        createStage: async () => stage,
      }),
    ).rejects.toThrow(new MediaPipelineError("media_filename_mime_mismatch"));
    expect(stage.aborted).toBe(false);
    await expect(
      acceptSingleMediaPart({
        parts: parts(file("media", "x.mov", "video/quicktime", [])),
        maxUploadBytes: 1,
        maxMultipartBytes: 2,
        measuredMultipartBytes: 2,
        createStage: async () => stage,
      }),
    ).rejects.toThrow(new MediaPipelineError("media_empty"));
  });
});

class MemoryStage {
  public readonly bytes: number[] = [];
  public aborted = false;

  public async write(chunk: Uint8Array): Promise<void> {
    this.bytes.push(...chunk);
  }

  public async abort(): Promise<void> {
    this.aborted = true;
  }
}

function file(
  name: string,
  filename: string,
  contentType: string,
  chunks: readonly Uint8Array[],
): MultipartPart {
  return { kind: "file", name, filename, contentType, body: chunks };
}

function field(name: string, chunks: readonly Uint8Array[]): MultipartPart {
  return { kind: "field", name, body: chunks };
}

async function* parts(
  ...values: readonly MultipartPart[]
): AsyncIterable<MultipartPart> {
  yield* values;
}
