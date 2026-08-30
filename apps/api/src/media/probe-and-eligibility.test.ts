import { describe, expect, it } from "vitest";
import {
  MediaPipelineError,
  parseFfprobePayload,
  sniffMediaContainer,
} from "./probe.js";
import {
  evaluateMediaEligibility,
  freeSampleTimestamps,
} from "./eligibility.js";

const verifiedProbe = {
  container: "mp4" as const,
  durationSeconds: 64,
  displayWidth: 1280,
  displayHeight: 720,
  nominalFps: 30,
  codec: "h264",
};

describe("media sniffing and probe boundary", () => {
  it("recognizes split-safe MP4, MOV, and WebM magic without trusting filenames", () => {
    expect(
      sniffMediaContainer(
        Buffer.from([
          0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d,
        ]),
      ),
    ).toBe("mp4");
    expect(
      sniffMediaContainer(
        Buffer.from([
          0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x71, 0x74, 0x20, 0x20,
        ]),
      ),
    ).toBe("mov");
    expect(
      sniffMediaContainer(
        Buffer.from([
          0x1a, 0x45, 0xdf, 0xa3, 0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d,
        ]),
      ),
    ).toBe("webm");
  });

  it("rejects truncated or unsupported magic with a safe container category", () => {
    expect(() => sniffMediaContainer(Buffer.from([0, 0, 0, 24, 0x66]))).toThrow(
      new MediaPipelineError("media_container_not_allowed"),
    );
    expect(() => sniffMediaContainer(Buffer.from("not video"))).toThrow(
      new MediaPipelineError("media_container_not_allowed"),
    );
  });

  it("parses one rotated decodable video stream and applies display rotation", () => {
    expect(
      parseFfprobePayload(
        JSON.stringify({
          format: { format_name: "mov,mp4,m4a,3gp,3g2,mj2", duration: "64" },
          streams: [
            {
              codec_type: "video",
              codec_name: "h264",
              width: 720,
              height: 1280,
              avg_frame_rate: "30000/1001",
              tags: { rotate: "90" },
              disposition: { attached_pic: 0 },
            },
          ],
        }),
      ),
    ).toEqual({ ...verifiedProbe, nominalFps: 30000 / 1001 });
  });

  it("rejects malformed, multi-video, attached-picture, encrypted, and mismatched containers", () => {
    expect(() => parseFfprobePayload("{")).toThrow(
      new MediaPipelineError("media_probe_failed"),
    );
    for (const stream of [
      [baseVideoStream(), baseVideoStream()],
      [{ ...baseVideoStream(), disposition: { attached_pic: 1 } }],
      [{ ...baseVideoStream(), codec_name: "mystery" }],
      [{ ...baseVideoStream(), encryption: "cenc" }],
    ]) {
      expect(() =>
        parseFfprobePayload(
          JSON.stringify({
            format: { format_name: "mov,mp4,m4a,3gp,3g2,mj2", duration: "64" },
            streams: stream,
          }),
        ),
      ).toThrow(new MediaPipelineError("media_probe_failed"));
    }
  });
});

describe("mode-owned media eligibility", () => {
  it("accepts verified boundaries with exact 40/600 decoded timestamps", () => {
    expect(
      evaluateMediaEligibility({
        mode: "verified",
        probe: verifiedProbe,
        timestamps: verifiedTimeline(),
        activeSceneChangeScores: [0.419],
      }),
    ).toEqual({ kind: "eligible", sampleCount: 640 });
  });

  it("rejects verified duration, display, fps, continuity, and active cuts at boundaries", () => {
    for (const input of [
      { probe: { ...verifiedProbe, durationSeconds: 63.999 } },
      { probe: { ...verifiedProbe, displayWidth: 1279 } },
      { probe: { ...verifiedProbe, displayHeight: 721, displayWidth: 721 } },
      { probe: { ...verifiedProbe, nominalFps: 23.999 } },
      {
        timestamps: verifiedTimeline().map((value, index) =>
          index === 41 ? value + 0.251 : value,
        ),
      },
      { activeSceneChangeScores: [0.42] },
    ]) {
      expect(
        evaluateMediaEligibility({
          mode: "verified",
          probe: input.probe ?? verifiedProbe,
          timestamps: input.timestamps ?? verifiedTimeline(),
          activeSceneChangeScores: input.activeSceneChangeScores ?? [],
        }),
      ).toEqual({ kind: "ineligible" });
    }
  });

  it("accepts Free portrait without verified calibration or continuity requirements", () => {
    const probe = {
      container: "webm" as const,
      durationSeconds: 3,
      displayWidth: 480,
      displayHeight: 853,
      nominalFps: 12,
      codec: "vp9",
    };
    expect(evaluateMediaEligibility({ mode: "free", probe })).toEqual({
      kind: "eligible",
      sampleCount: 12,
    });
    expect(freeSampleTimestamps(3)).toEqual([
      0,
      3 / 11,
      (3 * 2) / 11,
      (3 * 3) / 11,
      (3 * 4) / 11,
      (3 * 5) / 11,
      (3 * 6) / 11,
      (3 * 7) / 11,
      (3 * 8) / 11,
      (3 * 9) / 11,
      (3 * 10) / 11,
      3,
    ]);
  });

  it("holds Free duration, short-edge, and fps boundaries", () => {
    for (const probe of [
      {
        ...verifiedProbe,
        durationSeconds: 2.999,
        displayWidth: 480,
        displayHeight: 700,
        nominalFps: 12,
      },
      {
        ...verifiedProbe,
        durationSeconds: 180.001,
        displayWidth: 480,
        displayHeight: 700,
        nominalFps: 12,
      },
      {
        ...verifiedProbe,
        durationSeconds: 3,
        displayWidth: 479,
        displayHeight: 700,
        nominalFps: 12,
      },
      {
        ...verifiedProbe,
        durationSeconds: 3,
        displayWidth: 480,
        displayHeight: 700,
        nominalFps: 11.999,
      },
    ]) {
      expect(evaluateMediaEligibility({ mode: "free", probe })).toEqual({
        kind: "ineligible",
      });
    }
    expect(freeSampleTimestamps(180)).toHaveLength(180);
  });
});

function baseVideoStream() {
  return {
    codec_type: "video",
    codec_name: "h264",
    width: 1280,
    height: 720,
    avg_frame_rate: "30/1",
    disposition: { attached_pic: 0 },
  };
}

function verifiedTimeline(): number[] {
  return Array.from({ length: 640 }, (_, index) => index / 10);
}
