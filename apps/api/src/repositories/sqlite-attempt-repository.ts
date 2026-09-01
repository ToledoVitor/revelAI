import {
  AttemptOutcomeSchema,
  type AttemptOutcome,
  type CreateAttemptInput,
  UtcIsoTimestampSchema,
  VerifiedResultSchema,
} from "@revelai/contracts";
import {
  calculateFrozenWallPassSnapshot as calculateSnapshot,
  rankWallPassV1Cohort,
  type WallPassRankableResult as DomainWallPassRankableResult,
} from "@revelai/domain";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { AnalysisJob } from "../queue/analysis-queue.js";
import {
  originalOrFrameDeleteAt,
  temporaryDeleteAt,
} from "../media/retention-deadlines.js";
import {
  parseDurableProcessingContext,
  type DurableProcessingContext,
} from "../media/extraction-manifest.js";
import type {
  AcceptedMediaHandoff,
  AcceptedMediaHandoffVerifier,
} from "../media/accepted-media-handoff.js";
import { isC5AcceptedMediaHandoffVerifier } from "../media/media-pipeline.js";
import {
  isFactoryIssuedSqliteDatabase,
  resolveFactoryIssuedC4AcceptedMediaCleanupAuthority,
  resolveFactoryIssuedSqliteDatabaseCompositionToken,
  type C4AcceptedMediaCleanupAuthority,
  type SqliteDatabase,
  type SqliteDatabaseCompositionToken,
} from "../database/sqlite-database.js";
import {
  isStoredMediaAttachment,
  RepositoryError,
} from "./attempt-repository.js";
import { isCurrentRankedPolicyFinalization } from "./sqlite-competitive-policy-repository.js";
import { createAes256GcmNonceAllocator } from "./cursor-nonce-allocator.js";
export {
  RepositoryError,
  type RepositoryErrorCode,
} from "./attempt-repository.js";
import { reconcileMediaDeliveryCleanup } from "./media-delivery-recovery-sql.js";
import type {
  AttemptRecord,
  AttemptRepository,
  CalibrationSessionRecord,
  DeadLetterProcessingClaimOutcome,
  FinalizeTerminalResultOutcome,
  FinalizedAttempt,
  FinalizeTerminalResultInput,
  LiveLeaderboardPage,
  LiveLeaderboardPageInput,
  ProcessingFailureRecordOutcome,
  ProcessingClaim,
  MediaUploadContext,
  MediaDeliveryRecovery,
  MediaAttachmentRecoveryClaim,
  MediaDeliveryRedeliveryClaim,
  PersistedProcessingContext,
  StoredMedia,
  TerminalCandidate,
} from "./attempt-repository.js";

export type { C4AcceptedMediaCleanupAuthority } from "../database/sqlite-database.js";

const c4AcceptedMediaCleanupAuthorities = new WeakMap<
  object,
  C4AcceptedMediaCleanupAuthority
