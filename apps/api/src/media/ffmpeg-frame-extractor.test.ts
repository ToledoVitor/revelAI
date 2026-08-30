import { describe, expect, it } from "vitest";
import { FfmpegFrameExtractor } from "./ffmpeg-frame-extractor.js";
import { MediaPipelineError } from "./probe.js";

const attemptId = "11111111-1111-4111-8111-111111111111";
const mediaId = "22222222-2222-4222-8222-222222222222";
const probe = {
  container: "mp4" as const,
  durationSeconds: 64,
  displayWidth: 1280,
  displayHeight: 720,
  nominalFps: 30,
  codec: "h264",
};

describe("FfmpegFrameExtractor", () => {
  it("passes a fixed argv extraction plan to an injected runner and produces a path-free verified manifest", async () => {
    const calls: unknown[] = [];
    const extractor = new FfmpegFrameExtractor({
      runner: {
        extract: async (command) => {
          calls.push(command);
          return verifiedFrames();
        },
      },
    });
    const manifest = await extractor.extract({
      mode: "verified",
      attemptId,
      generation: 1,
      mediaId,
      mediaSha256: "a".repeat(64),
      privateMediaPath: "/private/video.mp4",
      probe,
    });
    expect(manifest).toMatchObject({
      mode: "verified",
      preRoll: { count: 40 },
      active: { count: 600 },
    });
    expect(calls).toEqual([
      {
        executable: "ffmpeg",
        arguments: [
          "-v",
          "error",
          "-i",
          "/private/video.mp4",
          "-vf",
          "fps=10",
          "-frames:v",
          "640",
        ],
        timeoutMilliseconds: 30000,
      },
    ]);
    expect(JSON.stringify(manifest)).not.toContain("private");
  });

  it("maps runner and partial frame failures to a safe probe category", async () => {
    const extractor = new FfmpegFrameExtractor({
      runner: { extract: async () => verifiedFrames().slice(0, 5) },
    });
    await expect(
      extractor.extract({
        mode: "verified",
        attemptId,
        generation: 1,
        mediaId,
        mediaSha256: "a".repeat(64),
        privateMediaPath: "/private/video.mp4",
        probe,
      }),
    ).rejects.toThrow(new MediaPipelineError("media_probe_failed"));
  });
});

function verifiedFrames() {
  return Array.from({ length: 640 }, (_, index) => ({
    timestampSeconds: index / 10,
    reference: `frame-${String(index).padStart(4, "0")}`,
    rawBytes: Uint8Array.of(index % 256),
  }));
}
