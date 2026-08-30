import Database from "better-sqlite3";

type Migration = Readonly<{
  version: number;
  sql: string;
  afterApply?: (raw: Database.Database) => void;
}>;

export type SqliteDatabase = Readonly<{
  raw: Database.Database;
  reopen(): SqliteDatabase;
  close(): void;
}>;

const migrations: readonly Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE athletes (
        id TEXT PRIMARY KEY NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE calibration_sessions (
        id TEXT PRIMARY KEY NOT NULL,
        athlete_id TEXT NOT NULL REFERENCES athletes(id),
        nonce TEXT NOT NULL,
        challenge_id TEXT NOT NULL CHECK (challenge_id = 'wall-pass'),
        challenge_version INTEGER NOT NULL CHECK (challenge_version = 1),
        state TEXT NOT NULL CHECK (state IN ('issued', 'ready', 'consumed', 'expired')),
        issued_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        ready_at TEXT,
        consumed_at TEXT
      );
      CREATE TABLE attempts (
        id TEXT PRIMARY KEY NOT NULL,
        athlete_id TEXT NOT NULL REFERENCES athletes(id),
        mode TEXT NOT NULL CHECK (mode IN ('free', 'verified')),
        challenge_id TEXT,
        challenge_version INTEGER,
        calibration_session_id TEXT REFERENCES calibration_sessions(id),
        status TEXT NOT NULL CHECK (status IN ('awaiting-upload', 'uploaded', 'processing', 'valid', 'invalid', 'failed')),
        deletion_state TEXT NOT NULL CHECK (deletion_state IN ('active', 'tombstoned')),
        media_json TEXT,
        processing_generation INTEGER NOT NULL DEFAULT 0 CHECK (processing_generation >= 0),
        processing_lease_id TEXT,
        processing_lease_expires_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        tombstoned_at TEXT,
        CHECK (
          (mode = 'free' AND challenge_id IS NULL AND challenge_version IS NULL AND calibration_session_id IS NULL)
          OR
          (mode = 'verified' AND challenge_id = 'wall-pass' AND challenge_version = 1 AND calibration_session_id IS NOT NULL)
        )
      );
      CREATE INDEX attempts_by_athlete_created ON attempts(athlete_id, deletion_state, created_at DESC, id DESC);
      CREATE TABLE processing_events (
        id INTEGER PRIMARY KEY,
        attempt_id TEXT NOT NULL REFERENCES attempts(id),
        generation INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE canonical_observations (
        id TEXT PRIMARY KEY NOT NULL,
        attempt_id TEXT NOT NULL REFERENCES attempts(id),
        payload_json TEXT NOT NULL,
        delete_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE media_retention_records (
        media_id TEXT PRIMARY KEY NOT NULL,
        attempt_id TEXT NOT NULL REFERENCES attempts(id),
        metadata_json TEXT NOT NULL,
        delete_at TEXT NOT NULL,
        cleanup_requested_at TEXT,
        created_at TEXT NOT NULL
      );
    `,
  },
  {
    version: 2,
    sql: `
      CREATE TABLE terminal_results (
        id TEXT PRIMARY KEY NOT NULL,
        attempt_id TEXT NOT NULL UNIQUE REFERENCES attempts(id),
        lease_id TEXT NOT NULL,
        generation INTEGER NOT NULL,
        terminal_state TEXT NOT NULL CHECK (terminal_state IN ('valid', 'invalid', 'failed')),
        outcome_json TEXT NOT NULL,
        completed_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE leaderboard_entries (
        id TEXT PRIMARY KEY NOT NULL,
        result_id TEXT NOT NULL UNIQUE REFERENCES terminal_results(id),
        attempt_id TEXT NOT NULL UNIQUE REFERENCES attempts(id),
        challenge_id TEXT NOT NULL CHECK (challenge_id = 'wall-pass'),
        challenge_version INTEGER NOT NULL CHECK (challenge_version = 1),
        rule_version TEXT NOT NULL,
        score INTEGER NOT NULL,
        completed_at TEXT NOT NULL,
        ranking_snapshot_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX leaderboard_cohort_order ON leaderboard_entries(challenge_id, challenge_version, rule_version, score DESC, completed_at ASC, attempt_id ASC);
    `,
  },
  {
    version: 3,
    sql: `
      CREATE TABLE workflow_benchmark_receipts (
        id TEXT PRIMARY KEY NOT NULL,
        receipt_sha256 TEXT NOT NULL UNIQUE,
        schema_version TEXT NOT NULL,
        workflow_id TEXT NOT NULL,
        workflow_version TEXT NOT NULL,
        model_bundle_id TEXT NOT NULL,
        provider_version TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('passed', 'failed')),
        run_at TEXT NOT NULL,
        valid_until TEXT NOT NULL,
        invalidated_at TEXT,
        receipt_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE approved_competitive_model_policies (
        id TEXT PRIMARY KEY NOT NULL,
        receipt_id TEXT NOT NULL REFERENCES workflow_benchmark_receipts(id),
        receipt_sha256 TEXT NOT NULL,
        receipt_schema_version TEXT NOT NULL,
        model_bundle_id TEXT NOT NULL,
        workflow_id TEXT NOT NULL,
        workflow_version TEXT NOT NULL,
        provider_version TEXT NOT NULL,
        calibration_evidence_version TEXT NOT NULL,
        challenge_id TEXT NOT NULL CHECK (challenge_id = 'wall-pass'),
        challenge_version INTEGER NOT NULL CHECK (challenge_version = 1),
        rule_version TEXT NOT NULL,
        active INTEGER NOT NULL CHECK (active IN (0, 1)),
        created_at TEXT NOT NULL,
        UNIQUE(model_bundle_id, workflow_id, workflow_version, provider_version, calibration_evidence_version, challenge_id, challenge_version, rule_version)
      );
    `,
  },
  {
    version: 4,
    sql: `
      ALTER TABLE terminal_results
      ADD COLUMN request_outcome_json TEXT NOT NULL DEFAULT '';
    `,
  },
  {
    version: 5,
    sql: `
      CREATE TABLE calibration_sessions_v5 (
        id TEXT PRIMARY KEY NOT NULL,
        athlete_id TEXT NOT NULL REFERENCES athletes(id),
        nonce TEXT NOT NULL,
        challenge_id TEXT NOT NULL CHECK (challenge_id = 'wall-pass'),
        challenge_version INTEGER NOT NULL CHECK (challenge_version = 1),
        state TEXT NOT NULL CHECK (state IN ('issued', 'ready', 'consumed', 'expired')),
        issued_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        ready_at TEXT,
        consumed_at TEXT,
        UNIQUE (id, athlete_id, challenge_id, challenge_version)
      );
      CREATE TABLE attempts_v5 (
        id TEXT PRIMARY KEY NOT NULL,
        athlete_id TEXT NOT NULL REFERENCES athletes(id),
        mode TEXT NOT NULL CHECK (mode IN ('free', 'verified')),
        challenge_id TEXT,
        challenge_version INTEGER,
        calibration_session_id TEXT,
        status TEXT NOT NULL CHECK (status IN ('awaiting-upload', 'uploaded', 'processing', 'valid', 'invalid', 'failed')),
        deletion_state TEXT NOT NULL CHECK (deletion_state IN ('active', 'tombstoned')),
        media_json TEXT,
        processing_generation INTEGER NOT NULL DEFAULT 0 CHECK (processing_generation >= 0),
        processing_lease_id TEXT,
        processing_lease_expires_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        tombstoned_at TEXT,
        CHECK (
          (mode = 'free' AND challenge_id IS NULL AND challenge_version IS NULL AND calibration_session_id IS NULL)
          OR
          (mode = 'verified' AND challenge_id = 'wall-pass' AND challenge_version = 1 AND calibration_session_id IS NOT NULL)
        ),
        UNIQUE (calibration_session_id),
        FOREIGN KEY (calibration_session_id, athlete_id, challenge_id, challenge_version)
          REFERENCES calibration_sessions_v5(id, athlete_id, challenge_id, challenge_version)
      );
      CREATE TABLE processing_events_v5 (
        id INTEGER PRIMARY KEY,
        attempt_id TEXT NOT NULL REFERENCES attempts_v5(id),
        generation INTEGER NOT NULL CHECK (generation >= 0),
        event_type TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE canonical_observations_v5 (
        id TEXT PRIMARY KEY NOT NULL,
        attempt_id TEXT NOT NULL REFERENCES attempts_v5(id),
        payload_json TEXT NOT NULL,
        delete_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE media_retention_records_v5 (
        media_id TEXT PRIMARY KEY NOT NULL,
        attempt_id TEXT NOT NULL REFERENCES attempts_v5(id),
        metadata_json TEXT NOT NULL,
        delete_at TEXT NOT NULL,
        cleanup_requested_at TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE terminal_results_v5 (
        id TEXT PRIMARY KEY NOT NULL,
        attempt_id TEXT NOT NULL UNIQUE REFERENCES attempts_v5(id),
        lease_id TEXT NOT NULL,
        generation INTEGER NOT NULL CHECK (generation >= 0),
        terminal_state TEXT NOT NULL CHECK (terminal_state IN ('valid', 'invalid', 'failed')),
        outcome_json TEXT NOT NULL,
        candidate_json TEXT NOT NULL,
        completed_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (id, attempt_id)
      );
      CREATE TABLE leaderboard_entries_v5 (
        id TEXT PRIMARY KEY NOT NULL,
        result_id TEXT NOT NULL,
        attempt_id TEXT NOT NULL,
        challenge_id TEXT NOT NULL CHECK (challenge_id = 'wall-pass'),
        challenge_version INTEGER NOT NULL CHECK (challenge_version = 1),
        rule_version TEXT NOT NULL CHECK (rule_version = 'wall-pass-v1-score-1'),
        score INTEGER NOT NULL CHECK (score BETWEEN 0 AND 100),
        completed_at TEXT NOT NULL,
        ranking_snapshot_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (result_id),
        UNIQUE (attempt_id),
        FOREIGN KEY (result_id, attempt_id)
          REFERENCES terminal_results_v5(id, attempt_id)
      );
      CREATE TABLE workflow_benchmark_receipts_v5 (
        id TEXT PRIMARY KEY NOT NULL,
        receipt_sha256 TEXT NOT NULL UNIQUE,
        schema_version TEXT NOT NULL CHECK (schema_version = 'workflow-benchmark-receipt-v1'),
        workflow_id TEXT NOT NULL CHECK (workflow_id = 'revelai-wall-pass-geometry-v1'),
        workflow_version TEXT NOT NULL CHECK (workflow_version = '1.0.0'),
        model_bundle_id TEXT NOT NULL,
        provider_version TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('passed', 'failed')),
        run_at TEXT NOT NULL,
        valid_until TEXT NOT NULL,
        invalidated_at TEXT,
        receipt_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (id, receipt_sha256, schema_version, model_bundle_id, workflow_id, workflow_version, provider_version)
      );
      CREATE TABLE workflow_benchmark_receipt_invalidations_v5 (
        receipt_id TEXT PRIMARY KEY NOT NULL REFERENCES workflow_benchmark_receipts_v5(id),
        invalidated_at TEXT NOT NULL,
        reason TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE approved_competitive_model_policies_v5 (
        id TEXT PRIMARY KEY NOT NULL,
        receipt_id TEXT NOT NULL,
        receipt_sha256 TEXT NOT NULL,
        receipt_schema_version TEXT NOT NULL CHECK (receipt_schema_version = 'workflow-benchmark-receipt-v1'),
        model_bundle_id TEXT NOT NULL,
        workflow_id TEXT NOT NULL CHECK (workflow_id = 'revelai-wall-pass-geometry-v1'),
        workflow_version TEXT NOT NULL CHECK (workflow_version = '1.0.0'),
        provider_version TEXT NOT NULL,
        calibration_evidence_version TEXT NOT NULL,
        challenge_id TEXT NOT NULL CHECK (challenge_id = 'wall-pass'),
        challenge_version INTEGER NOT NULL CHECK (challenge_version = 1),
        rule_version TEXT NOT NULL CHECK (rule_version = 'wall-pass-v1-score-1'),
        active INTEGER NOT NULL CHECK (active IN (0, 1)),
        created_at TEXT NOT NULL,
        FOREIGN KEY (receipt_id, receipt_sha256, receipt_schema_version, model_bundle_id, workflow_id, workflow_version, provider_version)
          REFERENCES workflow_benchmark_receipts_v5(id, receipt_sha256, schema_version, model_bundle_id, workflow_id, workflow_version, provider_version)
      );

      INSERT INTO calibration_sessions_v5 SELECT * FROM calibration_sessions;
      INSERT INTO attempts_v5 SELECT * FROM attempts;
      INSERT INTO processing_events_v5 SELECT * FROM processing_events;
      INSERT INTO canonical_observations_v5 SELECT * FROM canonical_observations;
      INSERT INTO media_retention_records_v5 SELECT * FROM media_retention_records;
      INSERT INTO terminal_results_v5 (id, attempt_id, lease_id, generation, terminal_state, outcome_json, candidate_json, completed_at, created_at)
        SELECT id, attempt_id, lease_id, generation, terminal_state, outcome_json, request_outcome_json, completed_at, created_at FROM terminal_results;
      INSERT INTO leaderboard_entries_v5 SELECT * FROM leaderboard_entries;
      INSERT INTO workflow_benchmark_receipts_v5 SELECT * FROM workflow_benchmark_receipts;
      INSERT INTO approved_competitive_model_policies_v5 SELECT * FROM approved_competitive_model_policies;

      DROP TABLE leaderboard_entries;
      DROP TABLE terminal_results;
      DROP TABLE canonical_observations;
      DROP TABLE media_retention_records;
      DROP TABLE processing_events;
      DROP TABLE approved_competitive_model_policies;
      DROP TABLE attempts;
      DROP TABLE calibration_sessions;
      DROP TABLE workflow_benchmark_receipts;

      ALTER TABLE calibration_sessions_v5 RENAME TO calibration_sessions;
      ALTER TABLE attempts_v5 RENAME TO attempts;
      ALTER TABLE processing_events_v5 RENAME TO processing_events;
      ALTER TABLE canonical_observations_v5 RENAME TO canonical_observations;
      ALTER TABLE media_retention_records_v5 RENAME TO media_retention_records;
      ALTER TABLE terminal_results_v5 RENAME TO terminal_results;
      ALTER TABLE leaderboard_entries_v5 RENAME TO leaderboard_entries;
      ALTER TABLE workflow_benchmark_receipts_v5 RENAME TO workflow_benchmark_receipts;
      ALTER TABLE workflow_benchmark_receipt_invalidations_v5 RENAME TO workflow_benchmark_receipt_invalidations;
      ALTER TABLE approved_competitive_model_policies_v5 RENAME TO approved_competitive_model_policies;

      CREATE INDEX attempts_by_athlete_created_v5 ON attempts(athlete_id, deletion_state, created_at DESC, id DESC);
      CREATE INDEX leaderboard_cohort_order_v5 ON leaderboard_entries(challenge_id, challenge_version, rule_version, score DESC, completed_at ASC, attempt_id ASC);
      CREATE UNIQUE INDEX active_competitive_policy_tuple_v5
        ON approved_competitive_model_policies(model_bundle_id, workflow_id, workflow_version, provider_version, calibration_evidence_version, challenge_id, challenge_version, rule_version)
        WHERE active = 1;
    `,
  },
  {
    version: 6,
    sql: `
      CREATE TABLE workflow_benchmark_receipt_invalidations_v6 (
        receipt_id TEXT PRIMARY KEY NOT NULL REFERENCES workflow_benchmark_receipts(id),
        invalidated_at TEXT NOT NULL CHECK (
          invalidated_at GLOB '????-??-??T??:??:??.???Z'
          AND strftime('%Y-%m-%dT%H:%M:%fZ', invalidated_at) IS NOT NULL
          AND strftime('%Y-%m-%dT%H:%M:%fZ', invalidated_at) = invalidated_at
        ),
        reason TEXT NOT NULL CHECK (reason IN ('tuple_changed', 'manifest_set_changed', 'operator_revoked')),
        created_at TEXT NOT NULL
      );
      INSERT INTO workflow_benchmark_receipt_invalidations_v6
        SELECT
          receipt_id,
          CASE
            WHEN strftime('%Y-%m-%dT%H:%M:%fZ', invalidated_at) = invalidated_at
              THEN invalidated_at
            ELSE created_at
          END,
          CASE
            WHEN reason IN ('tuple_changed', 'manifest_set_changed', 'operator_revoked')
              THEN reason
            ELSE 'operator_revoked'
          END,
          created_at
        FROM workflow_benchmark_receipt_invalidations;
      DROP TABLE workflow_benchmark_receipt_invalidations;
      ALTER TABLE workflow_benchmark_receipt_invalidations_v6 RENAME TO workflow_benchmark_receipt_invalidations;
    `,
  },
  {
    version: 7,
    sql: `
      CREATE TABLE workflow_benchmark_receipt_invalidations_v7 (
        receipt_id TEXT PRIMARY KEY NOT NULL REFERENCES workflow_benchmark_receipts(id),
        invalidated_at TEXT NOT NULL CHECK (
          invalidated_at GLOB '????-??-??T??:??:??.???Z'
          AND substr(invalidated_at, 6, 2) BETWEEN '01' AND '12'
          AND substr(invalidated_at, 9, 2) BETWEEN '01' AND '31'
          AND substr(invalidated_at, 12, 2) BETWEEN '00' AND '23'
          AND strftime('%Y-%m-%dT%H:%M:%fZ', invalidated_at) IS NOT NULL
          AND strftime('%Y-%m-%dT%H:%M:%fZ', invalidated_at) = invalidated_at
          AND date(
            substr(invalidated_at, 1, 8) || '01',
            '+' || (CAST(substr(invalidated_at, 9, 2) AS INTEGER) - 1) || ' days'
          ) = substr(invalidated_at, 1, 10)
        ),
        reason TEXT NOT NULL CHECK (reason IN ('tuple_changed', 'manifest_set_changed', 'operator_revoked')),
        created_at TEXT NOT NULL
      );
      CREATE TABLE workflow_benchmark_receipt_invalidation_quarantine (
        receipt_id TEXT PRIMARY KEY NOT NULL REFERENCES workflow_benchmark_receipts(id),
        invalidated_at TEXT NOT NULL,
        reason TEXT NOT NULL,
        created_at TEXT NOT NULL,
        quarantine_reason TEXT NOT NULL CHECK (quarantine_reason = 'invalid_v6_timestamp')
      );
      INSERT INTO workflow_benchmark_receipt_invalidations_v7
        SELECT receipt_id, invalidated_at, reason, created_at
        FROM workflow_benchmark_receipt_invalidations
        WHERE CASE
          WHEN invalidated_at GLOB '????-??-??T??:??:??.???Z'
            AND substr(invalidated_at, 6, 2) BETWEEN '01' AND '12'
            AND substr(invalidated_at, 9, 2) BETWEEN '01' AND '31'
            AND substr(invalidated_at, 12, 2) BETWEEN '00' AND '23'
            AND strftime('%Y-%m-%dT%H:%M:%fZ', invalidated_at) IS NOT NULL
            AND strftime('%Y-%m-%dT%H:%M:%fZ', invalidated_at) = invalidated_at
            AND date(
              substr(invalidated_at, 1, 8) || '01',
              '+' || (CAST(substr(invalidated_at, 9, 2) AS INTEGER) - 1) || ' days'
            ) = substr(invalidated_at, 1, 10)
            THEN 1
          ELSE 0
        END = 1;
      INSERT INTO workflow_benchmark_receipt_invalidation_quarantine
        (receipt_id, invalidated_at, reason, created_at, quarantine_reason)
        SELECT receipt_id, invalidated_at, reason, created_at, 'invalid_v6_timestamp'
        FROM workflow_benchmark_receipt_invalidations
        WHERE CASE
          WHEN invalidated_at GLOB '????-??-??T??:??:??.???Z'
            AND substr(invalidated_at, 6, 2) BETWEEN '01' AND '12'
            AND substr(invalidated_at, 9, 2) BETWEEN '01' AND '31'
            AND substr(invalidated_at, 12, 2) BETWEEN '00' AND '23'
            AND strftime('%Y-%m-%dT%H:%M:%fZ', invalidated_at) IS NOT NULL
            AND strftime('%Y-%m-%dT%H:%M:%fZ', invalidated_at) = invalidated_at
            AND date(
              substr(invalidated_at, 1, 8) || '01',
              '+' || (CAST(substr(invalidated_at, 9, 2) AS INTEGER) - 1) || ' days'
            ) = substr(invalidated_at, 1, 10)
            THEN 1
          ELSE 0
        END = 0;
      DROP TABLE workflow_benchmark_receipt_invalidations;
      ALTER TABLE workflow_benchmark_receipt_invalidations_v7 RENAME TO workflow_benchmark_receipt_invalidations;
    `,
    afterApply: canonicalizeLegacyTerminalCandidates,
  },
  {
    version: 8,
    sql: `
      CREATE TABLE processing_recovery_records (
        attempt_id TEXT NOT NULL REFERENCES attempts(id),
        generation INTEGER NOT NULL CHECK (generation >= 0),
        retry_attempts INTEGER NOT NULL CHECK (retry_attempts >= 0),
        state TEXT NOT NULL CHECK (state IN ('retrying', 'dead-lettered')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (attempt_id, generation)
      );
    `,
  },
];

export function openSqliteDatabase(filename: string): SqliteDatabase {
  return openSqliteDatabaseInternal(filename);
}

/** Test-only fixture helper for proving an upgrade from a historical schema. */
export function openSqliteDatabaseAtVersionForTest(
  filename: string,
  migrationVersion: number,
): SqliteDatabase {
  return openSqliteDatabaseInternal(filename, migrationVersion);
}

function openSqliteDatabaseInternal(
  filename: string,
  migrationVersion?: number,
): SqliteDatabase {
  let raw: Database.Database | undefined;
  try {
    raw = new Database(filename);
    raw.pragma("foreign_keys = ON");
    raw.pragma("journal_mode = WAL");
    raw.pragma("busy_timeout = 5000");
    applyMigrations(raw, migrationVersion);
  } catch (error) {
    raw?.close();
    throw error;
  }

  return Object.freeze({
    raw,
    reopen: () => openSqliteDatabaseInternal(filename, migrationVersion),
    close: () => raw.close(),
  });
}

function applyMigrations(
  raw: Database.Database,
  migrationVersion?: number,
): void {
  raw.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY NOT NULL, applied_at TEXT NOT NULL)",
  );
  const applied = new Set(
    raw
      .prepare("SELECT version FROM schema_migrations")
      .all()
      .map((row) => Number((row as { version: number }).version)),
  );

  for (const migration of migrations) {
    if (migrationVersion !== undefined && migration.version > migrationVersion)
      break;
    if (applied.has(migration.version)) continue;
    raw.exec("BEGIN IMMEDIATE");
    try {
      raw.exec(migration.sql);
      migration.afterApply?.(raw);
      raw
        .prepare(
          "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
        )
        .run(migration.version, new Date().toISOString());
      raw.exec("COMMIT");
    } catch (error) {
      raw.exec("ROLLBACK");
      throw error;
    }
  }
}

function canonicalizeLegacyTerminalCandidates(raw: Database.Database): void {
  const rows = raw
    .prepare("SELECT id, candidate_json FROM terminal_results")
    .all() as readonly Readonly<{ id: string; candidate_json: string }>[];
  const update = raw.prepare(
    "UPDATE terminal_results SET candidate_json = ? WHERE id = ?",
  );
  for (const row of rows) {
    const canonical = canonicalizeLegacyTerminalCandidate(row.candidate_json);
    if (canonical !== row.candidate_json) update.run(canonical, row.id);
  }
}

function canonicalizeLegacyTerminalCandidate(value: string): string {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    const result = parsed.result;
    if (
      parsed.state !== "valid" ||
      !result ||
      typeof result !== "object" ||
      Array.isArray(result)
    )
      return value;
    const verified = result as Record<string, unknown>;
    if (
      verified.kind !== "verified-result" ||
      verified.competitiveStatus !== "ranked" ||
      !("rankingSnapshot" in verified)
    )
      return value;
    const { rankingSnapshot: _legacySnapshot, ...candidateResult } = verified;
    void _legacySnapshot;
    return canonicalJson({ ...parsed, result: candidateResult });
  } catch {
    return value;
  }
}

function canonicalJson(value: unknown): string {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  )
    return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object")
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  throw new Error("Cannot canonicalize non-JSON terminal candidate");
}
