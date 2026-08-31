import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { temporaryDeleteAt } from "../media/retention-deadlines.js";
import type { RetentionRecord } from "../media/retention-scavenger.js";
import {
  MediaPipelineError,
  sniffMediaContainer,
  type MediaContainer,
  type MediaProbe,
} from "../media/probe.js";

export interface OpaqueMediaIdGenerator {
  next(): string;
}

const localMediaStorageCapabilities = new WeakSet<object>();

export type LocalMediaStorage = Readonly<{
  initialize(): Promise<void>;
  createUploadSession(input: UploadOptions): Promise<LocalMediaUploadSession>;
  store(
    input: Readonly<{
      source: AsyncIterable<Uint8Array>;
      maxBytes: number;
      validate?: (
        input: Readonly<{ bytes: number; probe: MediaProbe }>,
      ) => void | Promise<void>;
      retention: UploadOptions["retention"];
    }>,
  ): Promise<StoredLocalMedia>;
  delete(id: string): Promise<void>;
  deleteFrame(id: string): Promise<void>;
  deleteTemporary(id: string): Promise<void>;
  discoverReservedOrphans(
    limit: number,
  ): Promise<readonly Readonly<{ id: string; kind: "temporary" | "frame" }>[]>;
}>;

export type LocalMediaStorageInput = Readonly<{
  root: string;
  ids: OpaqueMediaIdGenerator;
  prober: LocalMediaProber;
  publisher?: NoReplacePublisher;
  cleanupLog?: UploadCleanupLog;
}>;

/** Runtime capability check used only by C5 composition; it never mints. */
export function isLocalMediaStorageCapability(
  value: unknown,
): value is LocalMediaStorage {
  return (
    typeof value === "object" &&
    value !== null &&
    localMediaStorageCapabilities.has(value)
  );
}

/** Process-backed probing stays injected so tests never require host FFprobe. */
export interface LocalMediaProber {
  probe(
    input: Readonly<{ filePath: string; magicContainer: MediaContainer }>,
  ): Promise<MediaProbe>;
}

/** A durable cleanup fact is created before an exclusive temporary is usable. */
export interface UploadRetentionRepository {
  schedule(
    input: Readonly<{
      id: string;
      attemptId: string;
      kind: "temporary";
      deleteAt: string;
    }>,
  ): Promise<RetentionScheduleResult>;
  acknowledge(record: RetentionRecord): Promise<void>;
}

/** Scheduling must identify whether the current writer owns this fact. */
export type RetentionScheduleResult = Readonly<{
  kind: "created" | "existing-owned" | "conflict";
}>;

export interface UploadCleanupLog {
  event(
    event: Readonly<{
      category: "retention_cleanup_failed";
      attempt: string;
      resource: string;
    }>,
  ): void;
}

/**
 * The publisher is the only visibility boundary. Production reserves an
 * opaque final directory then atomically renames its private payload; tests
 * can inject ambiguous post-publication failures without exposing paths.
 */
export interface NoReplacePublisher {
  publish(
    input: Readonly<{
      temporaryPath: string;
      finalDirectory: string;
      payloadPath: string;
      ownerToken: string;
    }>,
  ): Promise<void>;
}

export type StoredLocalMedia = Readonly<{
  id: string;
  bytes: number;
  contentType: "video/mp4" | "video/quicktime" | "video/webm";
  sha256: string;
  probe: MediaProbe;
  transitionResourceId: string;
}>;

export type StagedLocalMedia = Readonly<{
  id: string;
  bytes: number;
  contentType: "video/mp4" | "video/quicktime" | "video/webm";
  sha256: string;
  probe: MediaProbe;
  transitionResourceId: string;
}>;

export interface LocalMediaUploadSession {
  write(chunk: Uint8Array): Promise<void>;
  inspect(): Promise<StagedLocalMedia>;
  publish(): Promise<StoredLocalMedia>;
  commit(): Promise<StoredLocalMedia>;
  abort(): Promise<void>;
}

type UploadOptions = Readonly<{
  maxBytes: number;
  validate?: (
    input: Readonly<{ bytes: number; probe: MediaProbe }>,
  ) => void | Promise<void>;
  retention: Readonly<{
    repository: UploadRetentionRepository;
    attemptId: string;
    createdAt: string;
  }>;
}>;

/**
 * The only storage constructor exported by C5. The returned object has no
 * prototype methods to override and is registered by identity for composition.
 */
