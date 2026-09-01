import {
  isFactoryIssuedSqliteDatabase,
  resolveFactoryIssuedSqliteDatabaseCompositionToken,
  type SqliteDatabase,
  type SqliteDatabaseCompositionToken,
} from "../database/sqlite-database.js";
import { reconcileMediaDeliveryCleanup } from "../repositories/media-delivery-recovery-sql.js";
import type {
  RetentionRecord,
  RetentionRepository,
} from "./retention-scavenger.js";
import type { RetentionScheduleResult } from "../storage/local-media-storage.js";

type RetentionRow = Readonly<{
  id: string;
  attempt_id: string;
  kind: RetentionRecord["kind"];
  delete_at: string;
  cleanup_requested_at: string | null;
}>;

type ProductionSQLiteRetentionUploadPort = Readonly<{
  token: SqliteDatabaseCompositionToken;
  isCurrent(): boolean;
  schedule: SQLiteRetentionRepository["schedule"];
  listDue: SQLiteRetentionRepository["listDue"];
  acknowledge: SQLiteRetentionRepository["acknowledge"];
}>;

const productionSQLiteRetentionUploadPorts = new WeakMap<
  object,
  ProductionSQLiteRetentionUploadPort
>();

/** Resolves only the immutable production upload facade for this exact C5 adapter. */
export function resolveProductionSQLiteRetentionUploadPort(
  repository: unknown,
): ProductionSQLiteRetentionUploadPort | undefined {
  if (typeof repository !== "object" || repository === null) return undefined;
  return productionSQLiteRetentionUploadPorts.get(repository);
}

/** SQLite adapter contains only opaque retention identifiers, never local paths. */
export class SQLiteRetentionRepository implements RetentionRepository {
  readonly #raw;

  public constructor(input: Readonly<{ database: SqliteDatabase }>) {
    if (!isFactoryIssuedSqliteDatabase(input.database))
      throw new Error(
        "Retention requires a factory-issued SQLite database capability.",
      );
    this.#raw = input.database.raw;
    const token = resolveFactoryIssuedSqliteDatabaseCompositionToken(
      input.database,
    );
    if (!token)
      throw new Error(
        "Retention factory database composition token is required.",
      );
    registerProductionSQLiteRetentionUploadPort(this, token);
  }

  public async schedule(
    input: Readonly<{
      id: string;
      attemptId: string;
      kind: "frame" | "temporary" | "observation";
      deleteAt: string;
    }>,
  ): Promise<RetentionScheduleResult> {
    assertIdentifier(input.id);
    assertIdentifier(input.attemptId);
    assertTimestamp(input.deleteAt);
    return this.#transaction(() => {
      const existing = this.#raw
        .prepare(
          "SELECT attempt_id, resource_kind, delete_at FROM retention_cleanup_records WHERE resource_id = ?",
        )
        .get(input.id) as
        | Readonly<{
            attempt_id: string;
            resource_kind: string;
            delete_at: string;
          }>
        | undefined;
      if (existing) {
        return Object.freeze({
          kind:
            existing.attempt_id === input.attemptId &&
            existing.resource_kind === input.kind &&
            existing.delete_at === input.deleteAt
              ? "existing-owned"
              : "conflict",
        });
      }
      this.#raw
        .prepare(
          "INSERT INTO retention_cleanup_records (resource_id, attempt_id, resource_kind, delete_at, created_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run(
          input.id,
          input.attemptId,
          input.kind,
          input.deleteAt,
          input.deleteAt,
        );
      return Object.freeze({ kind: "created" });
    });
  }

  public async requestAttemptCleanup(
    input: Readonly<{ attemptId: string; requestedAt: string }>,
  ): Promise<void> {
    assertIdentifier(input.attemptId);
    assertTimestamp(input.requestedAt);
    this.#transaction(() => {
      this.#raw
        .prepare(
          "UPDATE media_retention_records SET cleanup_requested_at = ? WHERE attempt_id = ?",
        )
        .run(input.requestedAt, input.attemptId);
      this.#raw
        .prepare(
          "UPDATE retention_cleanup_records SET cleanup_requested_at = ? WHERE attempt_id = ?",
        )
        .run(input.requestedAt, input.attemptId);
    });
  }

  public async listDue(
    input: Readonly<{ now: string; limit: number }>,
  ): Promise<readonly RetentionRecord[]> {
    assertTimestamp(input.now);
    if (!Number.isSafeInteger(input.limit) || input.limit < 1)
      throw new Error("Invalid retention batch limit.");
    const rows = this.#raw
      .prepare(
        `SELECT id, attempt_id, kind, delete_at, cleanup_requested_at
           FROM (
             SELECT media_id AS id, attempt_id, 'original' AS kind, delete_at, cleanup_requested_at
             FROM media_retention_records
             UNION ALL
             SELECT resource_id AS id, attempt_id, resource_kind AS kind, delete_at, cleanup_requested_at
             FROM retention_cleanup_records
           )
           WHERE cleanup_requested_at IS NOT NULL OR delete_at <= ?
           ORDER BY CASE WHEN cleanup_requested_at IS NULL THEN delete_at ELSE cleanup_requested_at END ASC,
                    id ASC
           LIMIT ?`,
      )
      .all(input.now, input.limit);
    return Object.freeze(rows.map(parseRetentionRow));
  }

  public async acknowledge(record: RetentionRecord): Promise<void> {
    this.#transaction(() => {
      if (record.kind === "original") {
        this.#raw
          .prepare(
            "DELETE FROM media_retention_records WHERE media_id = ? AND attempt_id = ?",
          )
          .run(record.id, record.attemptId);
        reconcileMediaDeliveryCleanup(this.#raw, {
          attemptId: record.attemptId,
          now: new Date().toISOString(),
        });
        return;
      }
      if (record.kind === "observation") {
        // The observation is canonical database data, so physical deletion and
        // acknowledgement share one transaction: a cleanup fact can never be
        // removed while its observation still exists.
        this.#raw
          .prepare(
            "DELETE FROM canonical_observations WHERE id = ? AND attempt_id = ?",
          )
          .run(record.id, record.attemptId);
      }
      this.#raw
        .prepare(
          "DELETE FROM retention_cleanup_records WHERE resource_id = ? AND attempt_id = ?",
        )
        .run(record.id, record.attemptId);
      reconcileMediaDeliveryCleanup(this.#raw, {
        attemptId: record.attemptId,
        now: new Date().toISOString(),
      });
    });
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
}

