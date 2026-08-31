import { isMediaProbeAdmissible, type MediaMode } from "./eligibility.js";
import { MediaPipelineError } from "./probe.js";
import type { ExtractionManifest } from "./extraction-manifest.js";
import {
  type AcceptedMediaCleanup,
  type AcceptedMediaHandoff,
  type AcceptedMediaHandoffVerifier,
} from "./accepted-media-handoff.js";
import {
  acceptSingleMediaPart,
  type MultipartIntake,
} from "./multipart-intake.js";
import {
  createStoredMediaAttachment,
  type MediaUploadContext,
} from "../repositories/attempt-repository.js";
import { originalOrFrameDeleteAt } from "./retention-deadlines.js";
import { temporaryDeleteAt } from "./retention-deadlines.js";
import {
  LocalMediaStorage,
  isLocalMediaStorageCapability,
  type LocalMediaUploadSession,
  type StoredLocalMedia,
  type UploadRetentionRepository,
} from "../storage/local-media-storage.js";
import {
  LocalFrameExtraction,
  isLocalFrameExtractionCapability,
} from "../storage/local-frame-extraction.js";

/**
 * C5's acceptance result deliberately separates private evidence from its
 * six-field persistence attachment. The correlated values cross C5→C8 only
 * through the branded accepted-media handoff, never as caller-mixable fields.
 */
export type AcceptedMedia = AcceptedMediaHandoff &
  Readonly<{
    sha256: string;
    probe: StoredLocalMedia["probe"];
    manifest: ExtractionManifest;
  }>;

export type { AcceptedMediaCleanup } from "./accepted-media-handoff.js";

export type MediaPipelineAcceptanceInput = Readonly<{
  mode: MediaMode;
  source: AsyncIterable<Uint8Array>;
  maxBytes: number;
  retention: Readonly<{
    repository: UploadRetentionRepository;
    attemptId: string;
    generation: number;
    uploadedAt: string;
    authority: MediaUploadContext;
  }>;
}>;

export type MediaPipelineMultipartAcceptanceInput = Readonly<{
  mode: MediaMode;
  multipart: Omit<MultipartIntake, "createStage">;
  retention: MediaPipelineAcceptanceInput["retention"];
}>;

const c5HandoffVerifiers = new WeakSet<object>();

/** Only a real MediaPipeline can register a verifier in this private registry. */
export function isC5AcceptedMediaHandoffVerifier(
  value: unknown,
): value is AcceptedMediaHandoffVerifier {
  return (
    typeof value === "object" && value !== null && c5HandoffVerifiers.has(value)
  );
}

/**
 * The only public C5 boundary. Its concrete constructor remains private so a
 * structural object cannot acquire an attach-capable verifier or issuer.
 */
export interface C5MediaPipeline {
  handoffVerifier(): AcceptedMediaHandoffVerifier;
  accept(input: MediaPipelineAcceptanceInput): Promise<AcceptedMedia>;
  acceptMultipart(
    input: MediaPipelineMultipartAcceptanceInput,
  ): Promise<AcceptedMedia>;
}

/** C5-owned composition point. Both inputs are concrete runtime capabilities. */
export function createMediaPipeline(
  input: Readonly<{
    storage: LocalMediaStorage;
    extraction: LocalFrameExtraction;
  }>,
): C5MediaPipeline {
  if (
    !isLocalMediaStorageCapability(input.storage) ||
    !isLocalFrameExtractionCapability(input.extraction)
  )
    throw new Error("C5 media pipeline requires local storage and extraction.");
  return new MediaPipeline(input.storage, input.extraction);
}

/** The public acceptance capability cannot publish a probe-only upload. */
class MediaPipeline implements C5MediaPipeline {
  private readonly storage: LocalMediaStorage;
  private readonly extractor: LocalFrameExtraction;
  private readonly issuedHandoffs = new WeakSet<object>();
  private readonly verifier: AcceptedMediaHandoffVerifier;

  constructor(storage: LocalMediaStorage, extractor: LocalFrameExtraction) {
    this.storage = storage;
    this.extractor = extractor;
    this.verifier = Object.freeze({
      accepts: (value: unknown): value is AcceptedMediaHandoff =>
        typeof value === "object" &&
        value !== null &&
        this.issuedHandoffs.has(value),
    });
    c5HandoffVerifiers.add(this.verifier);
  }

  /** Composition gives C4 this verifier; no caller receives an issuer. */
  public handoffVerifier(): AcceptedMediaHandoffVerifier {
    return this.verifier;
  }

  public async accept(
    input: MediaPipelineAcceptanceInput,
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
    input: MediaPipelineMultipartAcceptanceInput,
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
        authority: MediaUploadContext;
      }>;
    }>,
  ): Promise<AcceptedMedia> {
    const staged = await input.session.inspect();
    const authority = input.retention.authority;
    let cleanup: AcceptedMediaCleanup | undefined;
    try {
      const manifest = await this.extractor.extract({
        mode: input.mode,
        attemptId: input.retention.attemptId,
        generation: input.retention.generation,
        mediaId: staged.id,
        mediaSha256: staged.sha256,
        probe: staged.probe,
        uploadedAt: input.retention.uploadedAt,
        source: "staged",
        authority: Object.freeze({
          athleteId: authority.athleteId,
          calibrationSessionId:
            authority.mode === "verified"
              ? authority.verified.calibrationSessionId
              : null,
          calibrationNonce:
            authority.mode === "verified"
              ? authority.verified.calibrationNonce
              : null,
        }),
      });
      if (
        manifest.attemptId !== authority.attemptId ||
        manifest.generation !== authority.generation ||
        manifest.mode !== authority.mode ||
        manifest.mediaId !== staged.id ||
        manifest.mediaSha256 !== staged.sha256
      )
        throw new MediaPipelineError("media_probe_failed");
      const receipt = this.extractor.durableReceiptFor(manifest);
      const processingContext = durableStorageContext(receipt);
      // Derive cleanup identifiers before the original can be published.
      cleanup = this.cleanupCapability(
        staged.id,
        processingContext.receipt.frameBatchId,
      );
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
      return this.issueAcceptedMedia({
        context: authority,
        storedMedia,
        sourceSha256: stored.sha256,
        processingContext,
        cleanup,
        sha256: stored.sha256,
        probe: stored.probe,
        manifest,
      });
    } catch (error) {
      if (cleanup) await cleanup.cleanup().catch(() => undefined);
      throw error;
    }
  }

  private cleanupCapability(
    mediaId: string,
    frameBatchId: string,
  ): AcceptedMediaCleanup {
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

  private issueAcceptedMedia<T extends AcceptedMediaHandoff>(input: T): T {
    const handoff = Object.freeze({ ...input });
    this.issuedHandoffs.add(handoff);
    return handoff;
  }
}

function durableStorageContext(
  input: Readonly<{
    frameBatchId: string;
    mediaId: string;
    sha256: string;
  }>,
) {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      input.frameBatchId,
    ) ||
    input.mediaId.length < 1 ||
    input.mediaId.length > 80 ||
    !/^[a-f0-9]{64}$/i.test(input.sha256)
  )
    throw new MediaPipelineError("media_probe_failed");
  return Object.freeze({
    kind: "c5-durable-processing-context-v2" as const,
    receipt: Object.freeze({ ...input }),
  });
}
