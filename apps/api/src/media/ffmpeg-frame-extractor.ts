import {
  createExtractionManifest,
  type ExtractedFrame,
  type ExtractionManifest,
} from "./extraction-manifest.js";
import { freeSampleTimestamps } from "./eligibility.js";
import { MediaPipelineError, type MediaProbe } from "./probe.js";

export interface FrameExtractionRunner {
  extract(
    command: Readonly<{
      executable: string;
      arguments: readonly string[];
      timeoutMilliseconds: number;
    }>,
  ): Promise<readonly ExtractedFrame[]>;
}

/** FFmpeg invocation boundary. Runner owns frame-file staging and cleanup. */
export class FfmpegFrameExtractor {
  private readonly runner: FrameExtractionRunner;
  private readonly executable: string;
  private readonly timeoutMilliseconds: number;

  public constructor(
    input: Readonly<{
      runner: FrameExtractionRunner;
      executable?: string;
      timeoutMilliseconds?: number;
    }>,
  ) {
    this.runner = input.runner;
    this.executable = input.executable ?? "ffmpeg";
    this.timeoutMilliseconds = input.timeoutMilliseconds ?? 30_000;
  }

  public async extract(
    input: Readonly<{
      mode: "free" | "verified";
      attemptId: string;
      generation: number;
      mediaId: string;
      mediaSha256: string;
      privateMediaPath: string;
      probe: MediaProbe;
    }>,
  ): Promise<ExtractionManifest> {
    try {
      const expectedCount =
        input.mode === "verified"
          ? 640
          : freeSampleTimestamps(input.probe.durationSeconds).length;
      const frames = await this.runner.extract({
        executable: this.executable,
        arguments: [
          "-v",
          "error",
          "-i",
          input.privateMediaPath,
          "-vf",
          input.mode === "verified" ? "fps=10" : "fps=2",
          "-frames:v",
          String(expectedCount),
        ],
        timeoutMilliseconds: this.timeoutMilliseconds,
      });
      return createExtractionManifest({ ...input, frames });
    } catch (error) {
      if (error instanceof MediaPipelineError) throw error;
      throw new MediaPipelineError("media_probe_failed");
    }
  }
}
