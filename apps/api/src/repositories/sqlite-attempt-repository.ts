import {
  AttemptOutcomeSchema,
  type AttemptOutcome,
  type CreateAttemptInput,
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
  FinalizedAttempt,
  FinalizeTerminalResultInput,
  ProcessingClaim,
  StoredMedia,
} from "./attempt-repository.js";

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
  request_outcome_json: string;
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
      | "terminal_result_conflict",
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
          "SELECT id, nonce, state, issued_at, expires_at FROM calibration_sessions WHERE id = ? AND athlete_id = ?",
        )
        .get(input.id, input.athleteId) as
        | {
            id: string;
            nonce: string;
            state: "issued" | "ready" | "consumed" | "expired";
            issued_at: string;
            expires_at: string;
          }
        | undefined;
      if (!row) return null;
      if (row.expires_at <= this.clock.now()) {
        this.raw
          .prepare(
            "UPDATE calibration_sessions SET state = 'expired' WHERE id = ? AND state IN ('issued', 'ready')",
          )
          .run(row.id);
        return null;
      }
      if (row.state !== "issued" && row.state !== "ready") return null;
      return calibrationSession(
        row.id,
        row.nonce,
        row.issued_at,
        row.expires_at,
        row.state,
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
          "SELECT athlete_id, state, expires_at FROM calibration_sessions WHERE id = ?",
        )
        .get(input.id) as
        | { athlete_id: string; state: string; expires_at: string }
        | undefined;
      if (!row || row.athlete_id !== input.athleteId)
        throw new RepositoryError("calibration_session_not_found");
      if (row.expires_at <= this.clock.now()) {
        this.raw
          .prepare(
            "UPDATE calibration_sessions SET state = 'expired' WHERE id = ? AND state IN ('issued', 'ready')",
          )
          .run(input.id);
        throw new RepositoryError("calibration_session_expired");
      }
      if (row.state === "consumed")
        throw new RepositoryError("calibration_session_consumed");
      if (row.state !== "issued")
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
          "UPDATE attempts SET media_json = ?, status = 'uploaded', updated_at = ? WHERE id = ? AND athlete_id = ? AND status = 'awaiting-upload' AND deletion_state = 'active'",
        )
        .run(stableJson(input.media), now, input.attemptId, input.athleteId);
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
        row.processing_generation,
        "media-attached",
        now,
      );
      return Object.freeze({ attemptId: input.attemptId });
    });
  }

  public async rollbackMediaAttachment(
    input: Readonly<{ attemptId: string; athleteId: string; mediaId: string }>,
  ): Promise<void> {
    await this.transaction(() => {
      const row = this.selectScopedAttempt(input.attemptId, input.athleteId);
      const attempt = row ? parseAttemptRow(row) : null;
      if (
        !row ||
        !attempt ||
        !attempt.media ||
        attempt.media.id !== input.mediaId ||
        attempt.status !== "uploaded"
      )
        return;
      const now = this.clock.now();
      this.raw
        .prepare(
          "UPDATE attempts SET media_json = NULL, status = 'awaiting-upload', updated_at = ? WHERE id = ? AND athlete_id = ? AND status = 'uploaded' AND deletion_state = 'active'",
        )
        .run(now, input.attemptId, input.athleteId);
      this.raw
        .prepare(
          "DELETE FROM media_retention_records WHERE media_id = ? AND attempt_id = ?",
        )
        .run(input.mediaId, input.attemptId);
      this.event(
        input.attemptId,
        row.processing_generation,
        "media-rolled-back",
        now,
      );
    });
  }

  public async claimProcessing(
    job: AnalysisJob,
  ): Promise<ProcessingClaim | null> {
    return this.transaction(() => {
      const row = this.raw
        .prepare(
          "SELECT id, status, deletion_state, processing_generation, processing_lease_expires_at FROM attempts WHERE id = ?",
        )
        .get(job.attemptId) as
        | Pick<
            AttemptRow,
            | "id"
            | "status"
            | "deletion_state"
            | "processing_generation"
            | "processing_lease_expires_at"
          >
        | undefined;
      if (!row || row.deletion_state !== "active") return null;
      const now = this.clock.now();
      const canClaim =
        row.status === "uploaded" ||
        (row.status === "processing" &&
          row.processing_lease_expires_at !== null &&
          row.processing_lease_expires_at <= now);
      if (!canClaim) return null;
      const generation = row.processing_generation + 1;
      const leaseId = this.ids.next();
      const expiresAt = addMilliseconds(now, 5 * 60_000);
      this.raw
        .prepare(
          "UPDATE attempts SET status = 'processing', processing_generation = ?, processing_lease_id = ?, processing_lease_expires_at = ?, updated_at = ? WHERE id = ? AND deletion_state = 'active'",
        )
        .run(generation, leaseId, expiresAt, now, job.attemptId);
      this.event(job.attemptId, generation, "processing-claimed", now);
      return Object.freeze({ leaseId, generation });
    });
  }

  public async finalizeTerminalResult(
    input: FinalizeTerminalResultInput,
  ): Promise<FinalizedAttempt | null> {
    return this.transaction(() => {
      const row = this.raw
        .prepare(
          "SELECT a.id, a.athlete_id, a.mode, a.challenge_id, a.challenge_version, a.status, a.deletion_state, a.media_json, a.processing_generation, a.processing_lease_id, a.processing_lease_expires_at, a.created_at, tr.outcome_json FROM attempts a LEFT JOIN terminal_results tr ON tr.attempt_id = a.id WHERE a.id = ?",
        )
        .get(input.attemptId) as AttemptRow | undefined;
      if (!row || row.deletion_state !== "active") return null;
      const existing = this.raw
        .prepare(
          "SELECT id, lease_id, generation, outcome_json, request_outcome_json FROM terminal_results WHERE attempt_id = ?",
        )
        .get(input.attemptId) as TerminalResultRow | undefined;
      if (existing) {
        if (
          existing.lease_id === input.leaseId &&
          existing.generation === input.generation &&
          existing.request_outcome_json === stableJson(input.outcome)
        ) {
          return this.finalizedFromRows(row, existing.outcome_json);
        }
        throw new RepositoryError("terminal_result_conflict");
      }
      if (
        row.status !== "processing" ||
        row.processing_generation !== input.generation ||
        row.processing_lease_id !== input.leaseId ||
        row.processing_lease_expires_at === null ||
        row.processing_lease_expires_at < this.clock.now()
      )
        return null;

      let outcome = parseTerminalOutcome(input.outcome, row);
      let leaderboard: Readonly<{
        entryId: string;
        score: number;
        completedAt: string;
        snapshot: object;
      }> | null = null;
      if (isRankedOutcome(outcome)) {
        const entryId = this.ids.next();
        const cohort = this.currentCohort();
        const candidate: DomainWallPassRankableResult = {
          attemptId: input.attemptId,
          entryId,
          score: outcome.result.score,
          completedAt: outcome.result.completedAt,
          state: "valid",
          active: true,
          competitiveEligible: true,
          challengeId: outcome.result.challengeId,
          challengeVersion: outcome.result.challengeVersion,
          ruleVersion: outcome.result.ruleVersion,
        };
        const snapshot = calculateSnapshot(
          [...cohort, candidate],
          input.attemptId,
          this.clock.now(),
        );
        const rankedOutcome = AttemptOutcomeSchema.parse({
          state: "valid",
          result: { ...outcome.result, rankingSnapshot: snapshot },
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
      }

      const completedAt = terminalCompletedAt(outcome, this.clock.now());
      const terminalId = this.ids.next();
      this.raw
        .prepare(
          "INSERT INTO terminal_results (id, attempt_id, lease_id, generation, terminal_state, outcome_json, request_outcome_json, completed_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          terminalId,
          input.attemptId,
          input.leaseId,
          input.generation,
          outcome.state,
          stableJson(outcome),
          stableJson(input.outcome),
          completedAt,
          this.clock.now(),
        );
      this.raw
        .prepare(
          "UPDATE attempts SET status = ?, updated_at = ? WHERE id = ? AND deletion_state = 'active' AND status = 'processing' AND processing_generation = ? AND processing_lease_id = ?",
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
      return this.finalizedFromRows(
        { ...row, status: outcome.state },
        stableJson(outcome),
      );
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
      .map((row) => {
        const value = row as {
          attempt_id: string;
          entry_id: string;
          score: number;
          completed_at: string;
        };
        return {
          attemptId: value.attempt_id,
          entryId: value.entry_id,
          score: value.score,
          completedAt: value.completed_at,
          state: "valid" as const,
          active: true as const,
          competitiveEligible: true as const,
          challengeId: "wall-pass",
          challengeVersion: 1,
          ruleVersion: "wall-pass-v1-score-1",
        };
      });
  }

  private finalizedFromRows(
    row: AttemptRow,
    outcomeJson: string,
  ): FinalizedAttempt {
    const outcome = AttemptOutcomeSchema.parse(JSON.parse(outcomeJson));
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
    const session = this.raw
      .prepare(
        "SELECT athlete_id, challenge_id, challenge_version, state, expires_at FROM calibration_sessions WHERE id = ?",
      )
      .get(input.calibrationSessionId) as
      | {
          athlete_id: string;
          challenge_id: string;
          challenge_version: number;
          state: string;
          expires_at: string;
        }
      | undefined;
    if (!session || session.athlete_id !== athleteId)
      throw new RepositoryError("calibration_session_not_found");
    if (session.expires_at <= now) {
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
      session.challenge_id !== input.challengeId ||
      session.challenge_version !== input.challengeVersion
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

function parseAttemptRow(row: AttemptRow): AttemptRecord {
  return Object.freeze({
    id: row.id,
    athleteId: row.athlete_id,
    mode: row.mode,
    status: row.status,
    createdAt: row.created_at,
    outcome:
      row.outcome_json === null || row.outcome_json === undefined
        ? Object.freeze({
            state: "pending" as const,
            attemptId: row.id,
            mode: row.mode,
            status: row.status as "awaiting-upload" | "uploaded" | "processing",
          })
        : AttemptOutcomeSchema.parse(JSON.parse(row.outcome_json)),
    challenge:
      row.challenge_id === null
        ? null
        : Object.freeze({
            id: row.challenge_id,
            version: row.challenge_version!,
          }),
    media: row.media_json === null ? null : parseStoredMedia(row.media_json),
  });
}

function parseStoredMedia(value: string): StoredMedia {
  const parsed = JSON.parse(value) as Partial<StoredMedia>;
  if (
    typeof parsed.id !== "string" ||
    typeof parsed.contentType !== "string" ||
    typeof parsed.bytes !== "number" ||
    typeof parsed.deleteAt !== "string"
  )
    throw new RepositoryError("invalid_terminal_outcome");
  return Object.freeze({
    id: parsed.id,
    contentType: parsed.contentType,
    bytes: parsed.bytes,
    deleteAt: parsed.deleteAt,
  });
}

function parseTerminalOutcome(
  outcome: AttemptOutcome,
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
    if (typeof value.createdAt !== "string" || typeof value.id !== "string")
      throw new Error();
    return Object.freeze({ createdAt: value.createdAt, id: value.id });
  } catch {
    throw new RepositoryError("invalid_attempt_transition");
  }
}
