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
];

export function openSqliteDatabase(filename: string): SqliteDatabase {
  const raw = new Database(filename);
  raw.pragma("foreign_keys = ON");
  raw.pragma("journal_mode = WAL");
  raw.pragma("busy_timeout = 5000");
  applyMigrations(raw);

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