>();
type ProductionSQLiteAttemptUploadPort = Readonly<{
  token: SqliteDatabaseCompositionToken;
  isCurrent(): boolean;
  handoffVerifier: AcceptedMediaHandoffVerifier;
  prepareMediaUpload(
    input: Readonly<{ attemptId: string; athleteId: string }>,
  ): Promise<MediaUploadContext>;
  attachment: Readonly<{
    attachPreparedMedia(
      input: Readonly<{ accepted: AcceptedMediaHandoff }>,
    ): Promise<AnalysisJob>;
    rollbackMediaAttachment(
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
    markMediaDeliveryQueued(
      input: Readonly<{ attemptId: string; generation: number }>,
    ): Promise<void>;
  }>;
}>;

type ProductionSQLiteAttemptProcessingPort = Readonly<{
  token: SqliteDatabaseCompositionToken;
  isCurrent(): boolean;
  handoffVerifier: AcceptedMediaHandoffVerifier;
  processing: Pick<
    AttemptRepository,
    | "claimProcessing"
    | "getProcessingContext"
    | "releaseProcessingClaim"
    | "recordProcessingFailure"
    | "deadLetterProcessingClaim"
    | "finalizeTerminalResult"
    | "listLiveLeaderboard"
    | "tombstoneAttempt"
  >;
}>;
type ProductionSQLiteAttemptReadinessPort = Readonly<{
  probeDatabase(signal?: AbortSignal): Promise<void>;
}>;

const productionSQLiteAttemptUploadPorts = new WeakMap<
  object,
  ProductionSQLiteAttemptUploadPort
>();
const productionSQLiteAttemptProcessingPorts = new WeakMap<
  object,
  ProductionSQLiteAttemptProcessingPort
>();
const productionSQLiteAttemptReadinessPorts = new WeakMap<
  object,
  ProductionSQLiteAttemptReadinessPort
>();

/**
 * Narrow C8 composition resolver. The WeakMap identity check is the only way
 * to obtain an authority and a returned authority remains bound to its own
 * raw database rather than the caller's object graph.
 */
export function resolveC4AcceptedMediaCleanupAuthority(
  repository: unknown,
): C4AcceptedMediaCleanupAuthority | undefined {
  if (typeof repository !== "object" || repository === null) return undefined;
  return c4AcceptedMediaCleanupAuthorities.get(repository);
}

/** Resolves only the immutable production upload facade for this exact C4 instance. */
export function resolveProductionSQLiteAttemptUploadPort(
  repository: unknown,
): ProductionSQLiteAttemptUploadPort | undefined {
  if (typeof repository !== "object" || repository === null) return undefined;
  return productionSQLiteAttemptUploadPorts.get(repository);
}

/** Resolves only the sealed C4 lease/finalization facade for this exact instance. */
export function resolveProductionSQLiteAttemptProcessingPort(
  repository: unknown,
): ProductionSQLiteAttemptProcessingPort | undefined {
  if (typeof repository !== "object" || repository === null) return undefined;
  return productionSQLiteAttemptProcessingPorts.get(repository);
}

/** Resolves the sealed SQLite liveness query for the exact C4 host. */
export function resolveProductionSQLiteAttemptReadinessPort(
  repository: unknown,
): ProductionSQLiteAttemptReadinessPort | undefined {
  if (typeof repository !== "object" || repository === null) return undefined;
  return productionSQLiteAttemptReadinessPorts.get(repository);
}

const MAX_RECOVERY_ATTEMPTS = Number.MAX_SAFE_INTEGER;
const CLEAR_ATTACHED_MEDIA_COLUMNS =
  "media_json = NULL, media_sha256 = NULL, processing_context_json = NULL, processing_receipt_id = NULL, processing_receipt_sha256 = NULL";

type AttemptRow = Readonly<{
  id: string;
  athlete_id: string;
  mode: "free" | "verified";
  challenge_id: "wall-pass" | null;
  challenge_version: 1 | null;
  status: AttemptRecord["status"];
  deletion_state: "active" | "tombstoned";
  media_json: string | null;
  processing_generation: number;
  processing_lease_id: string | null;
  processing_lease_expires_at: string | null;
  created_at: string;
  outcome_json?: string | null;
}>;

type UploadPreparationRow = Readonly<{
  id: string;
  athlete_id: string;
  mode: "free" | "verified";
  challenge_id: "wall-pass" | null;
  challenge_version: 1 | null;
  calibration_session_id: string | null;
  calibration_nonce: string | null;
  status: AttemptRecord["status"];
  deletion_state: "active" | "tombstoned";
  media_json: string | null;
  processing_generation: number;
}>;

type ProcessingAuthorityRow = Readonly<{
  id: string;
  athlete_id: string;
  mode: "free" | "verified";
  challenge_id: "wall-pass" | null;
  challenge_version: 1 | null;
  calibration_session_id: string | null;
  calibration_nonce: string | null;
  media_json: string | null;
  media_sha256: string | null;
  processing_context_json: string | null;
  processing_receipt_id: string | null;
  processing_receipt_sha256: string | null;
  processing_generation: number;
}>;

type TerminalResultRow = Readonly<{
  id: string;
  lease_id: string;
  generation: number;
  outcome_json: string;
  candidate_json: string;
}>;

type MediaDeliveryRecoveryRow = Readonly<{
  attempt_mode?: "free" | "verified";
  attempt_id: string;
  generation: number;
  media_id: string;
  frame_batch_id: string | null;
  state: "pending-delivery" | "queued" | "cleanup-recoverable" | "resolved";
  requires_rollback: 0 | 1;
  queued_at: string | null;
  rollback_completed_at: string | null;
  cleanup_completed_at: string | null;
  recovery_lease_id: string | null;
  recovery_lease_expires_at: string | null;
}>;

export interface Clock {
  now(): string;
}

export interface IdGenerator {
  next(): string;
}

type SQLiteAttemptRepositoryInput = Readonly<{
  database: SqliteDatabase;
  clock: Clock;
  ids: IdGenerator;
  handoffVerifier: AcceptedMediaHandoffVerifier;
  attemptCursor?: AttemptCursorCodec;
  attemptCursorCrypto?: AttemptCursorCrypto;
  liveLeaderboardCursor?: LiveLeaderboardCursorCodec;
  liveLeaderboardCursorCrypto?: LiveLeaderboardCursorCrypto;
}>;

type ReadOnlyAttemptRepositoryTestInput = Omit<
  SQLiteAttemptRepositoryInput,
  "handoffVerifier"
>;

/**
 * A server-owned live-page cursor. The implementation deliberately makes no
 * attempt identifier recoverable by a client. Production's process-random
 * key invalidates old cursors after a restart; deployments that need durable
 * cursors can inject their managed codec at composition time.
 */
export interface LiveLeaderboardCursorCodec {
  encode(value: LiveLeaderboardCursorPayload): string;
  decode(cursor: string): LiveLeaderboardCursorPayload;
}

/** Opaque seek boundary bound to exactly one athlete's attempt page. */
export interface AttemptCursorCodec {
  encode(value: AttemptCursorPayload): string;
  decode(cursor: string): AttemptCursorPayload;
}

export type AttemptCursorPayload = Readonly<{
  version: 1;
  athleteId: string;
  createdAt: string;
  attemptId: string;
}>;

export type AttemptCursorCrypto = Readonly<{
  key: Uint8Array;
}>;

export type LiveLeaderboardCursorCrypto = Readonly<{
  key: Uint8Array;
}>;

export type LiveLeaderboardCursorPayload = Readonly<{
  version: 3;
  challengeId: "wall-pass";
  challengeVersion: 1;
  ruleVersion: "wall-pass-v1-score-1";
  calculatedAt: string;
  /** Monotonic repository membership cutoff, independent from wall time. */
  snapshotSequence: number;
  score: number;
  completedAt: string;
  attemptId: string;
}>;

export class SQLiteAttemptRepository implements AttemptRepository {
  private static readonly readOnlyTestVerifier: AcceptedMediaHandoffVerifier =
    Object.freeze({
      accepts: (_value: unknown): _value is AcceptedMediaHandoff => false,
    });
  readonly #raw;
  readonly #clock: Clock;
  private readonly ids: IdGenerator;
  private readonly attemptCursor: AttemptCursorCodec;
  private readonly liveLeaderboardCursor: LiveLeaderboardCursorCodec;
  readonly #handoffVerifier: AcceptedMediaHandoffVerifier;
  readonly #compositionToken: SqliteDatabaseCompositionToken | undefined;

  /**
   * Test/migration reads never attach C5 media. Keep that explicitly
   * unattachable rather than making production's C5 verifier optional.
   */
  public static forReadOnlyTest(
    input: ReadOnlyAttemptRepositoryTestInput,
  ): SQLiteAttemptRepository {
    return new SQLiteAttemptRepository({
      ...input,
      handoffVerifier: SQLiteAttemptRepository.readOnlyTestVerifier,
    });
  }

  public constructor(input: SQLiteAttemptRepositoryInput) {
    const database = input.database;
    if (!isFactoryIssuedSqliteDatabase(database))
      throw new Error(
        "C4 requires a factory-issued SQLite database capability.",
      );
    this.#raw = database.raw;
    this.#clock = input.clock;
    this.ids = input.ids;
    this.attemptCursor =
      input.attemptCursor ??
      createAttemptCursorCodec(
        input.attemptCursorCrypto ?? processAttemptCursorCrypto,
      );
    this.liveLeaderboardCursor =
      input.liveLeaderboardCursor ??
      createLiveLeaderboardCursorCodec(
        input.liveLeaderboardCursorCrypto ?? processLiveLeaderboardCursorCrypto,
      );
    // C4 can be constructed in a read-only test harness, but finalization
    // authority is still bound to the exact factory-issued database wrapper.
    // Keep that co-location fact independent of the C5 upload verifier.
    const token = resolveFactoryIssuedSqliteDatabaseCompositionToken(database);
    if (!token)
      throw new Error("C4 factory database composition token is required.");
    const productionVerifier =
      input.handoffVerifier !== SQLiteAttemptRepository.readOnlyTestVerifier;
    if (
      productionVerifier &&
      !isC5AcceptedMediaHandoffVerifier(input.handoffVerifier)
    )
      throw new Error("C5 handoff verifier is required from MediaPipeline.");
    this.#handoffVerifier = input.handoffVerifier;
    if (productionVerifier) {
      const cleanupAuthority =
        resolveFactoryIssuedC4AcceptedMediaCleanupAuthority(database);
      if (!cleanupAuthority)
        throw new Error("C4 factory cleanup authority is required.");
      c4AcceptedMediaCleanupAuthorities.set(this, cleanupAuthority);
      registerProductionSQLiteAttemptUploadPort(
        this,
        token,
        input.handoffVerifier,
      );
      registerProductionSQLiteAttemptProcessingPort(
        this,
        token,
        input.handoffVerifier,
      );
      registerProductionSQLiteAttemptReadinessPort(this, this.#raw);
    }
    this.#compositionToken = token;
  }

  public async issueCalibrationSession(
    input: Readonly<{
      id: string;
      athleteId: string;
      nonce: string;
      challengeId: "wall-pass";
      challengeVersion: 1;
    }>,
  ): Promise<CalibrationSessionRecord> {
    return this.#transaction(() => {
      const issuedAt = this.#clock.now();
      const expiresAt = addMilliseconds(issuedAt, 15 * 60_000);
      this.ensureAthlete(input.athleteId, issuedAt);
      this.#raw
        .prepare(
          "INSERT INTO calibration_sessions (id, athlete_id, nonce, challenge_id, challenge_version, state, issued_at, expires_at) VALUES (?, ?, ?, ?, ?, 'issued', ?, ?)",
        )
        .run(
          input.id,
          input.athleteId,
          input.nonce,
          input.challengeId,
          input.challengeVersion,
          issuedAt,
          expiresAt,
        );
      return calibrationSession(
        input.id,
        input.nonce,
        issuedAt,
        expiresAt,
        "issued",
      );
    });
  }

  public async getCalibrationSession(
    input: Readonly<{ id: string; athleteId: string }>,
  ): Promise<CalibrationSessionRecord | null> {
    return this.#transaction(() => {
      const row = this.#raw
        .prepare(
          "SELECT id, athlete_id, nonce, challenge_id, challenge_version, state, issued_at, expires_at, ready_at, consumed_at FROM calibration_sessions WHERE id = ? AND athlete_id = ?",
        )
        .get(input.id, input.athleteId);
      if (!row) return null;
      const session = parseCalibrationRow(row);
      if (session.expiresAt <= this.#clock.now()) {
        this.#raw
          .prepare(
            "UPDATE calibration_sessions SET state = 'expired' WHERE id = ? AND state IN ('issued', 'ready')",
          )
          .run(session.id);
        return null;
      }
      if (session.state !== "issued" && session.state !== "ready") return null;
      return calibrationSession(
        session.id,
        session.nonce,
        session.issuedAt,
        session.expiresAt,
        session.state,
      );
    });
  }

  public async readyCalibrationSession(
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
  ): Promise<void> {
    await this.#transaction(() => {
      const row = this.#raw
        .prepare(
          "SELECT id, athlete_id, nonce, challenge_id, challenge_version, state, issued_at, expires_at, ready_at, consumed_at FROM calibration_sessions WHERE id = ?",
        )
        .get(input.id);
      if (!row) throw new RepositoryError("calibration_session_not_found");
      const session = parseCalibrationRow(row);
      if (session.athleteId !== input.athleteId)
        throw new RepositoryError("calibration_session_not_found");
      if (session.expiresAt <= this.#clock.now()) {
        this.#raw
          .prepare(
            "UPDATE calibration_sessions SET state = 'expired' WHERE id = ? AND state IN ('issued', 'ready')",
          )
          .run(input.id);
        throw new RepositoryError("calibration_session_expired");
      }
      if (session.state === "consumed")
        throw new RepositoryError("calibration_session_consumed");
      if (session.state !== "issued")
        throw new RepositoryError("calibration_session_not_ready");
      this.#raw
        .prepare(
          "UPDATE calibration_sessions SET state = 'ready', ready_at = ? WHERE id = ? AND state = 'issued'",
        )
        .run(this.#clock.now(), input.id);
    });
  }

  public async createAttempt(
    input: Readonly<{
      id: string;
      athleteId: string;
      input: CreateAttemptInput;
    }>,
  ): Promise<AttemptRecord> {
    return this.#transaction(() => {
      const now = this.#clock.now();
      this.ensureAthlete(input.athleteId, now);
      if (input.input.mode === "verified")
        this.consumeCalibrationSession(input.athleteId, input.input, now);
      this.#raw
        .prepare(
          "INSERT INTO attempts (id, athlete_id, mode, challenge_id, challenge_version, calibration_session_id, status, deletion_state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'awaiting-upload', 'active', ?, ?)",
        )
        .run(
          input.id,
          input.athleteId,
          input.input.mode,
          input.input.mode === "verified" ? input.input.challengeId : null,
          input.input.mode === "verified" ? input.input.challengeVersion : null,
          input.input.mode === "verified"
            ? input.input.calibrationSessionId
            : null,
          now,
          now,
        );
      return parseAttemptRow(
        this.mustGetScopedAttempt(input.id, input.athleteId),
      );
    });
  }

  public async getAttempt(
    input: Readonly<{ attemptId: string; athleteId: string }>,
  ): Promise<AttemptRecord | null> {
    const row = this.selectScopedAttempt(input.attemptId, input.athleteId);
    return row ? parseAttemptRow(row) : null;
  }

  public async listAttempts(
    input: Readonly<{ athleteId: string; limit: number; cursor?: string }>,
  ): Promise<
    Readonly<{ items: readonly AttemptRecord[]; nextCursor: string | null }>
  > {
    if (
      !isUuid(input.athleteId) ||
      !Number.isSafeInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 50
    )
      throw new RepositoryError("invalid_input");
    const cursor = input.cursor
      ? this.attemptCursor.decode(input.cursor)
      : undefined;
    if (cursor && cursor.athleteId !== input.athleteId)
      throw new RepositoryError("invalid_input");
    const rows = this.#raw
      .prepare(
        `SELECT a.id, a.athlete_id, a.mode, a.challenge_id, a.challenge_version, a.status, a.deletion_state, a.media_json, a.processing_generation, a.processing_lease_id, a.processing_lease_expires_at, a.created_at, tr.outcome_json
       FROM attempts a
       LEFT JOIN terminal_results tr ON tr.attempt_id = a.id
       WHERE a.athlete_id = ? AND a.deletion_state = 'active'
         AND (? IS NULL OR a.created_at < ? OR (a.created_at = ? AND a.id < ?))
       ORDER BY a.created_at DESC, a.id DESC LIMIT ?`,
      )
      .all(
        input.athleteId,
        cursor?.createdAt ?? null,
        cursor?.createdAt ?? null,
        cursor?.createdAt ?? null,
        cursor?.attemptId ?? null,
        input.limit + 1,
      ) as AttemptRow[];
    const page = rows.slice(0, input.limit).map(parseAttemptRow);
    const last = page.at(-1);
    return Object.freeze({
      items: Object.freeze(page),
      nextCursor:
        rows.length > input.limit && last
          ? this.attemptCursor.encode(
              Object.freeze({
                version: 1,
                athleteId: input.athleteId,
                createdAt: last.createdAt,
                attemptId: last.id,
              }),
            )
          : null,
    });
  }

  public async prepareMediaUpload(
    input: Readonly<{ attemptId: string; athleteId: string }>,
  ): Promise<MediaUploadContext> {
    return this.#transaction(() => {
      const row = this.#raw
        .prepare(
          `SELECT a.id, a.athlete_id, a.mode, a.challenge_id, a.challenge_version,
                  a.calibration_session_id, a.status, a.deletion_state,
                  a.media_json, a.processing_generation, c.nonce AS calibration_nonce
             FROM attempts a
        LEFT JOIN calibration_sessions c ON c.id = a.calibration_session_id
            WHERE a.id = ? AND a.athlete_id = ? AND a.deletion_state = 'active'`,
        )
        .get(input.attemptId, input.athleteId) as
        | UploadPreparationRow
        | undefined;
      if (!row) throw new RepositoryError("attempt_not_found");
      return uploadContextFromRow(row, this.#clock.now());
    });
  }

  public async attachPreparedMedia(
    input: Readonly<{
      accepted: AcceptedMediaHandoff;
    }>,
  ): Promise<AnalysisJob> {
    return this.#transaction(() => {
      if (!this.#handoffVerifier.accepts(input.accepted))
        throw new RepositoryError("invalid_input");
      const { context: acceptedContext, storedMedia: acceptedMedia } =
        input.accepted;
      const processingContext = parseDurableProcessingContext(
        input.accepted.processingContext,
      );
      if (processingContext.kind !== "c5-durable-processing-context-v2")
        throw new RepositoryError("invalid_input");
      let context: MediaUploadContext;
      try {
        context = parsePersistedUploadContext(acceptedContext);
      } catch {
        throw new RepositoryError("invalid_input");
      }
      const media = projectStoredMedia(acceptedMedia);
      assertTransitionMedia(media);
      if (media.uploadedAt !== context.uploadedAt)
        throw new RepositoryError("invalid_input");
      if (processingContext.receipt.mediaId !== media.id)
        throw new RepositoryError("invalid_input");
      const row = this.#raw
        .prepare(
          `SELECT a.id, a.athlete_id, a.mode, a.challenge_id, a.challenge_version,
                  a.calibration_session_id, a.status, a.deletion_state,
                  a.media_json, a.processing_generation, c.nonce AS calibration_nonce
             FROM attempts a
        LEFT JOIN calibration_sessions c ON c.id = a.calibration_session_id
            WHERE a.id = ? AND a.athlete_id = ? AND a.deletion_state = 'active'`,
        )
        .get(context.attemptId, context.athleteId) as
        | UploadPreparationRow
        | undefined;
      if (!row) throw new RepositoryError("attempt_not_found");
      const expected = uploadContextFromRow(row, context.uploadedAt);
      if (!sameUploadContext(expected, context))
        throw new RepositoryError("invalid_attempt_transition");
      if (
        input.accepted.sourceSha256.length !== 64 ||
        !/^[a-f0-9]{64}$/i.test(input.accepted.sourceSha256) ||
        processingContext.receipt.frameBatchId.length !== 36 ||
        processingContext.receipt.sha256.length !== 64
      )
        throw new RepositoryError("invalid_input");
      if (row.media_json !== null)
        throw new RepositoryError("duplicate_media_upload");
      if (row.status !== "awaiting-upload")
        throw new RepositoryError("invalid_attempt_transition");
      const now = this.#clock.now();
      const updated = this.#raw
        .prepare(
          "UPDATE attempts SET media_json = ?, media_sha256 = ?, processing_context_json = ?, processing_receipt_id = ?, processing_receipt_sha256 = ?, status = 'uploaded', processing_generation = ?, updated_at = ? WHERE id = ? AND athlete_id = ? AND status = 'awaiting-upload' AND deletion_state = 'active' AND processing_generation = ?",
        )
        .run(
          stableJson(media),
          input.accepted.sourceSha256,
          stableJson({
            upload: expected,
            processing: processingContext,
            sourceSha256: input.accepted.sourceSha256,
          }),
          processingContext.receipt.frameBatchId,
          processingContext.receipt.sha256,
          context.generation,
          now,
          context.attemptId,
          context.athleteId,
          row.processing_generation,
        );
      if (updated.changes !== 1)
        throw new RepositoryError("invalid_attempt_transition");
      this.#raw
        .prepare(
          "INSERT INTO media_retention_records (media_id, attempt_id, metadata_json, delete_at, created_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run(
          media.id,
          context.attemptId,
          stableJson(media),
          media.deleteAt,
          now,
        );
      const acknowledged = this.#raw
        .prepare(
          "DELETE FROM retention_cleanup_records WHERE resource_id = ? AND attempt_id = ? AND resource_kind = 'temporary' AND delete_at = ?",
        )
        .run(
          media.transition.resourceId,
          context.attemptId,
          media.transition.deleteAt,
        );
      if (acknowledged.changes !== 1)
        throw new RepositoryError("invalid_input");
      this.#raw
        .prepare(
          `INSERT INTO media_delivery_recovery_records
             (attempt_id, generation, media_id, frame_batch_id, state, requires_rollback, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'pending-delivery', 1, ?, ?)`,
        )
        .run(
          context.attemptId,
          context.generation,
          media.id,
          processingContext.receipt.frameBatchId,
          now,
          now,
        );
      this.#event(context.attemptId, context.generation, "media-attached", now);
      return Object.freeze({
        attemptId: context.attemptId,
        generation: context.generation,
        mode: context.mode,
      });
    });
  }

  public async rollbackMediaAttachment(
    input: Readonly<{
      attemptId: string;
      generation: number;
    }>,
  ): Promise<void> {
    await this.#transaction(() => {
      const row = this.#raw
        .prepare(
          "SELECT a.id, a.athlete_id, a.mode, a.challenge_id, a.challenge_version, a.status, a.deletion_state, a.media_json, a.processing_generation, a.processing_lease_id, a.processing_lease_expires_at, a.created_at, tr.outcome_json FROM attempts a LEFT JOIN terminal_results tr ON tr.attempt_id = a.id WHERE a.id = ? AND a.deletion_state = 'active'",
        )
        .get(input.attemptId) as AttemptRow | undefined;
      const attempt = row ? parseAttemptRow(row) : null;
      const delivery = this.#deliveryRecovery(input);
      if (!delivery || delivery.requires_rollback === 0)
        throw new RepositoryError("persisted_data_corrupt");
      if (delivery.rollback_completed_at !== null) return;
      if (
        !row ||
        !attempt ||
        !attempt.media ||
        attempt.status !== "uploaded" ||
        row.processing_generation !== input.generation ||
        attempt.media.id !== delivery.media_id
      )
        throw new RepositoryError("persisted_data_corrupt");
      const now = this.#clock.now();
      const rolledBack = this.#raw
        .prepare(
          `UPDATE attempts SET ${CLEAR_ATTACHED_MEDIA_COLUMNS}, status = 'awaiting-upload', updated_at = ? WHERE id = ? AND status = 'uploaded' AND processing_generation = ? AND deletion_state = 'active'`,
        )
        .run(now, input.attemptId, input.generation);
      if (rolledBack.changes !== 1)
        throw new RepositoryError("invalid_attempt_transition");
      this.#raw
        .prepare(
          "UPDATE media_retention_records SET cleanup_requested_at = ? WHERE attempt_id = ? AND media_id = ?",
        )
        .run(now, input.attemptId, delivery.media_id);
      this.#raw
        .prepare(
          `UPDATE media_delivery_recovery_records
              SET rollback_completed_at = ?,
                  state = CASE WHEN cleanup_completed_at IS NULL THEN 'cleanup-recoverable' ELSE 'resolved' END,
                  updated_at = ?
            WHERE attempt_id = ? AND generation = ? AND media_id = ?`,
        )
        .run(now, now, input.attemptId, input.generation, delivery.media_id);
      // Queue delivery is not an authority to lose physical-byte coverage.
      // Keep the original +23h retention fact while the attempt returns to
      // awaiting-upload. C8 may delete and acknowledge it later; a crash or
      // failed delete leaves it due for the scavenger.
      this.#event(input.attemptId, input.generation, "media-rolled-back", now);
    });
  }

  public async recoverMediaAttachment(
    input: Readonly<{ attemptId: string; generation: number }>,
  ): Promise<void> {
    const delivery = await this.getMediaDeliveryRecovery(input);
    if (!delivery) return;
    try {
      await this.beginMediaAttachmentRecovery({
        ...input,
        mediaId: delivery.mediaId,
        frameBatchId: delivery.frameBatchId,
      });
    } catch (error) {
      // Historical callers may retry an old generation after a newer upload
      // has won. It must remain a harmless no-op, never touch that new media.
      if (
        error instanceof RepositoryError &&
        error.code === "invalid_attempt_transition"
      )
        return;
      throw error;
    }
  }

  public async markMediaDeliveryQueued(
    input: Readonly<{ attemptId: string; generation: number }>,
  ): Promise<void> {
    await this.#transaction(() => {
      const now = this.#clock.now();
      const update = this.#raw
        .prepare(
          `UPDATE media_delivery_recovery_records
              SET state = 'queued', requires_rollback = 0,
                  queued_at = COALESCE(queued_at, ?), updated_at = ?
            WHERE attempt_id = ? AND generation = ? AND state = 'pending-delivery'`,
        )
        .run(now, now, input.attemptId, input.generation);
      if (update.changes === 1) return;
      const delivery = this.#deliveryRecovery(input);
      if (delivery?.state === "queued") return;
      throw new RepositoryError("persisted_data_corrupt");
    });
  }

  public async beginMediaAttachmentRecovery(
    input: Readonly<{
      attemptId: string;
      generation: number;
      mediaId: string;
      frameBatchId: string;
    }>,
  ): Promise<void> {
    await this.#transaction(() => {
      const now = this.#clock.now();
      const row = this.#raw
        .prepare(
          "SELECT id, status, deletion_state, processing_generation, media_json FROM attempts WHERE id = ?",
        )
        .get(input.attemptId) as
        | Readonly<{
            id: string;
            status: AttemptRecord["status"];
            deletion_state: "active" | "tombstoned";
            processing_generation: number;
            media_json: string | null;
          }>
        | undefined;
      if (!row || row.deletion_state !== "active")
        throw new RepositoryError("attempt_not_found");
      const existing = this.#deliveryRecovery(input);
      if (existing && existing.media_id !== input.mediaId)
        throw new RepositoryError("persisted_data_corrupt");
      if (existing && existing.frame_batch_id !== input.frameBatchId)
        throw new RepositoryError("persisted_data_corrupt");
      if (!isUuid(input.frameBatchId) || input.frameBatchId.length !== 36)
        throw new RepositoryError("invalid_input");
      if (
        row.status === "uploaded" &&
        row.processing_generation === input.generation
      ) {
        const media = row.media_json ? parseStoredMedia(row.media_json) : null;
        if (!media || media.id !== input.mediaId)
          throw new RepositoryError("persisted_data_corrupt");
        if (!existing) throw new RepositoryError("persisted_data_corrupt");
        this.#raw
          .prepare(
            `UPDATE media_delivery_recovery_records
                SET state = 'cleanup-recoverable',
                    recovery_lease_id = NULL, recovery_lease_expires_at = NULL,
                    updated_at = ?
              WHERE attempt_id = ? AND generation = ? AND media_id = ?`,
          )
          .run(now, input.attemptId, input.generation, input.mediaId);
      } else if (
        row.status === "awaiting-upload" &&
        (row.processing_generation === input.generation - 1 ||
          (row.processing_generation === input.generation && existing !== null))
      ) {
        if (row.processing_generation === input.generation - 1) {
          const retired = this.#raw
            .prepare(
              "UPDATE attempts SET processing_generation = ?, updated_at = ? WHERE id = ? AND status = 'awaiting-upload' AND deletion_state = 'active' AND processing_generation = ?",
            )
            .run(
              input.generation,
              now,
              input.attemptId,
              row.processing_generation,
            );
          if (retired.changes !== 1)
            throw new RepositoryError("invalid_attempt_transition");
        }
        this.#raw
          .prepare(
            `INSERT INTO media_delivery_recovery_records
              (attempt_id, generation, media_id, frame_batch_id, state, requires_rollback, created_at, updated_at)
             VALUES (?, ?, ?, ?, 'cleanup-recoverable', 0, ?, ?)
             ON CONFLICT(attempt_id, generation) DO UPDATE SET
               state = 'cleanup-recoverable', updated_at = excluded.updated_at
             WHERE media_delivery_recovery_records.media_id = excluded.media_id
               AND media_delivery_recovery_records.requires_rollback = 0`,
          )
          .run(
            input.attemptId,
            input.generation,
            input.mediaId,
            input.frameBatchId,
            now,
            now,
          );
        // No attachment references this generation, so retention may become
        // due immediately. Attached rows reach this only after rollback.
        this.#raw
          .prepare(
            "UPDATE retention_cleanup_records SET cleanup_requested_at = ? WHERE attempt_id = ?",
          )
          .run(now, input.attemptId);
      } else {
        throw new RepositoryError("invalid_attempt_transition");
      }
      this.#event(
        input.attemptId,
        input.generation,
        "media-recovery-requested",
        now,
      );
    });
  }

  public async acknowledgeMediaAttachmentCleanup(
    input: Readonly<{ attemptId: string; generation: number; mediaId: string }>,
  ): Promise<void> {
    await this.#transaction(() => {
      const delivery = this.#deliveryRecovery(input);
      if (!delivery || delivery.media_id !== input.mediaId)
        throw new RepositoryError("persisted_data_corrupt");
      if (delivery.cleanup_completed_at !== null) return;
      if (
        delivery.requires_rollback === 1 &&
        delivery.rollback_completed_at === null
      )
        throw new RepositoryError("invalid_attempt_transition");
      const now = this.#clock.now();
      this.#raw
        .prepare(
          "DELETE FROM media_retention_records WHERE attempt_id = ? AND media_id = ?",
        )
        .run(input.attemptId, input.mediaId);
      this.#raw
        .prepare(
          "DELETE FROM retention_cleanup_records WHERE attempt_id = ? AND resource_id = ? AND resource_kind = 'frame'",
        )
        .run(input.attemptId, delivery.frame_batch_id);
      reconcileMediaDeliveryCleanup(this.#raw, {
        attemptId: input.attemptId,
        now,
      });
    });
  }

  public async getMediaDeliveryRecovery(
    input: Readonly<{ attemptId: string; generation: number }>,
  ): Promise<MediaDeliveryRecovery | null> {
    return this.#transaction(() => {
      const delivery = this.#deliveryRecovery(input);
      return delivery ? projectMediaDeliveryRecovery(delivery) : null;
    });
  }

  public async claimMediaAttachmentRecovery(
    input: Readonly<{ now: string; limit: number }>,
  ): Promise<readonly MediaAttachmentRecoveryClaim[]> {
    if (!UtcIsoTimestampSchema.safeParse(input.now).success)
      throw new RepositoryError("invalid_input");
    if (
      !Number.isSafeInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 100
    )
      throw new RepositoryError("invalid_input");
    return this.#transaction(() => {
      const candidates = this.#raw
        .prepare(
          `SELECT attempt_id, generation, media_id, state, requires_rollback,
                  frame_batch_id, queued_at, rollback_completed_at, cleanup_completed_at,
                  recovery_lease_id, recovery_lease_expires_at
             FROM media_delivery_recovery_records
            WHERE state = 'cleanup-recoverable'
              AND (recovery_lease_expires_at IS NULL OR recovery_lease_expires_at <= ?)
            ORDER BY updated_at ASC, attempt_id ASC
            LIMIT ?`,
        )
        .all(input.now, input.limit) as MediaDeliveryRecoveryRow[];
      const expiresAt = addMilliseconds(input.now, 5 * 60_000);
      const claims: MediaAttachmentRecoveryClaim[] = [];
      for (const candidate of candidates) {
        const recovery = projectMediaDeliveryRecovery(candidate);
        const leaseId = this.ids.next();
        const update = this.#raw
          .prepare(
            `UPDATE media_delivery_recovery_records
                SET recovery_lease_id = ?, recovery_lease_expires_at = ?, updated_at = ?
              WHERE attempt_id = ? AND generation = ? AND state = 'cleanup-recoverable'
                AND (recovery_lease_expires_at IS NULL OR recovery_lease_expires_at <= ?)`,
          )
          .run(
            leaseId,
            expiresAt,
            input.now,
            recovery.attemptId,
            recovery.generation,
            input.now,
          );
        if (update.changes === 1)
          claims.push(Object.freeze({ ...recovery, leaseId }));
      }
      return Object.freeze(claims);
    });
  }

  public async claimMediaDeliveryRedelivery(
    input: Readonly<{ now: string; limit: number }>,
  ): Promise<readonly MediaDeliveryRedeliveryClaim[]> {
    assertRecoveryClaimInput(input);
    return this.#transaction(() => {
      const candidates = this.#raw
        .prepare(
          `SELECT a.mode AS attempt_mode, r.attempt_id, r.generation, r.media_id, r.state, r.requires_rollback,
                  frame_batch_id, queued_at, rollback_completed_at, cleanup_completed_at,
                  recovery_lease_id, recovery_lease_expires_at
             FROM media_delivery_recovery_records r
             JOIN attempts a ON a.id = r.attempt_id
            WHERE r.state IN ('pending-delivery', 'queued')
              AND (r.recovery_lease_expires_at IS NULL OR r.recovery_lease_expires_at <= ?)
            ORDER BY r.updated_at ASC, r.attempt_id ASC
            LIMIT ?`,
        )
        .all(input.now, input.limit) as MediaDeliveryRecoveryRow[];
      const expiresAt = addMilliseconds(input.now, 5 * 60_000);
      const claims: MediaDeliveryRedeliveryClaim[] = [];
      for (const candidate of candidates) {
        const recovery = projectMediaDeliveryRecovery(candidate);
        if (
          recovery.state !== "pending-delivery" &&
          recovery.state !== "queued"
        ) {
          throw new RepositoryError("persisted_data_corrupt");
        }
        const leaseId = this.ids.next();
        const update = this.#raw
          .prepare(
            `UPDATE media_delivery_recovery_records
                SET recovery_lease_id = ?, recovery_lease_expires_at = ?, updated_at = ?
              WHERE attempt_id = ? AND generation = ?
                AND state IN ('pending-delivery', 'queued')
                AND (recovery_lease_expires_at IS NULL OR recovery_lease_expires_at <= ?)`,
          )
          .run(
            leaseId,
            expiresAt,
            input.now,
            recovery.attemptId,
            recovery.generation,
            input.now,
          );
        if (update.changes === 1) {
          const redelivery: MediaDeliveryRedeliveryClaim = Object.freeze({
            ...recovery,
            state: recovery.state,
            leaseId,
          });
          claims.push(redelivery);
        }
      }
      return Object.freeze(claims);
    });
  }

  public async acknowledgeMediaDeliveryRedelivery(
    input: Readonly<{ attemptId: string; generation: number; leaseId: string }>,
  ): Promise<void> {
    await this.#transaction(() => {
      const now = this.#clock.now();
      const update = this.#raw
        .prepare(
          `UPDATE media_delivery_recovery_records
              SET state = 'queued', requires_rollback = 0,
                  queued_at = COALESCE(queued_at, ?),
                  recovery_lease_id = NULL, recovery_lease_expires_at = NULL,
                  updated_at = ?
            WHERE attempt_id = ? AND generation = ? AND recovery_lease_id = ?
              AND state IN ('pending-delivery', 'queued')`,
        )
        .run(now, now, input.attemptId, input.generation, input.leaseId);
      if (update.changes !== 1)
        throw new RepositoryError("invalid_attempt_transition");
    });
  }

  public async releaseMediaDeliveryRedelivery(
    input: Readonly<{ attemptId: string; generation: number; leaseId: string }>,
  ): Promise<void> {
    await this.#transaction(() => {
      const update = this.#raw
        .prepare(
          `UPDATE media_delivery_recovery_records
              SET recovery_lease_id = NULL, recovery_lease_expires_at = NULL, updated_at = ?
            WHERE attempt_id = ? AND generation = ? AND recovery_lease_id = ?
              AND state IN ('pending-delivery', 'queued')`,
        )
        .run(
          this.#clock.now(),
          input.attemptId,
          input.generation,
          input.leaseId,
        );
      if (update.changes > 1)
        throw new RepositoryError("persisted_data_corrupt");
    });
  }

  public async releaseMediaAttachmentRecovery(
    input: Readonly<{ attemptId: string; generation: number; leaseId: string }>,
  ): Promise<void> {
    await this.#transaction(() => {
      const update = this.#raw
        .prepare(
          `UPDATE media_delivery_recovery_records
              SET recovery_lease_id = NULL, recovery_lease_expires_at = NULL, updated_at = ?
            WHERE attempt_id = ? AND generation = ? AND recovery_lease_id = ?`,
        )
        .run(
          this.#clock.now(),
          input.attemptId,
          input.generation,
          input.leaseId,
        );
      if (update.changes > 1)
        throw new RepositoryError("persisted_data_corrupt");
    });
  }

  public async claimProcessing(
    job: AnalysisJob,
  ): Promise<ProcessingClaim | null> {
    return this.#transaction(() => {
      const row = this.#raw
        .prepare(
          `SELECT a.id, a.athlete_id, a.mode, a.challenge_id, a.challenge_version,
                  a.calibration_session_id, c.nonce AS calibration_nonce, a.media_json,
                  a.media_sha256, a.processing_context_json, a.processing_receipt_id,
                  a.processing_receipt_sha256, a.status, a.deletion_state,
                  a.processing_generation, a.processing_lease_expires_at
             FROM attempts a LEFT JOIN calibration_sessions c ON c.id = a.calibration_session_id
            WHERE a.id = ?`,
        )
        .get(job.attemptId) as
        | (ProcessingAuthorityRow &
            Readonly<{
              status: AttemptRecord["status"];
              deletion_state: "active" | "tombstoned";
              processing_generation: number;
              processing_lease_expires_at: string | null;
            }>)
        | undefined;
      if (!row || row.deletion_state !== "active") return null;
      const recovery = this.#raw
        .prepare(
          "SELECT state FROM processing_recovery_records WHERE attempt_id = ? AND generation = ?",
        )
        .get(job.attemptId, job.generation) as { state: string } | undefined;
      if (recovery?.state === "dead-lettered") return null;
      const now = this.#clock.now();
      const generationMatches = row.processing_generation === job.generation;
      const canClaim =
        (generationMatches && row.status === "uploaded") ||
        (generationMatches &&
          row.status === "processing" &&
          row.processing_lease_expires_at !== null &&
          row.processing_lease_expires_at <= now);
      if (!canClaim) return null;
      assertClaimableProcessingRow(row);
      const leaseId = this.ids.next();
      const expiresAt = addMilliseconds(now, 5 * 60_000);
      const update = this.#raw
        .prepare(
          "UPDATE attempts SET status = 'processing', processing_lease_id = ?, processing_lease_expires_at = ?, updated_at = ? WHERE id = ? AND processing_generation = ? AND deletion_state = 'active' AND (status = 'uploaded' OR (status = 'processing' AND processing_lease_expires_at <= ?))",
        )
        .run(leaseId, expiresAt, now, job.attemptId, job.generation, now);
      if (update.changes !== 1) return null;
      this.#event(job.attemptId, job.generation, "processing-claimed", now);
      return Object.freeze({
        leaseId,
        generation: job.generation,
        mode: row.mode,
      });
    });
  }

  public async getProcessingContext(
    input: Readonly<{
      attemptId: string;
      leaseId: string;
      generation: number;
    }>,
  ): Promise<PersistedProcessingContext | null> {
    return this.#transaction(() => {
      const row = this.#raw
        .prepare(
          `SELECT a.id, a.athlete_id, a.mode, a.challenge_id, a.challenge_version,
                  a.calibration_session_id, c.nonce AS calibration_nonce, a.media_json,
                  a.media_sha256, a.processing_context_json, a.processing_receipt_id,
                  a.processing_receipt_sha256, a.status, a.deletion_state,
                  a.processing_generation, a.processing_lease_id
             FROM attempts a LEFT JOIN calibration_sessions c ON c.id = a.calibration_session_id
            WHERE a.id = ?`,
        )
        .get(input.attemptId) as
        | (ProcessingAuthorityRow &
            Readonly<{
              status: AttemptRecord["status"];
              deletion_state: "active" | "tombstoned";
              processing_generation: number;
              processing_lease_id: string | null;
            }>)
        | undefined;
      if (
        !row ||
        row.deletion_state !== "active" ||
        row.status !== "processing" ||
        row.processing_generation !== input.generation ||
        row.processing_lease_id !== input.leaseId
      )
        return null;
      if (row.processing_context_json === null)
        throw new RepositoryError("persisted_data_corrupt");
      return assertClaimableProcessingRow(row);
    });
  }

  public async releaseProcessingClaim(
    input: Readonly<{
      attemptId: string;
      leaseId: string;
      generation: number;
    }>,
  ): Promise<boolean> {
    return this.#transaction(() => {
      const now = this.#clock.now();
      const update = this.#raw
        .prepare(
          "UPDATE attempts SET status = 'uploaded', processing_lease_id = NULL, processing_lease_expires_at = NULL, updated_at = ? WHERE id = ? AND status = 'processing' AND deletion_state = 'active' AND processing_generation = ? AND processing_lease_id = ?",
        )
        .run(now, input.attemptId, input.generation, input.leaseId);
      if (update.changes !== 1) return false;
      this.#event(
        input.attemptId,
        input.generation,
        "processing-released",
        now,
      );
      return true;
    });
  }

  public async recordProcessingFailure(
    input: Readonly<{
      attemptId: string;
      leaseId: string;
      generation: number;
    }>,
  ): Promise<ProcessingFailureRecordOutcome> {
    return this.#transaction(() => {
      const row = this.#raw
        .prepare(
          "SELECT deletion_state, status, processing_generation, processing_lease_id FROM attempts WHERE id = ?",
        )
        .get(input.attemptId) as
        | {
            deletion_state: "active" | "tombstoned";
            status: AttemptRecord["status"];
            processing_generation: number;
            processing_lease_id: string | null;
          }
        | undefined;
      if (!row) return Object.freeze({ kind: "lost-claim" });
      if (row.deletion_state === "tombstoned")
        return Object.freeze({ kind: "tombstoned" });
      if (
        row.status !== "processing" ||
        row.processing_generation !== input.generation ||
        row.processing_lease_id !== input.leaseId
      )
        return Object.freeze({ kind: "lost-claim" });
      const now = this.#clock.now();
      const existingRecovery = this.#raw
        .prepare(
          "SELECT retry_attempts FROM processing_recovery_records WHERE attempt_id = ? AND generation = ?",
        )
        .get(input.attemptId, input.generation) as
        | { retry_attempts: number }
        | undefined;
      if (
        existingRecovery &&
        !Number.isSafeInteger(existingRecovery.retry_attempts)
      )
        throw new RepositoryError("persisted_data_corrupt");
      if (existingRecovery?.retry_attempts === MAX_RECOVERY_ATTEMPTS) {
        this.#event(
          input.attemptId,
          input.generation,
          "processing-failed",
          now,
        );
        return Object.freeze({
          kind: "recorded",
          retryAttempt: MAX_RECOVERY_ATTEMPTS,
        });
      }
      this.#raw
        .prepare(
          `INSERT INTO processing_recovery_records
             (attempt_id, generation, retry_attempts, state, created_at, updated_at)
           VALUES (?, ?, 1, 'retrying', ?, ?)
           ON CONFLICT(attempt_id, generation) DO UPDATE SET
             retry_attempts = processing_recovery_records.retry_attempts + 1,
             state = 'retrying',
             updated_at = excluded.updated_at`,
        )
        .run(input.attemptId, input.generation, now, now);
      const recovery = this.#raw
        .prepare(
          "SELECT retry_attempts FROM processing_recovery_records WHERE attempt_id = ? AND generation = ?",
        )
        .get(input.attemptId, input.generation) as
        | { retry_attempts: number }
        | undefined;
      if (!recovery || !Number.isSafeInteger(recovery.retry_attempts))
        throw new RepositoryError("persisted_data_corrupt");
      this.#event(input.attemptId, input.generation, "processing-failed", now);
      return Object.freeze({
        kind: "recorded",
        retryAttempt: recovery.retry_attempts,
      });
    });
  }

  public async deadLetterProcessingClaim(
    input: Readonly<{
      attemptId: string;
      leaseId: string;
      generation: number;
    }>,
  ): Promise<DeadLetterProcessingClaimOutcome> {
    return this.#transaction(() => {
      const row = this.#raw
        .prepare(
          "SELECT deletion_state, status, processing_generation, processing_lease_id FROM attempts WHERE id = ?",
        )
        .get(input.attemptId) as
        | {
            deletion_state: "active" | "tombstoned";
            status: AttemptRecord["status"];
            processing_generation: number;
            processing_lease_id: string | null;
          }
        | undefined;
      if (!row) return Object.freeze({ kind: "lost-claim" });
      if (row.deletion_state === "tombstoned")
        return Object.freeze({ kind: "tombstoned" });
      if (
        row.status !== "processing" ||
        row.processing_generation !== input.generation ||
        row.processing_lease_id !== input.leaseId
      )
        return Object.freeze({ kind: "lost-claim" });
      const now = this.#clock.now();
      this.#raw
        .prepare(
          `INSERT INTO processing_recovery_records
             (attempt_id, generation, retry_attempts, state, created_at, updated_at)
           VALUES (?, ?, 1, 'dead-lettered', ?, ?)
           ON CONFLICT(attempt_id, generation) DO UPDATE SET
             state = 'dead-lettered',
             updated_at = excluded.updated_at`,
        )
        .run(input.attemptId, input.generation, now, now);
      const release = this.#raw
        .prepare(
          "UPDATE attempts SET status = 'uploaded', processing_lease_id = NULL, processing_lease_expires_at = NULL, updated_at = ? WHERE id = ? AND status = 'processing' AND deletion_state = 'active' AND processing_generation = ? AND processing_lease_id = ?",
        )
        .run(now, input.attemptId, input.generation, input.leaseId);
      if (release.changes !== 1) return Object.freeze({ kind: "lost-claim" });
      this.#event(
        input.attemptId,
        input.generation,
        "processing-dead-lettered",
        now,
      );
      return Object.freeze({ kind: "dead-lettered" });
    });
  }

  public async finalizeTerminalResult(
    input: FinalizeTerminalResultInput,
  ): Promise<FinalizeTerminalResultOutcome> {
    return this.#transaction(() => {
      const row = this.#raw
        .prepare(
          "SELECT a.id, a.athlete_id, a.mode, a.challenge_id, a.challenge_version, a.status, a.deletion_state, a.media_json, a.processing_generation, a.processing_lease_id, a.processing_lease_expires_at, a.created_at, tr.outcome_json FROM attempts a LEFT JOIN terminal_results tr ON tr.attempt_id = a.id WHERE a.id = ?",
        )
        .get(input.attemptId) as AttemptRow | undefined;
      if (!row) return Object.freeze({ kind: "lost-claim" });
      if (row.deletion_state !== "active")
        return Object.freeze({ kind: "tombstoned" });
      const existing = this.#raw
        .prepare(
          "SELECT id, lease_id, generation, outcome_json, candidate_json FROM terminal_results WHERE attempt_id = ?",
        )
        .get(input.attemptId) as TerminalResultRow | undefined;
      if (existing) {
        if (
          existing.lease_id === input.leaseId &&
          existing.generation === input.generation &&
          existing.candidate_json === stableJson(input.candidate)
        ) {
          return Object.freeze({
            kind: "idempotent",
            finalized: this.finalizedFromRows(row, existing.outcome_json),
          });
        }
        throw new RepositoryError("terminal_result_conflict");
      }
      if (
        row.status !== "processing" ||
        row.processing_generation !== input.generation ||
        row.processing_lease_id !== input.leaseId ||
        row.processing_lease_expires_at === null ||
        row.processing_lease_expires_at <= this.#clock.now()
      )
        return Object.freeze({ kind: "lost-claim" });

      const candidate = parseTerminalCandidate(input.candidate, row);
      const committedAt = this.#clock.now();
      let outcome: Exclude<AttemptOutcome, { state: "pending" }>;
      let leaderboard: Readonly<{
        entryId: string;
        score: number;
        completedAt: string;
        snapshot: object;
      }> | null = null;
      if (
        isRankedCandidate(candidate) &&
        (!input.rankedPolicy ||
          !this.#compositionToken ||
          !isCurrentRankedPolicyFinalization(input.rankedPolicy, {
            token: this.#compositionToken,
            now: committedAt,
            result: candidate.result,
          }))
      ) {
        outcome = experimentalOutcome(candidate, row);
      } else if (isRankedCandidate(candidate)) {
        const entryId = this.ids.next();
        const cohort = this.currentCohort();
        const rankable: DomainWallPassRankableResult = {
          attemptId: input.attemptId,
          entryId,
          score: candidate.result.score,
          completedAt: candidate.result.completedAt,
          state: "valid",
          active: true,
          competitiveEligible: true,
          challengeId: candidate.result.challengeId,
          challengeVersion: candidate.result.challengeVersion,
          ruleVersion: candidate.result.ruleVersion,
        };
        const snapshot = calculateSnapshot(
          [...cohort, rankable],
          input.attemptId,
          committedAt,
        );
        const rankedOutcome = AttemptOutcomeSchema.parse({
          state: "valid",
          result: { ...candidate.result, rankingSnapshot: snapshot },
        });
        if (!isRankedOutcome(rankedOutcome))
          throw new RepositoryError("invalid_terminal_outcome");
        outcome = rankedOutcome;
        leaderboard = Object.freeze({
          entryId,
          score: rankedOutcome.result.score,
          completedAt: rankedOutcome.result.completedAt,
          snapshot,
        });
      } else {
        outcome = parseTerminalOutcome(candidate, row);
      }

      const completedAt = terminalCompletedAt(outcome, committedAt);
      const terminalId = this.ids.next();
      this.#raw
        .prepare(
          "INSERT INTO terminal_results (id, attempt_id, lease_id, generation, terminal_state, outcome_json, candidate_json, completed_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          terminalId,
          input.attemptId,
          input.leaseId,
          input.generation,
          outcome.state,
          stableJson(outcome),
          stableJson(input.candidate),
          completedAt,
          committedAt,
        );
      this.#raw
        .prepare(
          "UPDATE attempts SET status = ?, processing_context_json = NULL, processing_lease_id = NULL, processing_lease_expires_at = NULL, updated_at = ? WHERE id = ? AND deletion_state = 'active' AND status = 'processing' AND processing_generation = ? AND processing_lease_id = ?",
        )
        .run(
          outcome.state,
          committedAt,
          input.attemptId,
          input.generation,
          input.leaseId,
        );
      if (leaderboard) {
        const commitSequence = this.nextLeaderboardCommitSequence();
        this.#raw
          .prepare(
            "INSERT INTO leaderboard_entries (id, result_id, attempt_id, challenge_id, challenge_version, rule_version, score, completed_at, ranking_snapshot_json, created_at, commit_sequence) VALUES (?, ?, ?, 'wall-pass', 1, 'wall-pass-v1-score-1', ?, ?, ?, ?, ?)",
          )
          .run(
            leaderboard.entryId,
            terminalId,
            input.attemptId,
            leaderboard.score,
            leaderboard.completedAt,
            stableJson(leaderboard.snapshot),
            committedAt,
            commitSequence,
          );
      }
      this.#event(
        input.attemptId,
        input.generation,
        "terminal-finalized",
        committedAt,
      );
      this.#raw
        .prepare(
          "DELETE FROM processing_recovery_records WHERE attempt_id = ? AND generation = ?",
        )
        .run(input.attemptId, input.generation);
      // A terminalized generation no longer needs queue-delivery recovery;
      // normal C5 retention remains independently durable.
      this.#raw
        .prepare(
          "DELETE FROM media_delivery_recovery_records WHERE attempt_id = ? AND generation = ? AND state IN ('pending-delivery', 'queued')",
        )
        .run(input.attemptId, input.generation);
      return Object.freeze({
        kind: "finalized",
        finalized: this.finalizedFromRows(
          { ...row, status: outcome.state },
          stableJson(outcome),
        ),
      });
    });
  }

  public async tombstoneAttempt(
    input: Readonly<{ attemptId: string; athleteId: string }>,
  ): Promise<void> {
    await this.#transaction(() => {
      const row = this.#raw
        .prepare(
          "SELECT id, processing_generation FROM attempts WHERE id = ? AND athlete_id = ? AND deletion_state = 'active'",
        )
        .get(input.attemptId, input.athleteId) as
        | { id: string; processing_generation: number }
        | undefined;
      if (!row) throw new RepositoryError("attempt_not_found");
      const now = this.#clock.now();
      this.#raw
        .prepare("DELETE FROM leaderboard_entries WHERE attempt_id = ?")
        .run(input.attemptId);
      this.#raw
        .prepare("DELETE FROM terminal_results WHERE attempt_id = ?")
        .run(input.attemptId);
      this.#raw
        .prepare("DELETE FROM canonical_observations WHERE attempt_id = ?")
        .run(input.attemptId);
      this.#raw
        .prepare("DELETE FROM processing_recovery_records WHERE attempt_id = ?")
        .run(input.attemptId);
      this.#raw
        .prepare(
          `UPDATE media_delivery_recovery_records
              SET state = 'cleanup-recoverable', requires_rollback = 0,
                  queued_at = NULL, rollback_completed_at = NULL,
                  recovery_lease_id = NULL, recovery_lease_expires_at = NULL,
                  updated_at = ?
            WHERE attempt_id = ? AND state <> 'resolved'`,
        )
        .run(now, input.attemptId);
      this.#raw
        .prepare(
          "UPDATE media_retention_records SET cleanup_requested_at = ? WHERE attempt_id = ?",
        )
        .run(now, input.attemptId);
      this.#raw
        .prepare(
          "UPDATE retention_cleanup_records SET cleanup_requested_at = ? WHERE attempt_id = ?",
        )
        .run(now, input.attemptId);
      this.#raw
        .prepare(
          "UPDATE attempts SET deletion_state = 'tombstoned', processing_context_json = NULL, processing_generation = processing_generation + 1, processing_lease_id = NULL, processing_lease_expires_at = NULL, tombstoned_at = ?, updated_at = ? WHERE id = ? AND athlete_id = ? AND deletion_state = 'active'",
        )
        .run(now, now, input.attemptId, input.athleteId);
      this.#event(
        input.attemptId,
        row.processing_generation + 1,
        "tombstoned",
        now,
      );
    });
  }

  public async listLiveLeaderboard(
    input: LiveLeaderboardPageInput,
  ): Promise<LiveLeaderboardPage> {
    assertLiveLeaderboardInput(input);
    const cursor = input.cursor
      ? this.liveLeaderboardCursor.decode(input.cursor)
      : null;
    if (
      cursor &&
      (cursor.challengeId !== input.challenge.id ||
        cursor.challengeVersion !== input.challenge.version ||
        cursor.ruleVersion !== input.challenge.ruleVersion)
    )
      throw new RepositoryError("invalid_input");
    const calculatedAt = cursor ? cursor.calculatedAt : this.#clock.now();
    const snapshotSequence = cursor
      ? cursor.snapshotSequence
      : this.leaderboardCommitSequence(calculatedAt);
    const ranked = rankWallPassV1Cohort(
      this.currentCohort(calculatedAt, snapshotSequence),
    );
    const afterCursor = cursor
      ? ranked.filter((entry) => isAfterLiveLeaderboardCursor(entry, cursor))
      : ranked;
    const entries = afterCursor.slice(0, input.limit).map((entry) =>
      Object.freeze({
        entryId: entry.entryId,
        rank: entry.rank,
        score: entry.score,
        completedAt: entry.completedAt,
      }),
    );
    const last = afterCursor[input.limit - 1];
    return Object.freeze({
      entries: Object.freeze(entries),
      calculatedAt,
      cohortSize: ranked.length,
      nextCursor:
        afterCursor.length > input.limit && last
          ? this.liveLeaderboardCursor.encode(
              Object.freeze({
                version: 3,
                challengeId: input.challenge.id,
                challengeVersion: input.challenge.version,
                ruleVersion: input.challenge.ruleVersion,
                calculatedAt,
                snapshotSequence,
                score: last.score,
                completedAt: last.completedAt,
                attemptId: last.attemptId,
              }),
            )
          : null,
    });
  }

  private currentCohort(
    cutoff?: string,
    snapshotSequence?: number,
  ): DomainWallPassRankableResult[] {
    const sql =
      cutoff && snapshotSequence !== undefined
        ? `SELECT le.attempt_id, le.id AS entry_id, le.score, le.completed_at
       FROM leaderboard_entries le
       INNER JOIN attempts a ON a.id = le.attempt_id
       WHERE a.deletion_state = 'active' AND a.status = 'valid'
         AND le.challenge_id = 'wall-pass' AND le.challenge_version = 1 AND le.rule_version = 'wall-pass-v1-score-1'
         AND le.completed_at <= ? AND le.commit_sequence <= ?`
        : `SELECT le.attempt_id, le.id AS entry_id, le.score, le.completed_at
       FROM leaderboard_entries le
       INNER JOIN attempts a ON a.id = le.attempt_id
       WHERE a.deletion_state = 'active' AND a.status = 'valid'
         AND le.challenge_id = 'wall-pass' AND le.challenge_version = 1 AND le.rule_version = 'wall-pass-v1-score-1'`;
    const statement = this.#raw.prepare(sql);
    return (
      cutoff && snapshotSequence !== undefined
        ? statement.all(cutoff, snapshotSequence)
        : statement.all()
    ).map(parseCohortRow);
  }

  private nextLeaderboardCommitSequence(): number {
    const updated = this.#raw
      .prepare(
        "UPDATE leaderboard_commit_clock SET sequence = sequence + 1 WHERE singleton = 1",
      )
      .run();
    if (updated.changes !== 1)
      throw new RepositoryError("persisted_data_corrupt");
    return this.leaderboardCommitSequence();
  }

  private leaderboardCommitSequence(cutoff?: string): number {
    const row = cutoff
      ? (this.#raw
          .prepare(
            "SELECT COALESCE(MAX(commit_sequence), 0) AS sequence FROM leaderboard_entries WHERE created_at <= ?",
          )
          .get(cutoff) as { sequence: number } | undefined)
      : (this.#raw
          .prepare(
            "SELECT sequence FROM leaderboard_commit_clock WHERE singleton = 1",
          )
          .get() as { sequence: number } | undefined);
    if (!row || !Number.isSafeInteger(row.sequence) || row.sequence < 0)
      throw new RepositoryError("persisted_data_corrupt");
    return row.sequence;
  }

  private finalizedFromRows(
    row: AttemptRow,
    outcomeJson: string,
  ): FinalizedAttempt {
    const outcome = parsePersistedOutcome(outcomeJson);
    return Object.freeze({
      attempt: parseAttemptRow({ ...row, outcome_json: outcomeJson }),
      outcome,
    });
  }

  private selectScopedAttempt(
    attemptId: string,
    athleteId: string,
  ): AttemptRow | null {
    const row = this.#raw
      .prepare(
        "SELECT a.id, a.athlete_id, a.mode, a.challenge_id, a.challenge_version, a.status, a.deletion_state, a.media_json, a.processing_generation, a.processing_lease_id, a.processing_lease_expires_at, a.created_at, tr.outcome_json FROM attempts a LEFT JOIN terminal_results tr ON tr.attempt_id = a.id WHERE a.id = ? AND a.athlete_id = ? AND a.deletion_state = 'active'",
      )
      .get(attemptId, athleteId) as AttemptRow | undefined;
    return row ?? null;
  }

  private mustGetScopedAttempt(
    attemptId: string,
    athleteId: string,
  ): AttemptRow {
    const attempt = this.selectScopedAttempt(attemptId, athleteId);
    if (!attempt) throw new RepositoryError("attempt_not_found");
    return attempt;
  }

  private ensureAthlete(athleteId: string, createdAt: string): void {
    this.#raw
      .prepare(
        "INSERT INTO athletes (id, created_at) VALUES (?, ?) ON CONFLICT(id) DO NOTHING",
      )
      .run(athleteId, createdAt);
  }

  private consumeCalibrationSession(
    athleteId: string,
    input: Extract<CreateAttemptInput, { mode: "verified" }>,
    now: string,
  ): void {
    const row = this.#raw
      .prepare(
        "SELECT id, athlete_id, nonce, challenge_id, challenge_version, state, issued_at, expires_at, ready_at, consumed_at FROM calibration_sessions WHERE id = ?",
      )
      .get(input.calibrationSessionId);
    if (!row) throw new RepositoryError("calibration_session_not_found");
    const session = parseCalibrationRow(row);
    if (session.athleteId !== athleteId)
      throw new RepositoryError("calibration_session_not_found");
    if (session.expiresAt <= now) {
      this.#raw
        .prepare(
          "UPDATE calibration_sessions SET state = 'expired' WHERE id = ? AND state IN ('issued', 'ready')",
        )
        .run(input.calibrationSessionId);
      throw new RepositoryError("calibration_session_expired");
    }
    if (session.state === "consumed")
      throw new RepositoryError("calibration_session_consumed");
    if (
      session.challengeId !== input.challengeId ||
      session.challengeVersion !== input.challengeVersion
    )
      throw new RepositoryError("calibration_session_challenge_mismatch");
    if (session.state !== "ready")
      throw new RepositoryError("calibration_session_not_ready");
    this.#raw
      .prepare(
        "UPDATE calibration_sessions SET state = 'consumed', consumed_at = ? WHERE id = ? AND state = 'ready'",
      )
      .run(now, input.calibrationSessionId);
  }

  #event(
    attemptId: string,
    generation: number,
    eventType: string,
    createdAt: string,
  ): void {
    this.#raw
      .prepare(
        "INSERT INTO processing_events (attempt_id, generation, event_type, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(attemptId, generation, eventType, createdAt);
  }

  #transaction<T>(operation: () => T): T {
    this.#raw.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.#raw.exec("COMMIT");
      return result;
    } catch (error) {
      this.#raw.exec("ROLLBACK");
      throw error;
    }
  }

  #deliveryRecovery(
    input: Readonly<{ attemptId: string; generation: number }>,
  ): MediaDeliveryRecoveryRow | null {
    const row = this.#raw
      .prepare(
        `SELECT attempt_id, generation, media_id, state, requires_rollback,
                frame_batch_id, queued_at, rollback_completed_at, cleanup_completed_at,
                recovery_lease_id, recovery_lease_expires_at
           FROM media_delivery_recovery_records
          WHERE attempt_id = ? AND generation = ?`,
      )
      .get(input.attemptId, input.generation) as
      | MediaDeliveryRecoveryRow
      | undefined;
    return row ?? null;
  }
}

