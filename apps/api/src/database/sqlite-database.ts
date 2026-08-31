import Database from "better-sqlite3";
import {
  WorkflowBenchmarkReceiptSchema,
  workflowBenchmarkReceiptDigest,
} from "@revelai/contracts";
import {
  CompetitivePolicyRepositoryError,
  parseStoredBenchmarkReceipt,
} from "../repositories/competitive-policy-repository.js";

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
  {
    version: 9,
    sql: `
      CREATE TABLE IF NOT EXISTS workflow_benchmark_receipt_invalidation_quarantine (
        receipt_id TEXT PRIMARY KEY NOT NULL REFERENCES workflow_benchmark_receipts(id),
        invalidated_at TEXT NOT NULL,
        reason TEXT NOT NULL,
        created_at TEXT NOT NULL,
        quarantine_reason TEXT NOT NULL CHECK (quarantine_reason = 'invalid_v6_timestamp')
      );
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
        END = 0
        ON CONFLICT(receipt_id) DO NOTHING;
      DELETE FROM workflow_benchmark_receipt_invalidations
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

      CREATE TABLE processing_recovery_records_v9 (
        attempt_id TEXT NOT NULL REFERENCES attempts(id),
        generation INTEGER NOT NULL CHECK (
          typeof(generation) = 'integer'
          AND generation BETWEEN 0 AND 9007199254740991
        ),
        retry_attempts INTEGER NOT NULL CHECK (
          typeof(retry_attempts) = 'integer'
          AND retry_attempts BETWEEN 0 AND 9007199254740991
        ),
        state TEXT NOT NULL CHECK (state IN ('retrying', 'dead-lettered')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (attempt_id, generation)
      );
      INSERT INTO processing_recovery_records_v9
        (attempt_id, generation, retry_attempts, state, created_at, updated_at)
        SELECT attempt_id, generation, retry_attempts, state, created_at, updated_at
        FROM processing_recovery_records
        WHERE typeof(generation) = 'integer'
          AND generation BETWEEN 0 AND 9007199254740991
          AND typeof(retry_attempts) = 'integer'
          AND retry_attempts BETWEEN 0 AND 9007199254740991;
      DROP TABLE processing_recovery_records;
      ALTER TABLE processing_recovery_records_v9 RENAME TO processing_recovery_records;

      CREATE TRIGGER workflow_benchmark_receipt_invalidations_reject_quarantined
      BEFORE INSERT ON workflow_benchmark_receipt_invalidations
      WHEN EXISTS (
        SELECT 1 FROM workflow_benchmark_receipt_invalidation_quarantine
        WHERE receipt_id = NEW.receipt_id
      )
      BEGIN
        SELECT RAISE(ABORT, 'invalidation already quarantined');
      END;
      CREATE TRIGGER workflow_benchmark_receipt_invalidation_quarantine_reject_primary
      BEFORE INSERT ON workflow_benchmark_receipt_invalidation_quarantine
      WHEN EXISTS (
        SELECT 1 FROM workflow_benchmark_receipt_invalidations
        WHERE receipt_id = NEW.receipt_id
      )
      BEGIN
        SELECT RAISE(ABORT, 'invalidation already recorded');
      END;
    `,
  },
  {
    version: 10,
    sql: `
      CREATE TABLE retention_cleanup_records (
        resource_id TEXT PRIMARY KEY NOT NULL,
        attempt_id TEXT NOT NULL REFERENCES attempts(id),
        resource_kind TEXT NOT NULL CHECK (resource_kind IN ('frame', 'temporary', 'observation')),
        delete_at TEXT NOT NULL,
        cleanup_requested_at TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX retention_cleanup_records_due
        ON retention_cleanup_records(cleanup_requested_at, delete_at, resource_id);
    `,
  },
  {
    version: 11,
    sql: `
      CREATE TRIGGER attempts_media_json_requires_c5_transition
      BEFORE UPDATE OF media_json ON attempts
      WHEN NEW.media_json IS NOT NULL AND (
        json_valid(NEW.media_json) = 0
        OR json_type(NEW.media_json, '$.uploadedAt') IS NOT 'text'
        OR json_type(NEW.media_json, '$.deleteAt') IS NOT 'text'
        OR json_type(NEW.media_json, '$.transition') IS NOT 'object'
        OR json_extract(NEW.media_json, '$.transition.kind') IS NOT 'upload-transition'
        OR json_type(NEW.media_json, '$.transition.resourceId') IS NOT 'text'
        OR json_type(NEW.media_json, '$.transition.deleteAt') IS NOT 'text'
        OR json_extract(NEW.media_json, '$.transition.resourceId') IS NOT json_extract(NEW.media_json, '$.id')
      )
      BEGIN
        SELECT RAISE(ABORT, 'invalid C5 media transition');
      END;
    `,
    afterApply: canonicalizeLegacyStoredMedia,
  },
  {
    // Migration 11 may already be recorded on durable C5 databases. Keep its
    // historical behavior intact and repair every accepted predecessor shape
    // in a new, replay-safe migration.
    version: 12,
    sql: `
      DROP TRIGGER IF EXISTS attempts_media_json_requires_c5_transition;
      CREATE TRIGGER attempts_media_json_requires_c5_transition
      BEFORE UPDATE OF media_json ON attempts
      WHEN NEW.media_json IS NOT NULL AND (${invalidC5MediaV12Sql("NEW.media_json")})
      BEGIN
        SELECT RAISE(ABORT, 'invalid C5 media transition');
      END;

      CREATE TRIGGER attempts_media_json_insert_requires_c5_transition
      BEFORE INSERT ON attempts
      WHEN NEW.media_json IS NOT NULL AND (${invalidC5MediaV12Sql("NEW.media_json")})
      BEGIN
        SELECT RAISE(ABORT, 'invalid C5 media transition');
      END;
    `,
    afterApply: canonicalizeAllStoredMedia,
  },
  {
    // v12 guarded the six top-level fields but could still admit a nested
    // transition extra which the repository would later reject. v13 closes
    // both INSERT and UPDATE and only projects named, historical predecessors.
    version: 13,
    sql: `
      DROP TRIGGER IF EXISTS attempts_media_json_requires_c5_transition;
      DROP TRIGGER IF EXISTS attempts_media_json_insert_requires_c5_transition;
      CREATE TRIGGER attempts_media_json_requires_c5_transition
      BEFORE UPDATE OF media_json ON attempts
      WHEN NEW.media_json IS NOT NULL AND (${invalidC5MediaSql("NEW.media_json")})
      BEGIN
        SELECT RAISE(ABORT, 'invalid C5 media transition');
      END;

      CREATE TRIGGER attempts_media_json_insert_requires_c5_transition
      BEFORE INSERT ON attempts
      WHEN NEW.media_json IS NOT NULL AND (${invalidC5MediaSql("NEW.media_json")})
      BEGIN
        SELECT RAISE(ABORT, 'invalid C5 media transition');
      END;
    `,
    afterApply: canonicalizeStoredMediaV13,
  },
  {
    // C7 policy lookup is workspace-scoped. Existing policy rows are repaired
    // from their immutable, strictly parsed receipt rather than accepting a
    // caller-provided workspace identity.
    version: 14,
    sql: `
      ALTER TABLE approved_competitive_model_policies
      ADD COLUMN workspace_id TEXT NOT NULL DEFAULT '';
    `,
    afterApply: bindCompetitivePolicyWorkspacesV14,
  },
  {
    // Extraction and observation revisions are independently operator-approved
    // facts. Historical v14 rows receive only the one receipt-schema literals;
    // any future revision requires a new exact policy tuple.
    version: 15,
    sql: `
      ALTER TABLE approved_competitive_model_policies
      ADD COLUMN extraction_evidence_version TEXT NOT NULL DEFAULT 'c5-frame-manifest-v1';
      ALTER TABLE approved_competitive_model_policies
      ADD COLUMN observation_evidence_version TEXT NOT NULL DEFAULT 'wall-pass-geometry-evidence-v1';
      DROP INDEX IF EXISTS active_competitive_policy_tuple_v14;
      CREATE UNIQUE INDEX active_competitive_policy_tuple_v15
        ON approved_competitive_model_policies(workspace_id, model_bundle_id, workflow_id, workflow_version, provider_version, calibration_evidence_version, extraction_evidence_version, observation_evidence_version, challenge_id, challenge_version, rule_version)
        WHERE active = 1;
    `,
    afterApply: upgradeCompetitivePolicyEvidenceVersionsV15,
  },
  {
    // C8 persists only a C5-issued storage receipt reference. Source digest
    // and receipt facts live in independent columns so mutable context JSON
    // can never become its own authority. Contextless pre-v16 active uploads
    // are fail-safely reset for a fresh upload; their old retention facts stay
    // due, and their generation can never be claimed again.
    version: 16,
    sql: `
      ALTER TABLE attempts
      ADD COLUMN processing_context_json TEXT;
      ALTER TABLE attempts
      ADD COLUMN media_sha256 TEXT;
      ALTER TABLE attempts
      ADD COLUMN processing_receipt_id TEXT;
      ALTER TABLE attempts
      ADD COLUMN processing_receipt_sha256 TEXT;
    `,
    afterApply: resetLegacyProcessingRowsV16,
  },
  {
    // C8 records delivery intent in the same transaction as C4's accepted
    // attachment. Queue failures can then retire the exact generation and
    // leave a durable cleanup/retry fact without retaining any storage path.
    version: 17,
    sql: `
      CREATE TABLE media_delivery_recovery_records (
        attempt_id TEXT NOT NULL REFERENCES attempts(id),
        generation INTEGER NOT NULL CHECK (
          typeof(generation) = 'integer'
          AND generation BETWEEN 1 AND 9007199254740991
        ),
        media_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK (
          state IN ('pending-delivery', 'queued', 'cleanup-recoverable', 'resolved')
        ),
        requires_rollback INTEGER NOT NULL CHECK (requires_rollback IN (0, 1)),
        queued_at TEXT,
        rollback_completed_at TEXT,
        cleanup_completed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (attempt_id, generation)
      );
      CREATE INDEX media_delivery_recovery_pending
        ON media_delivery_recovery_records(state, updated_at, attempt_id);
    `,
  },
  {
    // A live leaderboard page is fixed by both event time and an allocation
    // sequence committed by this repository. Wall time alone admits either a
    // future-dated old commit or a newly committed backdated result.
    version: 18,
    sql: `
      ALTER TABLE leaderboard_entries
      ADD COLUMN commit_sequence INTEGER NOT NULL DEFAULT 0 CHECK (
        typeof(commit_sequence) = 'integer' AND commit_sequence >= 0
      );
      UPDATE leaderboard_entries
         SET commit_sequence = (
           SELECT COUNT(*)
             FROM leaderboard_entries AS older
            WHERE older.created_at < leaderboard_entries.created_at
               OR (older.created_at = leaderboard_entries.created_at
                   AND older.id <= leaderboard_entries.id)
         );
      CREATE UNIQUE INDEX leaderboard_entries_commit_sequence
        ON leaderboard_entries(commit_sequence);
      CREATE TABLE leaderboard_commit_clock (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        sequence INTEGER NOT NULL CHECK (
          typeof(sequence) = 'integer' AND sequence >= 0
        )
      );
      INSERT INTO leaderboard_commit_clock (singleton, sequence)
      SELECT 1, COALESCE(MAX(commit_sequence), 0) FROM leaderboard_entries;

      ALTER TABLE media_delivery_recovery_records
      ADD COLUMN frame_batch_id TEXT;
      ALTER TABLE media_delivery_recovery_records
      ADD COLUMN recovery_lease_id TEXT;
      ALTER TABLE media_delivery_recovery_records
      ADD COLUMN recovery_lease_expires_at TEXT;
      CREATE INDEX media_delivery_recovery_claimable
        ON media_delivery_recovery_records(state, recovery_lease_expires_at, updated_at, attempt_id);
    `,
    afterApply: backfillDeliveryRecoveryV18,
  },
  {
    // v18 only had enough information to add a frame identifier. It did not
    // prove that the independently persisted receipt, source digest, and
    // delivery tuple agreed. Repair those rows once, without changing v18:
    // malformed authority is retired for a fresh upload and exact live work
    // gets the one coherent recovery state it can safely resume from.
    version: 19,
    sql: "SELECT 1;",
    afterApply: normalizeDeliveryRecoveryV19,
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

/**
 * v11 may only project the one pre-C5 four-field attachment it actually
 * understands. It must not turn an unknown near-miss into a C5 transition
 * before v12/v13 have the opportunity to reject it.
 */
function canonicalizeLegacyStoredMedia(raw: Database.Database): void {
  const rows = raw
    .prepare("SELECT id, media_json FROM attempts WHERE media_json IS NOT NULL")
    .all() as readonly Readonly<{ id: string; media_json: string }>[];
  const update = raw.prepare("UPDATE attempts SET media_json = ? WHERE id = ?");
  for (const row of rows) {
    const canonical = canonicalizeLegacyMedia(row.media_json);
    if (canonical !== row.media_json) update.run(canonical, row.id);
  }
}

/**
 * v12 projection. Any unreadable non-null legacy attachment stops startup
 * inside the migration transaction rather than being silently marked current.
 */
function canonicalizeAllStoredMedia(raw: Database.Database): void {
  const rows = raw
    .prepare("SELECT id, media_json FROM attempts WHERE media_json IS NOT NULL")
    .all() as readonly Readonly<{ id: string; media_json: string }>[];
  const update = raw.prepare("UPDATE attempts SET media_json = ? WHERE id = ?");
  for (const row of rows) {
    const canonical = canonicalizeStoredMediaV12(row.media_json);
    update.run(canonical, row.id);
  }
}

/**
 * v13 accepts only exact named predecessor rows. In particular, an arbitrary
 * five-field object cannot be upgraded by inventing an upload transition.
 */
function canonicalizeStoredMediaV13(raw: Database.Database): void {
  const rows = raw
    .prepare("SELECT id, media_json FROM attempts WHERE media_json IS NOT NULL")
    .all() as readonly Readonly<{ id: string; media_json: string }>[];
  const update = raw.prepare("UPDATE attempts SET media_json = ? WHERE id = ?");
  for (const row of rows) {
    const canonical = canonicalizeStoredMediaV13Value(row.media_json);
    if (canonical !== row.media_json) update.run(canonical, row.id);
  }
}

/**
 * Receipt JSON is the sole durable source of a workflow workspace. Refuse an
 * upgrade that would otherwise invent or preserve an unverified association.
 */
function bindCompetitivePolicyWorkspacesV14(raw: Database.Database): void {
  const rows = raw
    .prepare(
      `SELECT p.id AS policy_id, r.id, r.receipt_sha256, r.schema_version,
              r.model_bundle_id, r.workflow_id, r.workflow_version,
              r.provider_version, r.status, r.run_at, r.valid_until,
              r.invalidated_at, r.receipt_json
       FROM approved_competitive_model_policies p
       INNER JOIN workflow_benchmark_receipts r ON r.id = p.receipt_id`,
    )
    .all() as readonly Readonly<{
    policy_id: string;
    id: string;
    receipt_sha256: string;
    schema_version: string;
    model_bundle_id: string;
    workflow_id: string;
    workflow_version: string;
    provider_version: string;
    status: string;
    run_at: string;
    valid_until: string;
    invalidated_at: string | null;
    receipt_json: string;
  }>[];
  const update = raw.prepare(
    "UPDATE approved_competitive_model_policies SET workspace_id = ? WHERE id = ?",
  );
  for (const row of rows) {
    const receipt = parseStoredBenchmarkReceipt({
      id: row.id,
      receiptSha256: row.receipt_sha256,
      schemaVersion: row.schema_version,
      modelBundleId: row.model_bundle_id,
      workflowId: row.workflow_id,
      workflowVersion: row.workflow_version,
      providerVersion: row.provider_version,
      status: row.status,
      runAt: row.run_at,
      validUntil: row.valid_until,
      invalidatedAt: row.invalidated_at,
      receiptJson: row.receipt_json,
    });
    update.run(receipt.workflow.workspaceId, row.policy_id);
  }
  raw.exec(
    `DROP INDEX IF EXISTS active_competitive_policy_tuple_v5;
     CREATE UNIQUE INDEX active_competitive_policy_tuple_v14
       ON approved_competitive_model_policies(workspace_id, model_bundle_id, workflow_id, workflow_version, provider_version, calibration_evidence_version, challenge_id, challenge_version, rule_version)
       WHERE active = 1;`,
  );
}

/**
 * v14 receipts predate the explicit evidence-version object. This exact
 * predecessor is upgraded only after its old canonical digest verifies; the
 * new canonical receipt hash and every linked policy hash move atomically.
 */
function resetLegacyProcessingRowsV16(raw: Database.Database): void {
  raw
    .prepare(
      "UPDATE attempts SET media_json = NULL, media_sha256 = NULL, processing_context_json = NULL, processing_receipt_id = NULL, processing_receipt_sha256 = NULL, status = 'awaiting-upload', processing_generation = processing_generation + 1, processing_lease_id = NULL, processing_lease_expires_at = NULL WHERE deletion_state = 'active' AND status IN ('uploaded', 'processing')",
    )
    .run();
}

/**
 * v17 created the delivery journal but could not see already-live v16 work.
 * An upload without a durable delivery acknowledgement is retired rather than
 * guessed queued; an already-processing row has proved a worker claim and is
 * preserved as queued. Malformed rows follow v16's fail-safe re-upload path.
 */
function backfillDeliveryRecoveryV18(raw: Database.Database): void {
  const rows = raw
    .prepare(
      `SELECT id, status, processing_generation, media_json,
              processing_context_json, processing_receipt_id
         FROM attempts
        WHERE deletion_state = 'active' AND status IN ('uploaded', 'processing')`,
    )
    .all() as readonly Readonly<{
    id: string;
    status: "uploaded" | "processing";
    processing_generation: number;
    media_json: string | null;
    processing_context_json: string | null;
    processing_receipt_id: string | null;
  }>[];
  const now = new Date().toISOString();
  const insert = raw.prepare(
    `INSERT INTO media_delivery_recovery_records
     (attempt_id, generation, media_id, frame_batch_id, state, requires_rollback, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(attempt_id, generation) DO UPDATE SET
       frame_batch_id = COALESCE(media_delivery_recovery_records.frame_batch_id, excluded.frame_batch_id),
       updated_at = excluded.updated_at`,
  );
  const reset = raw.prepare(
    `UPDATE attempts
        SET media_json = NULL, media_sha256 = NULL, processing_context_json = NULL,
            processing_receipt_id = NULL, processing_receipt_sha256 = NULL,
            status = 'awaiting-upload', processing_generation = processing_generation + 1,
            processing_lease_id = NULL, processing_lease_expires_at = NULL
      WHERE id = ? AND deletion_state = 'active' AND status IN ('uploaded', 'processing')`,
  );
  for (const row of rows) {
    const identity = legacyDeliveryIdentity(row);
    if (!identity) {
      reset.run(row.id);
      continue;
    }
    insert.run(
      row.id,
      row.processing_generation,
      identity.mediaId,
      identity.frameBatchId,
      row.status === "uploaded" ? "cleanup-recoverable" : "queued",
      row.status === "uploaded" ? 1 : 0,
      now,
      now,
    );
  }
}

function legacyDeliveryIdentity(
  row: Readonly<{
    processing_generation: number;
    media_json: string | null;
    processing_context_json: string | null;
    processing_receipt_id: string | null;
  }>,
): Readonly<{ mediaId: string; frameBatchId: string }> | null {
  try {
    if (
      !Number.isSafeInteger(row.processing_generation) ||
      row.processing_generation < 1 ||
      row.media_json === null ||
      row.processing_context_json === null ||
      row.processing_receipt_id === null
    )
      return null;
    const media = JSON.parse(row.media_json) as { id?: unknown };
    const context = JSON.parse(row.processing_context_json) as {
      processing?: {
        kind?: unknown;
        receipt?: { frameBatchId?: unknown; mediaId?: unknown };
      };
    };
    if (
      typeof media.id !== "string" ||
      context.processing?.kind !== "c5-durable-processing-context-v2" ||
      typeof context.processing.receipt?.frameBatchId !== "string" ||
      typeof context.processing.receipt?.mediaId !== "string" ||
      context.processing.receipt.mediaId !== media.id ||
      context.processing.receipt.frameBatchId !== row.processing_receipt_id
    )
      return null;
    return Object.freeze({
      mediaId: media.id,
      frameBatchId: context.processing.receipt.frameBatchId,
    });
  } catch {
    return null;
  }
}

type V19DeliveryAuthorityRow = Readonly<{
  id: string;
  athlete_id: string;
  mode: "free" | "verified";
  challenge_id: string | null;
  challenge_version: number | null;
  calibration_session_id: string | null;
  calibration_nonce: string | null;
  status: "uploaded" | "processing";
  processing_generation: number;
  media_json: string | null;
  media_sha256: string | null;
  processing_context_json: string | null;
  processing_receipt_id: string | null;
  processing_receipt_sha256: string | null;
}>;

type V19DeliveryRecoveryRow = Readonly<{
  attempt_id: string;
  generation: number;
  media_id: string;
  frame_batch_id: string | null;
  state: string;
  requires_rollback: number;
}>;

/**
 * v19 is intentionally a complete repair pass rather than a tweak to v18.
 * The delivery journal is recoverable work, never its own source of upload
 * authority. A row is retained only when every duplicated C5 fact agrees.
 */
function normalizeDeliveryRecoveryV19(raw: Database.Database): void {
  const now = new Date().toISOString();
  const liveRows = raw
    .prepare(
      `SELECT a.id, a.athlete_id, a.mode, a.challenge_id,
              a.challenge_version, a.calibration_session_id,
              s.nonce AS calibration_nonce, a.status,
              a.processing_generation, a.media_json, a.media_sha256,
              a.processing_context_json, a.processing_receipt_id,
              a.processing_receipt_sha256
         FROM attempts a
         LEFT JOIN calibration_sessions s ON s.id = a.calibration_session_id
        WHERE a.deletion_state = 'active'
          AND a.status IN ('uploaded', 'processing')`,
    )
    .all() as readonly V19DeliveryAuthorityRow[];
  const recoveryRows = raw
    .prepare(
      `SELECT attempt_id, generation, media_id, frame_batch_id, state,
              requires_rollback
         FROM media_delivery_recovery_records`,
    )
    .all() as readonly V19DeliveryRecoveryRow[];
  const recoveryByAttempt = new Map<string, V19DeliveryRecoveryRow[]>();
  for (const recovery of recoveryRows) {
    const current = recoveryByAttempt.get(recovery.attempt_id) ?? [];
    current.push(recovery);
    recoveryByAttempt.set(recovery.attempt_id, current);
  }

  const deleteRecovery = raw.prepare(
    "DELETE FROM media_delivery_recovery_records WHERE attempt_id = ?",
  );
  const reset = raw.prepare(
    `UPDATE attempts
        SET media_json = NULL, media_sha256 = NULL, processing_context_json = NULL,
            processing_receipt_id = NULL, processing_receipt_sha256 = NULL,
            status = 'awaiting-upload', processing_generation = processing_generation + 1,
            processing_lease_id = NULL, processing_lease_expires_at = NULL
      WHERE id = ? AND deletion_state = 'active'
        AND status IN ('uploaded', 'processing')`,
  );
  const insert = raw.prepare(
    `INSERT INTO media_delivery_recovery_records
       (attempt_id, generation, media_id, frame_batch_id, state,
        requires_rollback, queued_at, rollback_completed_at,
        cleanup_completed_at, recovery_lease_id, recovery_lease_expires_at,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?)`,
  );

  for (const row of liveRows) {
    const authority = strictV19DeliveryAuthority(row);
    const existing = recoveryByAttempt.get(row.id) ?? [];
    if (
      authority === null ||
      existing.some(
        (recovery) =>
          recovery.generation !== row.processing_generation ||
          recovery.media_id !== authority?.mediaId ||
          recovery.frame_batch_id !== authority?.frameBatchId,
      )
    ) {
      deleteRecovery.run(row.id);
      reset.run(row.id);
      continue;
    }

    // Delete then insert makes v19 authoritative over every legacy flag,
    // timestamp, lease, and conflicting state while retaining only the exact
    // tuple that the attempt row independently proves.
    deleteRecovery.run(row.id);
    const pending = row.status === "uploaded";
    insert.run(
      row.id,
      row.processing_generation,
      authority.mediaId,
      authority.frameBatchId,
      pending ? "pending-delivery" : "queued",
      pending ? 1 : 0,
      pending ? null : now,
      now,
      now,
    );
    recoveryByAttempt.delete(row.id);
  }

  // A terminal or fresh-upload attempt has no redelivery authority. A
  // tombstone retains only an exact resource pair, converted to cleanup so it
  // can never be redelivered after the owning attempt disappeared.
  const tombstoned = raw
    .prepare(
      "SELECT id, processing_generation FROM attempts WHERE deletion_state = 'tombstoned'",
    )
    .all() as readonly Readonly<{
    id: string;
    processing_generation: number;
  }>[];
  const tombstonedIds = new Set(tombstoned.map((row) => row.id));
  for (const [attemptId, records] of recoveryByAttempt) {
    if (!tombstonedIds.has(attemptId)) {
      deleteRecovery.run(attemptId);
      continue;
    }
    const tombstone = tombstoned.find((row) => row.id === attemptId)!;
    const exact = records.length === 1 ? records[0] : null;
    if (
      exact === null ||
      !isExactV19CleanupTuple(exact, tombstone.processing_generation)
    ) {
      deleteRecovery.run(attemptId);
      continue;
    }
    deleteRecovery.run(attemptId);
    insert.run(
      exact.attempt_id,
      exact.generation,
      exact.media_id,
      exact.frame_batch_id,
      "cleanup-recoverable",
      0,
      null,
      now,
      now,
    );
  }
}

function strictV19DeliveryAuthority(
  row: V19DeliveryAuthorityRow,
): Readonly<{ mediaId: string; frameBatchId: string }> | null {
  try {
    if (
      !isUuidV19(row.id) ||
      !isUuidV19(row.athlete_id) ||
      !Number.isSafeInteger(row.processing_generation) ||
      row.processing_generation < 1 ||
      row.media_json === null ||
      row.media_sha256 === null ||
      row.processing_context_json === null ||
      row.processing_receipt_id === null ||
      row.processing_receipt_sha256 === null ||
      !isDigestV19(row.media_sha256) ||
      !isUuidV19(row.processing_receipt_id) ||
      !isDigestV19(row.processing_receipt_sha256)
    )
      return null;
    const media = parseV19Media(row.media_json);
    const context = parseV19ProcessingContext(row.processing_context_json);
    if (
      media === null ||
      context === null ||
      context.sourceSha256 !== row.media_sha256 ||
      context.receipt.frameBatchId !== row.processing_receipt_id ||
      context.receipt.sha256 !== row.processing_receipt_sha256 ||
      context.receipt.mediaId !== media.id ||
      !matchesV19UploadContext(row, media.uploadedAt, context.upload)
    )
      return null;
    return Object.freeze({
      mediaId: media.id,
      frameBatchId: context.receipt.frameBatchId,
    });
  } catch {
    return null;
  }
}

function parseV19Media(
  value: string,
): Readonly<{ id: string; uploadedAt: string }> | null {
  const media = parseV19JsonRecord(value);
  if (
    media === null ||
    !hasExactObjectKeys(media, [
      "id",
      "contentType",
      "bytes",
      "uploadedAt",
      "deleteAt",
      "transition",
    ]) ||
    typeof media.id !== "string" ||
    media.id.length === 0 ||
    typeof media.contentType !== "string" ||
    media.contentType.length === 0 ||
    typeof media.bytes !== "number" ||
    !Number.isSafeInteger(media.bytes) ||
    media.bytes < 0 ||
    typeof media.uploadedAt !== "string" ||
    !isCanonicalIso(media.uploadedAt) ||
    typeof media.deleteAt !== "string" ||
    media.deleteAt !==
      new Date(
        Date.parse(media.uploadedAt) + 23 * 60 * 60 * 1000,
      ).toISOString() ||
    !isPlainRecord(media.transition) ||
    !hasExactObjectKeys(media.transition, ["kind", "resourceId", "deleteAt"]) ||
    media.transition.kind !== "upload-transition" ||
    media.transition.resourceId !== media.id ||
    media.transition.deleteAt !==
      new Date(Date.parse(media.uploadedAt) + 60 * 60 * 1000).toISOString()
  )
    return null;
  return Object.freeze({ id: media.id, uploadedAt: media.uploadedAt });
}

function parseV19ProcessingContext(value: string): Readonly<{
  sourceSha256: string;
  receipt: Readonly<{ frameBatchId: string; mediaId: string; sha256: string }>;
  upload: Record<string, unknown>;
}> | null {
  const context = parseV19JsonRecord(value);
  if (
    context === null ||
    !hasExactObjectKeys(context, ["processing", "sourceSha256", "upload"]) ||
    !isDigestV19(context.sourceSha256) ||
    !isPlainRecord(context.processing) ||
    !hasExactObjectKeys(context.processing, ["kind", "receipt"]) ||
    context.processing.kind !== "c5-durable-processing-context-v2" ||
    !isPlainRecord(context.processing.receipt) ||
    !hasExactObjectKeys(context.processing.receipt, [
      "frameBatchId",
      "mediaId",
      "sha256",
    ]) ||
    !isUuidV19(context.processing.receipt.frameBatchId) ||
    typeof context.processing.receipt.mediaId !== "string" ||
    context.processing.receipt.mediaId.length === 0 ||
    !isDigestV19(context.processing.receipt.sha256) ||
    !isPlainRecord(context.upload)
  )
    return null;
  return Object.freeze({
    sourceSha256: context.sourceSha256,
    receipt: Object.freeze({
      frameBatchId: context.processing.receipt.frameBatchId,
      mediaId: context.processing.receipt.mediaId,
      sha256: context.processing.receipt.sha256,
    }),
    upload: context.upload,
  });
}

function matchesV19UploadContext(
  row: V19DeliveryAuthorityRow,
  uploadedAt: string,
  upload: Record<string, unknown>,
): boolean {
  if (
    !hasExactObjectKeys(upload, [
      "attemptId",
      "athleteId",
      "mode",
      "generation",
      "uploadedAt",
      "verified",
    ]) ||
    upload.attemptId !== row.id ||
    upload.athleteId !== row.athlete_id ||
    upload.mode !== row.mode ||
    upload.generation !== row.processing_generation ||
    upload.uploadedAt !== uploadedAt
  )
    return false;
  if (row.mode === "free")
    return (
      row.challenge_id === null &&
      row.challenge_version === null &&
      row.calibration_session_id === null &&
      upload.verified === null
    );
  if (
    row.challenge_id !== "wall-pass" ||
    row.challenge_version !== 1 ||
    !isUuidV19(row.calibration_session_id) ||
    typeof row.calibration_nonce !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(row.calibration_nonce) ||
    !isPlainRecord(upload.verified) ||
    !hasExactObjectKeys(upload.verified, [
      "challenge",
      "calibrationSessionId",
      "calibrationNonce",
    ]) ||
    !isPlainRecord(upload.verified.challenge) ||
    !hasExactObjectKeys(upload.verified.challenge, ["id", "version"])
  )
    return false;
  return (
    upload.verified.challenge.id === "wall-pass" &&
    upload.verified.challenge.version === 1 &&
    upload.verified.calibrationSessionId === row.calibration_session_id &&
    upload.verified.calibrationNonce === row.calibration_nonce
  );
}

function isExactV19CleanupTuple(
  row: V19DeliveryRecoveryRow,
  tombstoneGeneration: number,
): row is V19DeliveryRecoveryRow & Readonly<{ frame_batch_id: string }> {
  return (
    Number.isSafeInteger(row.generation) &&
    row.generation >= 1 &&
    Number.isSafeInteger(tombstoneGeneration) &&
    row.generation + 1 === tombstoneGeneration &&
    typeof row.media_id === "string" &&
    row.media_id.length > 0 &&
    typeof row.frame_batch_id === "string" &&
    isUuidV19(row.frame_batch_id) &&
    ["pending-delivery", "queued", "cleanup-recoverable"].includes(row.state) &&
    (row.requires_rollback === 0 || row.requires_rollback === 1)
  );
}

function parseV19JsonRecord(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return isPlainRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isDigestV19(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}

function isUuidV19(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  );
}

function upgradeCompetitivePolicyEvidenceVersionsV15(
  raw: Database.Database,
): void {
  const rows = raw
    .prepare(
      "SELECT id, receipt_sha256, schema_version, model_bundle_id, workflow_id, workflow_version, provider_version, status, run_at, valid_until, invalidated_at, receipt_json FROM workflow_benchmark_receipts",
    )
    .all() as readonly Readonly<{
    id: string;
    receipt_sha256: string;
    schema_version: string;
    model_bundle_id: string;
    workflow_id: string;
    workflow_version: string;
    provider_version: string;
    status: string;
    run_at: string;
    valid_until: string;
    invalidated_at: string | null;
    receipt_json: string;
  }>[];
  const policiesForReceipt = raw.prepare(
    "SELECT id, receipt_id, receipt_sha256, receipt_schema_version, workspace_id, model_bundle_id, workflow_id, workflow_version, provider_version, calibration_evidence_version, extraction_evidence_version, observation_evidence_version, challenge_id, challenge_version, rule_version, active, created_at FROM approved_competitive_model_policies WHERE receipt_id = ? AND receipt_sha256 = ?",
  );
  const deletePolicies = raw.prepare(
    "DELETE FROM approved_competitive_model_policies WHERE receipt_id = ? AND receipt_sha256 = ?",
  );
  const insertPolicy = raw.prepare(
    "INSERT INTO approved_competitive_model_policies (id, receipt_id, receipt_sha256, receipt_schema_version, workspace_id, model_bundle_id, workflow_id, workflow_version, provider_version, calibration_evidence_version, extraction_evidence_version, observation_evidence_version, challenge_id, challenge_version, rule_version, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const updateReceipt = raw.prepare(
    "UPDATE workflow_benchmark_receipts SET receipt_sha256 = ?, receipt_json = ? WHERE id = ? AND receipt_sha256 = ?",
  );
  const receiptForId = raw.prepare(
    "SELECT id, receipt_sha256, schema_version, model_bundle_id, workflow_id, workflow_version, provider_version, status, run_at, valid_until, invalidated_at, receipt_json FROM workflow_benchmark_receipts WHERE id = ?",
  );
  for (const row of rows) {
    const parsed = parseV14ReceiptValue(row);
    if (parsed.kind === "current") {
      parseStrictV15ReceiptRow(row);
      continue;
    }
    const { next, nextHash } = parsed;
    const policies = policiesForReceipt.all(
      row.id,
      row.receipt_sha256,
    ) as readonly Readonly<{
      id: string;
      receipt_id: string;
      receipt_sha256: string;
      receipt_schema_version: string;
      workspace_id: string;
      model_bundle_id: string;
      workflow_id: string;
      workflow_version: string;
      provider_version: string;
      calibration_evidence_version: string;
      extraction_evidence_version: string;
      observation_evidence_version: string;
      challenge_id: string;
      challenge_version: number;
      rule_version: string;
      active: number;
      created_at: string;
    }>[];
    deletePolicies.run(row.id, row.receipt_sha256);
    const update = updateReceipt.run(
      nextHash,
      JSON.stringify(next),
      row.id,
      row.receipt_sha256,
    );
    if (update.changes !== 1)
      throw new CompetitivePolicyRepositoryError(
        "competitive_policy_persisted_data_corrupt",
      );
    const persisted = receiptForId.get(row.id) as V15ReceiptRow | undefined;
    if (!persisted)
      throw new CompetitivePolicyRepositoryError(
        "competitive_policy_persisted_data_corrupt",
      );
    parseStrictV15ReceiptRow(persisted);
    for (const policy of policies)
      insertPolicy.run(
        policy.id,
        policy.receipt_id,
        nextHash,
        policy.receipt_schema_version,
        policy.workspace_id,
        policy.model_bundle_id,
        policy.workflow_id,
        policy.workflow_version,
        policy.provider_version,
        policy.calibration_evidence_version,
        policy.extraction_evidence_version,
        policy.observation_evidence_version,
        policy.challenge_id,
        policy.challenge_version,
        policy.rule_version,
        policy.active,
        policy.created_at,
      );
  }
}

type V15ReceiptRow = Readonly<{
  id: string;
  receipt_sha256: string;
  schema_version: string;
  model_bundle_id: string;
  workflow_id: string;
  workflow_version: string;
  provider_version: string;
  status: string;
  run_at: string;
  valid_until: string;
  invalidated_at: string | null;
  receipt_json: string;
}>;

/**
 * v15 admits exactly two shapes: a current receipt or v14's one missing
 * evidence object. Both must correlate to every durable identity before any
 * new receipt or policy value is committed.
 */
function parseV14ReceiptValue(row: V15ReceiptRow):
  | Readonly<{ kind: "current" }>
  | Readonly<{
      kind: "legacy";
      next: ReturnType<typeof WorkflowBenchmarkReceiptSchema.parse>;
      nextHash: string;
    }> {
  let value: Record<string, unknown>;
  try {
    const parsed = JSON.parse(row.receipt_json);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("invalid receipt");
    value = parsed as Record<string, unknown>;
  } catch {
    throw new CompetitivePolicyRepositoryError(
      "competitive_policy_persisted_data_corrupt",
    );
  }
  if ("evidence" in value) return Object.freeze({ kind: "current" as const });

  const oldHash = value.receiptSha256;
  const oldPayload = { ...value };
  delete oldPayload.receiptSha256;
  if (
    typeof oldHash !== "string" ||
    oldHash !== row.receipt_sha256 ||
    workflowBenchmarkReceiptDigest(oldPayload as never) !== oldHash
  )
    throw new CompetitivePolicyRepositoryError(
      "competitive_policy_persisted_data_corrupt",
    );
  const nextPayload = {
    ...oldPayload,
    evidence: {
      calibrationEvidenceVersion: "wall-pass-calibration-evidence-v1",
      extractionEvidenceVersion: "c5-frame-manifest-v1",
      observationEvidenceVersion: "wall-pass-geometry-evidence-v1",
    },
  };
  const nextHash = workflowBenchmarkReceiptDigest(nextPayload as never);
  let next: ReturnType<typeof WorkflowBenchmarkReceiptSchema.parse>;
  try {
    next = WorkflowBenchmarkReceiptSchema.parse({
      ...nextPayload,
      receiptSha256: nextHash,
    });
    // Verify the post-v15 document against every row field before writing it.
    // `nextHash` is the deterministic successor of the verified old digest.
    parseStrictV15ReceiptRow({
      ...row,
      receipt_sha256: nextHash,
      receipt_json: JSON.stringify(next),
    });
  } catch (error) {
    if (error instanceof CompetitivePolicyRepositoryError) throw error;
    throw new CompetitivePolicyRepositoryError(
      "competitive_policy_persisted_data_corrupt",
    );
  }
  return Object.freeze({ kind: "legacy" as const, next, nextHash });
}

function parseStrictV15ReceiptRow(row: V15ReceiptRow) {
  return parseStoredBenchmarkReceipt({
    id: row.id,
    receiptSha256: row.receipt_sha256,
    schemaVersion: row.schema_version,
    modelBundleId: row.model_bundle_id,
    workflowId: row.workflow_id,
    workflowVersion: row.workflow_version,
    providerVersion: row.provider_version,
    status: row.status,
    runAt: row.run_at,
    validUntil: row.valid_until,
    invalidatedAt: row.invalidated_at,
    receiptJson: row.receipt_json,
  });
}

function canonicalizeStoredMediaV13Value(value: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("invalid legacy C5 media record");
  }
  if (!isPlainRecord(parsed)) throw new Error("invalid legacy C5 media record");
  const keys = Object.keys(parsed).sort();
  const exact = (...expected: readonly string[]): boolean =>
    keys.length === expected.length &&
    keys.every((key, index) => key === [...expected].sort()[index]);

  // Canonical C5 attachment and two persisted v11 predecessor forms are the
  // complete, explicit upgrade vocabulary. All routes yield the same strict
  // projection; unknown five-field JSON fails within the migration transaction.
  if (
    exact(
      "id",
      "contentType",
      "bytes",
      "uploadedAt",
      "deleteAt",
      "transition",
    ) ||
    exact(
      "id",
      "contentType",
      "bytes",
      "uploadedAt",
      "deleteAt",
      "transitionResourceId",
    ) ||
    exact(
      "id",
      "contentType",
      "bytes",
      "uploadedAt",
      "deleteAt",
      "sha256",
      "probe",
      "manifest",
      "transition",
    )
  )
    return canonicalizeStoredMediaV12(value);

  throw new Error("invalid legacy C5 media record");
}

