import type {
  AttemptMode,
  AttemptOutcome,
  CreateAttemptInput,
  FreeInsight,
  VerifiedResult,
} from "@revelai/contracts";
import type { DurableProcessingContext } from "../media/extraction-manifest.js";
import type { AcceptedMediaHandoff } from "../media/accepted-media-handoff.js";
import type { AnalysisJob } from "../queue/analysis-queue.js";

export type RepositoryErrorCode =
  | "attempt_not_found"
  | "duplicate_media_upload"
  | "invalid_attempt_transition"
  | "calibration_session_not_found"
  | "calibration_session_expired"
  | "calibration_session_not_ready"
  | "calibration_session_consumed"
  | "calibration_session_challenge_mismatch"
  | "invalid_terminal_outcome"
  | "terminal_result_conflict"
  | "invalid_input"
  | "idempotency_key_conflict"
  | "persisted_data_corrupt";

/** Safe repository-port error; HTTP maps only its allowlisted public codes. */
export class RepositoryError extends Error {
  public constructor(public readonly code: RepositoryErrorCode) {
    super(code);
    this.name = "RepositoryError";
  }
}

export type StoredMedia = Readonly<{
  id: string;
  contentType: string;
  bytes: number;
  /** Canonical C5 publish time; retention deadlines derive only from it. */
  uploadedAt: string;
  deleteAt: string;
  /**
   * Durable temporary coverage created by C5 before bytes are staged. Its
   * resource identity is deliberately the media identity: no caller can swap
   * cleanup facts between uploads.
   */
  transition: Readonly<{
    kind: "upload-transition";
    resourceId: string;
    deleteAt: string;
  }>;
}>;

/**
 * Non-enumerable capability marker. It is absent from persisted JSON, but
 * makes C5's attachment handoff unconstructable by structural coincidence.
 */
const storedMediaAttachmentBrand: unique symbol = Symbol(
  "revelai.stored-media-attachment",
);

export type StoredMediaAttachment = StoredMedia &
  Readonly<{ [storedMediaAttachmentBrand]: true }>;

export function createStoredMediaAttachment(
  media: StoredMedia,
): StoredMediaAttachment {
  const copied: StoredMedia = {
    id: media.id,
    contentType: media.contentType,
    bytes: media.bytes,
    uploadedAt: media.uploadedAt,
    deleteAt: media.deleteAt,
    transition: Object.freeze({
      kind: media.transition.kind,
      resourceId: media.transition.resourceId,
      deleteAt: media.transition.deleteAt,
    }),
  };
  Object.defineProperty(copied, storedMediaAttachmentBrand, {
    value: true,
    enumerable: false,
  });
  return Object.freeze(copied) as StoredMediaAttachment;
}

export function isStoredMediaAttachment(
  value: unknown,
): value is StoredMediaAttachment {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<PropertyKey, unknown>)[storedMediaAttachmentBrand] === true
  );
}

export type CalibrationSessionRecord = Readonly<{
  id: string;
  challengeId: "wall-pass";
  challengeVersion: 1;
  state: "issued" | "ready";
  nonce: string;
  issuedAt: string;
  expiresAt: string;
  requiredGates: readonly ["device", "space", "athlete", "rehearsal", "record"];
}>;

export type AttemptRecord = Readonly<{
  id: string;
  athleteId: string;
  mode: AttemptMode;
  status:
    | "awaiting-upload"
    | "uploaded"
    | "processing"
    | "valid"
    | "invalid"
    | "failed";
  createdAt: string;
  outcome: AttemptOutcome;
  challenge: Readonly<{ id: "wall-pass"; version: 1 }> | null;
  media: StoredMedia | null;
}>;

export type ProcessingClaim = Readonly<{
  leaseId: string;
  generation: number;
  mode: AttemptMode;
}>;

/**
 * Internal, identity-scoped upload authority. This never crosses an HTTP
 * boundary; C5 receives it before extraction and C4 validates it at attach.
 */
export type MediaUploadContext =
  | Readonly<{
      attemptId: string;
      athleteId: string;
      mode: "free";
      generation: number;
      uploadedAt: string;
      verified: null;
    }>
  | Readonly<{
      attemptId: string;
      athleteId: string;
      mode: "verified";
      generation: number;
      uploadedAt: string;
      verified: Readonly<{
        challenge: Readonly<{ id: "wall-pass"; version: 1 }>;
        calibrationSessionId: string;
        calibrationNonce: string;
      }>;
    }>;

/** C4 persists this C5-issued, path-free evidence only after exact attach. */
export type PersistedProcessingContext = Readonly<{
  upload: MediaUploadContext;
  processing: DurableProcessingContext;
  /** C4-owned column, independently matched to JSON and C5's receipt. */
  sourceSha256: string;
}>;

/** C3-compatible, cursor-paginated public projection with no athlete fields. */
export type LiveLeaderboardPageInput = Readonly<{
  challenge: Readonly<{
    id: "wall-pass";
    version: 1;
    ruleVersion: "wall-pass-v1-score-1";
  }>;
  limit: number;
  cursor?: string;
}>;

