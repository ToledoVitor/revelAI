import { constants } from "node:fs";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { decode } from "jpeg-js";
import {
  attestVerifiedExtractionContinuity,
  createExtractionManifest,
  type ExtractedFrame,
  type ExtractionManifest,
  type StorageExtractionReceipt,
  type StorageReceiptAuthority,
} from "../media/extraction-manifest.js";
import { freeSampleTimestamps } from "../media/eligibility.js";
import { originalOrFrameDeleteAt } from "../media/retention-deadlines.js";
import { MediaPipelineError, type MediaProbe } from "../media/probe.js";
import type {
  OpaqueMediaIdGenerator,
  RetentionScheduleResult,
} from "./local-media-storage.js";

const localFrameExtractionCapabilities = new WeakSet<object>();

/** Runtime capability check used only by C5 composition; it never mints. */
export function isLocalFrameExtractionCapability(
  value: unknown,
): value is LocalFrameExtraction {
  return (
    typeof value === "object" &&
    value !== null &&
    localFrameExtractionCapabilities.has(value)
  );
}

/**
 * C8 supplies child-process spawning. C5 owns the exact FFmpeg argv and
 * parses bounded raw `showinfo`/`metadata=print` output itself.
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
      evidenceFormat: "ffmpeg-showinfo-metadata-v1";
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
  ): Promise<RetentionScheduleResult>;
}

type DecodedFrame = Readonly<{ index: number; timestampSeconds: number }>;
type SceneEvidence = Readonly<{ timestampSeconds: number; score: number }>;
type ExtractionAuthority = Pick<
  StorageReceiptAuthority,
  "athleteId" | "calibrationSessionId" | "calibrationNonce"
>;

/** Only the local publisher may turn owned frame bytes into a durable receipt. */
function createLocalStorageExtractionReceipt(
  input: Readonly<{
    frameBatchId: string;
    authority: StorageExtractionReceipt["authority"];
    manifest: ExtractionManifest;
    frames: readonly Uint8Array[];
    activeScenes: StorageExtractionReceipt["activeScenes"];
  }>,
): StorageExtractionReceipt {
  const { manifest, authority } = input;
  if (
    authority.attemptId !== manifest.attemptId ||
    authority.generation !== manifest.generation ||
    authority.mode !== manifest.mode ||
    authority.mediaId !== manifest.mediaId ||
    authority.sourceSha256 !== manifest.mediaSha256 ||
    input.frames.length !== manifest.frames.items.length ||
    manifest.frames.items.some(
      (frame) =>
        frame.reference !==
        `${input.frameBatchId}_${String(frame.ordinal).padStart(4, "0")}`,
    ) ||
    (manifest.mode === "free" && input.activeScenes !== null) ||
    (manifest.mode === "verified" && input.activeScenes === null)
  )
    throw new MediaPipelineError("media_probe_failed");
  return Object.freeze({
    kind: "c5-storage-extraction-receipt-v1",
    frameBatchId: input.frameBatchId,
    authority: Object.freeze({ ...authority }),
    manifest,
    frameSha256: Object.freeze(
      input.frames.map((frame) =>
        createHash("sha256").update(frame).digest("hex"),
      ),
    ),
    activeScenes:
      input.activeScenes === null
        ? null
        : Object.freeze(
            input.activeScenes.map((scene) => Object.freeze({ ...scene })),
          ),
  });
}