const exactPrepareMediaUpload =
  SQLiteAttemptRepository.prototype.prepareMediaUpload;
const exactAttachPreparedMedia =
  SQLiteAttemptRepository.prototype.attachPreparedMedia;
const exactRollbackMediaAttachment =
  SQLiteAttemptRepository.prototype.rollbackMediaAttachment;
const exactBeginMediaAttachmentRecovery =
  SQLiteAttemptRepository.prototype.beginMediaAttachmentRecovery;
const exactAcknowledgeMediaAttachmentCleanup =
  SQLiteAttemptRepository.prototype.acknowledgeMediaAttachmentCleanup;
const exactMarkMediaDeliveryQueued =
  SQLiteAttemptRepository.prototype.markMediaDeliveryQueued;
const exactClaimProcessing = SQLiteAttemptRepository.prototype.claimProcessing;
const exactGetProcessingContext =
  SQLiteAttemptRepository.prototype.getProcessingContext;
const exactReleaseProcessingClaim =
  SQLiteAttemptRepository.prototype.releaseProcessingClaim;
const exactRecordProcessingFailure =
  SQLiteAttemptRepository.prototype.recordProcessingFailure;
const exactDeadLetterProcessingClaim =
  SQLiteAttemptRepository.prototype.deadLetterProcessingClaim;