export type LiveLeaderboardPage = Readonly<{
  entries: readonly Readonly<{
    entryId: string;
    rank: number;
    score: number;
    completedAt: string;
  }>[];
  /** C4's authenticated first-page cutoff or the cursor's bound cutoff. */
  calculatedAt: string;
  cohortSize: number;
  nextCursor: string | null;
}>;

export type FinalizedAttempt = Readonly<{
  attempt: AttemptRecord;
  outcome: AttemptOutcome;
}>;

/**
 * Finalization is intentionally not nullable: queue consumers must know
 * whether a delivery stored a fact, found an idempotent fact, or lost its
 * right to complete the claim.
 */
export type FinalizeTerminalResultOutcome =
  | Readonly<{ kind: "finalized"; finalized: FinalizedAttempt }>
  | Readonly<{ kind: "idempotent"; finalized: FinalizedAttempt }>
  | Readonly<{ kind: "tombstoned" }>
  | Readonly<{ kind: "lost-claim" }>;

/** Persisted retry counter for a single attachment generation. */
export type ProcessingFailureRecordOutcome =
  | Readonly<{ kind: "recorded"; retryAttempt: number }>
  | Readonly<{ kind: "tombstoned" }>
  | Readonly<{ kind: "lost-claim" }>;

/** Internal C4 delivery/cleanup fact; it is never a public attempt field. */
export type MediaDeliveryRecovery = Readonly<{
  attemptId: string;
  generation: number;
  /** Durable attempt mode is selected with redelivery facts, never guessed. */
  mode?: AttemptMode;
  mediaId: string;
  frameBatchId: string;
  state: "pending-delivery" | "queued" | "cleanup-recoverable" | "resolved";
  requiresRollback: boolean;
}>;

/** A bounded, leased C4 outbox item for opaque C5 byte cleanup. */
export type MediaAttachmentRecoveryClaim = MediaDeliveryRecovery &
  Readonly<{ leaseId: string }>;

/** A leased at-least-once delivery retry; physical bytes remain untouched. */
export type MediaDeliveryRedeliveryClaim = Omit<
  MediaDeliveryRecovery,
  "state"
> &
  Readonly<{
    state: "pending-delivery" | "queued";
    leaseId: string;
  }>;

/** A durable non-terminal recovery state after bounded terminalization fails. */
export type DeadLetterProcessingClaimOutcome =
  | Readonly<{ kind: "dead-lettered" }>
  | Readonly<{ kind: "tombstoned" }>
  | Readonly<{ kind: "lost-claim" }>;

type RankedVerifiedTerminalCandidate = Omit<
  Extract<VerifiedResult, { competitiveStatus: "ranked" }>,
  "rankingSnapshot"
>;

type VerifiedTerminalCandidate =
  | RankedVerifiedTerminalCandidate
  | Exclude<VerifiedResult, { competitiveStatus: "ranked" }>;

declare const transactionalRankedPolicyFinalizationAuthority: unique symbol;
declare const rankedPolicyFinalizationIssuer: unique symbol;

/**
 * Opaque C7-to-C4 capability. Only the production policy adapter can issue
 * one, and C4 validates its private registration before using it in a write.
 */
export type TransactionalRankedPolicyFinalizationAuthority = Readonly<{
  readonly [transactionalRankedPolicyFinalizationAuthority]: "transactional-ranked-policy-finalization";
}>;

/** Opaque issuer that can bind one C7-approved policy/receipt to C4. */
export type RankedPolicyFinalizationIssuer = Readonly<{
  readonly [rankedPolicyFinalizationIssuer]: "ranked-policy-finalization-issuer";
}>;

const rankedCandidatePolicyFinalizations = new WeakMap<
  object,
  TransactionalRankedPolicyFinalizationAuthority
>();

/**
 * Processor-owned terminal facts. The repository is the only component that
 * turns a ranked candidate into a public result by calculating its frozen
 * leaderboard snapshot inside the finalization transaction.
 */
export type TerminalCandidate =
  | Readonly<{
      state: "valid";
      result: FreeInsight | VerifiedTerminalCandidate;
    }>
  | Exclude<AttemptOutcome, { state: "pending" | "valid" }>;

/**
 * Associates a C7-created ranked candidate with its opaque, exact policy
 * approval. The association is in-memory only and never enters C4 JSON.
 */
export function bindRankedCandidatePolicyFinalization(
  candidate: TerminalCandidate,
  authority: TransactionalRankedPolicyFinalizationAuthority,
): TerminalCandidate {
  rankedCandidatePolicyFinalizations.set(candidate, authority);
  return candidate;
}

/** Resolves only an authority bound to this exact candidate object. */
export function resolveRankedCandidatePolicyFinalization(
  candidate: unknown,
): TransactionalRankedPolicyFinalizationAuthority | undefined {
  if (typeof candidate !== "object" || candidate === null) return undefined;
  return rankedCandidatePolicyFinalizations.get(candidate);
}