function canonicalizeLegacyMedia(value: string): string {
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("invalid legacy C5 media record");
    const media = parsed as Record<string, unknown>;
    const exactLegacy = hasExactObjectKeys(media, [
      "id",
      "contentType",
      "bytes",
      "deleteAt",
    ]);
    const isNamedV11Predecessor =
      hasExactObjectKeys(media, [
        "id",
        "contentType",
        "bytes",
        "uploadedAt",
        "deleteAt",
        "transition",
      ]) ||
      hasExactObjectKeys(media, [
        "id",
        "contentType",
        "bytes",
        "uploadedAt",
        "deleteAt",
        "transitionResourceId",
      ]) ||
      hasExactObjectKeys(media, [
        "id",
        "contentType",
        "bytes",
        "uploadedAt",
        "deleteAt",
        "sha256",
        "probe",
        "manifest",
        "transition",
      ]);
    if (isNamedV11Predecessor) return value;
    if (!exactLegacy) throw new Error("invalid legacy C5 media record");
    if (
      typeof media.id !== "string" ||
      media.id.length === 0 ||
      typeof media.contentType !== "string" ||
      media.contentType.length === 0 ||
      typeof media.bytes !== "number" ||
      !Number.isSafeInteger(media.bytes) ||
      media.bytes < 0 ||
      typeof media.deleteAt !== "string" ||
      !isCanonicalIso(media.deleteAt)
    )
      throw new Error("invalid legacy C5 media record");
    const deleteAt = Date.parse(media.deleteAt);
    if (!Number.isFinite(deleteAt))
      throw new Error("invalid legacy C5 media record");
    const uploadedAt = new Date(deleteAt - 23 * 60 * 60 * 1000).toISOString();
    return canonicalJson({
      ...media,
      uploadedAt,
      transition: {
        kind: "upload-transition",
        resourceId: media.id,
        deleteAt: new Date(
          Date.parse(uploadedAt) + 60 * 60 * 1000,
        ).toISOString(),
      },
    });
  } catch (error) {
    if (error instanceof Error) throw error;
    throw new Error("invalid legacy C5 media record");
  }
}