const exactSchedule = SQLiteRetentionRepository.prototype.schedule;
const exactListDue = SQLiteRetentionRepository.prototype.listDue;
const exactAcknowledge = SQLiteRetentionRepository.prototype.acknowledge;

function registerProductionSQLiteRetentionUploadPort(
  repository: SQLiteRetentionRepository,
  token: SqliteDatabaseCompositionToken,
): void {
  if (!isCurrentProductionSQLiteRetentionRepository(repository)) return;
  productionSQLiteRetentionUploadPorts.set(
    repository,
    Object.freeze({
      token,
      isCurrent: () => isCurrentProductionSQLiteRetentionRepository(repository),
      schedule: (input) => exactSchedule.call(repository, input),
      listDue: (input) => exactListDue.call(repository, input),
      acknowledge: (record) => exactAcknowledge.call(repository, record),
    }),
  );
}

function isCurrentProductionSQLiteRetentionRepository(
  repository: SQLiteRetentionRepository,
): boolean {
  return (
    Object.getPrototypeOf(repository) === SQLiteRetentionRepository.prototype &&
    !Object.hasOwn(repository, "schedule") &&
    !Object.hasOwn(repository, "listDue") &&
    !Object.hasOwn(repository, "acknowledge") &&
    hasExactProductionRetentionMethod("schedule", exactSchedule) &&
    hasExactProductionRetentionMethod("listDue", exactListDue) &&
    hasExactProductionRetentionMethod("acknowledge", exactAcknowledge)
  );
}

/** Descriptor inspection never invokes a hostile accessor installed later. */
function hasExactProductionRetentionMethod(
  name: "schedule" | "listDue" | "acknowledge",
  expected: unknown,
): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(
    SQLiteRetentionRepository.prototype,
    name,
  );
  return (
    descriptor !== undefined &&
    descriptor.value === expected &&
    !descriptor.get &&
    !descriptor.set
  );
}

function parseRetentionRow(value: unknown): RetentionRecord {
  if (!isRecord(value)) throw new Error("Invalid persisted retention record.");
  const row: RetentionRow = {
    id: readString(value.id),
    attempt_id: readString(value.attempt_id),
    kind: readKind(value.kind),
    delete_at: readString(value.delete_at),
    cleanup_requested_at:
      value.cleanup_requested_at === null
        ? null
        : readString(value.cleanup_requested_at),
  };
  assertIdentifier(row.id);
  assertIdentifier(row.attempt_id);
  assertTimestamp(row.delete_at);
  if (row.cleanup_requested_at !== null)
    assertTimestamp(row.cleanup_requested_at);
  if (
    !(["original", "frame", "temporary", "observation"] as const).includes(
      row.kind,
    )
  )
    throw new Error("Invalid persisted retention record.");
  return Object.freeze({
    id: row.id,
    attemptId: row.attempt_id,
    kind: row.kind,
    deleteAt: row.delete_at,
    cleanupRequestedAt: row.cleanup_requested_at,
  });
}

function readKind(value: unknown): RetentionRecord["kind"] {
  if (
    value !== "original" &&
    value !== "frame" &&
    value !== "temporary" &&
    value !== "observation"
  )
    throw new Error("Invalid persisted retention record.");
  return value;
}

function readString(value: unknown): string {
  if (typeof value !== "string")
    throw new Error("Invalid persisted retention record.");
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertIdentifier(value: string): void {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  )
    throw new Error("Invalid retention identifier.");
}

function assertTimestamp(value: string): void {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value))
    throw new Error("Invalid retention timestamp.");
}
