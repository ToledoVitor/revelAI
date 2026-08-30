import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import {
  createExtractionManifest,
  type ExtractedFrame,
  type ExtractionManifest,
} from "../media/extraction-manifest.js";
import { freeSampleTimestamps } from "../media/eligibility.js";
import { originalOrFrameDeleteAt } from "../media/retention-deadlines.js";
import { MediaPipelineError, type MediaProbe } from "../media/probe.js";
import type { OpaqueMediaIdGenerator } from "./local-media-storage.js";

export interface BoundedFrameProcessRunner {
  run(
    command: Readonly<{
      executable: string;
      arguments: readonly string[];
      inputPath: string;
      outputDirectory: string;
      timeoutMilliseconds: number;
      terminationGraceMilliseconds: number;
      maxOutputBytes: number;
    }>,
  ): Promise<
    Readonly<{ exitCode: number; activeSceneChangeScores?: readonly number[] }>
  >;
}

export interface FrameRetentionRepository {
  schedule(
    input: Readonly<{
      id: string;
      attemptId: string;
      kind: "frame";
      deleteAt: string;
    }>,
  ): Promise<void>;
}

/**
 * Stored-media extractor. Input/output paths are constructed and confined here;
 * callers supply opaque IDs and only receive a path-free manifest.
 */
export class LocalFrameExtraction {
  private readonly root: string;
  private readonly originals: string;
  private readonly frames: string;
  private readonly temporary: string;
  private readonly ids: OpaqueMediaIdGenerator;
  private readonly runner: BoundedFrameProcessRunner;
  private readonly retention: FrameRetentionRepository;
  private readonly executable: string;
  private readonly timeoutMilliseconds: number;
  private readonly maxFrameBytes: number;

  public constructor(
    input: Readonly<{
      root: string;
      ids: OpaqueMediaIdGenerator;
      runner: BoundedFrameProcessRunner;
      retention: FrameRetentionRepository;
      executable?: string;
      timeoutMilliseconds?: number;
      maxFrameBytes?: number;
    }>,
  ) {
    this.root = resolve(input.root);
    this.originals = join(this.root, "originals");
    this.frames = join(this.root, "frames");
    this.temporary = join(this.root, "temporary");
    this.ids = input.ids;
    this.runner = input.runner;
    this.retention = input.retention;
    this.executable = input.executable ?? "ffmpeg";
    this.timeoutMilliseconds = input.timeoutMilliseconds ?? 30_000;
    this.maxFrameBytes = input.maxFrameBytes ?? 52_428;
  }

  public async extract(
    input: Readonly<{
      mode: "free" | "verified";
      attemptId: string;
      generation: number;
      mediaId: string;
      mediaSha256: string;
      probe: MediaProbe;
      uploadedAt: string;
    }>,
  ): Promise<ExtractionManifest> {
    const batchId = this.ids.next();
    if (!isOpaqueUuid(batchId) || !isOpaqueUuid(input.mediaId))
      throw new MediaPipelineError("media_probe_failed");
    const inputPath = safeChild(this.originals, input.mediaId);
    const staging = safeChild(this.temporary, `${batchId}.frames`);
    const published = safeChild(this.frames, batchId);
    let visible = false;
    try {
      await assertPrivateRegularFile(inputPath);
      await mkdir(staging, { mode: 0o700 });
      await chmod(staging, 0o700);
      const timestamps = timestampsFor(input.mode, input.probe.durationSeconds);
      const result = await this.runner.run({
        executable: this.executable,
        arguments: extractionArguments(
          inputPath,
          join(staging, "frame-%04d.jpg"),
          input.mode,
          timestamps,
        ),
        inputPath,
        outputDirectory: staging,
        timeoutMilliseconds: this.timeoutMilliseconds,
        terminationGraceMilliseconds: 1_000,
        maxOutputBytes: this.maxFrameBytes * timestamps.length,
      });
      if (result.exitCode !== 0)
        throw new MediaPipelineError("media_probe_failed");
      if (
        input.mode === "verified" &&
        (!result.activeSceneChangeScores ||
          result.activeSceneChangeScores.length !== 600 ||
          result.activeSceneChangeScores.some(
            (score) => !Number.isFinite(score) || score >= 0.42,
          ))
      )
        throw new MediaPipelineError("media_probe_failed");
      const frames = await readStagedFrames(
        staging,
        timestamps,
        this.maxFrameBytes,
        batchId,
      );
      const manifest = createExtractionManifest({ ...input, frames });
      // The fact is durable before any frame can be observed in frames/.
      await this.retention.schedule({
        id: batchId,
        attemptId: input.attemptId,
        kind: "frame",
        deleteAt: originalOrFrameDeleteAt(input.uploadedAt),
      });
      await publishDirectoryNoReplace(staging, published);
      visible = true;
      return manifest;
    } catch (error) {
      await remove(staging);
      if (visible) await remove(published);
      if (error instanceof MediaPipelineError) throw error;
      throw new MediaPipelineError("media_probe_failed");
    }
  }
}

