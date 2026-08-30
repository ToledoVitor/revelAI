import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  rm,
  writeFile,
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

/**
 * C8 supplies child-process spawning. C5 owns this fixed NDJSON evidence
 * protocol, bounded output, deadline and termination contract.
 */
export interface BoundedFrameProcessRunner {
  run(
    command: Readonly<{
      executable: string;
      arguments: readonly string[];
      inputPath: string;
      outputDirectory: string;
      timeoutMilliseconds: number;
      terminationGraceMilliseconds: number;
      maxStdoutBytes: number;
      maxStderrBytes: number;
      maxOutputBytes: number;
      evidenceFormat: "revelai-frame-evidence-ndjson-v1";
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

type DecodedFrame = Readonly<{ index: number; timestampSeconds: number }>;
type SceneEvidence = Readonly<{ timestampSeconds: number; score: number }>;

/** Private stored-media capability: callers see only opaque IDs and manifests. */
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
    try {
      // One durable frame fact covers temporary/{batch}.frames and frames/{batch}
      // before either is created. Missing-file deletion is idempotent.
      await this.retention.schedule({
        id: batchId,
        attemptId: input.attemptId,
        kind: "frame",
        deleteAt: originalOrFrameDeleteAt(input.uploadedAt),
      });
      await assertPrivateRegularFile(inputPath);
      await mkdir(staging, { mode: 0o700 });
      await chmod(staging, 0o700);
      const result = await this.runner.run({
        executable: this.executable,
        arguments: extractionArguments(
          inputPath,
          join(staging, "decoded-%06d.jpg"),
        ),
        inputPath,
        outputDirectory: staging,
        timeoutMilliseconds: this.timeoutMilliseconds,
        terminationGraceMilliseconds: 1_000,
        maxStdoutBytes: 2 * 1024 * 1024,
        maxStderrBytes: 64 * 1024,
        maxOutputBytes: 128 * 1024 * 1024,
        evidenceFormat: "revelai-frame-evidence-ndjson-v1",
      });
      if (result.exitCode !== 0 || result.termination !== "completed")
        throw new MediaPipelineError("media_probe_failed");
      const evidence = parseEvidence(result, 2 * 1024 * 1024, 64 * 1024);
      const selected = selectDecodedFrames(
        input.mode,
        input.probe,
        evidence.decoded,
      );
      if (
        input.mode === "verified" &&
        !hasVerifiedSceneEvidence(evidence.scenes)
      )
        throw new MediaPipelineError("media_probe_failed");
      const frames = await materializeFrames(
        staging,
        selected,
        this.maxFrameBytes,
        batchId,
      );
      const manifest = createExtractionManifest({ ...input, frames });
      await publishFrameSet(staging, published);
      return manifest;
    } catch (error) {
      // The retention record intentionally remains due: it can clean either
      // staging or final state after an ambiguous process/publication failure.
      await remove(staging);
      await remove(published);
      if (error instanceof MediaPipelineError) throw error;
      throw new MediaPipelineError("media_probe_failed");
    }
  }

  /** Opaque C6-facing byte reader; no path or layout becomes public. */
  public async readFrame(reference: string): Promise<Uint8Array> {
    const match = /^([0-9a-f-]{36})_(\d{4})$/i.exec(reference);
    if (!match || !isOpaqueUuid(match[1]!))
      throw new MediaPipelineError("media_probe_failed");
    const path = safeChild(
      safeChild(this.frames, match[1]!),
      `frame-${match[2]}.jpg`,
    );
    const completion = safeChild(
      safeChild(this.frames, match[1]!),
      ".complete",
    );
    const completionStat = await lstat(completion);
    if (!completionStat.isFile() || completionStat.isSymbolicLink())
      throw new MediaPipelineError("media_probe_failed");
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1)
      throw new MediaPipelineError("media_probe_failed");
    return new Uint8Array(await readFile(path));
  }
}