/** Strictly recognizes only C5's valid predecessor attachment contracts. */
function canonicalizeStoredMediaV12(value: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("invalid legacy C5 media record");
  }
  if (!isPlainRecord(parsed)) throw new Error("invalid legacy C5 media record");
  const media = parsed;
  const isNamedV12Predecessor =
    hasExactObjectKeys(media, [
      "id",
      "contentType",
      "bytes",
      "uploadedAt",
      "deleteAt",
      "transition",
    ]) ||
    hasExactObjectKeys(media, [
      "id",
      "contentType",
      "bytes",
      "uploadedAt",
      "deleteAt",
      "transitionResourceId",
    ]) ||
    hasExactObjectKeys(media, [
      "id",
      "contentType",
      "bytes",
      "uploadedAt",
      "deleteAt",
      "sha256",
      "probe",
      "manifest",
      "transition",
    ]);
  if (!isNamedV12Predecessor) throw new Error("invalid legacy C5 media record");
  if (
    typeof media.id !== "string" ||
    media.id.length === 0 ||
    typeof media.contentType !== "string" ||
    media.contentType.length === 0 ||
    typeof media.bytes !== "number" ||
    !Number.isSafeInteger(media.bytes) ||
    media.bytes < 0 ||
    typeof media.deleteAt !== "string" ||
    !isCanonicalIso(media.deleteAt)
  )
    throw new Error("invalid legacy C5 media record");

  const uploadedAt =
    typeof media.uploadedAt === "string"
      ? media.uploadedAt
      : new Date(
          Date.parse(media.deleteAt) - 23 * 60 * 60 * 1000,
        ).toISOString();
  if (
    !isCanonicalIso(uploadedAt) ||
    media.deleteAt !==
      new Date(Date.parse(uploadedAt) + 23 * 60 * 60 * 1000).toISOString()
  )
    throw new Error("invalid legacy C5 media record");

  const richKeys = ["sha256", "probe", "manifest"] as const;
  const richCount = richKeys.filter((key) => key in media).length;
  if (
    richCount !== 0 &&
    (richCount !== richKeys.length ||
      typeof media.sha256 !== "string" ||
      !isPlainRecord(media.probe) ||
      !isPlainRecord(media.manifest))
  )
    throw new Error("invalid legacy C5 media record");

  const transitionDeleteAt = new Date(
    Date.parse(uploadedAt) + 60 * 60 * 1000,
  ).toISOString();
  if ("transition" in media) {
    if (
      !isPlainRecord(media.transition) ||
      !hasExactObjectKeys(media.transition, [
        "kind",
        "resourceId",
        "deleteAt",
      ]) ||
      media.transition.kind !== "upload-transition" ||
      media.transition.resourceId !== media.id ||
      media.transition.deleteAt !== transitionDeleteAt
    )
      throw new Error("invalid legacy C5 media record");
  }
  if (
    "transitionResourceId" in media &&
    media.transitionResourceId !== media.id
  )
    throw new Error("invalid legacy C5 media record");

  return canonicalJson({
    id: media.id,
    contentType: media.contentType,
    bytes: media.bytes,
    uploadedAt,
    deleteAt: media.deleteAt,
    transition: {
      kind: "upload-transition",
      resourceId: media.id,
      deleteAt: transitionDeleteAt,
    },
  });
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactObjectKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function isCanonicalIso(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(Date.parse(value)).toISOString() === value
  );
}