const exactFinalizeTerminalResult =
  SQLiteAttemptRepository.prototype.finalizeTerminalResult;
const exactListLiveLeaderboard =
  SQLiteAttemptRepository.prototype.listLiveLeaderboard;
const exactTombstoneAttempt =
  SQLiteAttemptRepository.prototype.tombstoneAttempt;

function registerProductionSQLiteAttemptUploadPort(
  repository: SQLiteAttemptRepository,
  token: SqliteDatabaseCompositionToken,
  handoffVerifier: AcceptedMediaHandoffVerifier,
): void {
  if (!isCurrentProductionSQLiteAttemptRepository(repository)) return;
  const attachment = Object.freeze({
    attachPreparedMedia: (
      input: Readonly<{ accepted: AcceptedMediaHandoff }>,
    ) => exactAttachPreparedMedia.call(repository, input),
    rollbackMediaAttachment: (
      input: Readonly<{ attemptId: string; generation: number }>,
    ) => exactRollbackMediaAttachment.call(repository, input),
    beginMediaAttachmentRecovery: (
      input: Readonly<{
        attemptId: string;
        generation: number;
        mediaId: string;
        frameBatchId: string;
      }>,
    ) => exactBeginMediaAttachmentRecovery.call(repository, input),
    acknowledgeMediaAttachmentCleanup: (
      input: Readonly<{
        attemptId: string;
        generation: number;
        mediaId: string;
      }>,
    ) => exactAcknowledgeMediaAttachmentCleanup.call(repository, input),
    markMediaDeliveryQueued: (
      input: Readonly<{ attemptId: string; generation: number }>,
    ) => exactMarkMediaDeliveryQueued.call(repository, input),
  });
  productionSQLiteAttemptUploadPorts.set(
    repository,
    Object.freeze({
      token,
      isCurrent: () => isCurrentProductionSQLiteAttemptRepository(repository),
      handoffVerifier,
      prepareMediaUpload: (
        input: Readonly<{ attemptId: string; athleteId: string }>,
      ) => exactPrepareMediaUpload.call(repository, input),
      attachment,
    }),
  );
}

