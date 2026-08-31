import { isMediaProbeAdmissible, type MediaMode } from "./eligibility.js";
import { MediaPipelineError } from "./probe.js";
import type { ExtractionManifest } from "./extraction-manifest.js";
import {
  createStoredMediaAttachment,
  type StoredMediaAttachment,
} from "../repositories/attempt-repository.js";
import { originalOrFrameDeleteAt } from "./retention-deadlines.js";
import { temporaryDeleteAt } from "./retention-deadlines.js";
import {
  LocalMediaStorage,
  type LocalMediaUploadSession,
  type StoredLocalMedia,
  type UploadRetentionRepository,
} from "../storage/local-media-storage.js";

/** C5 owns this seam; C8 may only provide process execution. */
export interface MediaEvidenceExtractor {
  extract(
    input: Readonly<{
      mode: MediaMode;
      attemptId: string;
      generation: number;
      mediaId: string;
      mediaSha256: string;
      probe: StoredLocalMedia["probe"];
      uploadedAt: string;
      source: "staged";
    }>,
  ): Promise<ExtractionManifest>;
}

/**
 * C5's acceptance result deliberately separates private evidence from its
 * six-field persistence attachment. `AcceptedMedia` therefore cannot be
 * structurally passed to `AttemptService.attachValidatedMedia`: only the
 * explicitly named, canonical `storedMedia` value crosses that boundary.
 */
export type AcceptedMedia = Readonly<{
  storedMedia: StoredMediaAttachment;
  sha256: string;
  probe: StoredLocalMedia["probe"];
  manifest: ExtractionManifest;
}>;

/** The public acceptance capability cannot publish a probe-only upload. */
export class MediaPipeline {
  private readonly storage: LocalMediaStorage;
  private readonly extractor: MediaEvidenceExtractor;

  public constructor(
    input: Readonly<{
      storage: LocalMediaStorage;
      extractor: MediaEvidenceExtractor;
    }>,
  ) {
    this.storage = input.storage;
    this.extractor = input.extractor;
  }

  public async accept(
    input: Readonly<{
      mode: MediaMode;
      source: AsyncIterable<Uint8Array>;
      maxBytes: number;
      retention: Readonly<{
        repository: UploadRetentionRepository;
        attemptId: string;
        generation: number;
        uploadedAt: string;
      }>;
    }>,
  ): Promise<AcceptedMedia> {
    const session = await this.openUpload({
      mode: input.mode,
      maxBytes: input.maxBytes,
      retention: {
        repository: input.retention.repository,
        attemptId: input.retention.attemptId,
        createdAt: input.retention.uploadedAt,
      },
    });
    try {
      for await (const chunk of input.source) await session.write(chunk);
      const staged = await session.inspect();
      const manifest = await this.extractor.extract({
        mode: input.mode,
        attemptId: input.retention.attemptId,
        generation: input.retention.generation,
        mediaId: staged.id,
        mediaSha256: staged.sha256,
        probe: staged.probe,
        uploadedAt: input.retention.uploadedAt,
        source: "staged",
      });
      const stored = await session.publish();
      const storedMedia = createStoredMediaAttachment({
        id: stored.id,
        contentType: stored.contentType,
        bytes: stored.bytes,
        uploadedAt: input.retention.uploadedAt,
        deleteAt: originalOrFrameDeleteAt(input.retention.uploadedAt),
        transition: Object.freeze({
          kind: "upload-transition" as const,
          resourceId: stored.id,
          deleteAt: temporaryDeleteAt(input.retention.uploadedAt),
        }),
      });
      return Object.freeze({
        storedMedia,
        sha256: stored.sha256,
        probe: stored.probe,
        manifest,
      });
    } catch (error) {
      await session.abort();
      throw error;
    }
  }

  /** One storage-backed upload session hidden behind C5 acceptance. */
  private async openUpload(
    input: Readonly<{
      mode: MediaMode;
      maxBytes: number;
      retention: Readonly<{
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