/** SQLite equivalent of the repository's exact six-field media contract. */
function invalidC5MediaSql(column: string): string {
  return invalidC5MediaSqlWithTransitionKeys(column, true);
}

/** Historical v12 trigger shape, retained only for real upgrade fixtures. */
function invalidC5MediaV12Sql(column: string): string {
  return invalidC5MediaSqlWithTransitionKeys(column, false);
}

function invalidC5MediaSqlWithTransitionKeys(
  column: string,
  requireExactTransitionKeys: boolean,
): string {
  return `
    CASE
    WHEN json_valid(${column}) = 0 THEN 1
    WHEN (
      (SELECT COUNT(*) FROM json_each(${column})) != 6
      OR EXISTS (
        SELECT 1 FROM json_each(${column})
        WHERE key NOT IN ('id', 'contentType', 'bytes', 'uploadedAt', 'deleteAt', 'transition')
      )
      OR json_type(${column}, '$.id') IS NOT 'text'
      OR length(json_extract(${column}, '$.id')) = 0
      OR json_type(${column}, '$.contentType') IS NOT 'text'
      OR length(json_extract(${column}, '$.contentType')) = 0
      OR json_type(${column}, '$.bytes') IS NOT 'integer'
      OR json_extract(${column}, '$.bytes') < 0
      OR json_extract(${column}, '$.bytes') > 9007199254740991
      OR json_type(${column}, '$.uploadedAt') IS NOT 'text'
      OR json_type(${column}, '$.deleteAt') IS NOT 'text'
      OR json_type(${column}, '$.transition') IS NOT 'object'
      ${
        requireExactTransitionKeys
          ? `OR (SELECT COUNT(*) FROM json_each(${column}, '$.transition')) != 3
      OR EXISTS (
        SELECT 1 FROM json_each(${column}, '$.transition')
        WHERE key NOT IN ('kind', 'resourceId', 'deleteAt')
      )`
          : ""
      }
      OR json_extract(${column}, '$.transition.kind') IS NOT 'upload-transition'
      OR json_type(${column}, '$.transition.resourceId') IS NOT 'text'
      OR json_type(${column}, '$.transition.deleteAt') IS NOT 'text'
      OR json_extract(${column}, '$.transition.resourceId') IS NOT json_extract(${column}, '$.id')
      OR strftime('%Y-%m-%dT%H:%M:%fZ', json_extract(${column}, '$.uploadedAt')) IS NOT json_extract(${column}, '$.uploadedAt')
      OR strftime('%Y-%m-%dT%H:%M:%fZ', json_extract(${column}, '$.deleteAt')) IS NOT json_extract(${column}, '$.deleteAt')
      OR strftime('%Y-%m-%dT%H:%M:%fZ', json_extract(${column}, '$.transition.deleteAt')) IS NOT json_extract(${column}, '$.transition.deleteAt')
      OR substr(json_extract(${column}, '$.uploadedAt'), 12, 2) = '24'
      OR substr(json_extract(${column}, '$.deleteAt'), 12, 2) = '24'
      OR substr(json_extract(${column}, '$.transition.deleteAt'), 12, 2) = '24'
      OR strftime('%Y-%m-%dT%H:%M:%fZ', json_extract(${column}, '$.uploadedAt'), '+23 hours') IS NOT json_extract(${column}, '$.deleteAt')
      OR strftime('%Y-%m-%dT%H:%M:%fZ', json_extract(${column}, '$.uploadedAt'), '+1 hour') IS NOT json_extract(${column}, '$.transition.deleteAt')
    ) THEN 1
    ELSE 0
    END = 1
  `;
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