function registerProductionSQLiteAttemptProcessingPort(
  repository: SQLiteAttemptRepository,
  token: SqliteDatabaseCompositionToken,
  handoffVerifier: AcceptedMediaHandoffVerifier,
): void {
  if (!isCurrentProductionSQLiteAttemptRepository(repository)) return;
  productionSQLiteAttemptProcessingPorts.set(
    repository,
    Object.freeze({
      token,
      isCurrent: () => isCurrentProductionSQLiteAttemptRepository(repository),
      handoffVerifier,
      processing: Object.freeze({
        claimProcessing: (
          job: Parameters<AttemptRepository["claimProcessing"]>[0],
        ) => exactClaimProcessing.call(repository, job),
        getProcessingContext: (
          input: Parameters<AttemptRepository["getProcessingContext"]>[0],
        ) => exactGetProcessingContext.call(repository, input),
        releaseProcessingClaim: (
          input: Parameters<AttemptRepository["releaseProcessingClaim"]>[0],
        ) => exactReleaseProcessingClaim.call(repository, input),
        recordProcessingFailure: (
          input: Parameters<AttemptRepository["recordProcessingFailure"]>[0],
        ) => exactRecordProcessingFailure.call(repository, input),
        deadLetterProcessingClaim: (
          input: Parameters<AttemptRepository["deadLetterProcessingClaim"]>[0],
        ) => exactDeadLetterProcessingClaim.call(repository, input),
        finalizeTerminalResult: (
          input: Parameters<AttemptRepository["finalizeTerminalResult"]>[0],
        ) => exactFinalizeTerminalResult.call(repository, input),
        listLiveLeaderboard: (
          input: Parameters<AttemptRepository["listLiveLeaderboard"]>[0],
        ) => exactListLiveLeaderboard.call(repository, input),
        tombstoneAttempt: (
          input: Parameters<AttemptRepository["tombstoneAttempt"]>[0],
        ) => exactTombstoneAttempt.call(repository, input),
      }),
    }),
  );
}

