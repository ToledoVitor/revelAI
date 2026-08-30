import { isMediaProbeAdmissible, type MediaMode } from "./eligibility.js";
import { MediaPipelineError } from "./probe.js";
import {
  LocalMediaStorage,
  type LocalMediaUploadSession,
  type StoredLocalMedia,
  type UploadRetentionRepository,
} from "../storage/local-media-storage.js";

/** C5 orchestration: byte/probe eligibility only; no integrity or score facts. */
export class MediaPipeline {
  private readonly storage: LocalMediaStorage;

  public constructor(input: Readonly<{ storage: LocalMediaStorage }>) {
    this.storage = input.storage;
  }

  public async accept(
    input: Readonly<{
      mode: MediaMode;
      source: AsyncIterable<Uint8Array>;
      maxBytes: number;
    }>,
  ): Promise<StoredLocalMedia> {
    const session = await this.openUpload(input);
    try {
      for await (const chunk of input.source) await session.write(chunk);
      return await session.commit();
    } catch (error) {
      await session.abort();
      throw error;
    }
  }

  /** One storage-backed upload session; callers cannot publish pre-validation. */
  public async openUpload(
    input: Readonly<{
      mode: MediaMode;
      maxBytes: number;
      retention?: Readonly<{
        repository: UploadRetentionRepository;
        attemptId: string;
        createdAt: string;
      }>;
    }>,
  ): Promise<LocalMediaUploadSession> {
    return this.storage.createUploadSession({
      maxBytes: input.maxBytes,
      retention: input.retention,
      validate: ({ probe }) => {
        if (!isMediaProbeAdmissible(input.mode, probe))
          throw new MediaPipelineError("media_requirements_not_met");
      },
    });
  }
}
