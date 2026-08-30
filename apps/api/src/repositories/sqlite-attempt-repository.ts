import {
  AttemptOutcomeSchema,
  type AttemptOutcome,
  type CreateAttemptInput,
  UtcIsoTimestampSchema,
  VerifiedResultSchema,
} from "@revelai/contracts";
import {
  calculateFrozenWallPassSnapshot as calculateSnapshot,
  calculateLiveWallPassLeaderboard as calculateLeaderboard,
  type WallPassRankableResult as DomainWallPassRankableResult,
} from "@revelai/domain";
import type { AnalysisJob } from "../queue/analysis-queue.js";
import type { SqliteDatabase } from "../database/sqlite-database.js";
import type {
  AttemptRecord,
  AttemptRepository,
  CalibrationSessionRecord,
  DeadLetterProcessingClaimOutcome,
  FinalizeTerminalResultOutcome,
  FinalizedAttempt,
  FinalizeTerminalResultInput,
  ProcessingFailureRecordOutcome,
  ProcessingClaim,
  StoredMedia,
  TerminalCandidate,
} from "./attempt-repository.js";

const MAX_RECOVERY_ATTEMPTS = Number.MAX_SAFE_INTEGER;

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

type TerminalResultRow = Readonly<{
  id: string;
  lease_id: string;
  generation: number;
  outcome_json: string;
  candidate_json: string;
}>;

export interface Clock {
  now(): string;
}

export interface IdGenerator {
  next(): string;
}

export class RepositoryError extends Error {
  public constructor(
    public readonly code:
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
      | "persisted_data_corrupt",
  ) {
    super(code);
    this.name = "RepositoryError";
  }
}

export class SQLiteAttemptRepository implements AttemptRepository {
  private readonly raw;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;