function registerProductionSQLiteAttemptReadinessPort(
  repository: SQLiteAttemptRepository,
  raw: Readonly<{
    prepare(sql: string): Readonly<{ get(): unknown }>;
  }>,
): void {
  if (!isCurrentProductionSQLiteAttemptRepository(repository)) return;
  productionSQLiteAttemptReadinessPorts.set(
    repository,
    Object.freeze({
      probeDatabase: async (signal) => {
        if (!isCurrentProductionSQLiteAttemptRepository(repository))
          throw new Error("C9 readiness composition is no longer current.");
        if (signal?.aborted)
          throw signal.reason ?? new Error("database readiness aborted");
        raw.prepare("SELECT 1").get();
        if (signal?.aborted)
          throw signal.reason ?? new Error("database readiness aborted");
      },
    }),
  );
}

function isCurrentProductionSQLiteAttemptRepository(
  repository: SQLiteAttemptRepository,
): boolean {
  return (
    Object.getPrototypeOf(repository) === SQLiteAttemptRepository.prototype &&
    !Object.hasOwn(repository, "prepareMediaUpload") &&
    !Object.hasOwn(repository, "attachPreparedMedia") &&
    !Object.hasOwn(repository, "rollbackMediaAttachment") &&
    !Object.hasOwn(repository, "beginMediaAttachmentRecovery") &&
    !Object.hasOwn(repository, "acknowledgeMediaAttachmentCleanup") &&
    !Object.hasOwn(repository, "markMediaDeliveryQueued") &&
    !Object.hasOwn(repository, "claimProcessing") &&
    !Object.hasOwn(repository, "getProcessingContext") &&
    !Object.hasOwn(repository, "releaseProcessingClaim") &&
    !Object.hasOwn(repository, "recordProcessingFailure") &&
    !Object.hasOwn(repository, "deadLetterProcessingClaim") &&
    !Object.hasOwn(repository, "finalizeTerminalResult") &&
    !Object.hasOwn(repository, "listLiveLeaderboard") &&
    !Object.hasOwn(repository, "tombstoneAttempt") &&
    hasExactProductionMethod("prepareMediaUpload", exactPrepareMediaUpload) &&
    hasExactProductionMethod("attachPreparedMedia", exactAttachPreparedMedia) &&
    hasExactProductionMethod(
      "rollbackMediaAttachment",
      exactRollbackMediaAttachment,
    ) &&
    hasExactProductionMethod(
      "beginMediaAttachmentRecovery",
      exactBeginMediaAttachmentRecovery,
    ) &&
    hasExactProductionMethod(
      "acknowledgeMediaAttachmentCleanup",
      exactAcknowledgeMediaAttachmentCleanup,
    ) &&
    hasExactProductionMethod(
      "markMediaDeliveryQueued",
      exactMarkMediaDeliveryQueued,
    ) &&
    hasExactProductionMethod("claimProcessing", exactClaimProcessing) &&
    hasExactProductionMethod(
      "getProcessingContext",
      exactGetProcessingContext,
    ) &&
    hasExactProductionMethod(
      "releaseProcessingClaim",
      exactReleaseProcessingClaim,
    ) &&
    hasExactProductionMethod(
      "recordProcessingFailure",
      exactRecordProcessingFailure,
    ) &&
    hasExactProductionMethod(
      "deadLetterProcessingClaim",
      exactDeadLetterProcessingClaim,
    ) &&
    hasExactProductionMethod(
      "finalizeTerminalResult",
      exactFinalizeTerminalResult,
    ) &&
    hasExactProductionMethod("listLiveLeaderboard", exactListLiveLeaderboard) &&
    hasExactProductionMethod("tombstoneAttempt", exactTombstoneAttempt)
  );
}

type ProductionAttemptMethod =
  | "prepareMediaUpload"
  | "attachPreparedMedia"
  | "rollbackMediaAttachment"
  | "beginMediaAttachmentRecovery"
  | "acknowledgeMediaAttachmentCleanup"
  | "markMediaDeliveryQueued"
  | "claimProcessing"
  | "getProcessingContext"
  | "releaseProcessingClaim"
  | "recordProcessingFailure"
  | "deadLetterProcessingClaim"
  | "finalizeTerminalResult"
  | "listLiveLeaderboard"
  | "tombstoneAttempt";

/** Descriptor inspection does not invoke a hostile getter installed later. */
function hasExactProductionMethod(
  name: ProductionAttemptMethod,
  expected: unknown,
): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(
    SQLiteAttemptRepository.prototype,
    name,
  );
  if (!descriptor) return false;
  return descriptor.value === expected && !descriptor.get && !descriptor.set;
}

function parseAttemptRow(row: unknown): AttemptRecord {
  const value = asRecord(row);
  const requiredStrings = [
    "id",
    "athlete_id",
    "mode",
    "status",
    "deletion_state",
    "created_at",
  ];
  if (requiredStrings.some((key) => typeof value[key] !== "string"))
    throw new RepositoryError("persisted_data_corrupt");
  if (
    (value.mode !== "free" && value.mode !== "verified") ||
    !isAttemptStatus(value.status) ||
    (value.deletion_state !== "active" &&
      value.deletion_state !== "tombstoned") ||
    !UtcIsoTimestampSchema.safeParse(value.created_at).success ||
    !Number.isInteger(value.processing_generation) ||
    (value.processing_generation as number) < 0 ||
    !isNullableString(value.media_json) ||
    !isNullableString(value.processing_lease_id) ||
    !isNullableString(value.processing_lease_expires_at) ||
    !isNullableString(value.outcome_json)
  )
    throw new RepositoryError("persisted_data_corrupt");
  if (
    value.processing_lease_expires_at !== null &&
    !UtcIsoTimestampSchema.safeParse(value.processing_lease_expires_at).success
  )
    throw new RepositoryError("persisted_data_corrupt");
  if (
    (value.challenge_id !== null && value.challenge_id !== "wall-pass") ||
    (value.challenge_version !== null && value.challenge_version !== 1) ||
    (value.mode === "free" &&
      (value.challenge_id !== null || value.challenge_version !== null)) ||
    (value.mode === "verified" &&
      (value.challenge_id !== "wall-pass" || value.challenge_version !== 1))
  )
    throw new RepositoryError("persisted_data_corrupt");
  const outcome =
    value.outcome_json === null
      ? pendingOutcome(value.id as string, value.mode, value.status)
      : parsePersistedOutcome(value.outcome_json);
  if (
    (value.outcome_json === null &&
      (value.status === "valid" ||
        value.status === "invalid" ||
        value.status === "failed")) ||
    (value.outcome_json !== null &&
      (outcome.state === "pending" ||
        !isPersistedTerminalOutcomeForAttempt(outcome, {
          id: value.id as string,
          mode: value.mode,
          status: value.status,
        })))
  )
    throw new RepositoryError("persisted_data_corrupt");
  return Object.freeze({
    id: value.id as string,
    athleteId: value.athlete_id as string,
    mode: value.mode,
    status: value.status,
    createdAt: value.created_at as string,
    outcome,
    challenge:
      value.challenge_id === null
        ? null
        : Object.freeze({
            id: "wall-pass" as const,
            version: 1 as const,
          }),
    media:
      value.media_json === null ? null : parseStoredMedia(value.media_json),
  });
}

type PersistedCalibrationSession = Readonly<{
  id: string;
  athleteId: string;
  nonce: string;
  challengeId: "wall-pass";
  challengeVersion: 1;
  state: "issued" | "ready" | "consumed" | "expired";
  issuedAt: string;
  expiresAt: string;
}>;

function parseCalibrationRow(row: unknown): PersistedCalibrationSession {
  const value = asRecord(row);
  const requiredStrings = [
    "id",
    "athlete_id",
    "nonce",
    "challenge_id",
    "state",
    "issued_at",
    "expires_at",
  ];
  if (requiredStrings.some((key) => typeof value[key] !== "string"))
    throw new RepositoryError("persisted_data_corrupt");
  if (
    !isUuid(value.id) ||
    !isUuid(value.athlete_id) ||
    !/^[A-Za-z0-9_-]{43}$/.test(value.nonce as string) ||
    value.challenge_id !== "wall-pass" ||
    value.challenge_version !== 1 ||
    (value.state !== "issued" &&
      value.state !== "ready" &&
      value.state !== "consumed" &&
      value.state !== "expired") ||
    !UtcIsoTimestampSchema.safeParse(value.issued_at).success ||
    !UtcIsoTimestampSchema.safeParse(value.expires_at).success ||
    !isNullableString(value.ready_at) ||
    !isNullableString(value.consumed_at) ||
    (value.ready_at !== null &&
      !UtcIsoTimestampSchema.safeParse(value.ready_at).success) ||
    (value.consumed_at !== null &&
      !UtcIsoTimestampSchema.safeParse(value.consumed_at).success) ||
    Date.parse(value.expires_at as string) -
      Date.parse(value.issued_at as string) !==
      15 * 60_000
  )
    throw new RepositoryError("persisted_data_corrupt");
  return Object.freeze({
    id: value.id as string,
    athleteId: value.athlete_id as string,
    nonce: value.nonce as string,
    challengeId: "wall-pass",
    challengeVersion: 1,
    state: value.state as PersistedCalibrationSession["state"],
    issuedAt: value.issued_at as string,
    expiresAt: value.expires_at as string,
  });
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  );
}

function parseStoredMedia(value: string): StoredMedia {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new RepositoryError("persisted_data_corrupt");
  }
  const record = asRecord(parsed);
  if (
    !hasExactKeys(record, [
      "id",
      "contentType",
      "bytes",
      "uploadedAt",
      "deleteAt",
      "transition",
    ]) ||
    typeof record.id !== "string" ||
    record.id.length === 0 ||
    typeof record.contentType !== "string" ||
    record.contentType.length === 0 ||
    typeof record.bytes !== "number" ||
    !Number.isFinite(record.bytes) ||
    !Number.isInteger(record.bytes) ||
    record.bytes < 0 ||
    typeof record.uploadedAt !== "string" ||
    !UtcIsoTimestampSchema.safeParse(record.uploadedAt).success ||
    typeof record.deleteAt !== "string" ||
    !UtcIsoTimestampSchema.safeParse(record.deleteAt).success ||
    !isRecord(record.transition) ||
    !hasExactKeys(record.transition, ["kind", "resourceId", "deleteAt"]) ||
    record.transition.kind !== "upload-transition" ||
    typeof record.transition.resourceId !== "string" ||
    typeof record.transition.deleteAt !== "string" ||
    !UtcIsoTimestampSchema.safeParse(record.transition.deleteAt).success
  )
    throw new RepositoryError("persisted_data_corrupt");
  const media: StoredMedia = Object.freeze({
    id: record.id,
    contentType: record.contentType,
    bytes: record.bytes,
    uploadedAt: record.uploadedAt,
    deleteAt: record.deleteAt,
    transition: Object.freeze({
      kind: "upload-transition",
      resourceId: record.transition.resourceId,
      deleteAt: record.transition.deleteAt,
    }),
  });
  try {
    assertTransitionMedia(media);
  } catch {
    throw new RepositoryError("persisted_data_corrupt");
  }
  return media;
}