// FFmpeg showinfo can emit a complete per-frame record with colour, side-data,
// and metadata. This cap permits 640 bounded 512-byte records plus process
// diagnostics. A record permits 512 bytes: fixed showinfo fields plus maximum
// pixel/colour/side-data fields emitted by the locked FFmpeg invocation. It
// still rejects unbounded/erroring runners before evidence crosses storage.
const MAX_SHOWINFO_RECORD_BYTES = 512;
const MAX_SHOWINFO_DIAGNOSTIC_BYTES = 16 * 1024;
const MAX_SHOWINFO_BYTES =
  640 * MAX_SHOWINFO_RECORD_BYTES + MAX_SHOWINFO_DIAGNOSTIC_BYTES;

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
  private readonly publishedReceiptReferences = new WeakMap<
    ExtractionManifest,
    Readonly<{ frameBatchId: string; mediaId: string; sha256: string }>
  >();

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
    localFrameExtractionCapabilities.add(this);
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
      /** Acceptance always extracts from the private staged upload. */
      source: "staged";
      /** Required for source digest verification and receipt publication. */
      authority: ExtractionAuthority;
    }>,
  ): Promise<ExtractionManifest> {
    const batchId = this.ids.next();
    if (!isOpaqueUuid(batchId) || !isOpaqueUuid(input.mediaId))
      throw new MediaPipelineError("media_probe_failed");
    const inputPath = safeChild(this.temporary, `${input.mediaId}.uploading`);
    const staging = safeChild(this.temporary, `${batchId}.frames`);
    const published = safeChild(this.frames, batchId);
    let stagingOwned = false;
    try {
      // One durable frame fact covers temporary/{batch}.frames and frames/{batch}
      // before either is created. Missing-file deletion is idempotent.
      const scheduled = await this.retention.schedule({
        id: batchId,
        attemptId: input.attemptId,
        kind: "frame",
        deleteAt: originalOrFrameDeleteAt(input.uploadedAt),
      });
      if (scheduled.kind === "conflict")
        throw new MediaPipelineError("media_probe_failed");
      await assertPrivateRegularFile(inputPath);
      if ((await sha256PrivateFile(inputPath)) !== input.mediaSha256)
        throw new MediaPipelineError("media_probe_failed");
      await mkdir(staging, { mode: 0o700 });
      stagingOwned = true;
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
        maxStderrBytes: MAX_SHOWINFO_BYTES,
        maxOutputBytes: 128 * 1024 * 1024,
        evidenceFormat: "ffmpeg-showinfo-metadata-v1",
      });
      if (result.exitCode !== 0 || result.termination !== "completed")
        throw new MediaPipelineError("media_probe_failed");
      const evidence = parseEvidence(
        result,
        2 * 1024 * 1024,
        MAX_SHOWINFO_BYTES,
      );
      const selected = selectDecodedFrames(
        input.mode,
        input.probe,
        evidence.decoded,
      );
      if (
        input.mode === "verified" &&
        !hasVerifiedSceneEvidence(evidence.scenes, selected.slice(40))
      )
        throw new MediaPipelineError("media_probe_failed");
      const frames = await materializeFrames(
        staging,
        selected,
        this.maxFrameBytes,
        batchId,
      );
      const manifest = createExtractionManifest({ ...input, frames });
      if (manifest.mode === "verified")
        attestVerifiedExtractionContinuity(manifest, evidence.scenes);
      let receiptSha256: string | null = null;
      const receipt = createLocalStorageExtractionReceipt({
        frameBatchId: batchId,
        authority: Object.freeze({
          attemptId: input.attemptId,
          athleteId: input.authority.athleteId,
          generation: input.generation,
          mode: input.mode,
          mediaId: input.mediaId,
          sourceSha256: input.mediaSha256,
          uploadedAt: input.uploadedAt,
          calibrationSessionId: input.authority.calibrationSessionId,
          calibrationNonce: input.authority.calibrationNonce,
        }),
        manifest,
        frames: frames.map((frame) => frame.rawBytes),
        activeScenes: input.mode === "verified" ? evidence.scenes : null,
      });
      const bytes = Buffer.from(JSON.stringify(receipt));
      receiptSha256 = createHash("sha256").update(bytes).digest("hex");
      await writeFile(safeChild(staging, ".receipt.json"), bytes, {
        mode: 0o600,
        flag: "wx",
      });
      await chmod(safeChild(staging, ".receipt.json"), 0o600);
      await publishFrameSet(staging, published);
      this.publishedReceiptReferences.set(
        manifest,
        Object.freeze({
          frameBatchId: batchId,
          mediaId: input.mediaId,
          sha256: receiptSha256,
        }),
      );
      return manifest;
    } catch (error) {
      // The retention record intentionally remains due: it can clean either
      // staging or final state after an ambiguous process/publication failure.
      if (stagingOwned) await remove(staging);
      // A collision or an ambiguous publisher failure is not ours to destroy.
      // Its still-due retention fact reconciles only resources it can prove it
      // owns on restart.
      if (error instanceof MediaPipelineError) throw error;
      throw new MediaPipelineError("media_probe_failed");
    }
  }

  /** C5 returns a reference only for the exact manifest it published. */
  public durableReceiptFor(
    manifest: ExtractionManifest,
  ): Readonly<{ frameBatchId: string; mediaId: string; sha256: string }> {
    const receipt = this.publishedReceiptReferences.get(manifest);
    if (!receipt) throw new MediaPipelineError("media_probe_failed");
    return receipt;
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
    try {
      const completionStat = await lstat(completion);
      if (!completionStat.isFile() || completionStat.isSymbolicLink())
        throw new MediaPipelineError("media_probe_failed");
      const stat = await lstat(path);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.size < 4 ||
        stat.size > this.maxFrameBytes
      )
        throw new MediaPipelineError("media_probe_failed");
      const handle = await open(
        path,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
      const bytes = new Uint8Array(
        await handle.readFile().finally(() => handle.close()),
      );
      if (!isJpeg(bytes)) throw new MediaPipelineError("media_probe_failed");
      return bytes;
    } catch {
      // Do not surface an OS error that embeds the private filesystem layout.
      throw new MediaPipelineError("media_probe_failed");
    }
  }

  /** Reads the receipt only from a complete, C5-owned opaque frame batch. */
  public async readReceipt(
    input: Readonly<{ frameBatchId: string }>,
  ): Promise<Readonly<{ bytes: Uint8Array }>> {
    if (!isOpaqueUuid(input.frameBatchId))
      throw new MediaPipelineError("media_probe_failed");
    const directory = safeChild(this.frames, input.frameBatchId);
    const receipt = safeChild(directory, ".receipt.json");
    const completion = safeChild(directory, ".complete");
    try {
      const completionStat = await lstat(completion);
      const receiptStat = await lstat(receipt);
      if (
        !completionStat.isFile() ||
        completionStat.isSymbolicLink() ||
        !receiptStat.isFile() ||
        receiptStat.isSymbolicLink() ||
        receiptStat.size < 2 ||
        receiptStat.size > 2 * 1024 * 1024
      )
        throw new MediaPipelineError("media_probe_failed");
      const handle = await open(
        receipt,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
      return Object.freeze({
        bytes: new Uint8Array(
          await handle.readFile().finally(() => handle.close()),
        ),
      });
    } catch {
      throw new MediaPipelineError("media_probe_failed");
    }
  }

  /** Streams a complete C5-owned original without revealing its path. */
  public async sourceSha256ForOriginal(
    input: Readonly<{ mediaId: string }>,
  ): Promise<string> {
    if (!isOpaqueUuid(input.mediaId))
      throw new MediaPipelineError("media_probe_failed");
    try {
      const original = safeChild(
        safeChild(this.originals, input.mediaId),
        "payload",
      );
      await assertPrivateRegularFile(original);
      return await sha256PrivateFile(original);
    } catch {
      throw new MediaPipelineError("media_probe_failed");
    }
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
    "info",
    "-i",
    inputPath,
    "-filter_complex",
    "[0:v]fps=10,split=2[decoded][active];[decoded]showinfo[frames];[active]select='gte(t,4)*lt(t,64)*gte(scene,0)',metadata=print:file=-[scene]",
    "-map",
    "[frames]",
    "-vsync",
    "0",
    // image2 defaults to 1 while showinfo begins at 0. C5 owns both sides of
    // this protocol, so the opaque decoded index and actual filename agree.
    "-start_number",
    "0",
    "-y",
    outputPattern,
    "-map",
    "[scene]",
    "-f",
    "null",
    "-",
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
  const decoded = parseShowinfo(result.stderr);
  const scenes = parseSceneMetadata(result.stdout);
  if (decoded.length === 0) throw new MediaPipelineError("media_probe_failed");
  return Object.freeze({
    decoded: Object.freeze(decoded),
    scenes: Object.freeze(scenes),
  });
}

function parseShowinfo(output: string): readonly DecodedFrame[] {
  const decoded: DecodedFrame[] = [];
  const lines = output.split("\n").filter((line) => line.trim());
  for (const line of lines) {
    const match =
      /\bn:\s*(\d+)\s+pts:\s*-?\d+\s+pts_time:([-+]?\d+(?:\.\d+)?)/.exec(line);
    if (!match) continue;
    if (Buffer.byteLength(line, "utf8") > MAX_SHOWINFO_RECORD_BYTES)
      throw new MediaPipelineError("media_probe_failed");
    const index = Number(match[1]);
    const timestampSeconds = Number(match[2]);
    if (
      !Number.isSafeInteger(index) ||
      index !== decoded.length ||
      !Number.isFinite(timestampSeconds) ||
      timestampSeconds < 0 ||
      (decoded.length > 0 &&
        timestampSeconds <= decoded.at(-1)!.timestampSeconds)
    )
      throw new MediaPipelineError("media_probe_failed");
    decoded.push(Object.freeze({ index, timestampSeconds }));
  }
  return Object.freeze(decoded);
}

function parseSceneMetadata(output: string): readonly SceneEvidence[] {
  const lines = output.split("\n").filter((line) => line.trim());
  const scenes: SceneEvidence[] = [];
  for (let cursor = 0; cursor < lines.length; cursor += 2) {
    const header =
      /^frame:\d+\s+pts:\s*-?\d+\s+pts_time:\s*([-+]?\d+(?:\.\d+)?)\s*$/.exec(
        lines[cursor]!,
      );
    const score = /^lavfi\.scene_score=([-+]?\d+(?:\.\d+)?)$/.exec(
      lines[cursor + 1] ?? "",
    );
    if (!header || !score) throw new MediaPipelineError("media_probe_failed");
    const timestampSeconds = Number(header[1]);
    const value = Number(score[1]);
    if (
      !Number.isFinite(timestampSeconds) ||
      !Number.isFinite(value) ||
      (scenes.length > 0 && timestampSeconds <= scenes.at(-1)!.timestampSeconds)
    )
      throw new MediaPipelineError("media_probe_failed");
    scenes.push(Object.freeze({ timestampSeconds, score: value }));
  }
  return Object.freeze(scenes);
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

function hasVerifiedSceneEvidence(
  scenes: readonly SceneEvidence[],
  active: readonly DecodedFrame[],
): boolean {
  return (
    scenes.length === active.length &&
    active.length === 600 &&
    scenes.every(
      (scene, index) =>
        scene.timestampSeconds === active[index]!.timestampSeconds &&
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
    if (!isJpeg(rawBytes)) throw new MediaPipelineError("media_probe_failed");
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

async function sha256PrivateFile(path: string): Promise<string> {
  const handle = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const hash = createHash("sha256");
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    for (;;) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
      if (bytesRead === 0) break;
      hash.update(chunk.subarray(0, bytesRead));
      position += bytesRead;
    }
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}

async function publishFrameSet(
  staging: string,
  published: string,
): Promise<void> {
  // O_EXCL reservation owns this opaque set; atomically rename each private
  // frame into it and expose a completion marker only after all moves succeed.
  let owned = false;
  await mkdir(published, { mode: 0o700 });
  owned = true;
  try {
    const names = (await readdir(staging)).sort();
    for (const name of names) {
      const source = safeChild(staging, name);
      const target = safeChild(published, name);
      await rename(source, target);
      await chmod(target, 0o600);
    }
    await writeFile(safeChild(published, ".complete"), "v1", {
      mode: 0o600,
      flag: "wx",
    });
    await remove(staging);
  } catch (error) {
    if (owned) await remove(published);
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

function isJpeg(bytes: Uint8Array): boolean {
  if (
    bytes.length < 16 ||
    bytes[0] !== 0xff ||
    bytes[1] !== 0xd8 ||
    bytes.at(-2) !== 0xff ||
    bytes.at(-1) !== 0xd9
  )
    return false;

  let cursor = 2;
  let sawSof = false;
  const quantizationTables = new Set<number>();
  const huffmanTables = new Set<string>();
  const components = new Map<number, number>();
  let restartInterval: number | undefined;
  let sawApp0 = false;

  while (cursor < bytes.length) {
    if (bytes[cursor] !== 0xff) return false;
    while (bytes[cursor] === 0xff) cursor += 1;
    const marker = bytes[cursor];
    if (
      marker === undefined ||
      marker === 0x00 ||
      marker === 0xd8 ||
      marker === 0xd9
    )
      return false;
    cursor += 1;
    if (marker === 0x01) return false;
    if (marker >= 0xd0 && marker <= 0xd7) return false;
    if (cursor + 2 > bytes.length) return false;
    const segmentLength = (bytes[cursor]! << 8) | bytes[cursor + 1]!;
    if (segmentLength < 2 || cursor + segmentLength > bytes.length)
      return false;
    const segmentStart = cursor + 2;
    const segmentEnd = cursor + segmentLength;

    if (marker === 0xe0) {
      if (
        sawApp0 ||
        sawSof ||
        !isSupportedApp0(bytes, segmentStart, segmentEnd)
      )
        return false;
      sawApp0 = true;
    } else if (marker === 0xdb) {
      if (
        sawSof ||
        !parseQuantizationTables(
          bytes,
          segmentStart,
          segmentEnd,
          quantizationTables,
        )
      )
        return false;
    } else if (marker === 0xc4) {
      if (!parseHuffmanTables(bytes, segmentStart, segmentEnd, huffmanTables))
        return false;
    } else if (marker === 0xc0) {
      if (
        sawSof ||
        !parseStartOfFrame(
          bytes,
          segmentStart,
          segmentLength,
          quantizationTables,
          components,
        )
      )
        return false;
      sawSof = true;
    } else if (marker === 0xda) {
      if (
        !sawSof ||
        quantizationTables.size === 0 ||
        huffmanTables.size === 0 ||
        !parseStartOfScan(
          bytes,
          segmentStart,
          segmentLength,
          components,
          huffmanTables,
        )
      )
        return false;
      return (
        hasOneBoundedEntropyScan(bytes, segmentEnd, restartInterval) &&
        isBoundedlyDecoderValidJpeg(bytes)
      );
    } else if (marker === 0xdd) {
      // Restart interval is a two-byte unsigned integer.
      if (
        sawSof ||
        restartInterval !== undefined ||
        segmentLength !== 4 ||
        ((bytes[segmentStart]! << 8) | bytes[segmentStart + 1]!) === 0
      )
        return false;
      restartInterval = (bytes[segmentStart]! << 8) | bytes[segmentStart + 1]!;
    } else return false;
    cursor = segmentEnd;
  }
  return false;
}

/**
 * Structural checks keep the supported C5 SOF0 subset explicit; this bounded
 * decoder pass closes the remaining Huffman/MCU entropy semantics before a
 * frame can enter an immutable extraction manifest or opaque reader result.
 */
function isBoundedlyDecoderValidJpeg(bytes: Uint8Array): boolean {
  try {
    const decoded = decode(bytes, {
      useTArray: true,
      formatAsRGBA: true,
      tolerantDecoding: false,
      maxResolutionInMP: 8,
      maxMemoryUsageInMB: 96,
    });
    return (
      decoded.width > 0 &&
      decoded.height > 0 &&
      decoded.data.byteLength === decoded.width * decoded.height * 4
    );
  } catch {
    return false;
  }
}

function isSupportedApp0(
  bytes: Uint8Array,
  start: number,
  end: number,
): boolean {
  // Restrict the C5 decoder boundary to the JFIF APP0 form emitted by our
  // frame extractor. Unsupported metadata markers are not image evidence.
  return (
    end - start >= 14 &&
    bytes[start] === 0x4a &&
    bytes[start + 1] === 0x46 &&
    bytes[start + 2] === 0x49 &&
    bytes[start + 3] === 0x46 &&
    bytes[start + 4] === 0 &&
    bytes[start + 5] === 1 &&
    bytes[start + 6] <= 2 &&
    bytes[start + 7] <= 2 &&
    ((bytes[start + 12]! << 8) | bytes[start + 13]!) === end - start - 14
  );
}

function parseQuantizationTables(
  bytes: Uint8Array,
  start: number,
  end: number,
  tables: Set<number>,
): boolean {
  let cursor = start;
  let added = 0;
  while (cursor < end) {
    const table = bytes[cursor++];
    if (table === undefined) return false;
    const precision = table >>> 4;
    const id = table & 0x0f;
    // FFmpeg frame evidence is deliberately restricted to baseline 8-bit
    // JPEG: 8-bit DQT values only, each non-zero, and a unique table ID.
    if (precision !== 0 || id > 3 || tables.has(id)) return false;
    const values = 64;
    if (cursor + values > end) return false;
    for (let index = 0; index < values; index += 1)
      if (bytes[cursor + index] === 0) return false;
    cursor += values;
    tables.add(id);
    added += 1;
  }
  return cursor === end && added > 0;
}

function parseHuffmanTables(
  bytes: Uint8Array,
  start: number,
  end: number,
  tables: Set<string>,
): boolean {
  let cursor = start;
  let added = 0;
  while (cursor < end) {
    if (cursor + 17 > end) return false;
    const selector = bytes[cursor++];
    if (selector === undefined) return false;
    const tableClass = selector >>> 4;
    const id = selector & 0x0f;
    const key = `${tableClass}:${id}`;
    if (tableClass > 1 || id > 3 || tables.has(key)) return false;
    let symbols = 0;
    let availableCodes = 1;
    for (let index = 0; index < 16; index += 1) {
      const count = bytes[cursor++]!;
      symbols += count;
      availableCodes = availableCodes * 2 - count;
      // Negative capacity is an oversubscribed canonical prefix tree.
      if (availableCodes < 0) return false;
    }
    // JPEG reserves the all-ones code for marker resynchronisation; a table
    // that fills the complete prefix space is therefore decoder-invalid.
    if (symbols < 1 || availableCodes <= 0 || cursor + symbols > end)
      return false;
    const seenSymbols = new Set<number>();
    for (let index = 0; index < symbols; index += 1) {
      const symbol = bytes[cursor + index];
      if (
        symbol === undefined ||
        seenSymbols.has(symbol) ||
        !isBaselineHuffmanSymbol(tableClass, symbol)
      )
        return false;
      seenSymbols.add(symbol);
    }
    cursor += symbols;
    tables.add(key);
    added += 1;
  }
  return cursor === end && added > 0;
}

function parseStartOfFrame(
  bytes: Uint8Array,
  start: number,
  segmentLength: number,
  quantizationTables: ReadonlySet<number>,
  components: Map<number, number>,
): boolean {
  if (segmentLength < 11) return false;
  const precision = bytes[start];
  const height = (bytes[start + 1]! << 8) | bytes[start + 2]!;
  const width = (bytes[start + 3]! << 8) | bytes[start + 4]!;
  const count = bytes[start + 5];
  if (
    precision === undefined ||
    precision !== 8 ||
    height === 0 ||
    width === 0 ||
    count === undefined ||
    count < 1 ||
    count > 4 ||
    segmentLength !== 8 + 3 * count
  )
    return false;
  let aggregateSampling = 0;
  for (let index = 0; index < count; index += 1) {
    const offset = start + 6 + index * 3;
    const id = bytes[offset];
    const sampling = bytes[offset + 1];
    const quantizationId = bytes[offset + 2];
    if (
      id === undefined ||
      id === 0 ||
      sampling === undefined ||
      sampling === 0 ||
      sampling >>> 4 === 0 ||
      (sampling & 0x0f) === 0 ||
      sampling >>> 4 > 4 ||
      (sampling & 0x0f) > 4 ||
      quantizationId === undefined ||
      !quantizationTables.has(quantizationId) ||
      components.has(id)
    )
      return false;
    components.set(id, quantizationId);
    aggregateSampling += (sampling >>> 4) * (sampling & 0x0f);
  }
  return aggregateSampling <= 10;
}

function parseStartOfScan(
  bytes: Uint8Array,
  start: number,
  segmentLength: number,
  components: ReadonlyMap<number, number>,
  huffmanTables: ReadonlySet<string>,
): boolean {
  const count = bytes[start];
  if (
    count === undefined ||
    count < 1 ||
    count !== components.size ||
    segmentLength !== 6 + 2 * count
  )
    return false;
  const seen = new Set<number>();
  for (let index = 0; index < count; index += 1) {
    const id = bytes[start + 1 + index * 2];
    const selectors = bytes[start + 2 + index * 2];
    if (
      id === undefined ||
      selectors === undefined ||
      !components.has(id) ||
      seen.has(id)
    )
      return false;
    const dc = selectors >>> 4;
    const ac = selectors & 0x0f;
    if (
      dc > 3 ||
      ac > 3 ||
      !huffmanTables.has(`0:${dc}`) ||
      !huffmanTables.has(`1:${ac}`)
    )
      return false;
    seen.add(id);
  }
  const spectralStart = bytes[start + 1 + count * 2];
  const spectralEnd = bytes[start + 2 + count * 2];
  const approximation = bytes[start + 3 + count * 2];
  return (
    spectralStart !== undefined &&
    spectralEnd !== undefined &&
    approximation !== undefined &&
    spectralStart === 0 &&
    spectralEnd === 63 &&
    approximation === 0
  );
}

function hasOneBoundedEntropyScan(
  bytes: Uint8Array,
  start: number,
  restartInterval: number | undefined,
): boolean {
  let cursor = start;
  let entropyBytes = 0;
  let expectedRestart = 0xd0;
  while (cursor < bytes.length) {
    if (bytes[cursor] !== 0xff) {
      entropyBytes += 1;
      cursor += 1;
      continue;
    }
    cursor += 1;
    const marker = bytes[cursor];
    if (marker === undefined) return false;
    cursor += 1;
    if (marker === 0x00) {
      entropyBytes += 1;
      continue;
    }
    if (marker >= 0xd0 && marker <= 0xd7) {
      if (restartInterval === undefined || marker !== expectedRestart)
        return false;
      expectedRestart = expectedRestart === 0xd7 ? 0xd0 : expectedRestart + 1;
      continue;
    }
    return marker === 0xd9 && entropyBytes > 0 && cursor === bytes.length;
  }
  return false;
}

function isBaselineHuffmanSymbol(tableClass: number, symbol: number): boolean {
  if (tableClass === 0) return symbol <= 11;
  const run = symbol >>> 4;
  const size = symbol & 0x0f;
  if (size > 10) return false;
  // Baseline AC permits EOB (0x00), ZRL (0xf0), and non-zero magnitudes.
  return size !== 0 || run === 0 || run === 15;
}
