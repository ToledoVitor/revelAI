import type {
  MediaAttachmentRecoveryClaim,
  MediaDeliveryRecovery,
} from "../repositories/attempt-repository.js";

/** C5 receives only opaque identifiers; this port cannot reveal a path. */
export interface OpaqueAcceptedMediaCleaner {
  cleanup(
    input: Readonly<{ mediaId: string; frameBatchId: string }>,
  ): Promise<void>;
}

export interface MediaAttachmentRecoveryRepository {
  claimMediaAttachmentRecovery(
    input: Readonly<{ now: string; limit: number }>,
  ): Promise<readonly MediaAttachmentRecoveryClaim[]>;
  rollbackMediaAttachment(
    input: Readonly<{ attemptId: string; generation: number }>,
  ): Promise<void>;
  acknowledgeMediaAttachmentCleanup(
    input: Readonly<{ attemptId: string; generation: number; mediaId: string }>,
  ): Promise<void>;
  releaseMediaAttachmentRecovery(
    input: Readonly<{ attemptId: string; generation: number; leaseId: string }>,
  ): Promise<void>;
}

export interface MediaAttachmentRecoveryLog {
  event(
    input: Readonly<{
      category: "media_attachment_recovery_failed";
      attempt: string;
      generation: number;
    }>,
  ): void;
}

/**
 * Bounded durable compensation executor. C4 owns state transitions and C5
 * owns byte deletion; a failure keeps the leased journal item retriable.
 */
export class MediaAttachmentRecoveryExecutor {
  public constructor(
    private readonly repository: MediaAttachmentRecoveryRepository,
    private readonly cleaner: OpaqueAcceptedMediaCleaner,
    private readonly log: MediaAttachmentRecoveryLog,
  ) {}

  public async run(
    input: Readonly<{ now: string; limit: number }>,
  ): Promise<number> {
    const claims = await this.repository.claimMediaAttachmentRecovery(input);
    let completed = 0;
    for (const claim of claims) {
      if (await this.reconcile(claim)) completed += 1;
    }
    return completed;
  }

  private async reconcile(
    claim: MediaAttachmentRecoveryClaim,
  ): Promise<boolean> {
    try {
      if (claim.requiresRollback)
        await this.repository.rollbackMediaAttachment({
          attemptId: claim.attemptId,
          generation: claim.generation,
        });
      await this.cleaner.cleanup({
        mediaId: claim.mediaId,
        frameBatchId: claim.frameBatchId,
      });
      await this.repository.acknowledgeMediaAttachmentCleanup({
        attemptId: claim.attemptId,
        generation: claim.generation,
        mediaId: claim.mediaId,
      });
      return true;
    } catch {
      this.logFailure(claim);
      return false;
    } finally {
      await this.repository
        .releaseMediaAttachmentRecovery({
          attemptId: claim.attemptId,
          generation: claim.generation,
          leaseId: claim.leaseId,
        })
        .catch(() => this.logFailure(claim));
    }
  }

  private logFailure(claim: MediaDeliveryRecovery): void {
    try {
      this.log.event(
        Object.freeze({
          category: "media_attachment_recovery_failed" as const,
          attempt: claim.attemptId.slice(0, 8),
          generation: claim.generation,
        }),
      );
    } catch {
      // A logger cannot break retry safety or create an unhandled rejection.
    }
  }
}
