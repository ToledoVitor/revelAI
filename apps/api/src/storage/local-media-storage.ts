import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, link, lstat, mkdir, open, rm, unlink } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import {
  MediaPipelineError,
  sniffMediaContainer,
  type MediaContainer,
  type MediaProbe,
} from "../media/probe.js";

export interface OpaqueMediaIdGenerator {
  next(): string;
}

/** Process-backed probing stays injected so tests never require host FFprobe. */
export interface LocalMediaProber {
  probe(
    input: Readonly<{ filePath: string; magicContainer: MediaContainer }>,
  ): Promise<MediaProbe>;
}

export type StoredLocalMedia = Readonly<{
  id: string;
  bytes: number;
  contentType: "video/mp4" | "video/quicktime" | "video/webm";
  sha256: string;
  probe: MediaProbe;
}>;

/**
 * Local-only media capability. Paths never leave this module's storage API.
 * Publication uses a hard-link + unlink sequence, so an existing target can
 * never be replaced between validation and visibility.
 */
export class LocalMediaStorage {
  private readonly root: string;
  private readonly originals: string;
  private readonly frames: string;
  private readonly temporary: string;
  private readonly ids: OpaqueMediaIdGenerator;
  private readonly prober: LocalMediaProber;

  public constructor(
    input: Readonly<{
      root: string;
      ids: OpaqueMediaIdGenerator;
      prober: LocalMediaProber;
    }>,
  ) {
    this.root = resolve(input.root);
    this.originals = join(this.root, "originals");
    this.frames = join(this.root, "frames");
    this.temporary = join(this.root, "temporary");
    this.ids = input.ids;
    this.prober = input.prober;
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

  public async store(
    input: Readonly<{
      source: AsyncIterable<Uint8Array>;
      maxBytes: number;
      validate?: (
        input: Readonly<{ bytes: number; probe: MediaProbe }>,
      ) => void | Promise<void>;
    }>,
  ): Promise<StoredLocalMedia> {
    if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes < 1)
      throw new MediaPipelineError("media_too_large");
    await this.initialize();
    const id = this.ids.next();
    if (!isOpaqueUuid(id)) throw new MediaPipelineError("media_probe_failed");
    const target = this.safePath(this.originals, id);
    const temporary = this.safePath(this.temporary, `${id}.uploading`);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    let published = false;
    try {
      if (await pathExists(target))
        throw new MediaPipelineError("media_probe_failed");
      handle = await open(
        temporary,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      await handle.chmod(0o600);
      const digest = createHash("sha256");
      const magic = new Uint8Array(4096);
      let magicLength = 0;
      let bytes = 0;
      for await (const chunk of input.source) {
        if (!(chunk instanceof Uint8Array))
          throw new MediaPipelineError("media_probe_failed");
        if (chunk.length > input.maxBytes - bytes)
          throw new MediaPipelineError("media_too_large");
        bytes += chunk.length;
        digest.update(chunk);
        if (magicLength < magic.length) {
          const copied = Math.min(chunk.length, magic.length - magicLength);
          magic.set(chunk.subarray(0, copied), magicLength);
          magicLength += copied;
        }
        await handle.write(chunk);
      }
      if (bytes === 0) throw new MediaPipelineError("media_empty");
      await handle.close();
      handle = undefined;
      const magicContainer = sniffMediaContainer(
        magic.subarray(0, magicLength),
      );
      const probe = await this.prober.probe({
        filePath: temporary,
        magicContainer,
      });
      if (probe.container !== magicContainer)
        throw new MediaPipelineError("media_container_not_allowed");
      await input.validate?.(
        Object.freeze({ bytes, probe: Object.freeze({ ...probe }) }),
      );
      if (await pathExists(target))
        throw new MediaPipelineError("media_probe_failed");
      await link(temporary, target);
      await chmod(target, 0o600);
      await unlink(temporary);
      published = true;
      return Object.freeze({
        id,
        bytes,
        contentType: contentTypeFor(magicContainer),
        sha256: digest.digest("hex"),
        probe: Object.freeze({ ...probe }),
      });
    } catch (error) {
      if (error instanceof MediaPipelineError) throw error;
      throw new MediaPipelineError("media_probe_failed");
    } finally {
      await handle?.close().catch(() => undefined);
      if (!published) await removeQuietly(temporary);
    }
  }

  public async delete(id: string): Promise<void> {
    if (!isOpaqueUuid(id)) return;
    await removeQuietly(this.safePath(this.originals, id));
  }

  public async deleteFrame(id: string): Promise<void> {
    if (!isOpaqueUuid(id)) return;
    await removeQuietly(this.safePath(this.frames, id));
  }

  public async deleteTemporary(id: string): Promise<void> {
    if (!isOpaqueUuid(id)) return;
    await removeQuietly(this.safePath(this.temporary, `${id}.uploading`));
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

async function removeQuietly(path: string): Promise<void> {
  await rm(path, { force: true }).catch(() => undefined);
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