function uploadContextFromRow(
  row: UploadPreparationRow,
  uploadedAt: string,
): MediaUploadContext {
  if (
    !isUuid(row.id) ||
    !isUuid(row.athlete_id) ||
    !UtcIsoTimestampSchema.safeParse(uploadedAt).success ||
    !Number.isSafeInteger(row.processing_generation) ||
    row.processing_generation < 0
  )
    throw new RepositoryError("persisted_data_corrupt");
  if (row.deletion_state !== "active")
    throw new RepositoryError("attempt_not_found");
  if (row.media_json !== null)
    throw new RepositoryError("duplicate_media_upload");
  if (row.status !== "awaiting-upload")
    throw new RepositoryError("invalid_attempt_transition");
  const generation = row.processing_generation + 1;
  if (!Number.isSafeInteger(generation))
    throw new RepositoryError("persisted_data_corrupt");
  if (row.mode === "free") {
    if (
      row.challenge_id !== null ||
      row.challenge_version !== null ||
      row.calibration_session_id !== null ||
      row.calibration_nonce !== null
    )
      throw new RepositoryError("persisted_data_corrupt");
    return Object.freeze({
      attemptId: row.id,
      athleteId: row.athlete_id,
      mode: "free",
      generation,
      uploadedAt,
      verified: null,
    });
  }
  if (
    row.mode !== "verified" ||
    row.challenge_id !== "wall-pass" ||
    row.challenge_version !== 1 ||
    !isUuid(row.calibration_session_id) ||
    typeof row.calibration_nonce !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(row.calibration_nonce)
  )
    throw new RepositoryError("persisted_data_corrupt");
  return Object.freeze({
    attemptId: row.id,
    athleteId: row.athlete_id,
    mode: "verified",
    generation,
    uploadedAt,
    verified: Object.freeze({
      challenge: Object.freeze({
        id: "wall-pass" as const,
        version: 1 as const,
      }),
      calibrationSessionId: row.calibration_session_id,
      calibrationNonce: row.calibration_nonce,
    }),
  });
}

function sameUploadContext(
  left: MediaUploadContext,
  right: MediaUploadContext,
): boolean {
  if (
    left.attemptId !== right.attemptId ||
    left.athleteId !== right.athleteId ||
    left.mode !== right.mode ||
    left.generation !== right.generation ||
    left.uploadedAt !== right.uploadedAt
  )
    return false;
  if (left.mode === "free" || right.mode === "free")
    return left.mode === "free" && right.mode === "free";
  return (
    left.verified.challenge.id === right.verified.challenge.id &&
    left.verified.challenge.version === right.verified.challenge.version &&
    left.verified.calibrationSessionId ===
      right.verified.calibrationSessionId &&
    left.verified.calibrationNonce === right.verified.calibrationNonce
  );
}

function parsePersistedProcessingContext(
  value: string,
): PersistedProcessingContext {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new RepositoryError("persisted_data_corrupt");
  }
  const record = asRecord(parsed);
  if (!hasExactKeys(record, ["processing", "sourceSha256", "upload"]))
    throw new RepositoryError("persisted_data_corrupt");
  const upload = parsePersistedUploadContext(record.upload);
  let processing: DurableProcessingContext;
  try {
    processing = parseDurableProcessingContext(record.processing);
  } catch {
    throw new RepositoryError("persisted_data_corrupt");
  }
  if (
    processing.kind !== "c5-durable-processing-context-v2" ||
    typeof record.sourceSha256 !== "string" ||
    !/^[a-f0-9]{64}$/i.test(record.sourceSha256)
  )
    throw new RepositoryError("persisted_data_corrupt");
  return Object.freeze({
    upload,
    processing,
    sourceSha256: record.sourceSha256,
  });
}

function projectMediaDeliveryRecovery(
  row: MediaDeliveryRecoveryRow,
): MediaDeliveryRecovery {
  if (
    !isUuid(row.attempt_id) ||
    (row.attempt_mode !== undefined &&
      row.attempt_mode !== "free" &&
      row.attempt_mode !== "verified") ||
    !Number.isSafeInteger(row.generation) ||
    row.generation < 1 ||
    typeof row.media_id !== "string" ||
    row.media_id.length < 1 ||
    row.frame_batch_id === null ||
    !isUuid(row.frame_batch_id) ||
    row.frame_batch_id.length !== 36 ||
    !["pending-delivery", "queued", "cleanup-recoverable", "resolved"].includes(
      row.state,
    ) ||
    (row.requires_rollback !== 0 && row.requires_rollback !== 1) ||
    !isNullableUtcTimestamp(row.queued_at) ||
    !isNullableUtcTimestamp(row.rollback_completed_at) ||
    !isNullableUtcTimestamp(row.cleanup_completed_at) ||
    !isNullableString(row.recovery_lease_id) ||
    !isNullableUtcTimestamp(row.recovery_lease_expires_at) ||
    (row.state === "pending-delivery" &&
      (row.requires_rollback !== 1 ||
        row.queued_at !== null ||
        row.rollback_completed_at !== null ||
        row.cleanup_completed_at !== null)) ||
    (row.state === "queued" &&
      (row.requires_rollback !== 0 ||
        row.queued_at === null ||
        row.rollback_completed_at !== null ||
        row.cleanup_completed_at !== null)) ||
    (row.state === "cleanup-recoverable" &&
      (row.queued_at !== null || row.cleanup_completed_at !== null)) ||
    (row.state === "resolved" &&
      (row.queued_at !== null ||
        row.cleanup_completed_at === null ||
        (row.requires_rollback === 1 && row.rollback_completed_at === null))) ||
    (row.rollback_completed_at !== null && row.requires_rollback !== 1) ||
    (row.recovery_lease_id === null) !==
      (row.recovery_lease_expires_at === null) ||
    (row.state === "resolved" &&
      (row.recovery_lease_id !== null ||
        row.recovery_lease_expires_at !== null))
  )
    throw new RepositoryError("persisted_data_corrupt");
  return Object.freeze({
    attemptId: row.attempt_id,
    generation: row.generation,
    ...(row.attempt_mode === undefined ? {} : { mode: row.attempt_mode }),
    mediaId: row.media_id,
    frameBatchId: row.frame_batch_id,
    state: row.state,
    requiresRollback: row.requires_rollback === 1,
  });
}

function assertRecoveryClaimInput(
  input: Readonly<{ now: string; limit: number }>,
): void {
  if (!UtcIsoTimestampSchema.safeParse(input.now).success)
    throw new RepositoryError("invalid_input");
  if (
    !Number.isSafeInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > 100
  )
    throw new RepositoryError("invalid_input");
}

function assertClaimableProcessingRow(
  row: ProcessingAuthorityRow,
): PersistedProcessingContext {
  if (
    row.processing_context_json === null ||
    row.media_json === null ||
    row.media_sha256 === null ||
    row.processing_receipt_id === null ||
    row.processing_receipt_sha256 === null
  )
    throw new RepositoryError("persisted_data_corrupt");
  const persisted = parsePersistedProcessingContext(
    row.processing_context_json,
  );
  const processing = persisted.processing;
  if (processing.kind !== "c5-durable-processing-context-v2")
    throw new RepositoryError("persisted_data_corrupt");
  let media: StoredMedia;
  try {
    media = parseStoredMedia(row.media_json);
  } catch {
    throw new RepositoryError("persisted_data_corrupt");
  }
  const expectedUpload =
    row.mode === "free"
      ? Object.freeze({
          attemptId: row.id,
          athleteId: row.athlete_id,
          mode: "free" as const,
          generation: row.processing_generation,
          uploadedAt: media.uploadedAt,
          verified: null,
        })
      : Object.freeze({
          attemptId: row.id,
          athleteId: row.athlete_id,
          mode: "verified" as const,
          generation: row.processing_generation,
          uploadedAt: media.uploadedAt,
          verified:
            row.challenge_id === "wall-pass" &&
            row.challenge_version === 1 &&
            row.calibration_session_id !== null &&
            row.calibration_nonce !== null
              ? Object.freeze({
                  challenge: Object.freeze({
                    id: "wall-pass" as const,
                    version: 1 as const,
                  }),
                  calibrationSessionId: row.calibration_session_id,
                  calibrationNonce: row.calibration_nonce,
                })
              : null,
        });
  if (
    (expectedUpload.mode === "verified" && expectedUpload.verified === null) ||
    !sameUploadContext(
      persisted.upload,
      expectedUpload as MediaUploadContext,
    ) ||
    persisted.sourceSha256 !== row.media_sha256 ||
    processing.receipt.frameBatchId !== row.processing_receipt_id ||
    processing.receipt.sha256 !== row.processing_receipt_sha256 ||
    media.id !== processing.receipt.mediaId
  )
    throw new RepositoryError("persisted_data_corrupt");
  return persisted;
}

function parsePersistedUploadContext(value: unknown): MediaUploadContext {
  const record = asRecord(value);
  const generation = record.generation;
  if (
    !hasExactKeys(record, [
      "attemptId",
      "athleteId",
      "mode",
      "generation",
      "uploadedAt",
      "verified",
    ]) ||
    !isUuid(record.attemptId) ||
    !isUuid(record.athleteId) ||
    typeof generation !== "number" ||
    !Number.isSafeInteger(generation) ||
    generation < 1 ||
    typeof record.uploadedAt !== "string" ||
    !UtcIsoTimestampSchema.safeParse(record.uploadedAt).success
  )
    throw new RepositoryError("persisted_data_corrupt");
  if (record.mode === "free") {
    if (record.verified !== null)
      throw new RepositoryError("persisted_data_corrupt");
    return Object.freeze({
      attemptId: record.attemptId,
      athleteId: record.athleteId,
      mode: "free",
      generation,
      uploadedAt: record.uploadedAt,
      verified: null,
    });
  }
  if (record.mode !== "verified" || !isRecord(record.verified))
    throw new RepositoryError("persisted_data_corrupt");
  const verified = record.verified;
  if (
    !hasExactKeys(verified, [
      "challenge",
      "calibrationSessionId",
      "calibrationNonce",
    ]) ||
    !isRecord(verified.challenge) ||
    !hasExactKeys(verified.challenge, ["id", "version"]) ||
    verified.challenge.id !== "wall-pass" ||
    verified.challenge.version !== 1 ||
    !isUuid(verified.calibrationSessionId) ||
    typeof verified.calibrationNonce !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(verified.calibrationNonce)
  )
    throw new RepositoryError("persisted_data_corrupt");
  return Object.freeze({
    attemptId: record.attemptId,
    athleteId: record.athleteId,
    mode: "verified",
    generation,
    uploadedAt: record.uploadedAt,
    verified: Object.freeze({
      challenge: Object.freeze({
        id: "wall-pass" as const,
        version: 1 as const,
      }),
      calibrationSessionId: verified.calibrationSessionId,
      calibrationNonce: verified.calibrationNonce,
    }),
  });
}

function assertTransitionMedia(media: StoredMedia): void {
  if (
    !UtcIsoTimestampSchema.safeParse(media.uploadedAt).success ||
    !UtcIsoTimestampSchema.safeParse(media.deleteAt).success ||
    !UtcIsoTimestampSchema.safeParse(media.transition.deleteAt).success ||
    media.transition.kind !== "upload-transition" ||
    media.transition.resourceId !== media.id ||
    media.deleteAt !== originalOrFrameDeleteAt(media.uploadedAt) ||
    media.transition.deleteAt !== temporaryDeleteAt(media.uploadedAt)
  )
    throw new RepositoryError("invalid_input");
}

/**
 * Runtime-only C5 boundary. Extra fields are intentionally discarded instead
 * of becoming durable JSON; malformed canonical fields fail before SQL.
 */