function extractionArguments(
  inputPath: string,
  outputPattern: string,
): readonly string[] {
  // `showinfo` emits every decoded frame timestamp; the C8 adapter converts
  // that stream plus scene records to the fixed NDJSON protocol above. C5 then
  // selects real decoded indices, never synthetic ordinal timestamps.
  return Object.freeze([
    "-nostdin",
    "-v",
    "error",
    "-i",
    inputPath,
    "-vf",
    "showinfo",
    "-vsync",
    "0",
    "-y",
    outputPattern,
  ]);
}

function parseEvidence(
  result: Readonly<{ stdout: string; stderr: string }>,
  maxStdoutBytes: number,
  maxStderrBytes: number,
): Readonly<{
  decoded: readonly DecodedFrame[];
  scenes: readonly SceneEvidence[];
}> {
  if (
    Buffer.byteLength(result.stdout, "utf8") > maxStdoutBytes ||
    Buffer.byteLength(result.stderr, "utf8") > maxStderrBytes
  )
    throw new MediaPipelineError("media_probe_failed");
  const decoded: DecodedFrame[] = [];
  const scenes: SceneEvidence[] = [];
  for (const line of result.stdout.split("\n")) {
    if (!line.trim()) continue;
    let item: unknown;
    try {
      item = JSON.parse(line);
    } catch {
      throw new MediaPipelineError("media_probe_failed");
    }
    if (!isRecord(item)) throw new MediaPipelineError("media_probe_failed");
    if (item.kind === "decoded") {
      if (
        !hasOnlyKeys(item, ["kind", "index", "timestampSeconds"]) ||
        !Number.isSafeInteger(item.index) ||
        item.index !== decoded.length ||
        typeof item.timestampSeconds !== "number" ||
        !Number.isFinite(item.timestampSeconds) ||
        item.timestampSeconds < 0 ||
        (decoded.length > 0 &&
          item.timestampSeconds <= decoded.at(-1)!.timestampSeconds)
      )
        throw new MediaPipelineError("media_probe_failed");
      decoded.push(
        Object.freeze({
          index: item.index,
          timestampSeconds: item.timestampSeconds,
        }),
      );
      continue;
    }
    if (item.kind === "scene") {
      if (
        !hasOnlyKeys(item, ["kind", "timestampSeconds", "score"]) ||
        typeof item.timestampSeconds !== "number" ||
        !Number.isFinite(item.timestampSeconds) ||
        typeof item.score !== "number" ||
        !Number.isFinite(item.score)
      )
        throw new MediaPipelineError("media_probe_failed");
      scenes.push(
        Object.freeze({
          timestampSeconds: item.timestampSeconds,
          score: item.score,
        }),
      );
      continue;
    }
    throw new MediaPipelineError("media_probe_failed");
  }
  if (decoded.length === 0) throw new MediaPipelineError("media_probe_failed");
  return Object.freeze({
    decoded: Object.freeze(decoded),
    scenes: Object.freeze(scenes),
  });
}