export function createLocalMediaStorage(
  input: LocalMediaStorageInput,
): LocalMediaStorage {
  const implementation = new LocalMediaStorageImplementation(input);
  const capability: LocalMediaStorage = Object.freeze({
    initialize: () => implementation.initialize(),
    createUploadSession: (options) =>
      implementation.createUploadSession(options),
    store: (options) => implementation.store(options),
    delete: (id) => implementation.delete(id),
    deleteFrame: (id) => implementation.deleteFrame(id),
    deleteTemporary: (id) => implementation.deleteTemporary(id),
    discoverReservedOrphans: (limit) =>
      implementation.discoverReservedOrphans(limit),
  });
  localMediaStorageCapabilities.add(capability);
  return capability;
}

/** Paths remain private to this unexported implementation. */
class LocalMediaStorageImplementation {
  private readonly root: string;
  private readonly originals: string;
  private readonly frames: string;
  private readonly temporary: string;
  private readonly ids: OpaqueMediaIdGenerator;
  private readonly prober: LocalMediaProber;
  private readonly publisher: NoReplacePublisher;
  private readonly cleanupLog: UploadCleanupLog | undefined;

  public constructor(input: LocalMediaStorageInput) {
    this.root = resolve(input.root);
    this.originals = join(this.root, "originals");
    this.frames = join(this.root, "frames");
    this.temporary = join(this.root, "temporary");
    this.ids = input.ids;
    this.prober = input.prober;
    this.publisher = input.publisher ?? { publish: publishNoReplace };
    this.cleanupLog = input.cleanupLog;
  }

  public async initialize(): Promise<void> {
    try {
      await ensurePrivateDirectory(this.root);
      await ensurePrivateDirectory(this.originals);
      await ensurePrivateDirectory(this.frames);
      await ensurePrivateDirectory(this.temporary);
    } catch {
      throw new MediaPipelineError("media_probe_failed");
    }
  }

  public async createUploadSession(
    input: UploadOptions,
  ): Promise<LocalMediaUploadSession> {
    if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes < 1)
      throw new MediaPipelineError("media_too_large");
    await this.initialize();
    const id = this.ids.next();
    if (!isOpaqueUuid(id)) throw new MediaPipelineError("media_probe_failed");
    // Owning this final directory is the no-replace boundary. A payload rename
    // inside a freshly-reserved directory is atomic and cannot replace another
    // upload's opaque id.
    const finalDirectory = this.safePath(this.originals, id);
    const finalPath = this.safePath(finalDirectory, "payload");
    const temporaryPath = this.safePath(this.temporary, `${id}.uploading`);
    if (await pathExists(finalDirectory))
      throw new MediaPipelineError("media_probe_failed");
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      // The transition fact exists before a byte path can be created. Until an
      // attachment installs the durable original-retention fact, this one fact
      // covers both possible names (temporary and final).
      const scheduled = await input.retention.repository.schedule({
        id,
        attemptId: input.retention.attemptId,
        kind: "temporary",
        deleteAt: temporaryDeleteAt(input.retention.createdAt),
      });
      if (scheduled.kind === "conflict")
        throw new MediaPipelineError("media_probe_failed");
      handle = await open(
        temporaryPath,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      await handle.chmod(0o600);
    } catch (error) {
      await handle?.close().catch(() => undefined);
      // An EEXIST path can only belong to another operation. Do not remove it.
      if (handle) await removeQuietly(temporaryPath);
      if (error instanceof MediaPipelineError) throw error;
      throw new MediaPipelineError("media_probe_failed");
    }
    return new LocalUploadSession({
      id,
      finalDirectory,
      finalPath,
      temporaryPath,
      handle,
      options: input,
      prober: this.prober,
      publisher: this.publisher,
      cleanupLog: this.cleanupLog,
    });
  }

  public async store(
    input: Readonly<{
      source: AsyncIterable<Uint8Array>;
      maxBytes: number;
      validate?: (
        input: Readonly<{ bytes: number; probe: MediaProbe }>,
      ) => void | Promise<void>;
      retention: UploadOptions["retention"];
    }>,
  ): Promise<StoredLocalMedia> {
    const session = await this.createUploadSession(input);
    try {
      for await (const chunk of input.source) await session.write(chunk);
      return await session.commit();
    } catch (error) {
      await session.abort();
      throw error;
    }
  }

  public async delete(id: string): Promise<void> {
    if (!isOpaqueUuid(id)) return;
    await removeStrict(this.safePath(this.originals, id));
  }

  public async deleteFrame(id: string): Promise<void> {
    if (!isOpaqueUuid(id)) return;
    await removeStrict(this.safePath(this.frames, id));
    await removeStrict(this.safePath(this.temporary, `${id}.frames`));
  }

  public async deleteTemporary(id: string): Promise<void> {
    if (!isOpaqueUuid(id)) return;
    await removeStrict(this.safePath(this.temporary, `${id}.uploading`));
    // A transition record may survive an interrupted publication, where the
    // bytes are already at the final name but no original fact exists yet.
    await removeStrict(this.safePath(this.originals, id));
  }

  /** Bounded restart reconciliation input; callers resolve opaque IDs to facts. */
  public async discoverReservedOrphans(
    limit: number,
  ): Promise<readonly Readonly<{ id: string; kind: "temporary" | "frame" }>[]> {
    if (!Number.isSafeInteger(limit) || limit < 1)
      throw new MediaPipelineError("media_probe_failed");
    await this.initialize();
    const found: Array<Readonly<{ id: string; kind: "temporary" | "frame" }>> =
      [];
    for (const name of (await readdir(this.temporary)).sort()) {
      const temporary = /^([0-9a-f-]{36})\.uploading$/i.exec(name);
      const frame = /^([0-9a-f-]{36})\.frames$/i.exec(name);
      const match = temporary ?? frame;
      if (!match || !isOpaqueUuid(match[1]!)) continue;
      found.push(
        Object.freeze({
          id: match[1]!,
          kind: temporary ? "temporary" : "frame",
        }),
      );
      if (found.length === limit) break;
    }
    return Object.freeze(found);
  }

  private safePath(directory: string, name: string): string {
    if (basename(name) !== name)
      throw new MediaPipelineError("media_probe_failed");
    const target = resolve(directory, name);
    if (!target.startsWith(`${directory}/`))
      throw new MediaPipelineError("media_probe_failed");
    return target;
  }
}