function timestampsFor(
  mode: "free" | "verified",
  duration: number,
): readonly number[] {
  return mode === "verified"
    ? Object.freeze(Array.from({ length: 640 }, (_, index) => index / 10))
    : freeSampleTimestamps(duration);
}

function extractionArguments(
  inputPath: string,
  outputPattern: string,
  mode: "free" | "verified",
  timestamps: readonly number[],
): readonly string[] {
  const filter = mode === "verified" ? "fps=10" : exactFreeFilter(timestamps);
  return Object.freeze([
    "-nostdin",
    "-v",
    "error",
    "-i",
    inputPath,
    "-vf",
    filter,
    "-frames:v",
    String(timestamps.length),
    "-y",
    outputPattern,
  ]);
}

function exactFreeFilter(timestamps: readonly number[]): string {
  // FFmpeg's select filter receives explicit first-to-last sample targets;
  // this is deliberately not `fps=2`, which cannot meet short/capped Free
  // timelines. The process adapter is also required to enforce frame count.
  const terms = timestamps.map((timestamp) => {
    const value = timestamp.toFixed(6);
    return `between(t\\,${value}-0.001\\,${value}+0.001)`;
  });
  return `select='${terms.join("+")}'`;
}

async function readStagedFrames(
  staging: string,
  timestamps: readonly number[],
  maxFrameBytes: number,
  batchId: string,
): Promise<readonly ExtractedFrame[]> {
  const expectedNames = timestamps.map((_, index) => frameName(index));
  const names = (await readdir(staging)).sort();
  if (
    names.length !== expectedNames.length ||
    names.some((name, index) => name !== expectedNames[index])
  )
    throw new MediaPipelineError("media_probe_failed");
  const frames: ExtractedFrame[] = [];
  for (let index = 0; index < expectedNames.length; index += 1) {
    const path = safeChild(staging, expectedNames[index]);
    const stat = await lstat(path);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size < 1 ||
      stat.size > maxFrameBytes
    )
      throw new MediaPipelineError("media_probe_failed");
    await chmod(path, 0o600);
    frames.push(
      Object.freeze({
        timestampSeconds: timestamps[index]!,
        reference: `${batchId}_${String(index).padStart(4, "0")}`,
        rawBytes: await readFile(path),
      }),
    );
  }
  return Object.freeze(frames);
}

async function publishDirectoryNoReplace(
  staging: string,
  published: string,
): Promise<void> {
  const reservation = `${published}.publishing`;
  await mkdir(reservation, { mode: 0o700 });
  try {
    try {
      await lstat(published);
      throw new MediaPipelineError("media_probe_failed");
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "ENOENT"
      )
        throw error;
    }
    await rename(staging, published);
  } finally {
    await rm(reservation, { recursive: true, force: true }).catch(
      () => undefined,
    );
  }
}

async function assertPrivateRegularFile(path: string): Promise<void> {
  const stat = await lstat(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    (stat.mode & constants.S_IROTH) !== 0
  )
    throw new MediaPipelineError("media_probe_failed");
}

function frameName(index: number): string {
  return `frame-${String(index).padStart(4, "0")}.jpg`;
}

function safeChild(directory: string, name: string): string {
  if (basename(name) !== name)
    throw new MediaPipelineError("media_probe_failed");
  const target = resolve(directory, name);
  if (!target.startsWith(`${directory}/`))
    throw new MediaPipelineError("media_probe_failed");
  return target;
}

async function remove(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true }).catch(() => undefined);
}

function isOpaqueUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}