function projectStoredMedia(value: unknown): StoredMedia {
  if (!isStoredMediaAttachment(value) || !isRecord(value.transition))
    throw new RepositoryError("invalid_input");
  if (
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    typeof value.contentType !== "string" ||
    value.contentType.length === 0 ||
    typeof value.bytes !== "number" ||
    !Number.isSafeInteger(value.bytes) ||
    value.bytes < 0 ||
    typeof value.uploadedAt !== "string" ||
    typeof value.deleteAt !== "string" ||
    value.transition.kind !== "upload-transition" ||
    typeof value.transition.resourceId !== "string" ||
    typeof value.transition.deleteAt !== "string"
  )
    throw new RepositoryError("invalid_input");
  return Object.freeze({
    id: value.id,
    contentType: value.contentType,
    bytes: value.bytes,
    uploadedAt: value.uploadedAt,
    deleteAt: value.deleteAt,
    transition: Object.freeze({
      kind: "upload-transition",
      resourceId: value.transition.resourceId,
      deleteAt: value.transition.deleteAt,
    }),
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new RepositoryError("persisted_data_corrupt");
  return value as Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const present = Object.keys(value).sort();
  return (
    present.length === keys.length &&
    present.every((key, index) => key === [...keys].sort()[index])
  );
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isNullableUtcTimestamp(value: unknown): value is string | null {
  return value === null || UtcIsoTimestampSchema.safeParse(value).success;
}

function isAttemptStatus(value: unknown): value is AttemptRecord["status"] {
  return (
    value === "awaiting-upload" ||
    value === "uploaded" ||
    value === "processing" ||
    value === "valid" ||
    value === "invalid" ||
    value === "failed"
  );
}

function pendingOutcome(
  attemptId: string,
  mode: "free" | "verified",
  status: AttemptRecord["status"],
): AttemptOutcome {
  if (
    status !== "awaiting-upload" &&
    status !== "uploaded" &&
    status !== "processing"
  )
    throw new RepositoryError("persisted_data_corrupt");
  return Object.freeze({ state: "pending", attemptId, mode, status });
}

function parsePersistedOutcome(
  outcomeJson: string,
): Exclude<AttemptOutcome, { state: "pending" }> {
  try {
    const parsed = AttemptOutcomeSchema.safeParse(JSON.parse(outcomeJson));
    if (!parsed.success || parsed.data.state === "pending")
      throw new Error("invalid outcome");
    return deeplyFreeze(parsed.data);
  } catch {
    throw new RepositoryError("persisted_data_corrupt");
  }
}

function isPersistedTerminalOutcomeForAttempt(
  outcome: Exclude<AttemptOutcome, { state: "pending" }>,
  attempt: Readonly<{
    id: string;
    mode: "free" | "verified";
    status: AttemptRecord["status"];
  }>,
): boolean {
  if (outcome.state === "valid")
    return (
      attempt.status === "valid" &&
      outcome.result.attemptId === attempt.id &&
      (outcome.result.kind === "free-insight"
        ? attempt.mode === "free"
        : attempt.mode === "verified")
    );
  return (
    outcome.state === attempt.status &&
    outcome.attemptId === attempt.id &&
    outcome.mode === attempt.mode
  );
}

function deeplyFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deeplyFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function parseCohortRow(row: unknown): DomainWallPassRankableResult {
  const value = asRecord(row);
  if (
    typeof value.attempt_id !== "string" ||
    value.attempt_id.length === 0 ||
    typeof value.entry_id !== "string" ||
    value.entry_id.length === 0 ||
    typeof value.score !== "number" ||
    !Number.isInteger(value.score) ||
    value.score < 0 ||
    value.score > 100 ||
    typeof value.completed_at !== "string" ||
    !UtcIsoTimestampSchema.safeParse(value.completed_at).success
  )
    throw new RepositoryError("persisted_data_corrupt");
  return Object.freeze({
    attemptId: value.attempt_id,
    entryId: value.entry_id,
    score: value.score,
    completedAt: value.completed_at,
    state: "valid",
    active: true,
    competitiveEligible: true,
    challengeId: "wall-pass",
    challengeVersion: 1,
    ruleVersion: "wall-pass-v1-score-1",
  });
}

function parseTerminalCandidate(
  candidate: TerminalCandidate,
  attempt: AttemptRow,
): TerminalCandidate {
  if (isRankedCandidate(candidate)) {
    if ("rankingSnapshot" in candidate.result)
      throw new RepositoryError("invalid_terminal_outcome");
    const parsed = VerifiedResultSchema.safeParse({
      ...candidate.result,
      rankingSnapshot: {
        kind: "frozen",
        challengeId: "wall-pass",
        challengeVersion: 1,
        ruleVersion: "wall-pass-v1-score-1",
        rank: 1,
        cohortSize: 1,
        percentile: 100,
        topPercent: 0,
        scoreCountAtFinalization: 1,
        asOfAttemptId: candidate.result.attemptId,
        calculatedAt: candidate.result.completedAt,
      },
    });
    if (!parsed.success || candidate.result.attemptId !== attempt.id)
      throw new RepositoryError("invalid_terminal_outcome");
    if (attempt.mode !== "verified")
      throw new RepositoryError("invalid_terminal_outcome");
    return candidate;
  }
  parseTerminalOutcome(candidate, attempt);
  return candidate;
}

/** A stale ranking authority never blocks a valid analysis result. */
function experimentalOutcome(
  candidate: RankedCandidate,
  attempt: AttemptRow,
): Exclude<AttemptOutcome, { state: "pending" }> {
  return parseTerminalOutcome(
    Object.freeze({
      state: "valid" as const,
      result: Object.freeze({
        ...candidate.result,
        competitiveStatus: "experimental" as const,
        competitiveEligible: false as const,
      }),
    }),
    attempt,
  );
}

function parseTerminalOutcome(
  outcome: unknown,
  attempt: AttemptRow,
): Exclude<AttemptOutcome, { state: "pending" }> {
  const parsed = AttemptOutcomeSchema.safeParse(outcome);
  if (!parsed.success || parsed.data.state === "pending")
    throw new RepositoryError("invalid_terminal_outcome");
  const outcomeAttemptId =
    parsed.data.state === "valid"
      ? parsed.data.result.attemptId
      : parsed.data.attemptId;
  const outcomeMode =
    parsed.data.state === "valid"
      ? parsed.data.result.kind === "free-insight"
        ? "free"
        : "verified"
      : parsed.data.mode;
  if (outcomeAttemptId !== attempt.id || outcomeMode !== attempt.mode)
    throw new RepositoryError("invalid_terminal_outcome");
  return parsed.data;
}

type RankedOutcome = Extract<AttemptOutcome, { state: "valid" }> & {
  result: Extract<
    Extract<AttemptOutcome, { state: "valid" }>["result"],
    { competitiveStatus: "ranked" }
  >;
};

type RankedTerminalCandidate = Extract<
  Extract<TerminalCandidate, { state: "valid" }>["result"],
  { competitiveStatus: "ranked" }
>;

type RankedCandidate = Readonly<{
  state: "valid";
  result: RankedTerminalCandidate;
}>;

function isRankedCandidate(
  candidate: TerminalCandidate,
): candidate is RankedCandidate {
  return (
    candidate.state === "valid" &&
    candidate.result.kind === "verified-result" &&
    candidate.result.competitiveStatus === "ranked"
  );
}

function isRankedOutcome(outcome: AttemptOutcome): outcome is RankedOutcome {
  return (
    outcome.state === "valid" &&
    outcome.result.kind === "verified-result" &&
    outcome.result.competitiveStatus === "ranked"
  );
}

function terminalCompletedAt(
  outcome: Exclude<AttemptOutcome, { state: "pending" }>,
  now: string,
): string {
  return outcome.state === "valid"
    ? outcome.result.kind === "free-insight"
      ? outcome.result.generatedAt
      : outcome.result.completedAt
    : now;
}

function calibrationSession(
  id: string,
  nonce: string,
  issuedAt: string,
  expiresAt: string,
  state: "issued" | "ready",
) {
  return Object.freeze({
    id,
    challengeId: "wall-pass" as const,
    challengeVersion: 1 as const,
    state,
    nonce,
    issuedAt,
    expiresAt,
    requiredGates: [
      "device",
      "space",
      "athlete",
      "rehearsal",
      "record",
    ] as const,
  });
}

function addMilliseconds(timestamp: string, milliseconds: number): string {
  return new Date(Date.parse(timestamp) + milliseconds).toISOString();
}

function stableJson(value: unknown): string {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  )
    return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(",")}}`;
  }
  throw new RepositoryError("invalid_terminal_outcome");
}

type LiveLeaderboardCursor = Pick<
  LiveLeaderboardCursorPayload,
  "attemptId" | "score" | "completedAt"
>;

const AES_256_GCM_KEY_BYTES = 32;
const AES_256_GCM_IV_BYTES = 12;
const AES_256_GCM_TAG_BYTES = 16;
const AES_256_GCM_MINIMUM_PAYLOAD_BYTES =
  AES_256_GCM_IV_BYTES + AES_256_GCM_TAG_BYTES;
const processAes256GcmCursorNonce = createAes256GcmNonceAllocator();
const processLiveLeaderboardCursorCrypto: LiveLeaderboardCursorCrypto =
  Object.freeze({
    key: randomBytes(AES_256_GCM_KEY_BYTES),
  });
const processAttemptCursorCrypto: AttemptCursorCrypto = Object.freeze({
  key: randomBytes(AES_256_GCM_KEY_BYTES),
});

/** AES-GCM attempt cursor with one independently-owned server key. */
export function createAttemptCursorCodec(
  input: AttemptCursorCrypto,
): AttemptCursorCodec {
  return createAes256GcmCursorCodec(
    input,
    parseAttemptCursorPayload,
    "Attempt",
  );
}

function parseAttemptCursorPayload(value: unknown): AttemptCursorPayload {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["version", "athleteId", "createdAt", "attemptId"]) ||
    value.version !== 1 ||
    !isUuid(value.athleteId) ||
    !isUuid(value.attemptId) ||
    typeof value.createdAt !== "string" ||
    !UtcIsoTimestampSchema.safeParse(value.createdAt).success
  )
    throw new Error("invalid attempt cursor");
  return Object.freeze({
    version: 1,
    athleteId: value.athleteId,
    createdAt: value.createdAt,
    attemptId: value.attemptId,
  });
}

/**
 * AES-GCM cursor encoding authenticates the cohort tuple, snapshot cutoff,
 * and complete C3 seek key. The process-random default intentionally makes
 * cursors invalid after restart; managed deployments can inject key material.
 */
export function createLiveLeaderboardCursorCodec(
  input: LiveLeaderboardCursorCrypto,
): LiveLeaderboardCursorCodec {
  return createAes256GcmCursorCodec(
    input,
    parseLiveLeaderboardCursorPayload,
    "Live leaderboard",
  );
}

type Aes256GcmCursorCrypto = Readonly<{
  key: Uint8Array;
}>;

type Aes256GcmCursorCodec<Payload> = Readonly<{
  encode(value: Payload): string;
  decode(cursor: string): Payload;
}>;

/**
 * AES-GCM cursor envelope shared by C3 and C4 pages. One process-wide,
 * random-seeded 96-bit monotonic nonce yields one twelve-byte IV per encode
 * without retaining an unbounded history of prior cursors.
 */
function createAes256GcmCursorCodec<Payload>(
  input: Aes256GcmCursorCrypto,
  parsePayload: (value: unknown) => Payload,
  name: string,
): Aes256GcmCursorCodec<Payload> {
  if (
    !(input.key instanceof Uint8Array) ||
    input.key.byteLength !== AES_256_GCM_KEY_BYTES
  )
    throw new Error(`${name} cursor key must be 32 bytes.`);
  const key = Buffer.from(input.key);
  return Object.freeze({
    encode(value: Payload): string {
      const payload = parsePayload(value);
      const iv = processAes256GcmCursorNonce.next();
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const encrypted = Buffer.concat([
        cipher.update(stableJson(payload), "utf8"),
        cipher.final(),
      ]);
      return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString(
        "base64url",
      );
    },
    decode(cursor: string): Payload {
      try {
        if (!/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error("invalid cursor");
        const encoded = Buffer.from(cursor, "base64url");
        if (encoded.toString("base64url") !== cursor)
          throw new Error("invalid cursor");
        if (encoded.length <= AES_256_GCM_MINIMUM_PAYLOAD_BYTES)
          throw new Error("invalid cursor");
        const decipher = createDecipheriv(
          "aes-256-gcm",
          key,
          encoded.subarray(0, AES_256_GCM_IV_BYTES),
        );
        decipher.setAuthTag(
          encoded.subarray(
            AES_256_GCM_IV_BYTES,
            AES_256_GCM_MINIMUM_PAYLOAD_BYTES,
          ),
        );
        return parsePayload(
          JSON.parse(
            Buffer.concat([
              decipher.update(
                encoded.subarray(AES_256_GCM_MINIMUM_PAYLOAD_BYTES),
              ),
              decipher.final(),
            ]).toString("utf8"),
          ),
        );
      } catch {
        throw new RepositoryError("invalid_input");
      }
    },
  });
}

function assertLiveLeaderboardInput(input: LiveLeaderboardPageInput): void {
  if (
    input.challenge.id !== "wall-pass" ||
    input.challenge.version !== 1 ||
    input.challenge.ruleVersion !== "wall-pass-v1-score-1" ||
    !Number.isSafeInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > 50
  )
    throw new RepositoryError("invalid_input");
}

function parseLiveLeaderboardCursorPayload(
  value: unknown,
): LiveLeaderboardCursorPayload {
  const score = isRecord(value) ? value.score : undefined;
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "version",
      "challengeId",
      "challengeVersion",
      "ruleVersion",
      "calculatedAt",
      "snapshotSequence",
      "attemptId",
      "score",
      "completedAt",
    ]) ||
    value.version !== 3 ||
    value.challengeId !== "wall-pass" ||
    value.challengeVersion !== 1 ||
    value.ruleVersion !== "wall-pass-v1-score-1" ||
    !isUuid(value.attemptId) ||
    typeof score !== "number" ||
    !Number.isInteger(score) ||
    score < 0 ||
    score > 100 ||
    typeof value.calculatedAt !== "string" ||
    !UtcIsoTimestampSchema.safeParse(value.calculatedAt).success ||
    typeof value.snapshotSequence !== "number" ||
    !Number.isSafeInteger(value.snapshotSequence) ||
    value.snapshotSequence < 0 ||
    typeof value.completedAt !== "string" ||
    !UtcIsoTimestampSchema.safeParse(value.completedAt).success
  )
    throw new Error("invalid live leaderboard cursor");
  return Object.freeze({
    version: 3,
    challengeId: "wall-pass",
    challengeVersion: 1,
    ruleVersion: "wall-pass-v1-score-1",
    calculatedAt: value.calculatedAt,
    snapshotSequence: value.snapshotSequence,
    attemptId: value.attemptId,
    score,
    completedAt: value.completedAt,
  });
}

function isAfterLiveLeaderboardCursor(
  entry: Readonly<{
    attemptId: string;
    score: number;
    completedAt: string;
  }>,
  cursor: LiveLeaderboardCursor,
): boolean {
  if (entry.score !== cursor.score) return entry.score < cursor.score;
  if (entry.completedAt !== cursor.completedAt)
    return entry.completedAt > cursor.completedAt;
  return entry.attemptId > cursor.attemptId;
}