class LocalUploadSession implements LocalMediaUploadSession {
  private readonly digest = createHash("sha256");
  private readonly magic = new Uint8Array(4096);
  private magicLength = 0;
  private bytes = 0;
  private handle: Awaited<ReturnType<typeof open>> | undefined;
  private settled = false;
  private inspected: StagedLocalMedia | undefined;
  private readonly ownerToken = randomUUID();

  public constructor(
    private readonly state: Readonly<{
      id: string;
      finalDirectory: string;
      finalPath: string;
      temporaryPath: string;
      handle: Awaited<ReturnType<typeof open>>;
      options: UploadOptions;
      prober: LocalMediaProber;
      publisher: NoReplacePublisher;
      cleanupLog: UploadCleanupLog | undefined;
    }>,
  ) {
    this.handle = state.handle;
  }

  public async write(chunk: Uint8Array): Promise<void> {
    if (this.settled || !this.handle || !(chunk instanceof Uint8Array))
      throw new MediaPipelineError("media_probe_failed");
    if (chunk.length > this.state.options.maxBytes - this.bytes)
      throw new MediaPipelineError("media_too_large");
    this.bytes += chunk.length;
    this.digest.update(chunk);
    if (this.magicLength < this.magic.length) {
      const copied = Math.min(
        chunk.length,
        this.magic.length - this.magicLength,
      );
      this.magic.set(chunk.subarray(0, copied), this.magicLength);
      this.magicLength += copied;
    }
    try {
      await this.handle.write(chunk);
    } catch {
      throw new MediaPipelineError("media_probe_failed");
    }
  }

  public async inspect(): Promise<StagedLocalMedia> {
    if (this.settled) throw new MediaPipelineError("media_probe_failed");
    if (this.inspected) return this.inspected;
    if (!this.handle) throw new MediaPipelineError("media_probe_failed");
    try {
      if (this.bytes === 0) throw new MediaPipelineError("media_empty");
      await this.handle.close();
      this.handle = undefined;
      const magicContainer = sniffMediaContainer(
        this.magic.subarray(0, this.magicLength),
      );
      const probe = await this.state.prober.probe({
        filePath: this.state.temporaryPath,
        magicContainer,
      });
      if (probe.container !== magicContainer)
        throw new MediaPipelineError("media_container_not_allowed");
      await this.state.options.validate?.(
        Object.freeze({
          bytes: this.bytes,
          probe: Object.freeze({ ...probe }),
        }),
      );
      await chmod(this.state.temporaryPath, 0o600);
      this.inspected = Object.freeze({
        id: this.state.id,
        bytes: this.bytes,
        contentType: contentTypeFor(magicContainer),
        sha256: this.digest.digest("hex"),
        probe: Object.freeze({ ...probe }),
        transitionResourceId: this.state.id,
      });
      return this.inspected;
    } catch (error) {
      await this.abort();
      if (error instanceof MediaPipelineError) throw error;
      throw new MediaPipelineError("media_probe_failed");
    }
  }

