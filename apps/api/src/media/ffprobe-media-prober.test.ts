import { describe, expect, it } from "vitest";
import { FfprobeMediaProber } from "./ffprobe-media-prober.js";
import { MediaPipelineError } from "./probe.js";

describe("FfprobeMediaProber", () => {
  it("uses bounded argv without shell interpolation and parses strict JSON", async () => {
    const calls: unknown[] = [];
    const prober = new FfprobeMediaProber({
      runner: {
        run: async (command) => {
          calls.push(command);
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              format: {
                format_name: "mov,mp4,m4a,3gp,3g2,mj2",
                duration: "64",
              },
              streams: [
                {
                  codec_type: "video",
                  codec_name: "h264",
                  width: 1280,
                  height: 720,
                  avg_frame_rate: "30/1",
                  disposition: { attached_pic: 0 },
                },
              ],
            }),
            stderr: "private /storage/path is deliberately ignored",
          };
        },
      },
      executable: "ffprobe",
      timeoutMilliseconds: 7000,
    });

    await expect(
      prober.probe({
        filePath: "/private/path;rm -rf nope",
        magicContainer: "mp4",
      }),
    ).resolves.toMatchObject({ container: "mp4", displayWidth: 1280 });
    expect(calls).toEqual([
      {
        executable: "ffprobe",
        arguments: [
          "-v",
          "error",
          "-print_format",
          "json",
          "-show_format",
          "-show_streams",
          "/private/path;rm -rf nope",
        ],
        timeoutMilliseconds: 7000,
        maxOutputBytes: 262144,
      },
    ]);
  });

  it("maps process failure, timeout, and magic/probe disagreement to safe categories", async () => {
    for (const result of [
      { exitCode: 1, stdout: "", stderr: "/private/a" },
      { exitCode: 0, stdout: "{}", stderr: "" },
    ]) {
      const prober = new FfprobeMediaProber({
        runner: { run: async () => result },
      });
      await expect(
        prober.probe({ filePath: "/private/a", magicContainer: "mp4" }),
      ).rejects.toThrow(new MediaPipelineError("media_probe_failed"));
    }
    const mismatch = new FfprobeMediaProber({
      runner: {
        run: async () => ({
          exitCode: 0,
          stdout: JSON.stringify({
            format: { format_name: "webm", duration: "64" },
            streams: [
              {
                codec_type: "video",
                codec_name: "vp9",
                width: 1280,
                height: 720,
                avg_frame_rate: "30/1",
                disposition: { attached_pic: 0 },
              },
            ],
          }),
          stderr: "",
        }),
      },
    });
    await expect(
      mismatch.probe({ filePath: "/private/a", magicContainer: "mp4" }),
    ).rejects.toThrow(new MediaPipelineError("media_container_not_allowed"));
  });
});
