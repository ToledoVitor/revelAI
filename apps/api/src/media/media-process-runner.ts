export type MediaProcessCommand = Readonly<{
  executable: string;
  arguments: readonly string[];
  timeoutMilliseconds: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
  maxOutputBytes: number;
}>;

export type MediaProcessResult = Readonly<{
  exitCode: number;
  termination: "completed" | "timed_out" | "terminated";
  stdout: string;
  stderr: string;
}>;

/** Bounded argv-only host process boundary shared by FFprobe and FFmpeg. */
export type MediaProcessRunner = Readonly<{
  run(command: MediaProcessCommand): Promise<MediaProcessResult>;
}>;