  public constructor(
    input: Readonly<{
      database: SqliteDatabase;
      clock: Clock;
      ids: IdGenerator;
    }>,
  ) {
    this.raw = input.database.raw;
    this.clock = input.clock;
    this.ids = input.ids;
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
    return this.transaction(() => {
      const issuedAt = this.clock.now();
      const expiresAt = addMilliseconds(issuedAt, 15 * 60_000);
      this.ensureAthlete(input.athleteId, issuedAt);
      this.raw
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
    return this.transaction(() => {
      const row = this.raw
        .prepare(
          "SELECT id, athlete_id, nonce, challenge_id, challenge_version, state, issued_at, expires_at, ready_at, consumed_at FROM calibration_sessions WHERE id = ? AND athlete_id = ?",
        )
        .get(input.id, input.athleteId);
      if (!row) return null;
      const session = parseCalibrationRow(row);
      if (session.expiresAt <= this.clock.now()) {
        this.raw
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
    await this.transaction(() => {
      const row = this.raw
        .prepare(
          "SELECT id, athlete_id, nonce, challenge_id, challenge_version, state, issued_at, expires_at, ready_at, consumed_at FROM calibration_sessions WHERE id = ?",
        )
        .get(input.id);
      if (!row) throw new RepositoryError("calibration_session_not_found");
      const session = parseCalibrationRow(row);
      if (session.athleteId !== input.athleteId)
        throw new RepositoryError("calibration_session_not_found");
      if (session.expiresAt <= this.clock.now()) {
        this.raw
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
      this.raw
        .prepare(
          "UPDATE calibration_sessions SET state = 'ready', ready_at = ? WHERE id = ? AND state = 'issued'",
        )
        .run(this.clock.now(), input.id);
    });
  }

  public async createAttempt(
    input: Readonly<{
      id: string;
      athleteId: string;
      input: CreateAttemptInput;
    }>,
  ): Promise<AttemptRecord> {
    return this.transaction(() => {
      const now = this.clock.now();
      this.ensureAthlete(input.athleteId, now);
      if (input.input.mode === "verified")
        this.consumeCalibrationSession(input.athleteId, input.input, now);
      this.raw
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
    const cursor = input.cursor ? decodeCursor(input.cursor) : undefined;
    const rows = this.raw
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
        cursor?.id ?? null,
        input.limit + 1,
      ) as AttemptRow[];
    const page = rows.slice(0, input.limit).map(parseAttemptRow);
    const last = page.at(-1);
    return Object.freeze({
      items: Object.freeze(page),
      nextCursor:
        rows.length > input.limit && last
          ? encodeCursor(last.createdAt, last.id)
          : null,
    });
  }

  public async attachValidatedMedia(
    input: Readonly<{
      attemptId: string;
      athleteId: string;
      media: StoredMedia;
    }>,
  ): Promise<AnalysisJob> {
    return this.transaction(() => {
      const row = this.mustGetScopedAttempt(input.attemptId, input.athleteId);
      const attempt = parseAttemptRow(row);
      if (attempt.media !== null)
        throw new RepositoryError("duplicate_media_upload");
      if (attempt.status !== "awaiting-upload")
        throw new RepositoryError("invalid_attempt_transition");
      const now = this.clock.now();
      this.raw
        .prepare(
          "UPDATE attempts SET media_json = ?, status = 'uploaded', processing_generation = ?, updated_at = ? WHERE id = ? AND athlete_id = ? AND status = 'awaiting-upload' AND deletion_state = 'active'",
        )
        .run(
          stableJson(input.media),
          row.processing_generation + 1,
          now,
          input.attemptId,
          input.athleteId,
        );
      this.raw
        .prepare(
          "INSERT INTO media_retention_records (media_id, attempt_id, metadata_json, delete_at, created_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run(
          input.media.id,
          input.attemptId,
          stableJson(input.media),
          input.media.deleteAt,
          now,
        );
      this.event(
        input.attemptId,
        row.processing_generation + 1,
        "media-attached",
        now,
      );
      return Object.freeze({
        attemptId: input.attemptId,
        generation: row.processing_generation + 1,
      });
    });
  }

  public async rollbackMediaAttachment(
    input: Readonly<{
      attemptId: string;
      generation: number;
    }>,
  ): Promise<void> {
    await this.transaction(() => {
      const row = this.raw
        .prepare(
          "SELECT a.id, a.athlete_id, a.mode, a.challenge_id, a.challenge_version, a.status, a.deletion_state, a.media_json, a.processing_generation, a.processing_lease_id, a.processing_lease_expires_at, a.created_at, tr.outcome_json FROM attempts a LEFT JOIN terminal_results tr ON tr.attempt_id = a.id WHERE a.id = ? AND a.deletion_state = 'active'",
        )
        .get(input.attemptId) as AttemptRow | undefined;
      const attempt = row ? parseAttemptRow(row) : null;
      if (
        !row ||
        !attempt ||
        !attempt.media ||
        attempt.status !== "uploaded" ||
        row.processing_generation !== input.generation
      )
        return;
      const now = this.clock.now();
      this.raw
        .prepare(
          "UPDATE attempts SET media_json = NULL, status = 'awaiting-upload', updated_at = ? WHERE id = ? AND status = 'uploaded' AND processing_generation = ? AND deletion_state = 'active'",
        )
        .run(now, input.attemptId, input.generation);
      this.raw
        .prepare(
          "DELETE FROM media_retention_records WHERE media_id = ? AND attempt_id = ?",
        )
        .run(attempt.media.id, input.attemptId);
      this.event(input.attemptId, input.generation, "media-rolled-back", now);
    });
  }

  public async claimProcessing(
    job: AnalysisJob,
  ): Promise<ProcessingClaim | null> {
    return this.transaction(() => {
      const row = this.raw
        .prepare(
          "SELECT id, mode, status, deletion_state, processing_generation, processing_lease_expires_at FROM attempts WHERE id = ?",
        )
        .get(job.attemptId) as
        | Pick<
            AttemptRow,
            | "id"
            | "mode"
            | "status"
            | "deletion_state"
            | "processing_generation"
            | "processing_lease_expires_at"
          >
        | undefined;
      if (!row || row.deletion_state !== "active") return null;
      const recovery = this.raw
        .prepare(
          "SELECT state FROM processing_recovery_records WHERE attempt_id = ? AND generation = ?",
        )
        .get(job.attemptId, job.generation) as { state: string } | undefined;
      if (recovery?.state === "dead-lettered") return null;
      const now = this.clock.now();
      const generationMatches = row.processing_generation === job.generation;
      const canClaim =
        (generationMatches && row.status === "uploaded") ||
        (generationMatches &&
          row.status === "processing" &&
          row.processing_lease_expires_at !== null &&
          row.processing_lease_expires_at <= now);
      if (!canClaim) return null;
      const leaseId = this.ids.next();
      const expiresAt = addMilliseconds(now, 5 * 60_000);
      const update = this.raw
        .prepare(
          "UPDATE attempts SET status = 'processing', processing_lease_id = ?, processing_lease_expires_at = ?, updated_at = ? WHERE id = ? AND processing_generation = ? AND deletion_state = 'active' AND (status = 'uploaded' OR (status = 'processing' AND processing_lease_expires_at <= ?))",
        )
        .run(leaseId, expiresAt, now, job.attemptId, job.generation, now);
      if (update.changes !== 1) return null;
      this.event(job.attemptId, job.generation, "processing-claimed", now);
      return Object.freeze({
        leaseId,
        generation: job.generation,
        mode: row.mode,
      });
    });
  }

  public async releaseProcessingClaim(
    input: Readonly<{
      attemptId: string;
      leaseId: string;
      generation: number;
    }>,
  ): Promise<boolean> {
    return this.transaction(() => {
      const now = this.clock.now();
      const update = this.raw
        .prepare(
          "UPDATE attempts SET status = 'uploaded', processing_lease_id = NULL, processing_lease_expires_at = NULL, updated_at = ? WHERE id = ? AND status = 'processing' AND deletion_state = 'active' AND processing_generation = ? AND processing_lease_id = ?",
        )
        .run(now, input.attemptId, input.generation, input.leaseId);
      if (update.changes !== 1) return false;
      this.event(input.attemptId, input.generation, "processing-released", now);
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
    return this.transaction(() => {
      const row = this.raw
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
      const now = this.clock.now();
      const existingRecovery = this.raw
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
        this.event(input.attemptId, input.generation, "processing-failed", now);
        return Object.freeze({
          kind: "recorded",
          retryAttempt: MAX_RECOVERY_ATTEMPTS,
        });
      }
      this.raw
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
      const recovery = this.raw
        .prepare(
          "SELECT retry_attempts FROM processing_recovery_records WHERE attempt_id = ? AND generation = ?",
        )
        .get(input.attemptId, input.generation) as
        | { retry_attempts: number }
        | undefined;
      if (!recovery || !Number.isSafeInteger(recovery.retry_attempts))
        throw new RepositoryError("persisted_data_corrupt");
      this.event(input.attemptId, input.generation, "processing-failed", now);
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
    return this.transaction(() => {
      const row = this.raw
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
      const now = this.clock.now();
      this.raw
        .prepare(
          `INSERT INTO processing_recovery_records
             (attempt_id, generation, retry_attempts, state, created_at, updated_at)
           VALUES (?, ?, 1, 'dead-lettered', ?, ?)
           ON CONFLICT(attempt_id, generation) DO UPDATE SET
             state = 'dead-lettered',
             updated_at = excluded.updated_at`,
        )
        .run(input.attemptId, input.generation, now, now);
      const release = this.raw
        .prepare(
          "UPDATE attempts SET status = 'uploaded', processing_lease_id = NULL, processing_lease_expires_at = NULL, updated_at = ? WHERE id = ? AND status = 'processing' AND deletion_state = 'active' AND processing_generation = ? AND processing_lease_id = ?",
        )
        .run(now, input.attemptId, input.generation, input.leaseId);
      if (release.changes !== 1) return Object.freeze({ kind: "lost-claim" });
      this.event(
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
    return this.transaction(() => {
      const row = this.raw
        .prepare(
          "SELECT a.id, a.athlete_id, a.mode, a.challenge_id, a.challenge_version, a.status, a.deletion_state, a.media_json, a.processing_generation, a.processing_lease_id, a.processing_lease_expires_at, a.created_at, tr.outcome_json FROM attempts a LEFT JOIN terminal_results tr ON tr.attempt_id = a.id WHERE a.id = ?",
        )
        .get(input.attemptId) as AttemptRow | undefined;
      if (!row) return Object.freeze({ kind: "lost-claim" });
      if (row.deletion_state !== "active")
        return Object.freeze({ kind: "tombstoned" });
      const existing = this.raw
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
        row.processing_lease_expires_at <= this.clock.now()
      )
        return Object.freeze({ kind: "lost-claim" });

      const candidate = parseTerminalCandidate(input.candidate, row);
      let outcome: Exclude<AttemptOutcome, { state: "pending" }>;
      let leaderboard: Readonly<{
        entryId: string;
        score: number;
        completedAt: string;
        snapshot: object;
      }> | null = null;
      if (isRankedCandidate(candidate)) {
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
          this.clock.now(),
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

      const completedAt = terminalCompletedAt(outcome, this.clock.now());
      const terminalId = this.ids.next();
      this.raw
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
          this.clock.now(),
        );
      this.raw
        .prepare(
          "UPDATE attempts SET status = ?, processing_lease_id = NULL, processing_lease_expires_at = NULL, updated_at = ? WHERE id = ? AND deletion_state = 'active' AND status = 'processing' AND processing_generation = ? AND processing_lease_id = ?",
        )
        .run(
          outcome.state,
          this.clock.now(),
          input.attemptId,
          input.generation,
          input.leaseId,
        );
      if (leaderboard) {
        this.raw
          .prepare(
            "INSERT INTO leaderboard_entries (id, result_id, attempt_id, challenge_id, challenge_version, rule_version, score, completed_at, ranking_snapshot_json, created_at) VALUES (?, ?, ?, 'wall-pass', 1, 'wall-pass-v1-score-1', ?, ?, ?, ?)",
          )
          .run(
            leaderboard.entryId,
            terminalId,
            input.attemptId,
            leaderboard.score,
            leaderboard.completedAt,
            stableJson(leaderboard.snapshot),
            this.clock.now(),
          );
      }
      this.event(
        input.attemptId,
        input.generation,
        "terminal-finalized",
        this.clock.now(),
      );
      this.raw
        .prepare(
          "DELETE FROM processing_recovery_records WHERE attempt_id = ? AND generation = ?",
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
    await this.transaction(() => {
      const row = this.raw
        .prepare(
          "SELECT id, processing_generation FROM attempts WHERE id = ? AND athlete_id = ? AND deletion_state = 'active'",
        )
        .get(input.attemptId, input.athleteId) as
        | { id: string; processing_generation: number }
        | undefined;
      if (!row) throw new RepositoryError("attempt_not_found");
      const now = this.clock.now();
      this.raw
        .prepare("DELETE FROM leaderboard_entries WHERE attempt_id = ?")
        .run(input.attemptId);
      this.raw
        .prepare("DELETE FROM terminal_results WHERE attempt_id = ?")
        .run(input.attemptId);
      this.raw
        .prepare("DELETE FROM canonical_observations WHERE attempt_id = ?")
        .run(input.attemptId);
      this.raw
        .prepare("DELETE FROM processing_recovery_records WHERE attempt_id = ?")
        .run(input.attemptId);
      this.raw
        .prepare(
          "UPDATE media_retention_records SET cleanup_requested_at = ? WHERE attempt_id = ?",
        )
        .run(now, input.attemptId);
      this.raw
        .prepare(
          "UPDATE attempts SET deletion_state = 'tombstoned', processing_generation = processing_generation + 1, processing_lease_id = NULL, processing_lease_expires_at = NULL, tombstoned_at = ?, updated_at = ? WHERE id = ? AND athlete_id = ? AND deletion_state = 'active'",
        )
        .run(now, now, input.attemptId, input.athleteId);
      this.event(
        input.attemptId,
        row.processing_generation + 1,
        "tombstoned",
        now,
      );
    });
  }

  public async listLiveLeaderboard(
    input: Readonly<{ calculatedAt: string }>,
  ): Promise<
    Readonly<{
      entries: readonly Readonly<{
        entryId: string;
        rank: number;
        score: number;
        completedAt: string;
      }>[];
      cohortSize: number;
      nextCursor: null;
    }>
  > {
    const leaderboard = calculateLeaderboard(
      this.currentCohort(),
      input.calculatedAt,
    );
    return Object.freeze({
      entries: leaderboard.entries,
      cohortSize: leaderboard.cohortSize,
      nextCursor: null,
    });
  }

  private currentCohort(): DomainWallPassRankableResult[] {
    return this.raw
      .prepare(
        `SELECT le.attempt_id, le.id AS entry_id, le.score, le.completed_at
       FROM leaderboard_entries le
       INNER JOIN attempts a ON a.id = le.attempt_id
       WHERE a.deletion_state = 'active' AND a.status = 'valid'
         AND le.challenge_id = 'wall-pass' AND le.challenge_version = 1 AND le.rule_version = 'wall-pass-v1-score-1'`,
      )
      .all()
      .map(parseCohortRow);
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
    const row = this.raw
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
    this.raw
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
    const row = this.raw
      .prepare(
        "SELECT id, athlete_id, nonce, challenge_id, challenge_version, state, issued_at, expires_at, ready_at, consumed_at FROM calibration_sessions WHERE id = ?",
      )
      .get(input.calibrationSessionId);
    if (!row) throw new RepositoryError("calibration_session_not_found");
    const session = parseCalibrationRow(row);
    if (session.athleteId !== athleteId)
      throw new RepositoryError("calibration_session_not_found");
    if (session.expiresAt <= now) {
      this.raw
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
    this.raw
      .prepare(
        "UPDATE calibration_sessions SET state = 'consumed', consumed_at = ? WHERE id = ? AND state = 'ready'",
      )
      .run(now, input.calibrationSessionId);
  }

  private event(
    attemptId: string,
    generation: number,
    eventType: string,
    createdAt: string,
  ): void {
    this.raw
      .prepare(
        "INSERT INTO processing_events (attempt_id, generation, event_type, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(attemptId, generation, eventType, createdAt);
  }

  private transaction<T>(operation: () => T): T {
    this.raw.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.raw.exec("COMMIT");
      return result;
    } catch (error) {
      this.raw.exec("ROLLBACK");
      throw error;
    }
  }
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
    (value.outcome_json !== null && outcome.state === "pending")
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
    typeof record.id !== "string" ||
    record.id.length === 0 ||
    typeof record.contentType !== "string" ||
    record.contentType.length === 0 ||
    typeof record.bytes !== "number" ||
    !Number.isFinite(record.bytes) ||
    !Number.isInteger(record.bytes) ||
    record.bytes < 0 ||
    typeof record.deleteAt !== "string" ||
    !UtcIsoTimestampSchema.safeParse(record.deleteAt).success
  )
    throw new RepositoryError("persisted_data_corrupt");
  return Object.freeze({
    id: record.id,
    contentType: record.contentType,
    bytes: record.bytes,
    deleteAt: record.deleteAt,
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new RepositoryError("persisted_data_corrupt");
  return value as Record<string, unknown>;
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
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
    return parsed.data;
  } catch {
    throw new RepositoryError("persisted_data_corrupt");
  }
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

function encodeCursor(createdAt: string, id: string): string {
  return Buffer.from(stableJson({ createdAt, id })).toString("base64url");
}

function decodeCursor(
  cursor: string,
): Readonly<{ createdAt: string; id: string }> {
  try {
    const value = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    ) as { createdAt?: unknown; id?: unknown };
    if (
      typeof value.createdAt !== "string" ||
      typeof value.id !== "string" ||
      value.id.length === 0 ||
      !UtcIsoTimestampSchema.safeParse(value.createdAt).success
    )
      throw new Error();
    return Object.freeze({ createdAt: value.createdAt, id: value.id });
  } catch {
    throw new RepositoryError("invalid_input");
  }
}
