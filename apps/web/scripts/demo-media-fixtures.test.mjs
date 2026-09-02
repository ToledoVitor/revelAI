import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createDemoMediaFixtures } from "./demo-media-fixtures.mjs";

test("generates and probes C10-compatible portrait and verified fixtures", async () => {
  const directory = await mkdtemp(join(tmpdir(), "revelai-demo-media-test-"));
  const commands = [];
  try {
    const fixtures = await createDemoMediaFixtures({
      directory,
      run: async ({ executable, arguments: args }) => {
        commands.push({ executable, arguments: args });
        if (executable === "ffprobe") {
          const verified = args.at(-1)?.endsWith("verified-landscape.mp4");
          return {
            exitCode: 0,
            stderr: "",
            stdout: JSON.stringify({
              format: { duration: verified ? "64.000000" : "3.000000" },
              streams: [
                {
                  codec_type: "video",
                  width: verified ? 1280 : 720,
                  height: verified ? 720 : 1280,
                  avg_frame_rate: "24/1",
                },
              ],
            }),
          };
        }
        return { exitCode: 0, stderr: "", stdout: "" };
      },
    });

    assert.deepEqual(
      fixtures.map((fixture) => fixture.kind),
      ["free-portrait", "verified-landscape"],
    );
    assert.deepEqual(
      fixtures.map((fixture) => fixture.probe),
      [
        { durationSeconds: 3, width: 720, height: 1280, fps: 24 },
        { durationSeconds: 64, width: 1280, height: 720, fps: 24 },
      ],
    );
    assert.equal(
      commands.filter((command) => command.executable === "ffmpeg").length,
      2,
    );
    assert.equal(
      commands.filter((command) => command.executable === "ffprobe").length,
      2,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