  public async publish(): Promise<StoredLocalMedia> {
    const inspected = await this.inspect();
    try {
      await this.state.publisher.publish({
        temporaryPath: this.state.temporaryPath,
        finalDirectory: this.state.finalDirectory,
        payloadPath: this.state.finalPath,
        ownerToken: this.ownerToken,
      });
      // The publisher performs the atomic move; missing temp is expected.
      await unlink(this.state.temporaryPath).catch((error: unknown) => {
        if (isNotFound(error)) return;
        throw error;
      });
      this.settled = true;
      return inspected;
    } catch {
      await this.abort();
      throw new MediaPipelineError("media_probe_failed");
    }
  }

  public async commit(): Promise<StoredLocalMedia> {
    await this.inspect();
    return this.publish();
  }

  public async abort(): Promise<void> {
    if (this.settled) return;
    this.settled = true;
    await this.handle?.close().catch(() => undefined);
    this.handle = undefined;
    try {
      await removeStrict(this.state.temporaryPath);
      const publicationClean = await removeOwnedPublication(
        this.state.finalDirectory,
        this.state.finalPath,
        this.ownerToken,
      );
      if (!publicationClean)
        throw new Error("publication ownership is ambiguous");
      await this.acknowledgeTemporary();
    } catch {
      this.state.cleanupLog?.event({
        category: "retention_cleanup_failed",
        attempt: redact(this.state.options.retention.attemptId),
        resource: redact(this.state.id),
      });
    }
  }

  private async acknowledgeTemporary(): Promise<void> {
    const retention = this.state.options.retention;
    await retention.repository.acknowledge({
      id: this.state.id,
      attemptId: retention.attemptId,
      kind: "temporary",
      deleteAt: temporaryDeleteAt(retention.createdAt),
      cleanupRequestedAt: null,
    });
  }
}

function contentTypeFor(
  container: MediaContainer,
): "video/mp4" | "video/quicktime" | "video/webm" {
  if (container === "mov") return "video/quicktime";
  if (container === "webm") return "video/webm";
  return "video/mp4";
}

function isOpaqueUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

async function publishNoReplace(
  input: Readonly<{
    temporaryPath: string;
    finalDirectory: string;
    payloadPath: string;
    ownerToken: string;
  }>,
): Promise<void> {
  // mkdir is the exclusive ownership primitive. It never overwrites another
  // opaque media id; the payload move is then an atomic same-filesystem rename.
  await mkdir(input.finalDirectory, { mode: 0o700 });
  await chmod(input.finalDirectory, 0o700);
  await writeFile(join(input.finalDirectory, ".owner"), input.ownerToken, {
    mode: 0o600,
    flag: "wx",
  });
  await rename(input.temporaryPath, input.payloadPath);
  await chmod(input.payloadPath, 0o600);
  await unlink(join(input.finalDirectory, ".owner"));
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  const current = await lstat(directory).catch((error: unknown) => {
    if (isNotFound(error)) return null;
    throw error;
  });
  if (current && (!current.isDirectory() || current.isSymbolicLink()))
    throw new Error("unsafe media directory");
  if (!current) await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

async function removeStrict(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}

async function removeQuietly(path: string): Promise<void> {
  await removeStrict(path).catch(() => undefined);
}

async function removeOwnedPublication(
  directory: string,
  payloadPath: string,
  ownerToken: string,
): Promise<boolean> {
  try {
    const owner = await readFile(join(directory, ".owner"), "utf8");
    if (owner !== ownerToken) return false;
    await removeStrict(payloadPath);
    await removeStrict(directory);
    return true;
  } catch (error) {
    if (isNotFound(error)) return !(await pathExists(directory));
    throw error;
  }
}

function redact(value: string | undefined): string {
  return value?.slice(0, 8) ?? "unknown";
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
