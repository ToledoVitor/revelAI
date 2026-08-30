import Database from "better-sqlite3";

type Migration = Readonly<{ version: number; sql: string }>;

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
];

export function openSqliteDatabase(filename: string): SqliteDatabase {
  let raw: Database.Database | undefined;
  try {
    raw = new Database(filename);
    raw.pragma("foreign_keys = ON");
    raw.pragma("journal_mode = WAL");
    raw.pragma("busy_timeout = 5000");
    applyMigrations(raw);
  } catch (error) {
    raw?.close();
    throw error;
  }

  return Object.freeze({
    raw,
    reopen: () => openSqliteDatabase(filename),
    close: () => raw.close(),
  });
}

function applyMigrations(raw: Database.Database): void {
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
    if (applied.has(migration.version)) continue;
    raw.exec("BEGIN IMMEDIATE");
    try {
      raw.exec(migration.sql);
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
