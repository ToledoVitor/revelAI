import type { LocalMediaProber } from "../storage/local-media-storage.js";
import {
  MediaPipelineError,
  parseFfprobePayload,
  type MediaProbe,
} from "./probe.js";

export interface MediaProcessRunner {
  run(
    command: Readonly<{
      executable: string;
      arguments: readonly string[];
      timeoutMilliseconds: number;
      maxOutputBytes: number;
    }>,
  ): Promise<
    Readonly<{
      exitCode: number;
      termination: "completed" | "timed_out" | "terminated";
      stdout: string;
      stderr: string;
    }>
  >;
}

/** FFprobe adapter: argv only, bounded output, and no process output leaks. */
export class FfprobeMediaProber implements LocalMediaProber {
  private readonly runner: MediaProcessRunner;
  private readonly executable: string;
  private readonly timeoutMilliseconds: number;

  public constructor(
    input: Readonly<{
      runner: MediaProcessRunner;
      executable?: string;
      timeoutMilliseconds?: number;
    }>,
  ) {
    this.runner = input.runner;
    this.executable = input.executable ?? "ffprobe";
    this.timeoutMilliseconds = input.timeoutMilliseconds ?? 8_000;
    if (
      !Number.isSafeInteger(this.timeoutMilliseconds) ||
      this.timeoutMilliseconds < 1
    )
      throw new Error("FFprobe timeout must be a positive safe integer.");
  }

  public async probe(
    input: Readonly<{
      filePath: string;
      magicContainer: "mp4" | "mov" | "webm";
    }>,
  ): Promise<MediaProbe> {
    let result: Readonly<{
      exitCode: number;
      termination: "completed" | "timed_out" | "terminated";
      stdout: string;
      stderr: string;
    }>;
    try {
      result = await this.runner.run({
        executable: this.executable,
        arguments: [
          "-v",
          "error",
          "-print_format",
          "json",
          "-show_format",
          "-show_streams",
          input.filePath,
        ],
        timeoutMilliseconds: this.timeoutMilliseconds,
        maxOutputBytes: 256 * 1024,
      });
    } catch {
      throw new MediaPipelineError("media_probe_failed");
    }
    if (result.exitCode !== 0 || result.termination !== "completed")
      throw new MediaPipelineError("media_probe_failed");
    const probe = parseFfprobePayload(result.stdout);
    const isoBmffAgreement =
      (probe.container === "mp4" || probe.container === "mov") &&
      (input.magicContainer === "mp4" || input.magicContainer === "mov");
    if (probe.container !== input.magicContainer && !isoBmffAgreement)
      throw new MediaPipelineError("media_container_not_allowed");
    return isoBmffAgreement
      ? Object.freeze({ ...probe, container: input.magicContainer })
      : probe;
  }
}
