import type { LocalMediaProber } from "../storage/local-media-storage.js";
import type { MediaProcessRunner } from "./media-process-runner.js";
import {
  MediaPipelineError,
  parseFfprobePayload,
  type MediaProbe,
} from "./probe.js";

export type { MediaProcessRunner } from "./media-process-runner.js";

/** FFprobe adapter: argv only, bounded output, and no process output leaks. */
export class FfprobeMediaProber implements LocalMediaProber {
  private readonly runner: MediaProcessRunner;
  private readonly executable: string;
  private readonly timeoutMilliseconds: number;
  private readonly maxOutputBytes: number;

  public constructor(
    input: Readonly<{
      runner: MediaProcessRunner;
      executable?: string;
      timeoutMilliseconds?: number;
      maxOutputBytes?: number;
    }>,
  ) {
    this.runner = input.runner;
    this.executable = input.executable ?? "ffprobe";
    this.timeoutMilliseconds = input.timeoutMilliseconds ?? 8_000;
    this.maxOutputBytes = input.maxOutputBytes ?? 256 * 1024;
    if (
      !Number.isSafeInteger(this.timeoutMilliseconds) ||
      this.timeoutMilliseconds < 1
    )
      throw new Error("FFprobe timeout must be a positive safe integer.");
    if (!Number.isSafeInteger(this.maxOutputBytes) || this.maxOutputBytes < 2)
      throw new Error(
        "FFprobe output cap must be a safe integer of at least two.",
      );
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
        maxStdoutBytes: Math.floor((this.maxOutputBytes * 3) / 4),
        maxStderrBytes:
          this.maxOutputBytes - Math.floor((this.maxOutputBytes * 3) / 4),
        maxOutputBytes: this.maxOutputBytes,
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
