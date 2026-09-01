import type { VisionProviderConfig } from "@revelai/config";
import {
  createDemoVisionProvider,
  createRoboflowVisionProvider,
  type ProviderFetch,
  type VisionProvider,
} from "@revelai/vision";

export type LocalDemoProcessCommand = Readonly<{
  executable: string;
  arguments: readonly string[];
  timeoutMilliseconds: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
  maxOutputBytes: number;
}>;

export type LocalDemoProcessRunner = Readonly<{
  run(
    command: LocalDemoProcessCommand,
  ): Promise<Readonly<{ exitCode: number; stdout: string; stderr: string }>>;
}>;

export class LocalDemoPreflightError extends Error {
  public constructor() {
    super("RevelAI local demo requires FFmpeg and FFprobe capabilities.");
    this.name = "LocalDemoPreflightError";
  }
}

/** Creates only the selected server-side provider; construction never fetches. */
export function createConfiguredVisionProvider(
  config: VisionProviderConfig,
  providerFetch: ProviderFetch = processProviderFetch,
): VisionProvider {
  if (config.kind === "demo") return createDemoVisionProvider();
  return createRoboflowVisionProvider({
    config: {
      apiUrl: config.apiUrl,
      ...(config.apiKey === undefined ? {} : { apiKey: config.apiKey }),
      workspaceId: config.workspaceId,
      freeModelBundleId: config.freeTraining.modelBundleId,
      verifiedModelBundleId: config.wallPass.modelBundleId,
      freeProviderVersion: "roboflow-inference-v1",
      verifiedProviderVersion: "roboflow-inference-v1",
    },
    fetch: providerFetch,
  });
}

/**
 * Normal local execution proves command availability and the precise C5
 * filters/encoder it needs before the server can bind. Output stays private.
 */
export async function preflightMediaBinaries(
  runner: LocalDemoProcessRunner,
): Promise<void> {
  try {
    const probe = await runner.run(command("ffprobe", ["-version"]));
    const ffmpeg = await runner.run(command("ffmpeg", ["-version"]));
    const filters = await runner.run(
      command("ffmpeg", ["-hide_banner", "-filters"]),
    );
    const encoders = await runner.run(
      command("ffmpeg", ["-hide_banner", "-encoders"]),
    );
    if (
      probe.exitCode !== 0 ||
      ffmpeg.exitCode !== 0 ||
      filters.exitCode !== 0 ||
      encoders.exitCode !== 0 ||
      !includesCapabilities(filters, ["showinfo", "metadata"]) ||
      !includesCapabilities(encoders, ["mjpeg"])
    )
      throw new LocalDemoPreflightError();
  } catch {
    throw new LocalDemoPreflightError();
  }
}

function command(
  executable: string,
  args: readonly string[],
): LocalDemoProcessCommand {
  return Object.freeze({
    executable,
    arguments: Object.freeze([...args]),
    timeoutMilliseconds: 8_000,
    maxStdoutBytes: 256 * 1024,
    maxStderrBytes: 256 * 1024,
    maxOutputBytes: 512 * 1024,
  });
}

function includesCapabilities(
  result: Readonly<{ stdout: string; stderr: string }>,
  names: readonly string[],
): boolean {
  const output = `${result.stdout}\n${result.stderr}`.toLowerCase();
  return names.every((name) => output.includes(name));
}

const processProviderFetch: ProviderFetch = async (url, init) => {
  const response = await fetch(url, {
    method: init.method,
    headers: init.headers,
    body: init.body,
    signal: init.signal,
  });
  return Object.freeze({
    status: response.status,
    json: () => response.json(),
  });
};
