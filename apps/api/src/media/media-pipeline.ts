import { isMediaProbeAdmissible, type MediaMode } from "./eligibility.js";
import { MediaPipelineError } from "./probe.js";
import {
  createDurableProcessingContext,
  type DurableProcessingContext,
  type ExtractionManifest,
} from "./extraction-manifest.js";
import {
  acceptSingleMediaPart,
  type MultipartIntake,
} from "./multipart-intake.js";
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
  processingContext: DurableProcessingContext;
  cleanup: AcceptedMediaCleanup;
}>;

/** Opaque C5 cleanup capability: callers can request cleanup but never paths. */
export type AcceptedMediaCleanup = Readonly<{
  cleanup(): Promise<void>;
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
      return await this.finalizeAcceptedSession({
        mode: input.mode,
        session,
        retention: input.retention,
      });
    } catch (error) {
      await session.abort();
      throw error;
    }
  }

  /**
   * Framework-neutral multipart bridge. Shape validation writes directly to
   * this pipeline's one C5 session, so media is never buffered or staged
   * twice before sniff/probe/extraction/publication.
   */
  public async acceptMultipart(
    input: Readonly<{
      mode: MediaMode;
      multipart: Omit<MultipartIntake, "createStage">;
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
      maxBytes: input.multipart.maxUploadBytes,
      retention: {
        repository: input.retention.repository,
        attemptId: input.retention.attemptId,
        createdAt: input.retention.uploadedAt,
      },
    });
    try {
      await acceptSingleMediaPart({
        ...input.multipart,
        createStage: async () => session,
      });
      return await this.finalizeAcceptedSession({
        mode: input.mode,
        session,
        retention: input.retention,
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

  private async finalizeAcceptedSession(
    input: Readonly<{
      mode: MediaMode;
      session: LocalMediaUploadSession;
      retention: Readonly<{
        attemptId: string;
        generation: number;
        uploadedAt: string;
      }>;
    }>,
  ): Promise<AcceptedMedia> {
    const staged = await input.session.inspect();
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
    const processingContext = createDurableProcessingContext(manifest);
    const stored = await input.session.publish();
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
      processingContext,
      cleanup: this.cleanupCapability(stored.id, manifest),
    });
  }

  private cleanupCapability(
    mediaId: string,
    manifest: ExtractionManifest,
  ): AcceptedMediaCleanup {
    const frameBatchId = frameBatchIdentifier(manifest);
    return Object.freeze({
      cleanup: async () => {
        const outcomes = await Promise.allSettled([
          this.storage.delete(mediaId),
          this.storage.deleteFrame(frameBatchId),
        ]);
        if (outcomes.some((outcome) => outcome.status === "rejected"))
          throw new MediaPipelineError("media_probe_failed");
      },
    });
  }
}

function frameBatchIdentifier(manifest: ExtractionManifest): string {
  const reference = manifest.frames.items[0]?.reference;
  const match = /^([0-9a-f-]{36})_\d{4}$/i.exec(reference ?? "");
  if (!match) throw new MediaPipelineError("media_probe_failed");
  return match[1]!;
}