export type FinalizeTerminalResultInput = Readonly<{
  attemptId: string;
  leaseId: string;
  generation: number;
  candidate: TerminalCandidate;
  rankedPolicy?: TransactionalRankedPolicyFinalizationAuthority;
}>;

export interface AttemptRepository {
  issueCalibrationSession(
    input: Readonly<{
      id: string;
      athleteId: string;
      nonce: string;
      challengeId: "wall-pass";
      challengeVersion: 1;
    }>,
  ): Promise<CalibrationSessionRecord>;
  getCalibrationSession(
    input: Readonly<{ id: string; athleteId: string }>,
  ): Promise<CalibrationSessionRecord | null>;
  readyCalibrationSession(
    input: Readonly<{
      id: string;
      athleteId: string;
      requiredGates: readonly [
        "device",
        "space",
        "athlete",
        "rehearsal",
        "record",
      ];
    }>,
  ): Promise<void>;
  createAttempt(
    input: Readonly<{
      id: string;
      athleteId: string;
      input: CreateAttemptInput;
      idempotencyKey?: string;
    }>,
  ): Promise<AttemptRecord>;
  getAttempt(
    input: Readonly<{ attemptId: string; athleteId: string }>,
  ): Promise<AttemptRecord | null>;
  listAttempts(
    input: Readonly<{ athleteId: string; limit: number; cursor?: string }>,
  ): Promise<
    Readonly<{ items: readonly AttemptRecord[]; nextCursor: string | null }>
  >;
  prepareMediaUpload(
    input: Readonly<{ attemptId: string; athleteId: string }>,
  ): Promise<MediaUploadContext>;
  attachPreparedMedia(
    input: Readonly<{
      accepted: AcceptedMediaHandoff;
    }>,
  ): Promise<AnalysisJob>;
  rollbackMediaAttachment(
    input: Readonly<{
      attemptId: string;
      generation: number;
    }>,
  ): Promise<void>;
  recoverMediaAttachment(
    input: Readonly<{
      attemptId: string;
      generation: number;
    }>,
  ): Promise<void>;
  markMediaDeliveryQueued(
    input: Readonly<{ attemptId: string; generation: number }>,
  ): Promise<void>;
  beginMediaAttachmentRecovery(
    input: Readonly<{
      attemptId: string;
      generation: number;
      mediaId: string;
      frameBatchId: string;
    }>,
  ): Promise<void>;
  acknowledgeMediaAttachmentCleanup(
    input: Readonly<{
      attemptId: string;
      generation: number;
      mediaId: string;
    }>,
  ): Promise<void>;
  getMediaDeliveryRecovery(
    input: Readonly<{ attemptId: string; generation: number }>,
  ): Promise<MediaDeliveryRecovery | null>;
  claimMediaAttachmentRecovery(
    input: Readonly<{ now: string; limit: number }>,
  ): Promise<readonly MediaAttachmentRecoveryClaim[]>;
  claimMediaDeliveryRedelivery(
    input: Readonly<{ now: string; limit: number }>,
  ): Promise<readonly MediaDeliveryRedeliveryClaim[]>;
  acknowledgeMediaDeliveryRedelivery(
    input: Readonly<{ attemptId: string; generation: number; leaseId: string }>,
  ): Promise<void>;
  releaseMediaDeliveryRedelivery(
    input: Readonly<{ attemptId: string; generation: number; leaseId: string }>,
  ): Promise<void>;
  releaseMediaAttachmentRecovery(
    input: Readonly<{ attemptId: string; generation: number; leaseId: string }>,
  ): Promise<void>;
  claimProcessing(job: AnalysisJob): Promise<ProcessingClaim | null>;
  getProcessingContext(
    input: Readonly<{
      attemptId: string;
      leaseId: string;
      generation: number;
    }>,
  ): Promise<PersistedProcessingContext | null>;
  listLiveLeaderboard(
    input: LiveLeaderboardPageInput,
  ): Promise<LiveLeaderboardPage>;
  releaseProcessingClaim(
    input: Readonly<{
      attemptId: string;
      leaseId: string;
      generation: number;
    }>,
  ): Promise<boolean>;
  recordProcessingFailure(
    input: Readonly<{
      attemptId: string;
      leaseId: string;
      generation: number;
    }>,
  ): Promise<ProcessingFailureRecordOutcome>;
  deadLetterProcessingClaim(
    input: Readonly<{
      attemptId: string;
      leaseId: string;
      generation: number;
    }>,
  ): Promise<DeadLetterProcessingClaimOutcome>;
  finalizeTerminalResult(
    input: FinalizeTerminalResultInput,
  ): Promise<FinalizeTerminalResultOutcome>;
  tombstoneAttempt(
    input: Readonly<{ attemptId: string; athleteId: string }>,
  ): Promise<void>;
}