function selectDecodedFrames(
  mode: "free" | "verified",
  probe: MediaProbe,
  decoded: readonly DecodedFrame[],
): readonly DecodedFrame[] {
  const count =
    mode === "verified"
      ? 640
      : freeSampleTimestamps(probe.durationSeconds).length;
  if (decoded.length < count)
    throw new MediaPipelineError("media_probe_failed");
  const first = mode === "verified" ? 0 : decoded[0]!.timestampSeconds;
  const last = mode === "verified" ? 63.9 : decoded.at(-1)!.timestampSeconds;
  const targets = Array.from(
    { length: count },
    (_, index) => first + ((last - first) * index) / (count - 1),
  );
  const selected: DecodedFrame[] = [];
  let floor = 0;
  for (const target of targets) {
    let best = -1;
    let distance = Infinity;
    for (let index = floor; index < decoded.length; index += 1) {
      const candidate = decoded[index]!;
      const next = decoded[index + 1];
      const currentDistance = Math.abs(candidate.timestampSeconds - target);
      if (currentDistance < distance) {
        best = index;
        distance = currentDistance;
      }
      if (next && next.timestampSeconds > target && currentDistance > distance)
        break;
    }
    if (best < floor) throw new MediaPipelineError("media_probe_failed");
    selected.push(decoded[best]!);
    floor = best + 1;
  }
  if (
    mode === "verified" &&
    (selected.some((frame, index) =>
      index < 40
        ? frame.timestampSeconds >= 4
        : frame.timestampSeconds < 4 || frame.timestampSeconds >= 64,
    ) ||
      selected.some(
        (frame, index) =>
          index > 0 &&
          frame.timestampSeconds - selected[index - 1]!.timestampSeconds > 0.25,
      ))
  )
    throw new MediaPipelineError("media_probe_failed");
  return Object.freeze(selected);
}

function hasVerifiedSceneEvidence(scenes: readonly SceneEvidence[]): boolean {
  return (
    scenes.length === 600 &&
    scenes.every(
      (scene, index) =>
        scene.timestampSeconds >= 4 &&
        scene.timestampSeconds < 64 &&
        scene.score >= 0 &&
        scene.score < 0.42 &&
        (index === 0 ||
          scene.timestampSeconds > scenes[index - 1]!.timestampSeconds),
    )
  );
}

async function materializeFrames(
  staging: string,
  selected: readonly DecodedFrame[],
  maxFrameBytes: number,
  batchId: string,
): Promise<readonly ExtractedFrame[]> {
  const frames: ExtractedFrame[] = [];
  for (let ordinal = 0; ordinal < selected.length; ordinal += 1) {
    const decoded = selected[ordinal]!;
    const source = safeChild(staging, decodedName(decoded.index));
    const stat = await lstat(source);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size < 1 ||
      stat.size > maxFrameBytes
    )
      throw new MediaPipelineError("media_probe_failed");
    const rawBytes = await readFile(source);
    const final = safeChild(staging, frameName(ordinal));
    await writeFile(final, rawBytes, { mode: 0o600, flag: "wx" });
    await chmod(final, 0o600);
    frames.push(
      Object.freeze({
        timestampSeconds: decoded.timestampSeconds,
        reference: `${batchId}_${String(ordinal).padStart(4, "0")}`,
        rawBytes,
      }),
    );
  }
  for (const name of await readdir(staging))
    if (name.startsWith("decoded-"))
      await rm(safeChild(staging, name), { force: true });
  const names = (await readdir(staging)).sort();
  const expected = selected.map((_, index) => frameName(index));
  if (
    names.length !== expected.length ||
    names.some((name, index) => name !== expected[index])
  )
    throw new MediaPipelineError("media_probe_failed");
  return Object.freeze(frames);
}

async function publishFrameSet(
  staging: string,
  published: string,
): Promise<void> {
  // O_EXCL reservation owns this opaque set; link each finished private frame
  // into it and expose a completion marker only after all links succeed.
  await mkdir(published, { mode: 0o700 });
  try {
    const names = (await readdir(staging)).sort();
    for (const name of names) {
      const source = safeChild(staging, name);
      const target = safeChild(published, name);
      const bytes = await readFile(source);
      await writeFile(target, bytes, { mode: 0o600, flag: "wx" });
      await chmod(target, 0o600);
    }
    await writeFile(safeChild(published, ".complete"), "v1", {
      mode: 0o600,
      flag: "wx",
    });
    await remove(staging);
  } catch (error) {
    await remove(published);
    throw error;
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

function decodedName(index: number): string {
  return `decoded-${String(index).padStart(6, "0")}.jpg`;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return (
    Object.keys(value).length === keys.length &&
    Object.keys(value).every((key) => keys.includes(key))
  );
}
