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
      authority: Readonly<{
        athleteId: string;
        calibrationSessionId: string | null;
        calibrationNonce: string | null;
      }>;
    }>,
  ): Promise<ExtractionManifest>;
  /**
   * The extractor owns this reference and returns it only for its exact
   * published manifest. C8 gets neither an issuer nor receipt bytes here.
   */
  durableReceiptFor(
    manifest: ExtractionManifest,
  ): Readonly<{ frameBatchId: string; mediaId: string; sha256: string }>;
}

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

const c5HandoffVerifiers = new WeakSet<object>();

/** Only a real MediaPipeline can register a verifier in this private registry. */
export function isC5AcceptedMediaHandoffVerifier(
  value: unknown,
): value is AcceptedMediaHandoffVerifier {
  return (
    typeof value === "object" && value !== null && c5HandoffVerifiers.has(value)
  );
}

/** The public acceptance capability cannot publish a probe-only upload. */
export class MediaPipeline {
  private readonly storage: LocalMediaStorage;
  private readonly extractor: MediaEvidenceExtractor;
  private readonly issuedHandoffs = new WeakSet<object>();
  private readonly verifier: AcceptedMediaHandoffVerifier;

  public constructor(
    input: Readonly<{
      storage: LocalMediaStorage;
      extractor: MediaEvidenceExtractor;
    }>,
  ) {
    this.storage = input.storage;
    this.extractor = input.extractor;
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
    input: Readonly<{
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
        authority: MediaUploadContext;
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
