import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { Worker } from "node:worker_threads";
import Database from "better-sqlite3";
import {
  failedWorkflowBenchmarkReceiptFixture,
  FailureMessageByCode,
  passingWorkflowBenchmarkReceiptFixture,
  staleWorkflowBenchmarkReceiptFixture,
  workflowBenchmarkReceiptDigest,
} from "@revelai/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  openSqliteDatabase,
  openSqliteDatabaseAtVersionForTest,
  type SqliteDatabase,
} from "../database/sqlite-database.js";
import {
  InMemoryAnalysisQueue,
  type QueueScheduler,
} from "../queue/in-memory-analysis-queue.js";
import {
  AnalysisWorker,
  ExpectedProcessingFailure,
  RetryableProcessingFailure,
} from "../workers/analysis-worker.js";
import {
  C5_TEST_SOURCE_SHA256,
  createC5PipelineTestSupport,
} from "../media/c5-pipeline-test-support.js";
import {
  SQLiteAttemptRepository,
  createAttemptCursorCodec,
  createLiveLeaderboardCursorCodec,
  type Clock,
  type IdGenerator,
} from "./sqlite-attempt-repository.js";
import {
  createStoredMediaAttachment,
  type StoredMedia,
  type TerminalCandidate,
} from "./attempt-repository.js";
import { createAttemptApi } from "../http/attempt-api.js";
import {
  issueRankedPolicyFinalization,
  resolveProductionSQLiteCompetitivePolicyLookupPort,
  SQLiteCompetitivePolicyRepository,
} from "./sqlite-competitive-policy-repository.js";

const ATHLETE_A = "11111111-1111-4111-8111-111111111111";
const ATHLETE_B = "22222222-2222-4222-8222-222222222222";
const ATHLETE_C = "33333333-3333-4333-8333-333333333333";
const ATTEMPT_A = "33333333-3333-4333-8333-333333333333";
const ATTEMPT_B = "44444444-4444-4444-8444-444444444444";
const ATTEMPT_C = "55555555-5555-4555-8555-555555555555";
const SESSION_A = "66666666-6666-4666-8666-666666666666";
const SESSION_B = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const SESSION_C = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const LEASE_A = "77777777-7777-4777-8777-777777777777";
const LEASE_B = "88888888-8888-4888-8888-888888888888";
const ENTRY_A = "99999999-9999-4999-8999-999999999999";
const ENTRY_B = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const migrationChildStartupTimeoutMs = 4_000;
const migrationChildTerminationGraceMs = 250;
const migrationStartupRounds = 3;
const migrationStartupSourceCount = 2;
const migrationStartupVerificationGraceMs = 2_000;
const migrationStartupTestTimeoutMs =
  migrationStartupSourceCount *
    migrationStartupRounds *
    (migrationChildStartupTimeoutMs + migrationChildTerminationGraceMs) +
  migrationStartupVerificationGraceMs;
const migrationChildStartupTimeoutError = "Database child startup timed out";
const migrationChildReadyMarker = "REVELAI_CHILD_DATABASE_READY";

class TestClock implements Clock {
  public current = "2030-01-15T12:00:00.000Z";

  public now(): string {
    return this.current;
  }

  public advance(milliseconds: number): void {
    this.current = new Date(
      Date.parse(this.current) + milliseconds,
    ).toISOString();
  }
}

class TestIds implements IdGenerator {
  private readonly ids: string[];

  public constructor(...ids: string[]) {
    this.ids = ids;
  }

  public next(): string {
    const id = this.ids.shift();
    if (!id) throw new Error("Test ran out of identifiers");
    return id;
  }
}

class ManualScheduler implements QueueScheduler {
  public readonly tasks: Array<() => Promise<void>> = [];

  public schedule(task: () => Promise<void>): void {
    this.tasks.push(task);
  }

  public async runAll(): Promise<void> {
    while (this.tasks.length > 0) await this.tasks.shift()!();
  }
}

type RepositoryActorInput = Readonly<{
  filename: string;
  now: string;
  ids: readonly string[];
  delayMilliseconds: number;
  holdAtBegin?: SharedArrayBuffer;
  action:
    | "finalize"
    | "finalize-with-current-policy"
    | "deactivate-policy"
    | "tombstone"
    | "create-verified";
  input: unknown;
}>;

type RepositoryActorResult = Readonly<{
  value?: unknown;
  error?: Readonly<{ code?: string; message: string }>;
}>;

function startRepositoryActor(input: RepositoryActorInput): Readonly<{
  ready: Promise<void>;
  attempting: Promise<void>;
  acquired: Promise<void>;
  done: Promise<RepositoryActorResult>;
  start(): void;
}> {
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  let resolveAttempting!: () => void;
  let rejectAttempting!: (error: Error) => void;
  let resolveAcquired!: () => void;
  let rejectAcquired!: (error: Error) => void;
  let resolveDone!: (result: RepositoryActorResult) => void;
  let rejectDone!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const attempting = new Promise<void>((resolve, reject) => {
    resolveAttempting = resolve;
    rejectAttempting = reject;
  });
  const acquired = new Promise<void>((resolve, reject) => {
    resolveAcquired = resolve;
    rejectAcquired = reject;
  });
  const done = new Promise<RepositoryActorResult>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });
  const worker = new Worker(
    `
      const fs = require("node:fs");
      const Module = require("node:module");
      const ts = require("typescript");
      const { parentPort, workerData } = require("node:worker_threads");
      const originalResolveFilename = Module._resolveFilename;
      Module._resolveFilename = function (request, parent, isMain, options) {
        if (request === "@revelai/contracts") return workerData.contractsModule;
        if (request === "@revelai/domain") return workerData.domainModule;
        try {
          return originalResolveFilename.call(this, request, parent, isMain, options);
        } catch (error) {
          if (typeof request === "string" && request.startsWith(".") && request.endsWith(".js")) {
            return originalResolveFilename.call(this, request.slice(0, -3) + ".ts", parent, isMain, options);
          }
          throw error;
        }
      };
      require.extensions[".ts"] = function (module, filename) {
        const output = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
          compilerOptions: {
            target: ts.ScriptTarget.ES2022,
            module: ts.ModuleKind.CommonJS,
            moduleResolution: ts.ModuleResolutionKind.NodeNext,
            esModuleInterop: true,
          },
          fileName: filename,
        }).outputText;
        module._compile(output, filename);
      };
      const { openSqliteDatabase } = require(workerData.databaseModule);
      const { SQLiteAttemptRepository } = require(workerData.repositoryModule);
      const {
        issueRankedPolicyFinalization,
        SQLiteCompetitivePolicyRepository,
        resolveProductionSQLiteCompetitivePolicyLookupPort,
      } = require(workerData.policyModule);
      class ActorClock { now() { return workerData.now; } }
      class ActorIds {
        constructor(ids) { this.ids = [...ids]; }
        next() {
          const id = this.ids.shift();
          if (!id) throw new Error("Repository actor ran out of identifiers");
          return id;
        }
      }
      const database = openSqliteDatabase(workerData.filename);
      const repository = SQLiteAttemptRepository.forReadOnlyTest({
        database,
        clock: new ActorClock(),
        ids: new ActorIds(workerData.ids),
      });
      const originalExec = database.raw.exec.bind(database.raw);
      const holdAtBegin = workerData.holdAtBegin
        ? new Int32Array(workerData.holdAtBegin)
        : null;
      database.raw.exec = (sql) => {
        if (sql !== "BEGIN IMMEDIATE") return originalExec(sql);
        parentPort.postMessage({ type: "attempting" });
        const result = originalExec(sql);
        if (holdAtBegin) {
          parentPort.postMessage({ type: "acquired" });
          Atomics.wait(holdAtBegin, 0, 0, 5_000);
        }
        return result;
      };
      parentPort.postMessage({ type: "ready" });
      parentPort.once("message", async (message) => {
        if (message.type !== "start") return;
        try {
          if (workerData.delayMilliseconds > 0)
            await new Promise((resolve) => setTimeout(resolve, workerData.delayMilliseconds));
          let value;
          if (workerData.action === "finalize")
            value = await repository.finalizeTerminalResult(workerData.input);
          else if (workerData.action === "finalize-with-current-policy") {
            const policy = new SQLiteCompetitivePolicyRepository({
              database,
              clock: new ActorClock(),
            });
            const port = resolveProductionSQLiteCompetitivePolicyLookupPort(policy);
            if (!port) throw new Error("Repository actor has no policy port");
            const { activation, ...finalizationInput } = workerData.input;
            value = await repository.finalizeTerminalResult({
              ...finalizationInput,
              rankedPolicy: activation
                ? issueRankedPolicyFinalization(port.finalization, activation)
                : undefined,
            });
          } else if (workerData.action === "deactivate-policy") {
            const policy = new SQLiteCompetitivePolicyRepository({
              database,
              clock: new ActorClock(),
            });
            value = await policy.deactivateCompetitivePolicy(workerData.input);
          }
          else if (workerData.action === "tombstone")
            value = await repository.tombstoneAttempt(workerData.input);
          else
            value = await repository.createAttempt(workerData.input);
          database.close();
          parentPort.postMessage({ type: "done", value });
        } catch (error) {
          database.close();
          parentPort.postMessage({
            type: "done",
            error: {
              code: error && typeof error === "object" ? error.code : undefined,
              message: error instanceof Error ? error.message : String(error),
            },
          });
        }
      });
    `,
    {
      eval: true,
      workerData: {
        ...input,
        databaseModule: join(process.cwd(), "src/database/sqlite-database.ts"),
        repositoryModule: join(
          process.cwd(),
          "src/repositories/sqlite-attempt-repository.ts",
        ),
        policyModule: join(
          process.cwd(),
          "src/repositories/sqlite-competitive-policy-repository.ts",
        ),
        contractsModule: join(
          process.cwd(),
          "../../packages/contracts/src/index.ts",
        ),
        domainModule: join(process.cwd(), "../../packages/domain/src/index.ts"),
      },
    },
  );
  worker.on("message", (message: unknown) => {
    const value = message as {
      type?: string;
      value?: unknown;
      error?: Readonly<{ code?: string; message: string }>;
    };
    if (value.type === "ready") resolveReady();
    if (value.type === "attempting") resolveAttempting();
    if (value.type === "acquired") resolveAcquired();
    if (value.type === "done") {
      resolveDone({ value: value.value, error: value.error });
      void worker.terminate();
    }
  });
  worker.on("error", (error) => {
    rejectReady(error);
    rejectAttempting(error);
    rejectAcquired(error);
    rejectDone(error);
    void worker.terminate();
  });
  return Object.freeze({
    ready,
    attempting,
    acquired,
    done,
    start: () => worker.postMessage({ type: "start" }),
  });
}

function startSqliteLockBarrier(
  input: Readonly<{
    filename: string;
    holdMilliseconds?: number;
  }>,
): Readonly<{ locked: Promise<void>; done: Promise<void> }> {
  let resolveLocked!: () => void;
  let resolveDone!: () => void;
  let reject!: (error: Error) => void;
  const locked = new Promise<void>((resolve) => {
    resolveLocked = resolve;
  });
  const done = new Promise<void>((resolve, rejectDone) => {
    resolveDone = resolve;
    reject = rejectDone;
  });
  const worker = new Worker(
    `
      const Database = require("better-sqlite3");
      const { parentPort, workerData } = require("node:worker_threads");
      const database = new Database(workerData.filename);
      database.pragma("foreign_keys = ON");
      database.exec("BEGIN IMMEDIATE");
      parentPort.postMessage({ type: "locked" });
      setTimeout(() => {
        try {
          database.exec("COMMIT");
          database.close();
          parentPort.postMessage({ type: "done" });
        } catch (error) {
          try { database.exec("ROLLBACK"); } catch {}
          database.close();
          parentPort.postMessage({ type: "error", message: String(error) });
        }
      }, workerData.holdMilliseconds ?? 150);
    `,
    { eval: true, workerData: input },
  );
  worker.on("message", (message: unknown) => {
    const value = message as { type?: string; message?: string };
    if (value.type === "locked") resolveLocked();
    if (value.type === "done") {
      resolveDone();
      void worker.terminate();
    }
    if (value.type === "error") {
      reject(new Error(value.message));
      void worker.terminate();
    }
  });
  worker.on("error", (error) => {
    reject(error);
    void worker.terminate();
  });
  return Object.freeze({ locked, done });
}

function freeOutcome(
  attemptId: string,
  completedAt: string,
): TerminalCandidate {
  return {
    state: "valid",
    result: {
      kind: "free-insight",
      attemptId,
      provenance: {
        kind: "demo",
        fixtureId: "free-well-framed-active-v1",
        providerVersion: "demo-observations-v1",
      },
      approximate: true,
      observations: [
        {
          kind: "athlete-visibility",
          unit: "percent",
          value: 90,
          range: "consistent",
        },
        {
          kind: "ball-visibility",
          unit: "percent",
          value: 90,
          range: "consistent",
        },
        {
          kind: "movement-activity",
          unit: "percent",
          value: 90,
          range: "high",
        },
      ],
      tips: ["Boa cobertura para uma análise aproximada."],
      generatedAt: completedAt,
    },
  };
}

function createV20TerminalPredecessor(
  filename: string,
  input: Readonly<{
    attemptId: string;
    outcome: TerminalCandidate;
    completedAt: string;
  }>,
) {
  if (input.outcome.state !== "valid")
    throw new Error("Expected a valid terminal predecessor outcome.");
  const database = openSqliteDatabaseAtVersionForTest(filename, 20);
  database.raw
    .prepare("INSERT INTO athletes (id, created_at) VALUES (?, ?)")
    .run(ATHLETE_A, input.completedAt);
  database.raw
    .prepare(
      "INSERT INTO attempts (id, athlete_id, mode, challenge_id, challenge_version, calibration_session_id, status, deletion_state, media_json, processing_generation, created_at, updated_at) VALUES (?, ?, 'free', NULL, NULL, NULL, 'processing', 'active', NULL, 1, ?, ?)",
    )
    .run(input.attemptId, ATHLETE_A, input.completedAt, input.completedAt);
  database.raw
    .prepare(
      "INSERT INTO terminal_results (id, attempt_id, lease_id, generation, terminal_state, outcome_json, candidate_json, completed_at, created_at) VALUES (?, ?, ?, 1, 'valid', ?, ?, ?, ?)",
    )
    .run(
      `terminal-${input.attemptId}`,
      input.attemptId,
      LEASE_A,
      JSON.stringify(input.outcome),
      JSON.stringify(input.outcome),
      input.completedAt,
      input.completedAt,
    );
  return database;
}

type MigrationHistoryFixtureRow = Readonly<{
  version: number | string;
  appliedAt: string;
}>;

function readMigrationHistoryRows(
  database: SqliteDatabase,
): readonly MigrationHistoryFixtureRow[] {
  return database.raw
    .prepare(
      "SELECT version, applied_at AS appliedAt FROM schema_migrations ORDER BY rowid ASC",
    )
    .all() as readonly MigrationHistoryFixtureRow[];
}

function replaceMigrationHistoryForTest(
  database: SqliteDatabase,
  rows: readonly MigrationHistoryFixtureRow[],
  schema = "CREATE TABLE schema_migrations (version NUMERIC NOT NULL, applied_at TEXT NOT NULL)",
): void {
  database.raw.exec("DROP TABLE schema_migrations");
  database.raw.exec(schema);
  const insert = database.raw.prepare(
    "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
  );
  for (const row of rows) insert.run(row.version, row.appliedAt);
}

function migrationHistoryStateForTest(database: SqliteDatabase): Readonly<{
  userVersion: unknown;
  rows: unknown;
}> {
  return Object.freeze({
    userVersion: database.raw.pragma("user_version", { simple: true }),
    rows: database.raw
      .prepare("SELECT rowid, * FROM schema_migrations ORDER BY rowid ASC")
      .all(),
  });
}

function missingLedgerStateForTest(database: SqliteDatabase): Readonly<{
  userVersion: unknown;
  schemaObject: unknown;
  athleteCount: unknown;
  attemptCount: unknown;
}> {
  return Object.freeze({
    userVersion: database.raw.pragma("user_version", { simple: true }),
    schemaObject: database.raw
      .prepare(
        "SELECT type, name, sql FROM sqlite_master WHERE name = 'schema_migrations'",
      )
      .all(),
    athleteCount: database.raw
      .prepare("SELECT COUNT(*) AS count FROM athletes")
      .get(),
    attemptCount: database.raw
      .prepare("SELECT COUNT(*) AS count FROM attempts")
      .get(),
  });
}

async function durableStartupStateForTest(filename: string): Promise<
  Readonly<{
    journalMode: unknown;
    userVersion: unknown;
    ledgerSchema: unknown;
    ledgerRows: unknown;
    fileBytes: Buffer;
  }>
> {
  const database = new Database(filename, { readonly: true });
  try {
    const state = Object.freeze({
      journalMode: database.pragma("journal_mode", { simple: true }),
      userVersion: database.pragma("user_version", { simple: true }),
      ledgerSchema: database
        .prepare(
          "SELECT type, name, sql FROM sqlite_master WHERE name = 'schema_migrations'",
        )
        .all(),
      ledgerRows: database
        .prepare(
          "SELECT rowid, version, applied_at FROM schema_migrations ORDER BY rowid ASC",
        )
        .all(),
      fileBytes: await readFile(filename),
    });
    return state;
  } finally {
    database.close();
  }
}

type DatabaseChildStartupOptions = Readonly<{
  forceHang?: boolean;
  onReady?: () => void;
  timeoutMs?: number;
}>;

function openDatabaseInChild(
  filename: string,
  options: DatabaseChildStartupOptions = {},
): Promise<Readonly<{ userVersion: unknown; migrationCount: unknown }>> {
  return new Promise((resolve, reject) => {
    const timeoutMs = options.timeoutMs ?? migrationChildStartupTimeoutMs;
    const child = spawn(
      process.execPath,
      [
        "-e",
        `
          const fs = require("node:fs");
          const Module = require("node:module");
          const ts = require("typescript");
          if (process.env.REVELAI_CHILD_FORCE_HANG === "1") {
            process.on("SIGTERM", () => undefined);
            process.stdout.write("REVELAI_CHILD_DATABASE_READY\\n");
            setInterval(() => undefined, 1_000);
          } else {
          const originalResolveFilename = Module._resolveFilename;
          Module._resolveFilename = function (request, parent, isMain, options) {
            if (request === "@revelai/contracts") return process.env.REVELAI_CHILD_CONTRACTS_MODULE;
            if (request === "@revelai/domain") return process.env.REVELAI_CHILD_DOMAIN_MODULE;
            try {
              return originalResolveFilename.call(this, request, parent, isMain, options);
            } catch (error) {
              if (typeof request === "string" && request.startsWith(".") && request.endsWith(".js")) {
                return originalResolveFilename.call(this, request.slice(0, -3) + ".ts", parent, isMain, options);
              }
              throw error;
            }
          };
          require.extensions[".ts"] = function (module, moduleFilename) {
            const output = ts.transpileModule(fs.readFileSync(moduleFilename, "utf8"), {
              compilerOptions: {
                target: ts.ScriptTarget.ES2022,
                module: ts.ModuleKind.CommonJS,
                moduleResolution: ts.ModuleResolutionKind.NodeNext,
                esModuleInterop: true,
              },
              fileName: moduleFilename,
            }).outputText;
            module._compile(output, moduleFilename);
          };
          try {
            const { openSqliteDatabase } = require(process.env.REVELAI_CHILD_DATABASE_MODULE);
            const database = openSqliteDatabase(process.env.REVELAI_CHILD_FILENAME);
            const result = {
              userVersion: database.raw.pragma("user_version", { simple: true }),
              migrationCount: database.raw.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get().count,
            };
            database.close();
            process.stdout.write(JSON.stringify(result));
          } catch (error) {
            process.stderr.write(error instanceof Error ? error.stack ?? error.message : String(error));
            process.exitCode = 1;
          }
          }
        `,
      ],
      {
        env: {
          ...process.env,
          REVELAI_CHILD_FILENAME: filename,
          REVELAI_CHILD_DATABASE_MODULE: join(
            process.cwd(),
            "src/database/sqlite-database.ts",
          ),
          REVELAI_CHILD_CONTRACTS_MODULE: join(
            process.cwd(),
            "../../packages/contracts/src/index.ts",
          ),
          REVELAI_CHILD_DOMAIN_MODULE: join(
            process.cwd(),
            "../../packages/domain/src/index.ts",
          ),
          ...(options.forceHang === true
            ? { REVELAI_CHILD_FORCE_HANG: "1" }
            : {}),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    let timedOut = false;
    let ready = false;
    let readinessOutput = "";
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(killTimer);
      callback();
    };
    const rejectTimeout = (signal: NodeJS.Signals | null = null) =>
      settle(() =>
        reject(
          Object.assign(new Error(migrationChildStartupTimeoutError), {
            signal,
          }),
        ),
      );

    child.stdout.on("data", (chunk: Buffer) => {
      stdout.push(chunk);
      if (ready || options.onReady === undefined) return;
      readinessOutput += chunk.toString("utf8");
      if (!readinessOutput.includes(migrationChildReadyMarker)) return;
      ready = true;
      options.onReady();
    });
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", (error) => {
      if (timedOut) rejectTimeout();
      else settle(() => reject(error));
    });
    child.once("close", (exitCode, signal) => {
      if (timedOut) {
        rejectTimeout(signal);
        return;
      }
      if (exitCode !== 0) {
        settle(() =>
          reject(
            new Error(
              `Database child exited ${exitCode}: ${Buffer.concat(stderr).toString("utf8")}`,
            ),
          ),
        );
        return;
      }
      try {
        settle(() =>
          resolve(
            JSON.parse(Buffer.concat(stdout).toString("utf8")) as Readonly<{
              userVersion: unknown;
              migrationCount: unknown;
            }>,
          ),
        );
      } catch (error) {
        settle(() => reject(error));
      }
    });
    timeout = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGTERM");
      } catch {
        rejectTimeout();
        return;
      }
      killTimer = setTimeout(() => {
        if (settled) return;
        try {
          child.kill("SIGKILL");
        } catch {
          rejectTimeout();
        }
      }, migrationChildTerminationGraceMs);
    }, timeoutMs);
  });
}

function rankedOutcome(
  attemptId: string,
  completedAt: string,
  score: number,
): TerminalCandidate {
  return {
    state: "valid",
    result: {
      kind: "verified-result",
      attemptId,
      challengeId: "wall-pass",
      challengeVersion: 1,
      ruleVersion: "wall-pass-v1-score-1",
      provenance: {
        kind: "roboflow",
        workspaceId: "revelai-workspace",
        workflowId: "revelai-wall-pass-geometry-v1",
        workflowVersion: "1.0.0",
        modelBundleId: "wall-pass-bundle-v1",
        providerVersion: "roboflow-inference-v1",
      },
      metrics: {
        validPasses: 20,
        accuracyPercent: 80,
        meanCadenceSeconds: 1.5,
        leftFootPercent: 50,
        rightFootPercent: 50,
      },
      score,
      completedAt,
      competitiveStatus: "ranked",
      competitiveEligible: true,
    },
  };
}

type PolicyReceiptFacts = Readonly<{
  id: string;
  receiptSha256: string;
  schemaVersion: "workflow-benchmark-receipt-v1";
  workflow: Readonly<{
    workspaceId: string;
    workflowId: "revelai-wall-pass-geometry-v1";
    workflowVersion: "1.0.0";
    modelBundleId: string;
    providerVersion: string;
  }>;
  evidence: Readonly<{
    calibrationEvidenceVersion: string;
    extractionEvidenceVersion: "c5-frame-manifest-v1";
    observationEvidenceVersion: "wall-pass-geometry-evidence-v1";
  }>;
}>;

function competitivePolicyActivation(receipt: PolicyReceiptFacts, id: string) {
  return {
    id,
    receiptId: receipt.id,
    receiptSha256: receipt.receiptSha256,
    receiptSchemaVersion: receipt.schemaVersion,
    workspaceId: receipt.workflow.workspaceId,
    modelBundleId: receipt.workflow.modelBundleId,
    workflowId: receipt.workflow.workflowId,
    workflowVersion: receipt.workflow.workflowVersion,
    providerVersion: receipt.workflow.providerVersion,
    calibrationEvidenceVersion: receipt.evidence.calibrationEvidenceVersion,
    extractionEvidenceVersion: receipt.evidence.extractionEvidenceVersion,
    observationEvidenceVersion: receipt.evidence.observationEvidenceVersion,
    challengeId: "wall-pass" as const,
    challengeVersion: 1 as const,
    ruleVersion: "wall-pass-v1-score-1" as const,
  };
}

function legacyRankedOutcome(
  attemptId: string,
  completedAt: string,
  score: number,
) {
  const candidate = rankedOutcome(attemptId, completedAt, score);
  if (
    candidate.state !== "valid" ||
    candidate.result.kind !== "verified-result" ||
    candidate.result.competitiveStatus !== "ranked"
  )
    throw new Error("Expected a ranked candidate fixture");
  return {
    state: "valid" as const,
    result: {
      ...candidate.result,
      rankingSnapshot: {
        kind: "frozen" as const,
        challengeId: "wall-pass" as const,
        challengeVersion: 1 as const,
        ruleVersion: "wall-pass-v1-score-1" as const,
        rank: 1,
        cohortSize: 1,
        percentile: 100,
        topPercent: 0,
        scoreCountAtFinalization: 1,
        asOfAttemptId: attemptId,
        calculatedAt: completedAt,
      },
    },
  };
}

function renewedReceipt() {
  const payload = {
    ...passingWorkflowBenchmarkReceiptFixture,
    id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    runAt: "2030-01-31T00:00:00.000Z",
    validUntil: "2030-03-02T00:00:00.000Z",
  };
  return {
    ...payload,
    receiptSha256: (() => {
      const { receiptSha256, ...receiptPayload } = payload;
      void receiptSha256;
      return workflowBenchmarkReceiptDigest(receiptPayload);
    })(),
  };
}

async function makeRepository(
  ids = new TestIds(LEASE_A, ENTRY_A, LEASE_B, ENTRY_B),
) {
  const directory = await mkdtemp(join(tmpdir(), "revelai-c4-"));
  const database = openSqliteDatabase(join(directory, "api.sqlite"));
  const secondaryDatabases: ReturnType<typeof openSqliteDatabase>[] = [];
  const clock = new TestClock();
  const c5 = createC5PipelineTestSupport({ root: join(directory, "c5") });
  const repository = new SQLiteAttemptRepository({
    database,
    clock,
    ids,
    handoffVerifier: c5.handoffVerifier,
  });
  const policy = new SQLiteCompetitivePolicyRepository({ database, clock });
  return {
    clock,
    c5,
    database,
    directory,
    ids,
    policy,
    repository,
    secondaryDatabases,
    openSecondaryDatabase: () => {
      const secondary = database.reopen();
      secondaryDatabases.push(secondary);
      return secondary;
    },
  };
}

/** C4 behavior probes attach the same durable C5 handoff every production upload carries. */
async function attachMedia(
  fixture: Awaited<ReturnType<typeof makeRepository>>,
  input: Readonly<{
    attemptId: string;
    athleteId: string;
    media: Readonly<{
      id: string;
      contentType: string;
      bytes: number;
      deleteAt: string;
    }>;
  }>,
) {
  const context = await fixture.repository.prepareMediaUpload({
    attemptId: input.attemptId,
    athleteId: input.athleteId,
  });
  const uploadedAt = context.uploadedAt;
  const transitionDeleteAt = new Date(
    Date.parse(uploadedAt) + 60 * 60 * 1000,
  ).toISOString();
  const media: StoredMedia = {
    ...input.media,
    uploadedAt,
    deleteAt: new Date(
      Date.parse(uploadedAt) + 23 * 60 * 60 * 1000,
    ).toISOString(),
    transition: {
      kind: "upload-transition",
      resourceId: input.media.id,
      deleteAt: transitionDeleteAt,
    },
  };
  fixture.database.raw
    .prepare(
      "INSERT INTO retention_cleanup_records (resource_id, attempt_id, resource_kind, delete_at, created_at) VALUES (?, ?, 'temporary', ?, ?)",
    )
    .run(media.id, input.attemptId, media.transition.deleteAt, uploadedAt);
  return fixture.repository.attachPreparedMedia({
    accepted: await fixture.c5.accept(
      context,
      createStoredMediaAttachment(media),
    ),
  });
}

async function claimVerifiedAttempt(
  fixture: Awaited<ReturnType<typeof makeRepository>>,
  input: Readonly<{
    attemptId: string;
    athleteId: string;
    sessionId: string;
    mediaId: string;
  }>,
) {
  await fixture.repository.issueCalibrationSession({
    id: input.sessionId,
    athleteId: input.athleteId,
    nonce: input.athleteId === ATHLETE_A ? "a".repeat(43) : "b".repeat(43),
    challengeId: "wall-pass",
    challengeVersion: 1,
  });
  await fixture.repository.readyCalibrationSession({
    id: input.sessionId,
    athleteId: input.athleteId,
    requiredGates: ["device", "space", "athlete", "rehearsal", "record"],
  });
  await fixture.repository.createAttempt({
    id: input.attemptId,
    athleteId: input.athleteId,
    input: {
      mode: "verified",
      challengeId: "wall-pass",
      challengeVersion: 1,
      calibrationSessionId: input.sessionId,
    },
  });
  const job = await attachMedia(fixture, {
    attemptId: input.attemptId,
    athleteId: input.athleteId,
    media: {
      id: input.mediaId,
      contentType: "video/mp4",
      bytes: 10,
      deleteAt: "2030-01-16T12:00:00.000Z",
    },
  });
  const claim = await fixture.repository.claimProcessing(job);
  if (!claim) throw new Error("Expected verified attempt claim");
  return claim;
}

async function activatePassingCompetitivePolicy(
  fixture: Awaited<ReturnType<typeof makeRepository>>,
  id = "abababab-abab-4bab-8bab-abababababab",
) {
  const policy = competitivePolicyActivation(
    passingWorkflowBenchmarkReceiptFixture,
    id,
  );
  await fixture.policy.storeBenchmarkReceipt(
    passingWorkflowBenchmarkReceiptFixture,
  );
  await fixture.policy.activateCompetitivePolicy(policy);
  const port = resolveProductionSQLiteCompetitivePolicyLookupPort(
    fixture.policy,
  );
  if (!port) throw new Error("Expected a factory-issued policy lookup port");
  const activation = await fixture.policy.getActiveCompetitivePolicy(policy);
  if (!activation) throw new Error("Expected an active competitive policy");
  const rankedPolicy = issueRankedPolicyFinalization(
    port.finalization,
    activation,
  );
  if (!rankedPolicy) throw new Error("Expected ranked policy finalization");
  return Object.freeze({ policy, port, activation, rankedPolicy });
}

function preparedStoredMedia(
  input: Readonly<{ id: string; uploadedAt: string }>,
): StoredMedia {
  return {
    id: input.id,
    contentType: "video/mp4",
    bytes: 10,
    uploadedAt: input.uploadedAt,
    deleteAt: new Date(
      Date.parse(input.uploadedAt) + 23 * 60 * 60 * 1000,
    ).toISOString(),
    transition: {
      kind: "upload-transition",
      resourceId: input.id,
      deleteAt: new Date(
        Date.parse(input.uploadedAt) + 60 * 60 * 1000,
      ).toISOString(),
    },
  };
}

async function scheduleTemporaryRetention(
  fixture: Awaited<ReturnType<typeof makeRepository>>,
  attemptId: string,
  media: StoredMedia,
): Promise<void> {
  fixture.database.raw
    .prepare(
      "INSERT INTO retention_cleanup_records (resource_id, attempt_id, resource_kind, delete_at, created_at) VALUES (?, ?, 'temporary', ?, ?)",
    )
    .run(media.id, attemptId, media.transition.deleteAt, media.uploadedAt);
}

function freeProcessingContext(
  input: Readonly<{ attemptId: string; generation: number; mediaId: string }>,
) {
  return Object.freeze({
    kind: "c5-durable-processing-context-v2" as const,
    receipt: Object.freeze({
      frameBatchId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      mediaId: input.mediaId,
      sha256: "d".repeat(64),
    }),
  });
}

describe("SQLiteAttemptRepository", () => {
  let fixture: Awaited<ReturnType<typeof makeRepository>>;

  beforeEach(async () => {
    fixture = await makeRepository();
  });

  afterEach(async () => {
    for (const database of fixture.secondaryDatabases) database.close();
    fixture.database.close();
    await rm(fixture.directory, { recursive: true, force: true });
  });

  it("rejects a structural handoff verifier outside the C5 topology", () => {
    expect(
      () =>
        new SQLiteAttemptRepository({
          database: fixture.database,
          clock: fixture.clock,
          ids: fixture.ids,
          handoffVerifier: { accepts: () => true },
        } as never),
    ).toThrow("C5 handoff verifier");
  });

  it("rejects cloned, proxied, and structural database wrappers before their raw methods can become C4 authority", () => {
    const structural = {
      raw: {
        exec: () => undefined,
        prepare: () => ({
          get: () => ({ originals: 1, frames: 1 }),
          run: () => ({ changes: 1 }),
          all: () => [],
        }),
      },
      reopen: () => structural,
      close: () => undefined,
    };
    for (const database of [
      Object.assign({}, fixture.database),
      new Proxy(fixture.database, {}),
      structural,
    ]) {
      expect(
        () =>
          new SQLiteAttemptRepository({
            database: database as never,
            clock: fixture.clock,
            ids: fixture.ids,
            handoffVerifier: fixture.c5.handoffVerifier,
          }),
      ).toThrow("factory-issued SQLite database capability");
    }
  });

  it("accepts only the handoff issuer composed with this C4 repository", async () => {
    await fixture.repository.createAttempt({
      id: ATTEMPT_A,
      athleteId: ATHLETE_A,
      input: { mode: "free" },
    });
    const context = await fixture.repository.prepareMediaUpload({
      attemptId: ATTEMPT_A,
      athleteId: ATHLETE_A,
    });
    const media = createStoredMediaAttachment(
      preparedStoredMedia({
        id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        uploadedAt: context.uploadedAt,
      }),
    );
    await scheduleTemporaryRetention(fixture, ATTEMPT_A, media);
    const foreignC5 = createC5PipelineTestSupport({
      root: join(fixture.directory, "foreign-c5"),
    });
    await expect(
      fixture.repository.attachPreparedMedia({
        accepted: await foreignC5.accept(context, media),
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      fixture.repository.attachPreparedMedia({
        accepted: await fixture.c5.accept(context, media),
      }),
    ).resolves.toEqual({ attemptId: ATTEMPT_A, generation: 1, mode: "free" });
  });

  it("creates a first-use athlete and scopes reads and tombstones to that exact identity", async () => {
    await fixture.repository.createAttempt({
      id: ATTEMPT_A,
      athleteId: ATHLETE_A,
      input: { mode: "free" },
    });

    expect(
      await fixture.repository.getAttempt({
        attemptId: ATTEMPT_A,
        athleteId: ATHLETE_B,
      }),
    ).toBeNull();
    await expect(
      fixture.repository.tombstoneAttempt({
        attemptId: ATTEMPT_A,
        athleteId: ATHLETE_B,
      }),
    ).rejects.toMatchObject({ code: "attempt_not_found" });
    expect(
      await fixture.repository.getAttempt({
        attemptId: ATTEMPT_A,
        athleteId: ATHLETE_A,
      }),
    ).toMatchObject({
      id: ATTEMPT_A,
      status: "awaiting-upload",
      outcome: {
        state: "pending",
        attemptId: ATTEMPT_A,
        mode: "free",
        status: "awaiting-upload",
      },
    });

    await fixture.repository.tombstoneAttempt({
      attemptId: ATTEMPT_A,
      athleteId: ATHLETE_A,
    });
    expect(
      await fixture.repository.getAttempt({
        attemptId: ATTEMPT_A,
        athleteId: ATHLETE_A,
      }),
    ).toBeNull();
  });

  it("issues, readies, and consumes a calibration session once with owner and expiry guards", async () => {
    const session = await fixture.repository.issueCalibrationSession({
      id: SESSION_A,
      athleteId: ATHLETE_A,
      nonce: "a".repeat(43),
      challengeId: "wall-pass",
      challengeVersion: 1,
    });

    expect(session.expiresAt).toBe("2030-01-15T12:15:00.000Z");
    expect(
      await fixture.repository.getCalibrationSession({
        id: SESSION_A,
        athleteId: ATHLETE_A,
      }),
    ).toMatchObject({ id: SESSION_A, state: "issued", nonce: "a".repeat(43) });
    expect(
      await fixture.repository.getCalibrationSession({
        id: SESSION_A,
        athleteId: ATHLETE_B,
      }),
    ).toBeNull();
    await expect(
      fixture.repository.readyCalibrationSession({
        id: SESSION_A,
        athleteId: ATHLETE_B,
        requiredGates: ["device", "space", "athlete", "rehearsal", "record"],
      }),
    ).rejects.toMatchObject({ code: "calibration_session_not_found" });
    await fixture.repository.readyCalibrationSession({
      id: SESSION_A,
      athleteId: ATHLETE_A,
      requiredGates: ["device", "space", "athlete", "rehearsal", "record"],
    });
    await fixture.repository.createAttempt({
      id: ATTEMPT_A,
      athleteId: ATHLETE_A,
      input: {
        mode: "verified",
        challengeId: "wall-pass",
        challengeVersion: 1,
        calibrationSessionId: SESSION_A,
      },
    });

    await expect(
      fixture.repository.createAttempt({
        id: ATTEMPT_B,
        athleteId: ATHLETE_A,
        input: {
          mode: "verified",
          challengeId: "wall-pass",
          challengeVersion: 1,
          calibrationSessionId: SESSION_A,
        },
      }),
    ).rejects.toMatchObject({ code: "calibration_session_consumed" });
  });

  it("issues an authoritative upload context and restores its exact C5 facts only for the winning claim", async () => {
    await fixture.repository.createAttempt({
      id: ATTEMPT_A,
      athleteId: ATHLETE_A,
      input: { mode: "free" },
    });
    const first = await fixture.repository.prepareMediaUpload({
      attemptId: ATTEMPT_A,
      athleteId: ATHLETE_A,
    });
    const stale = await fixture.repository.prepareMediaUpload({
      attemptId: ATTEMPT_A,
      athleteId: ATHLETE_A,
    });
    expect(first).toMatchObject({
      attemptId: ATTEMPT_A,
      athleteId: ATHLETE_A,
      mode: "free",
      generation: 1,
      verified: null,
    });

    const media = preparedStoredMedia({
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      uploadedAt: first.uploadedAt,
    });
    await scheduleTemporaryRetention(fixture, ATTEMPT_A, media);
    const poisonMedia = preparedStoredMedia({
      id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      uploadedAt: first.uploadedAt,
    });
    const poisonedContext = Object.freeze({
      ...first,
      providerPayload: "/private/revelai/c7-capability",
    });
    await expect(
      fixture.repository.attachPreparedMedia({
        accepted: await fixture.c5.accept(
          poisonedContext as typeof first,
          createStoredMediaAttachment(poisonMedia),
        ),
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    const accepted = await fixture.c5.accept(
      first,
      createStoredMediaAttachment(media),
    );
    const job = await fixture.repository.attachPreparedMedia({
      accepted,
    });
    await expect(
      fixture.repository.attachPreparedMedia({
        accepted: await fixture.c5.accept(
          stale,
          createStoredMediaAttachment(
            preparedStoredMedia({
              id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
              uploadedAt: stale.uploadedAt,
            }),
          ),
        ),
      }),
    ).rejects.toMatchObject({ code: "duplicate_media_upload" });

    const reopened = SQLiteAttemptRepository.forReadOnlyTest({
      database: fixture.openSecondaryDatabase(),
      clock: fixture.clock,
      ids: fixture.ids,
    });
    const claim = await reopened.claimProcessing(job);
    expect(claim).not.toBeNull();
    const persisted = await reopened.getProcessingContext({
      attemptId: job.attemptId,
      generation: job.generation,
      leaseId: claim!.leaseId,
    });
    expect(persisted).toEqual({
      upload: first,
      processing: accepted.processingContext,
      sourceSha256: C5_TEST_SOURCE_SHA256,
    });
    await expect(
      reopened.releaseProcessingClaim({
        attemptId: job.attemptId,
        generation: job.generation,
        leaseId: claim!.leaseId,
      }),
    ).resolves.toBe(true);
    const retryClaim = await reopened.claimProcessing(job);
    expect(retryClaim).toMatchObject({ generation: 1, mode: "free" });
    await expect(
      reopened.getProcessingContext({
        attemptId: job.attemptId,
        generation: job.generation,
        leaseId: retryClaim!.leaseId,
      }),
    ).resolves.toEqual(persisted);
    await expect(
      reopened.finalizeTerminalResult({
        attemptId: job.attemptId,
        generation: job.generation,
        leaseId: retryClaim!.leaseId,
        candidate: freeOutcome(job.attemptId, fixture.clock.now()),
      }),
    ).resolves.toMatchObject({ kind: "finalized" });
    expect(
      fixture.database.raw
        .prepare("SELECT processing_context_json FROM attempts WHERE id = ?")
        .get(job.attemptId),
    ).toEqual({ processing_context_json: null });
  });

  it("binds a verified upload context to the consumed calibration nonce without serializing it publicly", async () => {
    await fixture.repository.issueCalibrationSession({
      id: SESSION_A,
      athleteId: ATHLETE_A,
      nonce: "a".repeat(43),
      challengeId: "wall-pass",
      challengeVersion: 1,
    });
    await fixture.repository.readyCalibrationSession({
      id: SESSION_A,
      athleteId: ATHLETE_A,
      requiredGates: ["device", "space", "athlete", "rehearsal", "record"],
    });
    await fixture.repository.createAttempt({
      id: ATTEMPT_A,
      athleteId: ATHLETE_A,
      input: {
        mode: "verified",
        challengeId: "wall-pass",
        challengeVersion: 1,
        calibrationSessionId: SESSION_A,
      },
    });

    await expect(
      fixture.repository.prepareMediaUpload({
        attemptId: ATTEMPT_A,
        athleteId: ATHLETE_A,
      }),
    ).resolves.toMatchObject({
      mode: "verified",
      generation: 1,
      verified: {
        challenge: { id: "wall-pass", version: 1 },
        calibrationSessionId: SESSION_A,
        calibrationNonce: "a".repeat(43),
      },
    });
  });

  it("fails closed on exact claimed receipt/source row mismatches while stale jobs remain null", async () => {
    await fixture.repository.createAttempt({
      id: ATTEMPT_A,
      athleteId: ATHLETE_A,
      input: { mode: "free" },
    });
    const job = await attachMedia(fixture, {
      attemptId: ATTEMPT_A,
      athleteId: ATHLETE_A,
      media: {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        contentType: "video/mp4",
        bytes: 10,
        deleteAt: "2030-01-16T12:00:00.000Z",
      },
    });
    await expect(
      fixture.repository.claimProcessing({
        attemptId: job.attemptId,
        generation: job.generation + 1,
      }),
    ).resolves.toBeNull();
    fixture.database.raw
      .prepare(
        "UPDATE attempts SET processing_context_json = json_set(processing_context_json, '$.upload.generation', ?) WHERE id = ?",
      )
      .run(job.generation + 1, ATTEMPT_A);
    await expect(fixture.repository.claimProcessing(job)).rejects.toMatchObject(
      {
        code: "persisted_data_corrupt",
      },
    );
    fixture.database.raw
      .prepare(
        "UPDATE attempts SET processing_context_json = json_set(processing_context_json, '$.upload.generation', ?) WHERE id = ?",
      )
      .run(job.generation, ATTEMPT_A);
    const changedUploadedAt = "2030-01-15T12:00:01.000Z";
    fixture.database.raw
      .prepare(
        "UPDATE attempts SET media_json = json_set(media_json, '$.uploadedAt', ?, '$.deleteAt', ?, '$.transition.deleteAt', ?) WHERE id = ?",
      )
      .run(
        changedUploadedAt,
        "2030-01-16T11:00:01.000Z",
        "2030-01-15T13:00:01.000Z",
        ATTEMPT_A,
      );
    await expect(fixture.repository.claimProcessing(job)).rejects.toMatchObject(
      {
        code: "persisted_data_corrupt",
      },
    );
    fixture.database.raw
      .prepare(
        "UPDATE attempts SET media_json = json_set(media_json, '$.uploadedAt', ?, '$.deleteAt', ?, '$.transition.deleteAt', ?) WHERE id = ?",
      )
      .run(
        fixture.clock.now(),
        "2030-01-16T11:00:00.000Z",
        "2030-01-15T13:00:00.000Z",
        ATTEMPT_A,
      );
    fixture.database.raw
      .prepare(
        "UPDATE attempts SET processing_context_json = json_set(processing_context_json, '$.upload.uploadedAt', ?) WHERE id = ?",
      )
      .run(changedUploadedAt, ATTEMPT_A);
    await expect(fixture.repository.claimProcessing(job)).rejects.toMatchObject(
      {
        code: "persisted_data_corrupt",
      },
    );
    fixture.database.raw
      .prepare(
        "UPDATE attempts SET processing_context_json = json_set(processing_context_json, '$.upload.uploadedAt', ?) WHERE id = ?",
      )
      .run(fixture.clock.now(), ATTEMPT_A);
    await expect(
      fixture.repository.claimProcessing(job),
    ).resolves.toMatchObject({
      generation: job.generation,
    });
    await fixture.repository.releaseProcessingClaim({
      attemptId: job.attemptId,
      generation: job.generation,
      leaseId: LEASE_A,
    });
    fixture.database.raw
      .prepare("UPDATE attempts SET media_sha256 = ? WHERE id = ?")
      .run("f".repeat(64), ATTEMPT_A);
    await expect(fixture.repository.claimProcessing(job)).rejects.toMatchObject(
      {
        code: "persisted_data_corrupt",
      },
    );
    fixture.database.raw
      .prepare(
        "UPDATE attempts SET media_sha256 = ?, processing_context_json = NULL WHERE id = ?",
      )
      .run("e".repeat(64), ATTEMPT_A);
    await expect(fixture.repository.claimProcessing(job)).rejects.toMatchObject(
      {
        code: "persisted_data_corrupt",
      },
    );
  });

  it("allows exactly one independently-connected actor to consume a ready calibration session", async () => {
    await fixture.repository.issueCalibrationSession({
      id: SESSION_A,
      athleteId: ATHLETE_A,
      nonce: "a".repeat(43),
      challengeId: "wall-pass",
      challengeVersion: 1,
    });
    await fixture.repository.readyCalibrationSession({
      id: SESSION_A,
      athleteId: ATHLETE_A,
      requiredGates: ["device", "space", "athlete", "rehearsal", "record"],
    });
    const firstHold = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
    const first = startRepositoryActor({
      filename: join(fixture.directory, "api.sqlite"),
      now: fixture.clock.now(),
      ids: [],
      delayMilliseconds: 0,
      holdAtBegin: firstHold,
      action: "create-verified",
      input: {
        id: ATTEMPT_A,
        athleteId: ATHLETE_A,
        input: {
          mode: "verified",
          challengeId: "wall-pass",
          challengeVersion: 1,
          calibrationSessionId: SESSION_A,
        },
      },
    });
    const second = startRepositoryActor({
      filename: join(fixture.directory, "api.sqlite"),
      now: fixture.clock.now(),
      ids: [],
      delayMilliseconds: 0,
      action: "create-verified",
      input: {
        id: ATTEMPT_B,
        athleteId: ATHLETE_A,
        input: {
          mode: "verified",
          challengeId: "wall-pass",
          challengeVersion: 1,
          calibrationSessionId: SESSION_A,
        },
      },
    });
    await Promise.all([first.ready, second.ready]);
    first.start();
    await first.acquired;
    second.start();
    await second.attempting;
    Atomics.store(new Int32Array(firstHold), 0, 1);
    Atomics.notify(new Int32Array(firstHold), 0);
    const [firstResult, secondResult] = await Promise.all([
      first.done,
      second.done,
    ]);

    expect(
      [firstResult, secondResult].filter((result) => !result.error),
    ).toHaveLength(1);
    expect(
      [firstResult, secondResult].find((result) => result.error !== undefined)
        ?.error?.code,
    ).toBe("calibration_session_consumed");
    expect(
      fixture.database.raw
        .prepare(
          "SELECT COUNT(*) AS count FROM attempts WHERE calibration_session_id = ?",
        )
        .get(SESSION_A),
    ).toMatchObject({ count: 1 });
  });

  it("rejects corrupt calibration rows before returning or consuming them", async () => {
    await fixture.repository.issueCalibrationSession({
      id: SESSION_A,
      athleteId: ATHLETE_A,
      nonce: "a".repeat(43),
      challengeId: "wall-pass",
      challengeVersion: 1,
    });
    fixture.database.raw
      .prepare(
        "UPDATE calibration_sessions SET nonce = ?, issued_at = ? WHERE id = ?",
      )
      .run("bad", "not-a-time", SESSION_A);

    await expect(
      fixture.repository.getCalibrationSession({
        id: SESSION_A,
        athleteId: ATHLETE_A,
      }),
    ).rejects.toMatchObject({ code: "persisted_data_corrupt" });
    await expect(
      fixture.repository.readyCalibrationSession({
        id: SESSION_A,
        athleteId: ATHLETE_A,
        requiredGates: ["device", "space", "athlete", "rehearsal", "record"],
      }),
    ).rejects.toMatchObject({ code: "persisted_data_corrupt" });
  });

  it("returns reverse-created stable pages without leaking another athlete's attempts", async () => {
    await fixture.repository.createAttempt({
      id: ATTEMPT_A,
      athleteId: ATHLETE_A,
      input: { mode: "free" },
    });
    await fixture.repository.createAttempt({
      id: ATTEMPT_B,
      athleteId: ATHLETE_A,
      input: { mode: "free" },
    });
    await fixture.repository.createAttempt({
      id: ATTEMPT_C,
      athleteId: ATHLETE_B,
      input: { mode: "free" },
    });

    const first = await fixture.repository.listAttempts({
      athleteId: ATHLETE_A,
      limit: 1,
    });
    expect(first.items.map((attempt) => attempt.id)).toEqual([ATTEMPT_B]);
    expect(first.nextCursor).toEqual(expect.any(String));
    expect(() =>
      JSON.parse(Buffer.from(first.nextCursor!, "base64url").toString("utf8")),
    ).toThrow();
    await expect(
      fixture.repository.listAttempts({
        athleteId: ATHLETE_B,
        limit: 1,
        cursor: first.nextCursor!,
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    const second = await fixture.repository.listAttempts({
      athleteId: ATHLETE_A,
      limit: 1,
      cursor: first.nextCursor!,
    });
    expect(second.items.map((attempt) => attempt.id)).toEqual([ATTEMPT_A]);
    expect(second.nextCursor).toBeNull();
  });

  it("persists delivery recovery before exact rollback and resolves it after cleanup acknowledgement", async () => {
    await fixture.repository.createAttempt({
      id: ATTEMPT_A,
      athleteId: ATHLETE_A,
      input: { mode: "free" },
    });
    const job = await attachMedia(fixture, {
      attemptId: ATTEMPT_A,
      athleteId: ATHLETE_A,
      media: {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        contentType: "video/mp4",
        bytes: 10,
        deleteAt: "2030-01-16T12:00:00.000Z",
      },
    });
    expect(job).toEqual({ attemptId: ATTEMPT_A, generation: 1, mode: "free" });

    await expect(
      fixture.repository.getMediaDeliveryRecovery(job),
    ).resolves.toEqual({
      attemptId: ATTEMPT_A,
      generation: 1,
      mediaId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      frameBatchId: "eeeeeeee-eeee-4eee-8eee-000000000000",
      state: "pending-delivery",
      requiresRollback: true,
    });
    await fixture.repository.beginMediaAttachmentRecovery({
      ...job,
      mediaId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      frameBatchId: "eeeeeeee-eeee-4eee-8eee-000000000000",
    });
    const reopened = SQLiteAttemptRepository.forReadOnlyTest({
      database: fixture.openSecondaryDatabase(),
      clock: fixture.clock,
      ids: fixture.ids,
    });
    await expect(reopened.getMediaDeliveryRecovery(job)).resolves.toMatchObject(
      {
        state: "cleanup-recoverable",
        requiresRollback: true,
      },
    );

    await fixture.repository.rollbackMediaAttachment({
      attemptId: ATTEMPT_A,
      generation: job.generation,
    });
    expect(
      await fixture.repository.getAttempt({
        attemptId: ATTEMPT_A,
        athleteId: ATHLETE_A,
      }),
    ).toMatchObject({
      status: "awaiting-upload",
      media: null,
    });
    await fixture.repository.acknowledgeMediaAttachmentCleanup({
      ...job,
      mediaId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    });
    await expect(reopened.getMediaDeliveryRecovery(job)).resolves.toMatchObject(
      {
        state: "resolved",
        mediaId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      },
    );
  });

  it("leases pending delivery for at-least-once redelivery before recording a coherent queue acknowledgement", async () => {
    await fixture.repository.createAttempt({
      id: ATTEMPT_A,
      athleteId: ATHLETE_A,
      input: { mode: "free" },
    });
    const job = await attachMedia(fixture, {
      attemptId: ATTEMPT_A,
      athleteId: ATHLETE_A,
      media: {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        contentType: "video/mp4",
        bytes: 10,
        deleteAt: "2030-01-16T12:00:00.000Z",
      },
    });
    const recovery = fixture.repository as unknown as {
      claimMediaDeliveryRedelivery?: (
        input: Readonly<{
          now: string;
          limit: number;
        }>,
      ) => Promise<readonly Readonly<{ leaseId: string; state: string }>[]>;
      acknowledgeMediaDeliveryRedelivery?: (
        input: Readonly<{
          attemptId: string;
          generation: number;
          leaseId: string;
        }>,
      ) => Promise<void>;
    };

    expect(typeof recovery.claimMediaDeliveryRedelivery).toBe("function");
    expect(typeof recovery.acknowledgeMediaDeliveryRedelivery).toBe("function");
    if (
      !recovery.claimMediaDeliveryRedelivery ||
      !recovery.acknowledgeMediaDeliveryRedelivery
    )
      return;

    const claims = await recovery.claimMediaDeliveryRedelivery({
      now: fixture.clock.now(),
      limit: 1,
    });
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({ state: "pending-delivery" });
    await expect(
      recovery.claimMediaDeliveryRedelivery({
        now: fixture.clock.now(),
        limit: 1,
      }),
    ).resolves.toEqual([]);
    fixture.clock.advance(5 * 60_000);
    const reclaimed = await recovery.claimMediaDeliveryRedelivery({
      now: fixture.clock.now(),
      limit: 1,
    });
    expect(reclaimed).toHaveLength(1);
    expect(reclaimed[0]!.leaseId).not.toBe(claims[0]!.leaseId);
    await recovery.acknowledgeMediaDeliveryRedelivery({
      ...job,
      leaseId: reclaimed[0]!.leaseId,
    });
    await expect(
      fixture.repository.getMediaDeliveryRecovery(job),
    ).resolves.toEqual(
      expect.objectContaining({ state: "queued", requiresRollback: false }),
    );
  });

  it("turns a tombstoned pending delivery into exact cleanup recovery instead of orphaning its resources", async () => {
    await fixture.repository.createAttempt({
      id: ATTEMPT_A,
      athleteId: ATHLETE_A,
      input: { mode: "free" },
    });
    const job = await attachMedia(fixture, {
      attemptId: ATTEMPT_A,
      athleteId: ATHLETE_A,
      media: {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        contentType: "video/mp4",
        bytes: 10,
        deleteAt: "2030-01-16T12:00:00.000Z",
      },
    });

    await fixture.repository.tombstoneAttempt({
      attemptId: ATTEMPT_A,
      athleteId: ATHLETE_A,
    });

    await expect(
      fixture.repository.getMediaDeliveryRecovery(job),
    ).resolves.toEqual(
      expect.objectContaining({
        state: "cleanup-recoverable",
        requiresRollback: false,
      }),
    );
    await expect(
      fixture.repository.claimMediaAttachmentRecovery({
        now: fixture.clock.now(),
        limit: 1,
      }),
    ).resolves.toHaveLength(1);
  });

  it("rejects every impossible durable recovery lifecycle shape", async () => {
    await fixture.repository.createAttempt({
      id: ATTEMPT_A,
      athleteId: ATHLETE_A,
      input: { mode: "free" },
    });
    const job = await attachMedia(fixture, {
      attemptId: ATTEMPT_A,
      athleteId: ATHLETE_A,
      media: {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        contentType: "video/mp4",
        bytes: 10,
        deleteAt: "2030-01-16T12:00:00.000Z",
      },
    });
    const reset = () =>
      fixture.database.raw
        .prepare(
          `UPDATE media_delivery_recovery_records
              SET state = 'pending-delivery', requires_rollback = 1,
                  queued_at = NULL, rollback_completed_at = NULL,
                  cleanup_completed_at = NULL, recovery_lease_id = NULL,
                  recovery_lease_expires_at = NULL
            WHERE attempt_id = ? AND generation = ?`,
        )
        .run(job.attemptId, job.generation);
    const impossible = [
      "UPDATE media_delivery_recovery_records SET queued_at = '2030-01-15T12:00:00.000Z' WHERE attempt_id = ? AND generation = ?",
      "UPDATE media_delivery_recovery_records SET state = 'queued', requires_rollback = 0 WHERE attempt_id = ? AND generation = ?",
      "UPDATE media_delivery_recovery_records SET state = 'cleanup-recoverable', cleanup_completed_at = '2030-01-15T12:00:00.000Z' WHERE attempt_id = ? AND generation = ?",
      "UPDATE media_delivery_recovery_records SET state = 'resolved' WHERE attempt_id = ? AND generation = ?",
      "UPDATE media_delivery_recovery_records SET state = 'cleanup-recoverable', recovery_lease_id = 'ffffffff-ffff-4fff-8fff-ffffffffffff' WHERE attempt_id = ? AND generation = ?",
    ] as const;
    for (const statement of impossible) {
      reset();
      fixture.database.raw
        .prepare(statement)
        .run(job.attemptId, job.generation);
      await expect(
        fixture.repository.getMediaDeliveryRecovery(job),
      ).rejects.toMatchObject({ code: "persisted_data_corrupt" });
    }
  });

  it("rejects an attachment without its mandatory C5 upload-transition metadata before SQL", async () => {
    await fixture.repository.createAttempt({
      id: ATTEMPT_A,
      athleteId: ATHLETE_A,
      input: { mode: "free" },
    });

    await expect(
      fixture.repository.attachPreparedMedia({ accepted: {} as never }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      fixture.repository.attachPreparedMedia({
        accepted: { context: {}, storedMedia: {} } as never,
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      fixture.repository.attachPreparedMedia({
        accepted: { cleanup: { cleanup: async () => undefined } } as never,
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(
      await fixture.repository.getAttempt({
        attemptId: ATTEMPT_A,
        athleteId: ATHLETE_A,
      }),
    ).toMatchObject({ status: "awaiting-upload", media: null });
  });

  it("uses a generation and lease to reject duplicate and stale processing delivery", async () => {
    await fixture.repository.createAttempt({
      id: ATTEMPT_A,
      athleteId: ATHLETE_A,
      input: { mode: "free" },
    });
    const job = await attachMedia(fixture, {
      attemptId: ATTEMPT_A,
      athleteId: ATHLETE_A,
      media: {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        contentType: "video/mp4",
        bytes: 10,
        deleteAt: "2030-01-16T12:00:00.000Z",
      },
    });
    const claim = await fixture.repository.claimProcessing(job);

    expect(claim).toMatchObject({ leaseId: LEASE_A, generation: 1 });
    expect(await fixture.repository.claimProcessing(job)).toBeNull();
    expect(
      await fixture.repository.finalizeTerminalResult({
        attemptId: ATTEMPT_A,
        leaseId: "stale-lease",
        generation: 0,
        candidate: freeOutcome(ATTEMPT_A, fixture.clock.now()),
      }),
    ).toEqual({ kind: "lost-claim" });
  });

  it("finalizes one terminal fact idempotently and does not leaderboard a Free result", async () => {
    await fixture.repository.createAttempt({
      id: ATTEMPT_A,
      athleteId: ATHLETE_A,
      input: { mode: "free" },
    });
    const job = await attachMedia(fixture, {
      attemptId: ATTEMPT_A,
      athleteId: ATHLETE_A,
      media: {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        contentType: "video/mp4",
        bytes: 10,
        deleteAt: "2030-01-16T12:00:00.000Z",
      },
    });
    const claim = (await fixture.repository.claimProcessing(job))!;
    const input = {
      attemptId: ATTEMPT_A,
      leaseId: claim.leaseId,
      generation: claim.generation,
      candidate: freeOutcome(ATTEMPT_A, fixture.clock.now()),
    };

    const first = await fixture.repository.finalizeTerminalResult(input);
    const duplicate = await fixture.repository.finalizeTerminalResult(input);
    expect(first.kind).toBe("finalized");
    expect(duplicate).toMatchObject({
      kind: "idempotent",
      finalized:
        first.kind === "finalized" ? first.finalized : expect.anything(),
    });
    fixture.clock.advance(1);
    await expect(
      fixture.repository.finalizeTerminalResult({
        ...input,
        candidate: freeOutcome(ATTEMPT_A, fixture.clock.now()),
      }),
    ).rejects.toMatchObject({ code: "terminal_result_conflict" });
    expect(
      (
        await fixture.repository.listLiveLeaderboard({
          challenge: {
            id: "wall-pass",
            version: 1,
            ruleVersion: "wall-pass-v1-score-1",
          },
          limit: 20,
        })
      ).entries,
    ).toEqual([]);
    await expect(
      fixture.repository.getMediaDeliveryRecovery(job),
    ).resolves.toBeNull();
    const persisted = await fixture.repository.getAttempt({
      attemptId: ATTEMPT_A,
      athleteId: ATHLETE_A,
    });
    expect(persisted).not.toBeNull();
    expect(Object.isFrozen(persisted!.outcome)).toBe(true);
    if (
      persisted!.outcome.state !== "valid" ||
      persisted!.outcome.result.kind !== "free-insight"
    )
      throw new Error("Expected persisted free terminal outcome");
    expect(Object.isFrozen(persisted!.outcome.result)).toBe(true);
    expect(Object.isFrozen(persisted!.outcome.result.observations)).toBe(true);
    expect(Object.isFrozen(persisted!.outcome.result.observations[0]!)).toBe(
      true,
    );
  });

  it("fails closed when a persisted terminal outcome no longer belongs to its active attempt", async () => {
    await fixture.repository.createAttempt({
      id: ATTEMPT_A,
      athleteId: ATHLETE_A,
      input: { mode: "free" },
    });
    const job = await attachMedia(fixture, {
      attemptId: ATTEMPT_A,
      athleteId: ATHLETE_A,
      media: {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        contentType: "video/mp4",
        bytes: 10,
        deleteAt: "2030-01-16T12:00:00.000Z",
      },
    });
    const claim = (await fixture.repository.claimProcessing(job))!;
    await fixture.repository.finalizeTerminalResult({
      attemptId: ATTEMPT_A,
      leaseId: claim.leaseId,
      generation: claim.generation,
      candidate: freeOutcome(ATTEMPT_A, fixture.clock.now()),
    });
    fixture.database.raw
      .prepare("UPDATE attempts SET status = 'processing' WHERE id = ?")
      .run(ATTEMPT_A);
    await expect(
      fixture.repository.getAttempt({
        attemptId: ATTEMPT_A,
        athleteId: ATHLETE_A,
      }),
    ).rejects.toMatchObject({ code: "persisted_data_corrupt" });
    fixture.database.raw
      .prepare("UPDATE attempts SET status = 'valid' WHERE id = ?")
      .run(ATTEMPT_A);
    fixture.database.raw
      .prepare(
        "UPDATE terminal_results SET outcome_json = ? WHERE attempt_id = ?",
      )
      .run(
        JSON.stringify({
          state: "failed",
          attemptId: ATTEMPT_B,
          mode: "free",
          code: "analysis_temporary_unavailable",
          message: FailureMessageByCode.analysis_temporary_unavailable,
          retryable: true,
        }),
        ATTEMPT_A,
      );

    await expect(
      fixture.repository.getAttempt({
        attemptId: ATTEMPT_A,
        athleteId: ATHLETE_A,
      }),
    ).rejects.toMatchObject({ code: "persisted_data_corrupt" });
  });

  it("serializes independently-run ranked completions into frozen cohorts while preserving live ties", async () => {
    const secondDatabase = fixture.openSecondaryDatabase();
    const second = SQLiteAttemptRepository.forReadOnlyTest({
      database: secondDatabase,
      clock: fixture.clock,
      ids: new TestIds(
        LEASE_B,
        ENTRY_B,
        "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      ),
    });
    for (const [id, athlete, sessionId, nonce, mediaId] of [
      [
        ATTEMPT_A,
        ATHLETE_A,
        SESSION_A,
        "a".repeat(43),
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      ],
      [
        ATTEMPT_B,
        ATHLETE_B,
        SESSION_B,
        "b".repeat(43),
        "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      ],
    ] as const) {
      await fixture.repository.issueCalibrationSession({
        id: sessionId,
        athleteId: athlete,
        nonce,
        challengeId: "wall-pass",
        challengeVersion: 1,
      });
      await fixture.repository.readyCalibrationSession({
        id: sessionId,
        athleteId: athlete,
        requiredGates: ["device", "space", "athlete", "rehearsal", "record"],
      });
      await fixture.repository.createAttempt({
        id,
        athleteId: athlete,
        input: {
          mode: "verified",
          challengeId: "wall-pass",
          challengeVersion: 1,
          calibrationSessionId: sessionId,
        },
      });
      await attachMedia(fixture, {
        attemptId: id,
        athleteId: athlete,
        media: {
          id: mediaId,
          contentType: "video/mp4",
          bytes: 10,
          deleteAt: "2030-01-16T12:00:00.000Z",
        },
      });
    }
    const firstJob = {
      attemptId: ATTEMPT_A,
      generation: 1,
    } as const;
    const secondJob = {
      attemptId: ATTEMPT_B,
      generation: 1,
    } as const;
    const firstClaim = (await fixture.repository.claimProcessing(firstJob))!;
    const secondClaim = (await second.claimProcessing(secondJob))!;
    const { activation, rankedPolicy } =
      await activatePassingCompetitivePolicy(fixture);
    const completedAt = fixture.clock.now();
    const first = startRepositoryActor({
      filename: join(fixture.directory, "api.sqlite"),
      now: completedAt,
      ids: [ENTRY_A, "dddddddd-dddd-4ddd-8ddd-dddddddddddd"],
      delayMilliseconds: 0,
      action: "finalize-with-current-policy",
      input: {
        attemptId: ATTEMPT_A,
        leaseId: firstClaim.leaseId,
        generation: firstClaim.generation,
        candidate: rankedOutcome(ATTEMPT_A, completedAt, 80),
        activation,
      },
    });
    const secondActor = startRepositoryActor({
      filename: join(fixture.directory, "api.sqlite"),
      now: completedAt,
      ids: [ENTRY_B, "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"],
      delayMilliseconds: 50,
      action: "finalize-with-current-policy",
      input: {
        attemptId: ATTEMPT_B,
        leaseId: secondClaim.leaseId,
        generation: secondClaim.generation,
        candidate: rankedOutcome(ATTEMPT_B, completedAt, 80),
        activation,
      },
    });
    await Promise.all([first.ready, secondActor.ready]);
    const barrier = startSqliteLockBarrier({
      filename: join(fixture.directory, "api.sqlite"),
    });
    await barrier.locked;
    first.start();
    await first.attempting;
    secondActor.start();
    await secondActor.attempting;
    const [firstResult, secondResult] = await Promise.all([
      first.done,
      secondActor.done,
    ]);
    await barrier.done;

    expect(firstResult.error).toBeUndefined();
    expect(secondResult.error).toBeUndefined();
    const frozenRows = fixture.database.raw
      .prepare(
        "SELECT attempt_id, outcome_json FROM terminal_results WHERE attempt_id IN (?, ?) ORDER BY attempt_id",
      )
      .all(ATTEMPT_A, ATTEMPT_B) as readonly Readonly<{
      attempt_id: string;
      outcome_json: string;
    }>[];
    const snapshots = Object.fromEntries(
      frozenRows.map((row) => [
        row.attempt_id,
        (
          JSON.parse(row.outcome_json) as {
            result: { rankingSnapshot: object };
          }
        ).result.rankingSnapshot,
      ]),
    );
    expect(Object.values(snapshots)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ cohortSize: 1, rank: 1 }),
        expect.objectContaining({ cohortSize: 2, rank: 1 }),
      ]),
    );
    const firstPage = await fixture.repository.listLiveLeaderboard({
      challenge: {
        id: "wall-pass",
        version: 1,
        ruleVersion: "wall-pass-v1-score-1",
      },
      limit: 1,
    });
    expect(firstPage).toEqual({
      calculatedAt: completedAt,
      cohortSize: 2,
      entries: [
        {
          entryId: ENTRY_A,
          rank: 1,
          score: 80,
          completedAt,
        },
      ],
      nextCursor: expect.any(String),
    });
    const secondPage = await fixture.repository.listLiveLeaderboard({
      challenge: {
        id: "wall-pass",
        version: 1,
        ruleVersion: "wall-pass-v1-score-1",
      },
      limit: 1,
      cursor: firstPage.nextCursor!,
    });
    expect(secondPage).toEqual({
      calculatedAt: completedAt,
      cohortSize: 2,
      entries: [
        {
          entryId: ENTRY_B,
          rank: 1,
          score: 80,
          completedAt,
        },
      ],
      nextCursor: null,
    });
    expect(
      Buffer.from(firstPage.nextCursor!, "base64url").toString("utf8"),
    ).not.toContain(ATTEMPT_A);
    fixture.clock.advance(1);
    const thirdClaim = await claimVerifiedAttempt(fixture, {
      attemptId: ATTEMPT_C,
      athleteId: ATHLETE_C,
      sessionId: SESSION_C,
      mediaId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    });
    const insertedAt = fixture.clock.now();
    await fixture.repository.finalizeTerminalResult({
      attemptId: ATTEMPT_C,
      leaseId: thirdClaim.leaseId,
      generation: thirdClaim.generation,
      candidate: rankedOutcome(ATTEMPT_C, insertedAt, 90),
      rankedPolicy,
    });
    const currentPage = await fixture.repository.listLiveLeaderboard({
      challenge: {
        id: "wall-pass",
        version: 1,
        ruleVersion: "wall-pass-v1-score-1",
      },
      limit: 10,
    });
    expect(currentPage.calculatedAt).toBe(insertedAt);
    expect(currentPage.cohortSize).toBe(3);
    expect(currentPage.entries).toContainEqual(
      expect.objectContaining({ score: 90 }),
    );
    await expect(
      fixture.repository.listLiveLeaderboard({
        challenge: {
          id: "wall-pass",
          version: 1,
          ruleVersion: "wall-pass-v1-score-1",
        },
        limit: 1,
        cursor: firstPage.nextCursor!,
      }),
    ).resolves.toEqual(secondPage);
    const tamperedCursor = `${firstPage.nextCursor!.slice(0, -1)}${
      firstPage.nextCursor!.at(-1) === "A" ? "B" : "A"
    }`;
    await expect(
      fixture.repository.listLiveLeaderboard({
        challenge: {
          id: "wall-pass",
          version: 1,
          ruleVersion: "wall-pass-v1-score-1",
        },
        limit: 1,
        cursor: tamperedCursor,
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await fixture.repository.tombstoneAttempt({
      attemptId: ATTEMPT_A,
      athleteId: ATHLETE_A,
    });
    await expect(
      fixture.repository.listLiveLeaderboard({
        challenge: {
          id: "wall-pass",
          version: 1,
          ruleVersion: "wall-pass-v1-score-1",
        },
        limit: 1,
        cursor: firstPage.nextCursor!,
      }),
    ).resolves.toEqual({
      calculatedAt: completedAt,
      cohortSize: 1,
      entries: [{ entryId: ENTRY_B, rank: 1, score: 80, completedAt }],
      nextCursor: null,
    });
    expect(() =>
      fixture.database.raw
        .prepare(
          "UPDATE leaderboard_entries SET rule_version = 'wall-pass-v0-score-1' WHERE id = ?",
        )
        .run(ENTRY_B),
    ).toThrow(/rule_version/);
  });

  it("uses repository commit membership for a snapshot even when a later result backdates completion", async () => {
    const local = await makeRepository(
      new TestIds(
        LEASE_A,
        LEASE_B,
        ENTRY_A,
        "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        ENTRY_B,
        "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      ),
    );
    try {
      for (const [attemptId, athleteId, sessionId, nonce, mediaId] of [
        [
          ATTEMPT_A,
          ATHLETE_A,
          SESSION_A,
          "a".repeat(43),
          "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        ],
        [
          ATTEMPT_B,
          ATHLETE_B,
          SESSION_B,
          "b".repeat(43),
          "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        ],
      ] as const) {
        await local.repository.issueCalibrationSession({
          id: sessionId,
          athleteId,
          nonce,
          challengeId: "wall-pass",
          challengeVersion: 1,
        });
        await local.repository.readyCalibrationSession({
          id: sessionId,
          athleteId,
          requiredGates: ["device", "space", "athlete", "rehearsal", "record"],
        });
        await local.repository.createAttempt({
          id: attemptId,
          athleteId,
          input: {
            mode: "verified",
            challengeId: "wall-pass",
            challengeVersion: 1,
            calibrationSessionId: sessionId,
          },
        });
        await attachMedia(local, {
          attemptId,
          athleteId,
          media: {
            id: mediaId,
            contentType: "video/mp4",
            bytes: 10,
            deleteAt: "2030-01-16T12:00:00.000Z",
          },
        });
      }
      const cutoff = local.clock.now();
      const { rankedPolicy } = await activatePassingCompetitivePolicy(local);
      const firstClaim = (await local.repository.claimProcessing({
        attemptId: ATTEMPT_A,
        generation: 1,
      }))!;
      await local.repository.finalizeTerminalResult({
        attemptId: ATTEMPT_A,
        generation: 1,
        leaseId: firstClaim.leaseId,
        candidate: rankedOutcome(ATTEMPT_A, cutoff, 80),
        rankedPolicy,
      });
      const oldSnapshot = await local.repository.listLiveLeaderboard({
        challenge: {
          id: "wall-pass",
          version: 1,
          ruleVersion: "wall-pass-v1-score-1",
        },
        limit: 10,
      });
      expect(oldSnapshot.calculatedAt).toBe(cutoff);
      expect(oldSnapshot.entries).toHaveLength(1);
      local.clock.advance(1);
      const secondClaim = (await local.repository.claimProcessing({
        attemptId: ATTEMPT_B,
        generation: 1,
      }))!;
      await local.repository.finalizeTerminalResult({
        attemptId: ATTEMPT_B,
        generation: 1,
        leaseId: secondClaim.leaseId,
        candidate: rankedOutcome(ATTEMPT_B, cutoff, 80),
        rankedPolicy,
      });

      const currentSnapshot = await local.repository.listLiveLeaderboard({
        challenge: {
          id: "wall-pass",
          version: 1,
          ruleVersion: "wall-pass-v1-score-1",
        },
        limit: 10,
      });
      expect(currentSnapshot.calculatedAt).toBe(local.clock.now());
      expect(currentSnapshot.entries).toHaveLength(2);
      expect(currentSnapshot.entries).toContainEqual(oldSnapshot.entries[0]);
    } finally {
      for (const secondary of local.secondaryDatabases) secondary.close();
      local.database.close();
      await rm(local.directory, { recursive: true, force: true });
    }
  });

  it("authenticates opaque live cursors with an injected AES key", () => {
    const codec = createLiveLeaderboardCursorCodec({
      key: Uint8Array.from({ length: 32 }, (_, index) => index),
    });
    const payload = {
      version: 3 as const,
      challengeId: "wall-pass" as const,
      challengeVersion: 1 as const,
      ruleVersion: "wall-pass-v1-score-1" as const,
      calculatedAt: "2030-01-15T12:00:00.000Z",
      snapshotSequence: 7,
      score: 80,
      completedAt: "2030-01-15T12:00:00.000Z",
      attemptId: ATTEMPT_A,
    };
    const cursor = codec.encode(payload);
    expect(cursor).not.toContain(ATTEMPT_A);
    expect(codec.decode(cursor)).toEqual(payload);
    const secondCursor = codec.encode(payload);
    expect(secondCursor).not.toEqual(cursor);
    expect(codec.decode(secondCursor)).toEqual(payload);
    const firstNonce = BigInt(
      `0x${Buffer.from(cursor, "base64url").subarray(0, 12).toString("hex")}`,
    );
    expect(
      BigInt(
        `0x${Buffer.from(secondCursor, "base64url").subarray(0, 12).toString("hex")}`,
      ),
    ).toBe(firstNonce + 1n);
    const restarted = createLiveLeaderboardCursorCodec({
      key: Uint8Array.from({ length: 32 }, (_, index) => 31 - index),
    });
    expect(() => restarted.decode(cursor)).toThrow(
      expect.objectContaining({ code: "invalid_input" }),
    );
    const tampered = tamperCanonicalAesGcmCursor(cursor);
    expect(tampered).not.toEqual(cursor);
    expect(() => codec.decode(tampered)).toThrow(
      expect.objectContaining({ code: "invalid_input" }),
    );
    for (const malformed of ["A", "AAAA", `${cursor}!`, `${cursor}=`]) {
      expect(() => codec.decode(malformed)).toThrow(
        expect.objectContaining({ code: "invalid_input" }),
      );
    }
    expect(() =>
      createLiveLeaderboardCursorCodec({ key: new Uint8Array(31) }),
    ).toThrow("32 bytes");
    expect(() =>
      createLiveLeaderboardCursorCodec({ key: new Uint8Array(33) }),
    ).toThrow("32 bytes");
    expect(() => codec.encode(payload)).not.toThrow();
  });

  it("authenticates canonical opaque attempt cursors with their athlete boundary", () => {
    const codec = createAttemptCursorCodec({
      key: Uint8Array.from({ length: 32 }, (_, index) => index),
    });
    const payload = {
      version: 1 as const,
      athleteId: ATHLETE_A,
      createdAt: "2030-01-15T12:00:00.000Z",
      attemptId: ATTEMPT_A,
    };
    const cursor = codec.encode(payload);
    expect(cursor).not.toContain(ATHLETE_A);
    expect(cursor).not.toContain(ATTEMPT_A);
    expect(codec.decode(cursor)).toEqual(payload);
    const second = codec.encode(payload);
    expect(second).not.toEqual(cursor);
    expect(codec.decode(second)).toEqual(payload);
    expect(() =>
      createAttemptCursorCodec({
        key: Uint8Array.from({ length: 32 }, (_, index) => 31 - index),
      }).decode(cursor),
    ).toThrow(expect.objectContaining({ code: "invalid_input" }));
    for (const malformed of [
      "A",
      "AAAA",
      `${cursor}!`,
      `${cursor}=`,
      tamperCanonicalAesGcmCursor(cursor),
      Buffer.from(JSON.stringify(payload)).toString("base64url"),
    ]) {
      expect(() => codec.decode(malformed)).toThrow(
        expect.objectContaining({ code: "invalid_input" }),
      );
    }
  });

  it("derives unique attempt cursor IVs from a process-wide monotonic counter without per-page history", () => {
    const codec = createAttemptCursorCodec({
      key: Uint8Array.from({ length: 32 }, (_, index) => index),
    });
    const payload = {
      version: 1 as const,
      athleteId: ATHLETE_A,
      createdAt: "2030-01-15T12:00:00.000Z",
      attemptId: ATTEMPT_A,
    };
    const cursors = Array.from({ length: 128 }, () => codec.encode(payload));
    const ivs = cursors.map((cursor) => Buffer.from(cursor, "base64url"));
    const firstNonce = BigInt(`0x${ivs[0]!.subarray(0, 12).toString("hex")}`);

    expect(new Set(cursors)).toHaveLength(cursors.length);
    for (const [index, iv] of ivs.entries()) {
      expect(BigInt(`0x${iv.subarray(0, 12).toString("hex")}`)).toBe(
        firstNonce + BigInt(index),
      );
    }
    expect(Reflect.ownKeys(codec)).toEqual(["encode", "decode"]);
  });

  it("does not reuse an IV when separately-created attempt codecs share a key", () => {
    const key = Uint8Array.from({ length: 32 }, (_, index) => index);
    const first = createAttemptCursorCodec({ key });
    const second = createAttemptCursorCodec({ key });
    const payload = {
      version: 1 as const,
      athleteId: ATHLETE_A,
      createdAt: "2030-01-15T12:00:00.000Z",
      attemptId: ATTEMPT_A,
    };

    const firstIv = Buffer.from(first.encode(payload), "base64url").subarray(
      0,
      12,
    );
    const secondIv = Buffer.from(second.encode(payload), "base64url").subarray(
      0,
      12,
    );
    expect(secondIv).not.toEqual(firstIv);
  });

  it("reserves distinct IVs across attempt and live codecs with the exact same key", () => {
    const key = Uint8Array.from({ length: 32 }, (_, index) => index);
    const attempt = createAttemptCursorCodec({ key });
    const live = createLiveLeaderboardCursorCodec({ key });

    const attemptIv = Buffer.from(
      attempt.encode({
        version: 1,
        athleteId: ATHLETE_A,
        createdAt: "2030-01-15T12:00:00.000Z",
        attemptId: ATTEMPT_A,
      }),
      "base64url",
    ).subarray(0, 12);
    const liveIv = Buffer.from(
      live.encode({
        version: 3,
        challengeId: "wall-pass",
        challengeVersion: 1,
        ruleVersion: "wall-pass-v1-score-1",
        calculatedAt: "2030-01-15T12:00:00.000Z",
        snapshotSequence: 7,
        score: 80,
        completedAt: "2030-01-15T12:00:00.000Z",
        attemptId: ATTEMPT_A,
      }),
      "base64url",
    ).subarray(0, 12);

    expect(liveIv).not.toEqual(attemptIv);
  });

  it("never projects demo or experimental verified candidates onto the leaderboard", async () => {
    const candidates: readonly TerminalCandidate[] = [
      {
        state: "valid",
        result: {
          kind: "verified-result",
          attemptId: ATTEMPT_A,
          challengeId: "wall-pass",
          challengeVersion: 1,
          ruleVersion: "wall-pass-v1-score-1",
          provenance: {
            kind: "demo",
            fixtureId: "wall-pass-balanced-v1",
            providerVersion: "demo-observations-v1",
          },
          metrics: {
            validPasses: 20,
            accuracyPercent: 80,
            meanCadenceSeconds: 1.5,
            leftFootPercent: 50,
            rightFootPercent: 50,
          },
          score: 80,
          completedAt: "2030-01-15T12:00:00.000Z",
          competitiveStatus: "demo",
          competitiveEligible: false,
        },
      },
      {
        state: "valid",
        result: {
          kind: "verified-result",
          attemptId: ATTEMPT_B,
          challengeId: "wall-pass",
          challengeVersion: 1,
          ruleVersion: "wall-pass-v1-score-1",
          provenance: {
            kind: "roboflow",
            workspaceId: "revelai-workspace",
            workflowId: "revelai-wall-pass-geometry-v1",
            workflowVersion: "1.0.0",
            modelBundleId: "wall-pass-bundle-v1",
            providerVersion: "roboflow-inference-v1",
          },
          metrics: {
            validPasses: 20,
            accuracyPercent: 80,
            meanCadenceSeconds: 1.5,
            leftFootPercent: 50,
            rightFootPercent: 50,
          },
          score: 80,
          completedAt: "2030-01-15T12:00:00.000Z",
          competitiveStatus: "experimental",
          competitiveEligible: false,
        },
      },
    ];
    for (const [attemptId, athleteId, sessionId, candidate, mediaId] of [
      [
        ATTEMPT_A,
        ATHLETE_A,
        SESSION_A,
        candidates[0],
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      ],
      [
        ATTEMPT_B,
        ATHLETE_B,
        SESSION_B,
        candidates[1],
        "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      ],
    ] as const) {
      await fixture.repository.issueCalibrationSession({
        id: sessionId,
        athleteId,
        nonce: attemptId === ATTEMPT_A ? "a".repeat(43) : "b".repeat(43),
        challengeId: "wall-pass",
        challengeVersion: 1,
      });
      await fixture.repository.readyCalibrationSession({
        id: sessionId,
        athleteId,
        requiredGates: ["device", "space", "athlete", "rehearsal", "record"],
      });
      await fixture.repository.createAttempt({
        id: attemptId,
        athleteId,
        input: {
          mode: "verified",
          challengeId: "wall-pass",
          challengeVersion: 1,
          calibrationSessionId: sessionId,
        },
      });
      const job = await attachMedia(fixture, {
        attemptId,
        athleteId,
        media: {
          id: mediaId,
          contentType: "video/mp4",
          bytes: 10,
          deleteAt: "2030-01-16T12:00:00.000Z",
        },
      });
      const claim = (await fixture.repository.claimProcessing(job))!;
      await fixture.repository.finalizeTerminalResult({
        attemptId,
        leaseId: claim.leaseId,
        generation: claim.generation,
        candidate,
      });
    }

    expect(
      (
        await fixture.repository.listLiveLeaderboard({
          challenge: {
            id: "wall-pass",
            version: 1,
            ruleVersion: "wall-pass-v1-score-1",
          },
          limit: 20,
        })
      ).entries,
    ).toEqual([]);
  });

  it("lets tombstoning win over a claimed worker so a deleted attempt cannot resurrect", async () => {
    await fixture.repository.createAttempt({
      id: ATTEMPT_A,
      athleteId: ATHLETE_A,
      input: { mode: "free" },
    });
    const job = await attachMedia(fixture, {
      attemptId: ATTEMPT_A,
      athleteId: ATHLETE_A,
      media: {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        contentType: "video/mp4",
        bytes: 10,
        deleteAt: "2030-01-16T12:00:00.000Z",
      },
    });
    const claim = (await fixture.repository.claimProcessing(job))!;
    await fixture.repository.tombstoneAttempt({
      attemptId: ATTEMPT_A,
      athleteId: ATHLETE_A,
    });

    expect(
      await fixture.repository.finalizeTerminalResult({
        attemptId: ATTEMPT_A,
        leaseId: claim.leaseId,
        generation: claim.generation,
        candidate: freeOutcome(ATTEMPT_A, fixture.clock.now()),
      }),
    ).toEqual({ kind: "tombstoned" });
    expect(
      await fixture.repository.getAttempt({
        attemptId: ATTEMPT_A,
        athleteId: ATHLETE_A,
      }),
    ).toBeNull();
  });

  it("makes independently-run overlapping finalizers choose one canonical terminal candidate", async () => {
    await fixture.repository.createAttempt({
      id: ATTEMPT_A,
      athleteId: ATHLETE_A,
      input: { mode: "free" },
    });
    const job = await attachMedia(fixture, {
      attemptId: ATTEMPT_A,
      athleteId: ATHLETE_A,
      media: {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        contentType: "video/mp4",
        bytes: 10,
        deleteAt: "2030-01-16T12:00:00.000Z",
      },
    });
    const claim = (await fixture.repository.claimProcessing(job))!;
    const firstCandidate = freeOutcome(ATTEMPT_A, fixture.clock.now());
    const secondCandidate: TerminalCandidate = {
      state: "failed",
      attemptId: ATTEMPT_A,
      mode: "free",
      code: "analysis_internal_error",
      message: FailureMessageByCode.analysis_internal_error,
      retryable: false,
    };
    const first = startRepositoryActor({
      filename: join(fixture.directory, "api.sqlite"),
      now: fixture.clock.now(),
      ids: ["dddddddd-dddd-4ddd-8ddd-dddddddddddd"],
      delayMilliseconds: 0,
      action: "finalize",
      input: {
        attemptId: ATTEMPT_A,
        leaseId: claim.leaseId,
        generation: claim.generation,
        candidate: firstCandidate,
      },
    });
    const second = startRepositoryActor({
      filename: join(fixture.directory, "api.sqlite"),
      now: fixture.clock.now(),
      ids: ["eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"],
      delayMilliseconds: 50,
      action: "finalize",
      input: {
        attemptId: ATTEMPT_A,
        leaseId: claim.leaseId,
        generation: claim.generation,
        candidate: secondCandidate,
      },
    });
    await Promise.all([first.ready, second.ready]);
    const barrier = startSqliteLockBarrier({
      filename: join(fixture.directory, "api.sqlite"),
    });
    await barrier.locked;
    first.start();
    await first.attempting;
    second.start();
    await second.attempting;
    const [firstResult, secondResult] = await Promise.all([
      first.done,
      second.done,
    ]);
    await barrier.done;

    expect(
      [firstResult, secondResult].filter((result) => !result.error),
    ).toHaveLength(1);
    const conflict = [firstResult, secondResult].find(
      (result) => result.error !== undefined,
    );
    expect(conflict?.error?.message).toBe("terminal_result_conflict");
    expect(
      fixture.database.raw
        .prepare(
          "SELECT COUNT(*) AS count FROM terminal_results WHERE attempt_id = ?",
        )
        .get(ATTEMPT_A),
    ).toMatchObject({ count: 1 });
  });

  it("lets a tombstone lock winner prevent a concurrently-finalizing actor from resurrecting", async () => {
    await fixture.repository.createAttempt({
      id: ATTEMPT_A,
      athleteId: ATHLETE_A,
      input: { mode: "free" },
    });
    const job = await attachMedia(fixture, {
      attemptId: ATTEMPT_A,
      athleteId: ATHLETE_A,
      media: {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        contentType: "video/mp4",
        bytes: 10,
        deleteAt: "2030-01-16T12:00:00.000Z",
      },
    });
    const claim = (await fixture.repository.claimProcessing(job))!;
    const tombstoneHold = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
    const tombstone = startRepositoryActor({
      filename: join(fixture.directory, "api.sqlite"),
      now: fixture.clock.now(),
      ids: [],
      delayMilliseconds: 0,
      holdAtBegin: tombstoneHold,
      action: "tombstone",
      input: { attemptId: ATTEMPT_A, athleteId: ATHLETE_A },
    });
    const finalizer = startRepositoryActor({
      filename: join(fixture.directory, "api.sqlite"),
      now: fixture.clock.now(),
      ids: ["dddddddd-dddd-4ddd-8ddd-dddddddddddd"],
      delayMilliseconds: 50,
      action: "finalize",
      input: {
        attemptId: ATTEMPT_A,
        leaseId: claim.leaseId,
        generation: claim.generation,
        candidate: freeOutcome(ATTEMPT_A, fixture.clock.now()),
      },
    });
    await Promise.all([tombstone.ready, finalizer.ready]);
    tombstone.start();
    await tombstone.acquired;
    finalizer.start();
    await finalizer.attempting;
    Atomics.store(new Int32Array(tombstoneHold), 0, 1);
    Atomics.notify(new Int32Array(tombstoneHold), 0);
    const [tombstoneResult, finalizerResult] = await Promise.all([
      tombstone.done,
      finalizer.done,
    ]);

    expect(tombstoneResult.error).toBeUndefined();
    expect(finalizerResult).toEqual({
      value: { kind: "tombstoned" },
      error: undefined,
    });
    expect(
      await fixture.repository.getAttempt({
        attemptId: ATTEMPT_A,
        athleteId: ATHLETE_A,
      }),
    ).toBeNull();
  });

  it("allows a finalizer lock winner to commit once before a concurrent tombstone retracts it", async () => {
    await fixture.repository.createAttempt({
      id: ATTEMPT_A,
      athleteId: ATHLETE_A,
      input: { mode: "free" },
    });
    const job = await attachMedia(fixture, {
      attemptId: ATTEMPT_A,
      athleteId: ATHLETE_A,
      media: {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        contentType: "video/mp4",
        bytes: 10,
        deleteAt: "2030-01-16T12:00:00.000Z",
      },
    });
    const claim = (await fixture.repository.claimProcessing(job))!;
    const finalizerHold = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
    const finalizer = startRepositoryActor({
      filename: join(fixture.directory, "api.sqlite"),
      now: fixture.clock.now(),
      ids: ["dddddddd-dddd-4ddd-8ddd-dddddddddddd"],
      delayMilliseconds: 0,
      holdAtBegin: finalizerHold,
      action: "finalize",
      input: {
        attemptId: ATTEMPT_A,
        leaseId: claim.leaseId,
        generation: claim.generation,
        candidate: freeOutcome(ATTEMPT_A, fixture.clock.now()),
      },
    });
    const tombstone = startRepositoryActor({
      filename: join(fixture.directory, "api.sqlite"),
      now: fixture.clock.now(),
      ids: [],
      delayMilliseconds: 0,
      action: "tombstone",
      input: { attemptId: ATTEMPT_A, athleteId: ATHLETE_A },
    });
    await Promise.all([finalizer.ready, tombstone.ready]);
    finalizer.start();
    await finalizer.acquired;
    tombstone.start();
    await tombstone.attempting;
    Atomics.store(new Int32Array(finalizerHold), 0, 1);
    Atomics.notify(new Int32Array(finalizerHold), 0);
    const [finalizerResult, tombstoneResult] = await Promise.all([
      finalizer.done,
      tombstone.done,
    ]);

    expect(finalizerResult.error).toBeUndefined();
    expect(finalizerResult.value).not.toBeNull();
    expect(tombstoneResult.error).toBeUndefined();
    expect(
      fixture.database.raw
        .prepare(
          "SELECT COUNT(*) AS count FROM terminal_results WHERE attempt_id = ?",
        )
        .get(ATTEMPT_A),
    ).toMatchObject({ count: 0 });
    expect(
      await fixture.repository.finalizeTerminalResult({
        attemptId: ATTEMPT_A,
        leaseId: claim.leaseId,
        generation: claim.generation,
        candidate: freeOutcome(ATTEMPT_A, fixture.clock.now()),
      }),
    ).toEqual({ kind: "tombstoned" });
  });

  it("traces a Fastify DELETE against a separately-locked finalizer without resurrection", async () => {
    await fixture.repository.createAttempt({
      id: ATTEMPT_A,
      athleteId: ATHLETE_A,
      input: { mode: "free" },
    });
    const job = await attachMedia(fixture, {
      attemptId: ATTEMPT_A,
      athleteId: ATHLETE_A,
      media: {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        contentType: "video/mp4",
        bytes: 10,
        deleteAt: "2030-01-16T12:00:00.000Z",
      },
    });
    const claim = (await fixture.repository.claimProcessing(job))!;
    const app = createAttemptApi({
      repository: fixture.repository,
      queue: new InMemoryAnalysisQueue(),
      cleaner: { cleanup: async () => undefined },
      scheduler: { everyHour: () => undefined, cancel: () => undefined },
      clock: fixture.clock,
    });
    const barrier = startSqliteLockBarrier({
      filename: join(fixture.directory, "api.sqlite"),
      holdMilliseconds: 150,
    });
    const finalizer = startRepositoryActor({
      filename: join(fixture.directory, "api.sqlite"),
      now: fixture.clock.now(),
      ids: ["dddddddd-dddd-4ddd-8ddd-dddddddddddd"],
      delayMilliseconds: 0,
      action: "finalize",
      input: {
        attemptId: ATTEMPT_A,
        leaseId: claim.leaseId,
        generation: claim.generation,
        candidate: freeOutcome(ATTEMPT_A, fixture.clock.now()),
      },
    });
    try {
      await Promise.all([barrier.locked, finalizer.ready]);
      finalizer.start();
      await finalizer.attempting;
      const deleted = await app.inject({
        method: "DELETE",
        url: `/v1/attempts/${ATTEMPT_A}`,
        headers: { "x-revelai-athlete-id": ATHLETE_A },
      });
      const finalizerResult = await finalizer.done;
      await barrier.done;

      expect(deleted.statusCode).toBe(204);
      expect(finalizerResult.error).toBeUndefined();
      expect(finalizerResult.value).toEqual(
        expect.objectContaining({
          kind: expect.stringMatching(/finalized|tombstoned/),
        }),
      );
      expect(
        await fixture.repository.getAttempt({
          attemptId: ATTEMPT_A,
          athleteId: ATHLETE_A,
        }),
      ).toBeNull();
      expect(
        fixture.database.raw
          .prepare(
            "SELECT COUNT(*) AS count FROM terminal_results WHERE attempt_id = ?",
          )
          .get(ATTEMPT_A),
      ).toEqual({ count: 0 });
      expect(
        fixture.database.raw
          .prepare(
            "SELECT COUNT(*) AS count FROM leaderboard_entries WHERE attempt_id = ?",
          )
          .get(ATTEMPT_A),
      ).toEqual({ count: 0 });
    } finally {
      await app.close();
    }
  });

  it("guards rollback and claims by attachment generation, then reclaims only after the exclusive lease boundary", async () => {
    await fixture.repository.createAttempt({
      id: ATTEMPT_A,
      athleteId: ATHLETE_A,
      input: { mode: "free" },
    });
    const firstJob = await attachMedia(fixture, {
      attemptId: ATTEMPT_A,
      athleteId: ATHLETE_A,
      media: {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        contentType: "video/mp4",
        bytes: 10,
        deleteAt: "2030-01-16T12:00:00.000Z",
      },
    });
    await fixture.repository.rollbackMediaAttachment({
      attemptId: ATTEMPT_A,
      generation: firstJob.generation,
    });
    const secondJob = await attachMedia(fixture, {
      attemptId: ATTEMPT_A,
      athleteId: ATHLETE_A,
      media: {
        id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        contentType: "video/mp4",
        bytes: 10,
        deleteAt: "2030-01-16T12:00:00.000Z",
      },
    });
    await fixture.repository.rollbackMediaAttachment({
      attemptId: ATTEMPT_A,
      generation: firstJob.generation,
    });
    await fixture.repository.recoverMediaAttachment({
      attemptId: ATTEMPT_A,
      generation: firstJob.generation,
    });

    expect(secondJob).toEqual({
      attemptId: ATTEMPT_A,
      generation: 2,
      mode: "free",
    });
    expect(
      await fixture.repository.getAttempt({
        attemptId: ATTEMPT_A,
        athleteId: ATHLETE_A,
      }),
    ).toMatchObject({
      status: "uploaded",
      media: { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
    });
    expect(
      fixture.database.raw
        .prepare(
          "SELECT cleanup_requested_at FROM media_retention_records WHERE attempt_id = ? AND media_id = ?",
        )
        .get(ATTEMPT_A, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"),
    ).toMatchObject({ cleanup_requested_at: null });
    expect(await fixture.repository.claimProcessing(firstJob)).toBeNull();
    const firstClaim = (await fixture.repository.claimProcessing(secondJob))!;
    fixture.clock.advance(5 * 60_000);
    expect(
      await fixture.repository.finalizeTerminalResult({
        attemptId: ATTEMPT_A,
        leaseId: firstClaim.leaseId,
        generation: firstClaim.generation,
        candidate: freeOutcome(ATTEMPT_A, fixture.clock.now()),
      }),
    ).toEqual({ kind: "lost-claim" });
    const secondClaim = (await fixture.repository.claimProcessing(secondJob))!;
    expect(secondClaim.generation).toBe(secondJob.generation);
    expect(secondClaim.leaseId).not.toBe(firstClaim.leaseId);
  });

  it("recovers a rejected processor delivery through the generation-preserving repository lease", async () => {
    await fixture.repository.createAttempt({
      id: ATTEMPT_A,
      athleteId: ATHLETE_A,
      input: { mode: "free" },
    });
    const job = await attachMedia(fixture, {
      attemptId: ATTEMPT_A,
      athleteId: ATHLETE_A,
      media: {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        contentType: "video/mp4",
        bytes: 10,
        deleteAt: "2030-01-16T12:00:00.000Z",
      },
    });
    const scheduler = new ManualScheduler();
    const queue = new InMemoryAnalysisQueue({ scheduler });
    let calls = 0;
    const worker = new AnalysisWorker({
      queue,
      repository: fixture.repository,
      process: async () => {
        calls += 1;
        if (calls === 1)
          throw new RetryableProcessingFailure("temporary processor rejection");
        return freeOutcome(ATTEMPT_A, fixture.clock.now());
      },
    });
    const stop = worker.start();

    await queue.enqueue(job);
    await scheduler.runAll();
    stop();

    expect(calls).toBe(2);
    expect(
      await fixture.repository.getAttempt({
        attemptId: ATTEMPT_A,
        athleteId: ATHLETE_A,
      }),
    ).toMatchObject({ status: "valid", outcome: { state: "valid" } });
  });

  it("settles a permanent processor failure through bounded yielded retries with one terminal fact", async () => {
    await fixture.repository.createAttempt({
      id: ATTEMPT_A,
      athleteId: ATHLETE_A,
      input: { mode: "free" },
    });
    const job = await attachMedia(fixture, {
      attemptId: ATTEMPT_A,
      athleteId: ATHLETE_A,
      media: {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        contentType: "video/mp4",
        bytes: 10,
        deleteAt: "2030-01-16T12:00:00.000Z",
      },
    });
    const scheduler = new ManualScheduler();
    const queue = new InMemoryAnalysisQueue({ scheduler });
    let calls = 0;
    const delays: number[] = [];
    const worker = new AnalysisWorker({
      queue,
      repository: fixture.repository,
      process: async () => {
        calls += 1;
        throw new RetryableProcessingFailure("permanent processor failure");
      },
      unexpectedRetryPolicy: {
        maxAttempts: 2,
        delayMilliseconds: 0,
        terminalCandidate: ({ job: failedJob, claim }) => ({
          state: "failed",
          attemptId: failedJob.attemptId,
          mode: claim.mode,
          code: "analysis_internal_error",
          message: "A análise não pôde ser concluída.",
          retryable: false,
        }),
      },
      retryWaiter: {
        wait: async (delayMilliseconds) => {
          delays.push(delayMilliseconds);
        },
      },
    });
    const stop = worker.start();

    await queue.enqueue(job);
    await scheduler.runAll();
    stop();

    expect({ calls, delays, scheduled: scheduler.tasks.length }).toEqual({
      calls: 2,
      delays: [0],
      scheduled: 0,
    });
    expect(
      await fixture.repository.getAttempt({
        attemptId: ATTEMPT_A,
        athleteId: ATHLETE_A,
      }),
    ).toMatchObject({
      status: "failed",
      outcome: { code: "analysis_internal_error", retryable: false },
    });
    expect(
      fixture.database.raw
        .prepare(
          "SELECT COUNT(*) AS count FROM terminal_results WHERE attempt_id = ?",
        )
        .get(ATTEMPT_A),
    ).toMatchObject({ count: 1 });
  });

  it("settles an invalid classified candidate as one internal terminal result without spending a retry", async () => {
    await fixture.repository.createAttempt({
      id: ATTEMPT_A,
      athleteId: ATHLETE_A,
      input: { mode: "free" },
    });
    const job = await attachMedia(fixture, {
      attemptId: ATTEMPT_A,
      athleteId: ATHLETE_A,
      media: {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        contentType: "video/mp4",
        bytes: 10,
        deleteAt: "2030-01-16T12:00:00.000Z",
      },
    });
    const scheduler = new ManualScheduler();
    const queue = new InMemoryAnalysisQueue({ scheduler });
    let calls = 0;
    let fallbackBuilds = 0;
    const worker = new AnalysisWorker({
      queue,
      repository: fixture.repository,
      process: async () => {
        calls += 1;
        throw new ExpectedProcessingFailure(
          freeOutcome(ATTEMPT_B, fixture.clock.now()),
        );
      },
      unexpectedRetryPolicy: {
        maxAttempts: 2,
        delayMilliseconds: 0,
        terminalCandidate: ({ job: failedJob, claim }) => {
          fallbackBuilds += 1;
          return {
            state: "failed",
            attemptId: failedJob.attemptId,
            mode: claim.mode,
            code: "analysis_internal_error",
            message: FailureMessageByCode.analysis_internal_error,
            retryable: false,
          };
        },
      },
      retryWaiter: { wait: async () => undefined },
    });
    const stop = worker.start();

    await queue.enqueue(job);
    await scheduler.runAll();
    stop();

    expect({
      calls,
      fallbackBuilds,
      scheduled: scheduler.tasks.length,
    }).toEqual({
      calls: 1,
      fallbackBuilds: 0,
      scheduled: 0,
    });
    expect(
      await fixture.repository.getAttempt({
        attemptId: ATTEMPT_A,
        athleteId: ATHLETE_A,
      }),
    ).toMatchObject({
      status: "failed",
      outcome: { code: "analysis_internal_error" },
    });
    expect(
      fixture.database.raw
        .prepare(
          "SELECT COUNT(*) AS count FROM terminal_results WHERE attempt_id = ?",
        )
        .get(ATTEMPT_A),
    ).toMatchObject({ count: 1 });
  });

  it("replaces a transient finalizer rejection with one internal terminal result without a new claim", async () => {
    await fixture.repository.createAttempt({
      id: ATTEMPT_A,
      athleteId: ATHLETE_A,
      input: { mode: "free" },
    });
    const job = await attachMedia(fixture, {
      attemptId: ATTEMPT_A,
      athleteId: ATHLETE_A,
      media: {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        contentType: "video/mp4",
        bytes: 10,
        deleteAt: "2030-01-16T12:00:00.000Z",
      },
    });
    const scheduler = new ManualScheduler();
    const queue = new InMemoryAnalysisQueue({ scheduler });
    let processCalls = 0;
    let finalizerCalls = 0;
    let recoveryWrites = 0;
    const worker = new AnalysisWorker({
      queue,
      repository: {
        claimProcessing: (queuedJob) =>
          fixture.repository.claimProcessing(queuedJob),
        releaseProcessingClaim: (input) =>
          fixture.repository.releaseProcessingClaim(input),
        recordProcessingFailure: async (input) => {
          recoveryWrites += 1;
          return fixture.repository.recordProcessingFailure(input);
        },
        deadLetterProcessingClaim: (input) =>
          fixture.repository.deadLetterProcessingClaim(input),
        finalizeTerminalResult: async (input) => {
          finalizerCalls += 1;
          if (finalizerCalls === 1)
            throw new Error("temporary finalizer failure");
          return fixture.repository.finalizeTerminalResult(input);
        },
      },
      process: async () => {
        processCalls += 1;
        return freeOutcome(ATTEMPT_A, fixture.clock.now());
      },
    });
    const stop = worker.start();

    await queue.enqueue(job);
    await scheduler.runAll();
    stop();

    expect({
      processCalls,
      finalizerCalls,
      recoveryWrites,
      scheduled: scheduler.tasks.length,
    }).toEqual({
      processCalls: 1,
      finalizerCalls: 2,
      recoveryWrites: 0,
      scheduled: 0,
    });
    expect(
      fixture.database.raw
        .prepare(
          "SELECT COUNT(*) AS count FROM terminal_results WHERE attempt_id = ?",
        )
        .get(ATTEMPT_A),
    ).toMatchObject({ count: 1 });
  });

  it("settles permanent candidate finalizer rejections through one internal terminal fallback", async () => {
    await fixture.repository.createAttempt({
      id: ATTEMPT_A,
      athleteId: ATHLETE_A,
      input: { mode: "free" },
    });
    const job = await attachMedia(fixture, {
      attemptId: ATTEMPT_A,
      athleteId: ATHLETE_A,
      media: {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        contentType: "video/mp4",
        bytes: 10,
        deleteAt: "2030-01-16T12:00:00.000Z",
      },
    });
    const scheduler = new ManualScheduler();
    const queue = new InMemoryAnalysisQueue({ scheduler });
    let finalizerCalls = 0;
    let recoveryWrites = 0;
    let fallbackBuilds = 0;
    const worker = new AnalysisWorker({
      queue,
      repository: {
        claimProcessing: (queuedJob) =>
          fixture.repository.claimProcessing(queuedJob),
        releaseProcessingClaim: (input) =>
          fixture.repository.releaseProcessingClaim(input),
        recordProcessingFailure: async (input) => {
          recoveryWrites += 1;
          return fixture.repository.recordProcessingFailure(input);
        },
        deadLetterProcessingClaim: (input) =>
          fixture.repository.deadLetterProcessingClaim(input),
        finalizeTerminalResult: async (input) => {
          finalizerCalls += 1;
          if (input.candidate.state === "valid")
            throw new Error("permanent candidate finalizer failure");
          return fixture.repository.finalizeTerminalResult(input);
        },
      },
      process: async () => freeOutcome(ATTEMPT_A, fixture.clock.now()),
      unexpectedRetryPolicy: {
        maxAttempts: 2,
        delayMilliseconds: 0,
        terminalCandidate: ({ job: failedJob, claim }) => {
          fallbackBuilds += 1;
          return {
            state: "failed",
            attemptId: failedJob.attemptId,
            mode: claim.mode,
            code: "analysis_internal_error",
            message: FailureMessageByCode.analysis_internal_error,
            retryable: false,
          };
        },
      },
      retryWaiter: { wait: async () => undefined },
    });
    const stop = worker.start();

    await queue.enqueue(job);
    await scheduler.runAll();
    stop();

    expect({
      finalizerCalls,
      recoveryWrites,
      fallbackBuilds,
      scheduled: scheduler.tasks.length,
    }).toEqual({
      finalizerCalls: 2,
      recoveryWrites: 0,
      fallbackBuilds: 0,
      scheduled: 0,
    });
    expect(
      await fixture.repository.getAttempt({
        attemptId: ATTEMPT_A,
        athleteId: ATHLETE_A,
      }),
    ).toMatchObject({
      status: "failed",
      outcome: { code: "analysis_internal_error" },
    });
    expect(
      fixture.database.raw
        .prepare(
          "SELECT COUNT(*) AS count FROM terminal_results WHERE attempt_id = ?",
        )
        .get(ATTEMPT_A),
    ).toMatchObject({ count: 1 });
  });

  it("replaces a broken exhausted retry fallback builder with one internal terminal result", async () => {
    await fixture.repository.createAttempt({
      id: ATTEMPT_A,
      athleteId: ATHLETE_A,
      input: { mode: "free" },
    });
    const job = await attachMedia(fixture, {
      attemptId: ATTEMPT_A,
      athleteId: ATHLETE_A,
      media: {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        contentType: "video/mp4",
        bytes: 10,
        deleteAt: "2030-01-16T12:00:00.000Z",
      },
    });
    const scheduler = new ManualScheduler();
    const queue = new InMemoryAnalysisQueue({ scheduler });
    let fallbackCalls = 0;
    const worker = new AnalysisWorker({
      queue,
      repository: fixture.repository,
      process: async () => {
        throw new RetryableProcessingFailure("permanent processor failure");
      },
      unexpectedRetryPolicy: {
        maxAttempts: 1,
        delayMilliseconds: 0,
        terminalCandidate: () => {
          fallbackCalls += 1;
          throw new Error("broken terminal fallback");
        },
      },
      retryWaiter: { wait: async () => undefined },
    });
    const stop = worker.start();

    await queue.enqueue(job);
    await scheduler.runAll();
    stop();

    expect({ fallbackCalls, scheduled: scheduler.tasks.length }).toEqual({
      fallbackCalls: 1,
      scheduled: 0,
    });
    expect(
      await fixture.repository.getAttempt({
        attemptId: ATTEMPT_A,
        athleteId: ATHLETE_A,
      }),
    ).toMatchObject({
      status: "failed",
      outcome: { code: "analysis_internal_error", retryable: false },
    });
    expect(
      fixture.database.raw
        .prepare(
          "SELECT state FROM processing_recovery_records WHERE attempt_id = ? AND generation = ?",
        )
        .get(ATTEMPT_A, job.generation),
    ).toBeUndefined();
    expect(await fixture.repository.claimProcessing(job)).toBeNull();
    expect(
      fixture.database.raw
        .prepare(
          "SELECT COUNT(*) AS count FROM terminal_results WHERE attempt_id = ?",
        )
        .get(ATTEMPT_A),
    ).toMatchObject({ count: 1 });
  });

  it("replaces an invalid exhausted retry fallback candidate with one internal terminal result", async () => {
    await fixture.repository.createAttempt({
      id: ATTEMPT_A,
      athleteId: ATHLETE_A,
      input: { mode: "free" },
    });
    const job = await attachMedia(fixture, {
      attemptId: ATTEMPT_A,
      athleteId: ATHLETE_A,
      media: {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        contentType: "video/mp4",
        bytes: 10,
        deleteAt: "2030-01-16T12:00:00.000Z",
      },
    });
    const scheduler = new ManualScheduler();
    const queue = new InMemoryAnalysisQueue({ scheduler });
    const worker = new AnalysisWorker({
      queue,
      repository: fixture.repository,
      process: async () => {
        throw new RetryableProcessingFailure("permanent processor failure");
      },
      unexpectedRetryPolicy: {
        maxAttempts: 1,
        delayMilliseconds: 0,
        terminalCandidate: () => freeOutcome(ATTEMPT_B, fixture.clock.now()),
      },
      retryWaiter: { wait: async () => undefined },
    });
    const stop = worker.start();

    await queue.enqueue(job);
    await scheduler.runAll();
    stop();

    expect(scheduler.tasks).toEqual([]);
    expect(
      await fixture.repository.getAttempt({
        attemptId: ATTEMPT_A,
        athleteId: ATHLETE_A,
      }),
    ).toMatchObject({
      status: "failed",
      outcome: { code: "analysis_internal_error", retryable: false },
    });
    expect(
      fixture.database.raw
        .prepare(
          "SELECT state FROM processing_recovery_records WHERE attempt_id = ? AND generation = ?",
        )
        .get(ATTEMPT_A, job.generation),
    ).toBeUndefined();
  });

  it("leaves a permanently rejecting finalizer claim unacknowledged without retry accounting", async () => {
    await fixture.repository.createAttempt({
      id: ATTEMPT_A,
      athleteId: ATHLETE_A,
      input: { mode: "free" },
    });
    const job = await attachMedia(fixture, {
      attemptId: ATTEMPT_A,
      athleteId: ATHLETE_A,
      media: {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        contentType: "video/mp4",
        bytes: 10,
        deleteAt: "2030-01-16T12:00:00.000Z",
      },
    });
    const scheduler = new ManualScheduler();
    const queue = new InMemoryAnalysisQueue({ scheduler });
    let finalizerCalls = 0;
    const worker = new AnalysisWorker({
      queue,
      repository: {
        claimProcessing: (queuedJob) =>
          fixture.repository.claimProcessing(queuedJob),
        releaseProcessingClaim: (input) =>
          fixture.repository.releaseProcessingClaim(input),
        recordProcessingFailure: (input) =>
          fixture.repository.recordProcessingFailure(input),
        deadLetterProcessingClaim: (input) =>
          fixture.repository.deadLetterProcessingClaim(input),
        finalizeTerminalResult: async () => {
          finalizerCalls += 1;
          throw new Error("finalizer is permanently unavailable");
        },
      },
      process: async () => freeOutcome(ATTEMPT_A, fixture.clock.now()),
      unexpectedRetryPolicy: {
        maxAttempts: 1,
        delayMilliseconds: 0,
        terminalCandidate: ({ job: failedJob, claim }) => ({
          state: "failed",
          attemptId: failedJob.attemptId,
          mode: claim.mode,
          code: "analysis_internal_error",
          message: FailureMessageByCode.analysis_internal_error,
          retryable: false,
        }),
      },
      retryWaiter: { wait: async () => undefined },
    });
    const stop = worker.start();

    await queue.enqueue(job);
    await scheduler.runAll();
    stop();

    expect({ finalizerCalls, scheduled: scheduler.tasks.length }).toEqual({
      finalizerCalls: 2,
      scheduled: 0,
    });
    expect(
      await fixture.repository.getAttempt({
        attemptId: ATTEMPT_A,
        athleteId: ATHLETE_A,
      }),
    ).toMatchObject({ status: "processing", outcome: { state: "pending" } });
    expect(
      fixture.database.raw
        .prepare(
          "SELECT COUNT(*) AS count FROM processing_recovery_records WHERE attempt_id = ? AND generation = ?",
        )
        .get(ATTEMPT_A, job.generation),
    ).toEqual({ count: 0 });
  });

  it("reclaims an exact-boundary lease instead of acknowledging its unfinished result", async () => {
    await fixture.repository.createAttempt({
      id: ATTEMPT_A,
      athleteId: ATHLETE_A,
      input: { mode: "free" },
    });
    const job = await attachMedia(fixture, {
      attemptId: ATTEMPT_A,
      athleteId: ATHLETE_A,
      media: {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        contentType: "video/mp4",
        bytes: 10,
        deleteAt: "2030-01-16T12:00:00.000Z",
      },
    });
    const scheduler = new ManualScheduler();
    const queue = new InMemoryAnalysisQueue({ scheduler });
    let calls = 0;
    const worker = new AnalysisWorker({
      queue,
      repository: fixture.repository,
      process: async () => {
        calls += 1;
        if (calls === 1) fixture.clock.advance(5 * 60_000);
        return freeOutcome(ATTEMPT_A, fixture.clock.now());
      },
      unexpectedRetryPolicy: {
        maxAttempts: 2,
        delayMilliseconds: 0,
        terminalCandidate: ({ job: failedJob, claim }) => ({
          state: "failed",
          attemptId: failedJob.attemptId,
          mode: claim.mode,
          code: "analysis_internal_error",
          message: FailureMessageByCode.analysis_internal_error,
          retryable: false,
        }),
      },
      retryWaiter: { wait: async () => undefined },
    });
    const stop = worker.start();

    await queue.enqueue(job);
    await scheduler.runAll();
    stop();

    expect({ calls, scheduled: scheduler.tasks.length }).toEqual({
      calls: 2,
      scheduled: 0,
    });
    expect(
      await fixture.repository.getAttempt({
        attemptId: ATTEMPT_A,
        athleteId: ATHLETE_A,
      }),
    ).toMatchObject({ status: "valid", outcome: { state: "valid" } });
    expect(
      fixture.database.raw
        .prepare(
          "SELECT COUNT(*) AS count FROM terminal_results WHERE attempt_id = ?",
        )
        .get(ATTEMPT_A),
    ).toMatchObject({ count: 1 });
  });

  it("reclaims exact expiry at maxAttempts one and terminalizes only a later processing failure", async () => {
    await fixture.repository.createAttempt({
      id: ATTEMPT_A,
      athleteId: ATHLETE_A,
      input: { mode: "free" },
    });
    const job = await attachMedia(fixture, {
      attemptId: ATTEMPT_A,
      athleteId: ATHLETE_A,
      media: {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        contentType: "video/mp4",
        bytes: 10,
        deleteAt: "2030-01-16T12:00:00.000Z",
      },
    });
    const scheduler = new ManualScheduler();
    const queue = new InMemoryAnalysisQueue({ scheduler });
    let calls = 0;
    const worker = new AnalysisWorker({
      queue,
      repository: fixture.repository,
      process: async () => {
        calls += 1;
        if (calls === 1) {
          fixture.clock.advance(5 * 60_000);
          return freeOutcome(ATTEMPT_A, fixture.clock.now());
        }
        throw new Error("actual processing failure after reclaim");
      },
      unexpectedRetryPolicy: {
        maxAttempts: 1,
        delayMilliseconds: 0,
        terminalCandidate: ({ job: failedJob, claim }) => ({
          state: "failed",
          attemptId: failedJob.attemptId,
          mode: claim.mode,
          code: "analysis_internal_error",
          message: FailureMessageByCode.analysis_internal_error,
          retryable: false,
        }),
      },
      retryWaiter: { wait: async () => undefined },
    });
    const stop = worker.start();

    await queue.enqueue(job);
    await scheduler.runAll();
    stop();

    expect({ calls, scheduled: scheduler.tasks.length }).toEqual({
      calls: 2,
      scheduled: 0,
    });
    expect(
      await fixture.repository.getAttempt({
        attemptId: ATTEMPT_A,
        athleteId: ATHLETE_A,
      }),
    ).toMatchObject({
      status: "failed",
      outcome: { code: "analysis_internal_error" },
    });
    expect(
      fixture.database.raw
        .prepare(
          "SELECT COUNT(*) AS count FROM processing_recovery_records WHERE attempt_id = ?",
        )
        .get(ATTEMPT_A),
    ).toMatchObject({ count: 0 });
  });

  it("does not consume a pre-seeded at-limit recovery budget on exact lease expiry", async () => {
    await fixture.repository.createAttempt({
      id: ATTEMPT_A,
      athleteId: ATHLETE_A,
      input: { mode: "free" },
    });
    const job = await attachMedia(fixture, {
      attemptId: ATTEMPT_A,
      athleteId: ATHLETE_A,
      media: {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        contentType: "video/mp4",
        bytes: 10,
        deleteAt: "2030-01-16T12:00:00.000Z",
      },
    });
    const preseedClaim = (await fixture.repository.claimProcessing(job))!;
    await fixture.repository.recordProcessingFailure({
      attemptId: ATTEMPT_A,
      leaseId: preseedClaim.leaseId,
      generation: preseedClaim.generation,
    });
    await fixture.repository.releaseProcessingClaim({
      attemptId: ATTEMPT_A,
      leaseId: preseedClaim.leaseId,
      generation: preseedClaim.generation,
    });
    const scheduler = new ManualScheduler();
    const queue = new InMemoryAnalysisQueue({ scheduler });
    let calls = 0;
    const worker = new AnalysisWorker({
      queue,
      repository: fixture.repository,
      process: async () => {
        calls += 1;
        if (calls === 1) fixture.clock.advance(5 * 60_000);
        return freeOutcome(ATTEMPT_A, fixture.clock.now());
      },
      unexpectedRetryPolicy: {
        maxAttempts: 1,
        delayMilliseconds: 0,
        terminalCandidate: ({ job: failedJob, claim }) => ({
          state: "failed",
          attemptId: failedJob.attemptId,
          mode: claim.mode,
          code: "analysis_internal_error",
          message: FailureMessageByCode.analysis_internal_error,
          retryable: false,
        }),
      },
      retryWaiter: { wait: async () => undefined },
    });
    const stop = worker.start();

    await queue.enqueue(job);
    await scheduler.runAll();
    stop();

    expect({ calls, scheduled: scheduler.tasks.length }).toEqual({
      calls: 2,
      scheduled: 0,
    });
    expect(
      await fixture.repository.getAttempt({
        attemptId: ATTEMPT_A,
        athleteId: ATHLETE_A,
      }),
    ).toMatchObject({ status: "valid", outcome: { state: "valid" } });
    expect(
      fixture.database.raw
        .prepare(
          "SELECT COUNT(*) AS count FROM processing_recovery_records WHERE attempt_id = ?",
        )
        .get(ATTEMPT_A),
    ).toMatchObject({ count: 0 });
  });

  it("saturates a persisted maximum recovery budget into one durable terminal outcome", async () => {
    await fixture.repository.createAttempt({
      id: ATTEMPT_A,
      athleteId: ATHLETE_A,
      input: { mode: "free" },
    });
    const job = await attachMedia(fixture, {
      attemptId: ATTEMPT_A,
      athleteId: ATHLETE_A,
      media: {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        contentType: "video/mp4",
        bytes: 10,
        deleteAt: "2030-01-16T12:00:00.000Z",
      },
    });
    const initialClaim = (await fixture.repository.claimProcessing(job))!;
    fixture.database.raw
      .prepare(
        "INSERT INTO processing_recovery_records (attempt_id, generation, retry_attempts, state, created_at, updated_at) VALUES (?, ?, ?, 'retrying', ?, ?)",
      )
      .run(
        ATTEMPT_A,
        initialClaim.generation,
        Number.MAX_SAFE_INTEGER,
        fixture.clock.now(),
        fixture.clock.now(),
      );
    await fixture.repository.releaseProcessingClaim({
      attemptId: ATTEMPT_A,
      leaseId: initialClaim.leaseId,
      generation: initialClaim.generation,
    });

    const scheduler = new ManualScheduler();
    const queue = new InMemoryAnalysisQueue({ scheduler });
    const worker = new AnalysisWorker({
      queue,
      repository: fixture.repository,
      process: async () => {
        throw new RetryableProcessingFailure(
          "processor fault after exhausted recovery budget",
        );
      },
      unexpectedRetryPolicy: {
        maxAttempts: 1,
        delayMilliseconds: 0,
        terminalCandidate: ({ job: failedJob, claim }) => ({
          state: "failed",
          attemptId: failedJob.attemptId,
          mode: claim.mode,
          code: "analysis_internal_error",
          message: FailureMessageByCode.analysis_internal_error,
          retryable: false,
        }),
      },
      retryWaiter: { wait: async () => undefined },
    });
    const stop = worker.start();

    await queue.enqueue(job);
    await scheduler.runAll();
    stop();

    expect(scheduler.tasks).toHaveLength(0);
    expect(
      await fixture.repository.getAttempt({
        attemptId: ATTEMPT_A,
        athleteId: ATHLETE_A,
      }),
    ).toMatchObject({
      status: "failed",
      outcome: { code: "analysis_internal_error" },
    });
    expect(
      fixture.database.raw
        .prepare(
          "SELECT COUNT(*) AS count FROM terminal_results WHERE attempt_id = ?",
        )
        .get(ATTEMPT_A),
    ).toMatchObject({ count: 1 });
    expect(
      fixture.database.raw
        .prepare(
          "SELECT status, processing_lease_id AS leaseId FROM attempts WHERE id = ?",
        )
        .get(ATTEMPT_A),
    ).toEqual({ status: "failed", leaseId: null });

    const reopened = fixture.openSecondaryDatabase();
    const resumed = SQLiteAttemptRepository.forReadOnlyTest({
      database: reopened,
      clock: fixture.clock,
      ids: new TestIds(LEASE_B),
    });
    expect(
      await resumed.getAttempt({ attemptId: ATTEMPT_A, athleteId: ATHLETE_A }),
    ).toMatchObject({
      status: "failed",
      outcome: { code: "analysis_internal_error" },
    });
    expect(await resumed.claimProcessing(job)).toBeNull();
  });

  it("replaces rejected recovery accounting with one internal terminal result", async () => {
    await fixture.repository.createAttempt({
      id: ATTEMPT_A,
      athleteId: ATHLETE_A,
      input: { mode: "free" },
    });
    const job = await attachMedia(fixture, {
      attemptId: ATTEMPT_A,
      athleteId: ATHLETE_A,
      media: {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        contentType: "video/mp4",
        bytes: 10,
        deleteAt: "2030-01-16T12:00:00.000Z",
      },
    });
    fixture.database.raw.exec(`
      CREATE TRIGGER reject_processing_recovery
      BEFORE INSERT ON processing_recovery_records
      BEGIN
        SELECT RAISE(ABORT, 'forced recovery rejection');
      END;
    `);
    const scheduler = new ManualScheduler();
    const queue = new InMemoryAnalysisQueue({ scheduler });
    const worker = new AnalysisWorker({
      queue,
      repository: fixture.repository,
      process: async () => {
        throw new RetryableProcessingFailure("processor failure");
      },
      retryWaiter: { wait: async () => undefined },
    });
    const stop = worker.start();

    await queue.enqueue(job);
    await scheduler.runAll();
    stop();

    expect(scheduler.tasks).toHaveLength(0);
    expect(
      await fixture.repository.getAttempt({
        attemptId: ATTEMPT_A,
        athleteId: ATHLETE_A,
      }),
    ).toMatchObject({
      status: "failed",
      outcome: { code: "analysis_internal_error", retryable: false },
    });
    expect(
      fixture.database.raw
        .prepare(
          "SELECT COUNT(*) AS count FROM terminal_results WHERE attempt_id = ?",
        )
        .get(ATTEMPT_A),
    ).toMatchObject({ count: 1 });
    expect(
      fixture.database.raw
        .prepare(
          "SELECT processing_lease_id AS leaseId FROM attempts WHERE id = ?",
        )
        .get(ATTEMPT_A),
    ).toEqual({ leaseId: null });
  });

  it("persists recovery attempts by attachment generation across repository instances", async () => {
    await fixture.repository.createAttempt({
      id: ATTEMPT_A,
      athleteId: ATHLETE_A,
      input: { mode: "free" },
    });
    const job = await attachMedia(fixture, {
      attemptId: ATTEMPT_A,
      athleteId: ATHLETE_A,
      media: {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        contentType: "video/mp4",
        bytes: 10,
        deleteAt: "2030-01-16T12:00:00.000Z",
      },
    });
    const firstClaim = (await fixture.repository.claimProcessing(job))!;
    await expect(
      fixture.repository.recordProcessingFailure({
        attemptId: ATTEMPT_A,
        leaseId: firstClaim.leaseId,
        generation: firstClaim.generation,
      }),
    ).resolves.toEqual({ kind: "recorded", retryAttempt: 1 });
    await fixture.repository.releaseProcessingClaim({
      attemptId: ATTEMPT_A,
      leaseId: firstClaim.leaseId,
      generation: firstClaim.generation,
    });

    const reopened = fixture.openSecondaryDatabase();
    const resumed = SQLiteAttemptRepository.forReadOnlyTest({
      database: reopened,
      clock: fixture.clock,
      ids: new TestIds(LEASE_B),
    });
    const secondClaim = (await resumed.claimProcessing(job))!;
    await expect(
      resumed.recordProcessingFailure({
        attemptId: ATTEMPT_A,
        leaseId: secondClaim.leaseId,
        generation: secondClaim.generation,
      }),
    ).resolves.toEqual({ kind: "recorded", retryAttempt: 2 });
    await expect(
      resumed.deadLetterProcessingClaim({
        attemptId: ATTEMPT_A,
        leaseId: secondClaim.leaseId,
        generation: secondClaim.generation,
      }),
    ).resolves.toEqual({ kind: "dead-lettered" });
    expect(await fixture.repository.claimProcessing(job)).toBeNull();
  });

  it("retracts a ranked terminal fact, observations, and retained media without resurrection", async () => {
    await fixture.repository.issueCalibrationSession({
      id: SESSION_A,
      athleteId: ATHLETE_A,
      nonce: "a".repeat(43),
      challengeId: "wall-pass",
      challengeVersion: 1,
    });
    await fixture.repository.readyCalibrationSession({
      id: SESSION_A,
      athleteId: ATHLETE_A,
      requiredGates: ["device", "space", "athlete", "rehearsal", "record"],
    });
    await fixture.repository.createAttempt({
      id: ATTEMPT_A,
      athleteId: ATHLETE_A,
      input: {
        mode: "verified",
        challengeId: "wall-pass",
        challengeVersion: 1,
        calibrationSessionId: SESSION_A,
      },
    });
    const job = await attachMedia(fixture, {
      attemptId: ATTEMPT_A,
      athleteId: ATHLETE_A,
      media: {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        contentType: "video/mp4",
        bytes: 10,
        deleteAt: "2030-01-16T12:00:00.000Z",
      },
    });
    const claim = (await fixture.repository.claimProcessing(job))!;
    const { rankedPolicy } = await activatePassingCompetitivePolicy(fixture);
    await fixture.repository.finalizeTerminalResult({
      attemptId: ATTEMPT_A,
      leaseId: claim.leaseId,
      generation: claim.generation,
      candidate: rankedOutcome(ATTEMPT_A, fixture.clock.now(), 80),
      rankedPolicy,
    });
    fixture.database.raw
      .prepare(
        "INSERT INTO canonical_observations (id, attempt_id, payload_json, delete_at, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        "observation-a",
        ATTEMPT_A,
        '{"kind":"test"}',
        "2030-01-16T12:00:00.000Z",
        fixture.clock.now(),
      );
    await fixture.repository.tombstoneAttempt({
      attemptId: ATTEMPT_A,
      athleteId: ATHLETE_A,
    });

    expect(
      fixture.database.raw
        .prepare(
          "SELECT COUNT(*) AS count FROM terminal_results WHERE attempt_id = ?",
        )
        .get(ATTEMPT_A),
    ).toMatchObject({ count: 0 });
    expect(
      fixture.database.raw
        .prepare(
          "SELECT COUNT(*) AS count FROM canonical_observations WHERE attempt_id = ?",
        )
        .get(ATTEMPT_A),
    ).toMatchObject({ count: 0 });
    expect(
      fixture.database.raw
        .prepare(
          "SELECT cleanup_requested_at FROM media_retention_records WHERE attempt_id = ?",
        )
        .get(ATTEMPT_A),
    ).toMatchObject({ cleanup_requested_at: fixture.clock.now() });
    expect(
      await fixture.repository.finalizeTerminalResult({
        attemptId: ATTEMPT_A,
        leaseId: claim.leaseId,
        generation: claim.generation,
        candidate: rankedOutcome(ATTEMPT_A, fixture.clock.now(), 80),
      }),
    ).toEqual({ kind: "tombstoned" });
    expect(
      fixture.database.raw
        .prepare(
          "SELECT COUNT(*) AS count FROM leaderboard_entries WHERE attempt_id = ?",
        )
        .get(ATTEMPT_A),
    ).toMatchObject({ count: 0 });
  });

  it("rejects invalid cursors and corrupt persisted media with stable errors", async () => {
    await fixture.repository.createAttempt({
      id: ATTEMPT_A,
      athleteId: ATHLETE_A,
      input: { mode: "free" },
    });
    await attachMedia(fixture, {
      attemptId: ATTEMPT_A,
      athleteId: ATHLETE_A,
      media: {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        contentType: "video/mp4",
        bytes: 10,
        deleteAt: "2030-01-16T12:00:00.000Z",
      },
    });
    expect(() =>
      fixture.database.raw
        .prepare("UPDATE attempts SET media_json = ? WHERE id = ?")
        .run("{not-json", ATTEMPT_A),
    ).toThrow("invalid C5 media transition");
    fixture.database.raw.exec(
      "DROP TRIGGER attempts_media_json_requires_c5_transition",
    );
    fixture.database.raw
      .prepare("UPDATE attempts SET media_json = ? WHERE id = ?")
      .run("{not-json", ATTEMPT_A);

    await expect(
      fixture.repository.getAttempt({
        attemptId: ATTEMPT_A,
        athleteId: ATHLETE_A,
      }),
    ).rejects.toMatchObject({ code: "persisted_data_corrupt" });
    await expect(
      fixture.repository.listAttempts({
        athleteId: ATHLETE_A,
        limit: 1,
        cursor: "not-a-cursor",
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("reopens persisted attempts and applies migrations idempotently", async () => {
    await fixture.repository.createAttempt({
      id: ATTEMPT_A,
      athleteId: ATHLETE_A,
      input: { mode: "free" },
    });
    const reopened = fixture.openSecondaryDatabase();
    const repository = SQLiteAttemptRepository.forReadOnlyTest({
      database: reopened,
      clock: fixture.clock,
      ids: new TestIds(LEASE_B, ENTRY_B),
    });

    expect(
      await repository.getAttempt({
        attemptId: ATTEMPT_A,
        athleteId: ATHLETE_A,
      }),
    ).toMatchObject({ id: ATTEMPT_A });
  });

  it("upgrades the exact v16 predecessor with a reopen-safe delivery recovery outbox", () => {
    const filename = join(fixture.directory, "delivery-recovery-v16.sqlite");
    const predecessor = openSqliteDatabaseAtVersionForTest(filename, 16);
    expect(
      predecessor.raw
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'media_delivery_recovery_records'",
        )
        .get(),
    ).toBeUndefined();
    predecessor.close();

    const upgraded = openSqliteDatabase(filename);
    expect(
      upgraded.raw
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'media_delivery_recovery_records'",
        )
        .get(),
    ).toMatchObject({ sql: expect.stringContaining("pending-delivery") });
    upgraded.close();

    const reopened = openSqliteDatabase(filename);
    expect(
      reopened.raw
        .prepare("SELECT COUNT(*) AS count FROM schema_migrations")
        .get(),
    ).toEqual({ count: 22 });
    reopened.close();
  });

  it("repairs exact v20 terminal predecessors transactionally and leaves mismatches fail-closed", async () => {
    const completedAt = fixture.clock.now();
    const validFilename = join(fixture.directory, "legacy-terminal-v20.sqlite");
    const predecessor = createV20TerminalPredecessor(validFilename, {
      attemptId: ATTEMPT_A,
      outcome: freeOutcome(ATTEMPT_A, completedAt),
      completedAt,
    });
    expect(predecessor.raw.pragma("user_version", { simple: true })).toBe(20);
    predecessor.close();

    const normalized = openSqliteDatabase(validFilename);
    expect(
      normalized.raw
        .prepare("SELECT status FROM attempts WHERE id = ?")
        .get(ATTEMPT_A),
    ).toEqual({ status: "valid" });
    expect(normalized.raw.pragma("user_version", { simple: true })).toBe(22);
    normalized.close();

    const staleCurrent = openSqliteDatabaseAtVersionForTest(validFilename, 22);
    staleCurrent.raw.pragma("user_version = 0");
    staleCurrent.close();

    const idempotent = openSqliteDatabase(validFilename);
    expect(
      idempotent.raw
        .prepare("SELECT COUNT(*) AS count FROM schema_migrations")
        .get(),
    ).toEqual({ count: 22 });
    expect(idempotent.raw.pragma("user_version", { simple: true })).toBe(22);
    expect(
      idempotent.raw
        .prepare("SELECT status FROM attempts WHERE id = ?")
        .get(ATTEMPT_A),
    ).toEqual({ status: "valid" });
    idempotent.close();

    const mismatchFilename = join(
      fixture.directory,
      "legacy-terminal-v20-mismatch.sqlite",
    );
    const mismatchPredecessor = createV20TerminalPredecessor(mismatchFilename, {
      attemptId: ATTEMPT_A,
      outcome: freeOutcome(ATTEMPT_B, completedAt),
      completedAt,
    });
    mismatchPredecessor.close();
    const mismatch = openSqliteDatabase(mismatchFilename);
    expect(
      mismatch.raw
        .prepare("SELECT status FROM attempts WHERE id = ?")
        .get(ATTEMPT_A),
    ).toEqual({ status: "processing" });
    const mismatchRepository = SQLiteAttemptRepository.forReadOnlyTest({
      database: mismatch,
      clock: fixture.clock,
      ids: new TestIds(LEASE_B),
    });
    await expect(
      mismatchRepository.getAttempt({
        attemptId: ATTEMPT_A,
        athleteId: ATHLETE_A,
      }),
    ).rejects.toMatchObject({ code: "persisted_data_corrupt" });
    mismatch.close();

    const rollbackFilename = join(
      fixture.directory,
      "legacy-terminal-v20-rollback.sqlite",
    );
    const rollbackPredecessor = createV20TerminalPredecessor(rollbackFilename, {
      attemptId: ATTEMPT_A,
      outcome: freeOutcome(ATTEMPT_A, completedAt),
      completedAt,
    });
    // Simulate a v20 database created before user_version was reconciled.
    rollbackPredecessor.raw.pragma("user_version = 0");
    rollbackPredecessor.raw.exec(`
      CREATE TRIGGER reject_v21_terminal_normalization
      BEFORE UPDATE OF status ON attempts
      WHEN NEW.status = 'valid'
      BEGIN
        SELECT RAISE(ABORT, 'forced v21 rollback');
      END;
    `);

    expect(() => openSqliteDatabase(rollbackFilename)).toThrow(
      "forced v21 rollback",
    );
    expect(
      rollbackPredecessor.raw.pragma("user_version", { simple: true }),
    ).toBe(0);
    expect(
      rollbackPredecessor.raw
        .prepare(
          "SELECT status, outcome_json FROM attempts INNER JOIN terminal_results ON terminal_results.attempt_id = attempts.id WHERE attempts.id = ?",
        )
        .get(ATTEMPT_A),
    ).toEqual({
      status: "processing",
      outcome_json: JSON.stringify(freeOutcome(ATTEMPT_A, completedAt)),
    });
    rollbackPredecessor.raw.exec(
      "DROP TRIGGER reject_v21_terminal_normalization",
    );
    rollbackPredecessor.close();

    const repaired = openSqliteDatabase(rollbackFilename);
    expect(
      repaired.raw
        .prepare("SELECT status FROM attempts WHERE id = ?")
        .get(ATTEMPT_A),
    ).toEqual({ status: "valid" });
    expect(repaired.raw.pragma("user_version", { simple: true })).toBe(22);
    repaired.close();
  });

  it("rejects corrupted migration ledgers and ahead mirrors without changing a durable predecessor", () => {
    const canonicalAppliedAt = "2030-01-15T12:00:00.000Z";
    const cases: readonly Readonly<{
      label: string;
      mutate(database: SqliteDatabase): void;
    }>[] = [
      {
        label: "future history",
        mutate(database) {
          database.raw
            .prepare(
              "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
            )
            .run(22, canonicalAppliedAt);
        },
      },
      {
        label: "gap before the v20 prefix end",
        mutate(database) {
          database.raw
            .prepare("DELETE FROM schema_migrations WHERE version = 20")
            .run();
        },
      },
      {
        label: "duplicate history row",
        mutate(database) {
          const rows = readMigrationHistoryRows(database);
          replaceMigrationHistoryForTest(database, [
            ...rows,
            { version: 20, appliedAt: canonicalAppliedAt },
          ]);
        },
      },
      {
        label: "out-of-order history rows",
        mutate(database) {
          const [first, second, ...rest] = readMigrationHistoryRows(database);
          if (!first || !second) throw new Error("Expected v20 history rows.");
          replaceMigrationHistoryForTest(database, [second, first, ...rest]);
        },
      },
      {
        label: "fractional version row",
        mutate(database) {
          const rows = readMigrationHistoryRows(database);
          replaceMigrationHistoryForTest(database, [
            ...rows.slice(0, -1),
            { version: 20.5, appliedAt: canonicalAppliedAt },
          ]);
        },
      },
      {
        label: "text version row",
        mutate(database) {
          const rows = readMigrationHistoryRows(database);
          replaceMigrationHistoryForTest(database, [
            ...rows.slice(0, -1),
            { version: "20x", appliedAt: canonicalAppliedAt },
          ]);
        },
      },
      {
        label: "unsafe version row",
        mutate(database) {
          const rows = readMigrationHistoryRows(database);
          replaceMigrationHistoryForTest(database, [
            ...rows.slice(0, -1),
            {
              version: Number.MAX_SAFE_INTEGER + 1,
              appliedAt: canonicalAppliedAt,
            },
          ]);
        },
      },
      {
        label: "noncanonical applied_at row",
        mutate(database) {
          database.raw
            .prepare(
              "UPDATE schema_migrations SET applied_at = ? WHERE version = 20",
            )
            .run("2030-01-15T12:00:00Z");
        },
      },
      {
        label: "malformed ledger table",
        mutate(database) {
          const rows = readMigrationHistoryRows(database);
          replaceMigrationHistoryForTest(
            database,
            rows,
            "CREATE TABLE schema_migrations (version NUMERIC NOT NULL, applied_at TEXT NOT NULL, extra TEXT)",
          );
        },
      },
    ];

    for (const input of cases) {
      const filename = join(
        fixture.directory,
        `migration-history-${input.label.replaceAll(" ", "-")}.sqlite`,
      );
      const predecessor = openSqliteDatabaseAtVersionForTest(filename, 20);
      input.mutate(predecessor);
      const before = migrationHistoryStateForTest(predecessor);
      expect(() => openSqliteDatabase(filename), input.label).toThrow(
        "sqlite migration history is invalid",
      );
      expect(migrationHistoryStateForTest(predecessor), input.label).toEqual(
        before,
      );
      predecessor.close();
    }

    const aheadFilename = join(
      fixture.directory,
      "migration-mirror-ahead.sqlite",
    );
    const current = openSqliteDatabase(aheadFilename);
    current.raw.pragma("user_version = 23");
    const before = migrationHistoryStateForTest(current);
    expect(() => openSqliteDatabase(aheadFilename)).toThrow(
      "sqlite migration history is invalid",
    );
    expect(migrationHistoryStateForTest(current)).toEqual(before);
    current.close();

    const missingLedgerFilename = join(
      fixture.directory,
      "migration-missing-ledger-ahead.sqlite",
    );
    const missingLedger = openSqliteDatabaseAtVersionForTest(
      missingLedgerFilename,
      20,
    );
    missingLedger.raw.exec("DROP TABLE schema_migrations");
    missingLedger.raw.pragma("user_version = 23");
    const missingLedgerBefore = missingLedgerStateForTest(missingLedger);
    expect(() => openSqliteDatabase(missingLedgerFilename)).toThrow(
      "sqlite migration history is invalid",
    );
    expect(missingLedgerStateForTest(missingLedger)).toEqual(
      missingLedgerBefore,
    );
    missingLedger.close();

    const missingLedgerWithDataFilename = join(
      fixture.directory,
      "migration-missing-ledger-with-data.sqlite",
    );
    const missingLedgerWithData = openSqliteDatabaseAtVersionForTest(
      missingLedgerWithDataFilename,
      20,
    );
    missingLedgerWithData.raw
      .prepare("INSERT INTO athletes (id, created_at) VALUES (?, ?)")
      .run(ATHLETE_A, canonicalAppliedAt);
    missingLedgerWithData.raw.exec("DROP TABLE schema_migrations");
    missingLedgerWithData.raw.pragma("user_version = 0");
    const missingLedgerWithDataBefore = missingLedgerStateForTest(
      missingLedgerWithData,
    );
    expect(() => openSqliteDatabase(missingLedgerWithDataFilename)).toThrow(
      "sqlite migration history is invalid",
    );
    expect(missingLedgerStateForTest(missingLedgerWithData)).toEqual(
      missingLedgerWithDataBefore,
    );
    missingLedgerWithData.close();

    const emptyLedgerWithDataFilename = join(
      fixture.directory,
      "migration-empty-ledger-with-data.sqlite",
    );
    const emptyLedgerWithData = openSqliteDatabaseAtVersionForTest(
      emptyLedgerWithDataFilename,
      20,
    );
    emptyLedgerWithData.raw
      .prepare("INSERT INTO athletes (id, created_at) VALUES (?, ?)")
      .run(ATHLETE_A, canonicalAppliedAt);
    emptyLedgerWithData.raw.exec("DELETE FROM schema_migrations");
    emptyLedgerWithData.raw.pragma("user_version = 0");
    const emptyLedgerWithDataBefore =
      missingLedgerStateForTest(emptyLedgerWithData);
    expect(() => openSqliteDatabase(emptyLedgerWithDataFilename)).toThrow(
      "sqlite migration history is invalid",
    );
    expect(missingLedgerStateForTest(emptyLedgerWithData)).toEqual(
      emptyLedgerWithDataBefore,
    );
    emptyLedgerWithData.close();
  });

  it("leaves an invalid predecessor's journal and durable bytes unchanged", async () => {
    const filename = join(
      fixture.directory,
      "migration-journal-unchanged.sqlite",
    );
    const predecessor = openSqliteDatabase(filename);
    predecessor.raw.pragma("journal_mode = DELETE");
    predecessor.raw.pragma("user_version = 23");
    predecessor.close();

    const before = await durableStartupStateForTest(filename);
    expect(before.journalMode).toBe("delete");
    expect(() => openSqliteDatabase(filename)).toThrow(
      "sqlite migration history is invalid",
    );
    expect(await durableStartupStateForTest(filename)).toEqual(before);
  });

  it("terminates a stalled migration child startup", async () => {
    const filename = join(fixture.directory, "migration-child-timeout.sqlite");
    let resolveReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    const startup = openDatabaseInChild(filename, {
      forceHang: true,
      onReady: resolveReady,
      timeoutMs: 250,
    });
    void startup.catch(() => undefined);

    await expect(ready).resolves.toBeUndefined();
    await expect(startup).rejects.toMatchObject({
      message: migrationChildStartupTimeoutError,
      signal: "SIGKILL",
    });
  });

  // This covers six rounds of four child Node/TypeScript migration startups.
  it(
    "serializes concurrent fresh and predecessor migration startup",
    async () => {
      for (const source of [
        {
          label: "fresh",
          prepare(): void {
            // A missing file is the fresh predecessor.
          },
        },
        {
          label: "v20",
          prepare(filename: string): void {
            openSqliteDatabaseAtVersionForTest(filename, 20).close();
          },
        },
      ]) {
        for (let round = 1; round <= migrationStartupRounds; round += 1) {
          const filename = join(
            fixture.directory,
            `migration-concurrent-${source.label}-${round}.sqlite`,
          );
          source.prepare(filename);
          await expect(
            Promise.all(
              Array.from({ length: 4 }, () => openDatabaseInChild(filename)),
            ),
          ).resolves.toEqual(
            Array.from({ length: 4 }, () => ({
              userVersion: 22,
              migrationCount: 22,
            })),
          );
          const reopened = openSqliteDatabase(filename);
          expect(reopened.raw.pragma("user_version", { simple: true })).toBe(
            22,
          );
          expect(
            reopened.raw
              .prepare("SELECT COUNT(*) AS count FROM schema_migrations")
              .get(),
          ).toEqual({ count: 22 });
          reopened.close();
        }
      }
    },
    migrationStartupTestTimeoutMs,
  );

  it("backfills a live v17 delivery row with its exact durable frame batch once", () => {
    const filename = join(fixture.directory, "delivery-recovery-v17.sqlite");
    const predecessor = openSqliteDatabaseAtVersionForTest(filename, 17);
    const uploadedAt = fixture.clock.now();
    const mediaId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const frameBatchId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    const media = preparedStoredMedia({ id: mediaId, uploadedAt });
    predecessor.raw
      .prepare("INSERT INTO athletes (id, created_at) VALUES (?, ?)")
      .run(ATHLETE_A, uploadedAt);
    predecessor.raw
      .prepare(
        "INSERT INTO attempts (id, athlete_id, mode, challenge_id, challenge_version, calibration_session_id, status, deletion_state, media_json, processing_generation, created_at, updated_at, processing_context_json, media_sha256, processing_receipt_id, processing_receipt_sha256) VALUES (?, ?, 'free', NULL, NULL, NULL, 'uploaded', 'active', ?, 1, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        ATTEMPT_A,
        ATHLETE_A,
        JSON.stringify(media),
        uploadedAt,
        uploadedAt,
        JSON.stringify({
          upload: {
            attemptId: ATTEMPT_A,
            athleteId: ATHLETE_A,
            mode: "free",
            generation: 1,
            uploadedAt,
            verified: null,
          },
          processing: freeProcessingContext({
            attemptId: ATTEMPT_A,
            generation: 1,
            mediaId,
          }),
          sourceSha256: "e".repeat(64),
        }),
        "e".repeat(64),
        frameBatchId,
        "d".repeat(64),
      );
    predecessor.raw
      .prepare(
        "INSERT INTO media_delivery_recovery_records (attempt_id, generation, media_id, state, requires_rollback, created_at, updated_at) VALUES (?, 1, ?, 'pending-delivery', 1, ?, ?)",
      )
      .run(ATTEMPT_A, mediaId, uploadedAt, uploadedAt);
    predecessor.raw
      .prepare(
        "INSERT INTO media_retention_records (media_id, attempt_id, metadata_json, delete_at, created_at) VALUES (?, ?, '{}', ?, ?)",
      )
      .run(mediaId, ATTEMPT_A, "2030-01-16T12:00:00.000Z", uploadedAt);
    predecessor.raw
      .prepare(
        "INSERT INTO retention_cleanup_records (resource_id, attempt_id, resource_kind, delete_at, created_at) VALUES (?, ?, 'frame', ?, ?)",
      )
      .run(frameBatchId, ATTEMPT_A, "2030-01-16T12:00:00.000Z", uploadedAt);
    predecessor.close();

    const upgraded = openSqliteDatabase(filename);
    expect(
      upgraded.raw
        .prepare(
          "SELECT frame_batch_id, state, requires_rollback, queued_at FROM media_delivery_recovery_records WHERE attempt_id = ? AND generation = 1",
        )
        .get(ATTEMPT_A),
    ).toEqual({
      frame_batch_id: frameBatchId,
      state: "pending-delivery",
      requires_rollback: 1,
      queued_at: null,
    });
    upgraded.close();

    const reopened = openSqliteDatabase(filename);
    expect(
      reopened.raw
        .prepare(
          "SELECT COUNT(*) AS count FROM media_delivery_recovery_records WHERE attempt_id = ? AND generation = 1",
        )
        .get(ATTEMPT_A),
    ).toEqual({ count: 1 });
    reopened.close();
  });

  it("normalizes a valid v18 processing recovery conflict to the queued redelivery lifecycle", () => {
    const filename = join(
      fixture.directory,
      "delivery-recovery-v18-processing.sqlite",
    );
    const predecessor = openSqliteDatabaseAtVersionForTest(filename, 18);
    const uploadedAt = fixture.clock.now();
    const mediaId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const frameBatchId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    predecessor.raw
      .prepare("INSERT INTO athletes (id, created_at) VALUES (?, ?)")
      .run(ATHLETE_A, uploadedAt);
    predecessor.raw
      .prepare(
        "INSERT INTO attempts (id, athlete_id, mode, challenge_id, challenge_version, calibration_session_id, status, deletion_state, media_json, processing_generation, created_at, updated_at, processing_context_json, media_sha256, processing_receipt_id, processing_receipt_sha256) VALUES (?, ?, 'free', NULL, NULL, NULL, 'processing', 'active', ?, 1, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        ATTEMPT_A,
        ATHLETE_A,
        JSON.stringify(preparedStoredMedia({ id: mediaId, uploadedAt })),
        uploadedAt,
        uploadedAt,
        JSON.stringify({
          upload: {
            attemptId: ATTEMPT_A,
            athleteId: ATHLETE_A,
            mode: "free",
            generation: 1,
            uploadedAt,
            verified: null,
          },
          processing: freeProcessingContext({
            attemptId: ATTEMPT_A,
            generation: 1,
            mediaId,
          }),
          sourceSha256: "e".repeat(64),
        }),
        "e".repeat(64),
        frameBatchId,
        "d".repeat(64),
      );
    predecessor.raw
      .prepare(
        "INSERT INTO media_delivery_recovery_records (attempt_id, generation, media_id, frame_batch_id, state, requires_rollback, created_at, updated_at) VALUES (?, 1, ?, ?, 'pending-delivery', 1, ?, ?)",
      )
      .run(ATTEMPT_A, mediaId, frameBatchId, uploadedAt, uploadedAt);
    predecessor.raw
      .prepare(
        "INSERT INTO media_retention_records (media_id, attempt_id, metadata_json, delete_at, created_at) VALUES (?, ?, '{}', ?, ?)",
      )
      .run(mediaId, ATTEMPT_A, "2030-01-16T12:00:00.000Z", uploadedAt);
    predecessor.raw
      .prepare(
        "INSERT INTO retention_cleanup_records (resource_id, attempt_id, resource_kind, delete_at, created_at) VALUES (?, ?, 'frame', ?, ?)",
      )
      .run(frameBatchId, ATTEMPT_A, "2030-01-16T12:00:00.000Z", uploadedAt);
    predecessor.close();

    const upgraded = openSqliteDatabase(filename);
    expect(
      upgraded.raw
        .prepare(
          "SELECT state, requires_rollback, queued_at, rollback_completed_at, cleanup_completed_at, recovery_lease_id, recovery_lease_expires_at FROM media_delivery_recovery_records WHERE attempt_id = ? AND generation = 1",
        )
        .get(ATTEMPT_A),
    ).toMatchObject({
      state: "queued",
      requires_rollback: 0,
      queued_at: expect.any(String),
      rollback_completed_at: null,
      cleanup_completed_at: null,
      recovery_lease_id: null,
      recovery_lease_expires_at: null,
    });
    upgraded.close();
  });

  it("fails closed during v19 when a v18 delivery row preserves a mismatched source digest", () => {
    const filename = join(
      fixture.directory,
      "delivery-recovery-v18-bad-source.sqlite",
    );
    const predecessor = openSqliteDatabaseAtVersionForTest(filename, 18);
    const uploadedAt = fixture.clock.now();
    const mediaId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const frameBatchId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    predecessor.raw
      .prepare("INSERT INTO athletes (id, created_at) VALUES (?, ?)")
      .run(ATHLETE_A, uploadedAt);
    predecessor.raw
      .prepare(
        "INSERT INTO attempts (id, athlete_id, mode, challenge_id, challenge_version, calibration_session_id, status, deletion_state, media_json, processing_generation, created_at, updated_at, processing_context_json, media_sha256, processing_receipt_id, processing_receipt_sha256) VALUES (?, ?, 'free', NULL, NULL, NULL, 'uploaded', 'active', ?, 1, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        ATTEMPT_A,
        ATHLETE_A,
        JSON.stringify(preparedStoredMedia({ id: mediaId, uploadedAt })),
        uploadedAt,
        uploadedAt,
        JSON.stringify({
          upload: {
            attemptId: ATTEMPT_A,
            athleteId: ATHLETE_A,
            mode: "free",
            generation: 1,
            uploadedAt,
            verified: null,
          },
          processing: freeProcessingContext({
            attemptId: ATTEMPT_A,
            generation: 1,
            mediaId,
          }),
          sourceSha256: "e".repeat(64),
        }),
        "f".repeat(64),
        frameBatchId,
        "d".repeat(64),
      );
    predecessor.raw
      .prepare(
        "INSERT INTO media_delivery_recovery_records (attempt_id, generation, media_id, frame_batch_id, state, requires_rollback, created_at, updated_at) VALUES (?, 1, ?, ?, 'pending-delivery', 1, ?, ?)",
      )
      .run(ATTEMPT_A, mediaId, frameBatchId, uploadedAt, uploadedAt);
    predecessor.raw
      .prepare(
        "INSERT INTO media_retention_records (media_id, attempt_id, metadata_json, delete_at, created_at) VALUES (?, ?, '{}', ?, ?)",
      )
      .run(mediaId, ATTEMPT_A, "2030-01-16T12:00:00.000Z", uploadedAt);
    predecessor.raw
      .prepare(
        "INSERT INTO retention_cleanup_records (resource_id, attempt_id, resource_kind, delete_at, created_at) VALUES (?, ?, 'frame', ?, ?)",
      )
      .run(frameBatchId, ATTEMPT_A, "2030-01-16T12:00:00.000Z", uploadedAt);
    predecessor.close();

    const upgraded = openSqliteDatabase(filename);
    expect(
      upgraded.raw
        .prepare(
          "SELECT status, processing_generation, media_json, media_sha256, processing_context_json, processing_receipt_id, processing_receipt_sha256 FROM attempts WHERE id = ?",
        )
        .get(ATTEMPT_A),
    ).toEqual({
      status: "awaiting-upload",
      processing_generation: 2,
      media_json: null,
      media_sha256: null,
      processing_context_json: null,
      processing_receipt_id: null,
      processing_receipt_sha256: null,
    });
    expect(
      upgraded.raw
        .prepare(
          "SELECT COUNT(*) AS count FROM media_delivery_recovery_records WHERE attempt_id = ?",
        )
        .get(ATTEMPT_A),
    ).toEqual({ count: 0 });
    upgraded.close();
  });

  it.each([
    "absent",
    "cross-media",
    "cross-frame",
    "cross-both",
    "wrong-frame-kind",
    "swapped-pair",
  ] as const)(
    "fails closed during v19 when a v18 live delivery lacks exact %s retention ownership",
    (ownership) => {
      const filename = join(
        fixture.directory,
        `delivery-recovery-v18-${ownership}.sqlite`,
      );
      const predecessor = openSqliteDatabaseAtVersionForTest(filename, 18);
      const uploadedAt = fixture.clock.now();
      const mediaId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      const frameBatchId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
      const swappedMediaId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
      const swappedFrameId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
      predecessor.raw
        .prepare("INSERT INTO athletes (id, created_at) VALUES (?, ?)")
        .run(ATHLETE_A, uploadedAt);
      predecessor.raw
        .prepare("INSERT INTO athletes (id, created_at) VALUES (?, ?)")
        .run(ATHLETE_B, uploadedAt);
      predecessor.raw
        .prepare(
          "INSERT INTO attempts (id, athlete_id, mode, status, deletion_state, created_at, updated_at) VALUES (?, ?, 'free', 'awaiting-upload', 'active', ?, ?)",
        )
        .run(ATTEMPT_B, ATHLETE_B, uploadedAt, uploadedAt);
      predecessor.raw
        .prepare(
          "INSERT INTO attempts (id, athlete_id, mode, challenge_id, challenge_version, calibration_session_id, status, deletion_state, media_json, processing_generation, created_at, updated_at, processing_context_json, media_sha256, processing_receipt_id, processing_receipt_sha256) VALUES (?, ?, 'free', NULL, NULL, NULL, 'uploaded', 'active', ?, 1, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          ATTEMPT_A,
          ATHLETE_A,
          JSON.stringify(preparedStoredMedia({ id: mediaId, uploadedAt })),
          uploadedAt,
          uploadedAt,
          JSON.stringify({
            upload: {
              attemptId: ATTEMPT_A,
              athleteId: ATHLETE_A,
              mode: "free",
              generation: 1,
              uploadedAt,
              verified: null,
            },
            processing: freeProcessingContext({
              attemptId: ATTEMPT_A,
              generation: 1,
              mediaId,
            }),
            sourceSha256: "e".repeat(64),
          }),
          "e".repeat(64),
          frameBatchId,
          "d".repeat(64),
        );
      predecessor.raw
        .prepare(
          "INSERT INTO media_delivery_recovery_records (attempt_id, generation, media_id, frame_batch_id, state, requires_rollback, created_at, updated_at) VALUES (?, 1, ?, ?, 'pending-delivery', 1, ?, ?)",
        )
        .run(ATTEMPT_A, mediaId, frameBatchId, uploadedAt, uploadedAt);
      const insertOriginal = (attemptId: string, id: string) =>
        predecessor.raw
          .prepare(
            "INSERT INTO media_retention_records (media_id, attempt_id, metadata_json, delete_at, created_at) VALUES (?, ?, '{}', ?, ?)",
          )
          .run(id, attemptId, "2030-01-16T12:00:00.000Z", uploadedAt);
      const insertFrame = (attemptId: string, id: string, kind = "frame") =>
        predecessor.raw
          .prepare(
            "INSERT INTO retention_cleanup_records (resource_id, attempt_id, resource_kind, delete_at, created_at) VALUES (?, ?, ?, ?, ?)",
          )
          .run(id, attemptId, kind, "2030-01-16T12:00:00.000Z", uploadedAt);
      if (ownership === "cross-media" || ownership === "cross-both")
        insertOriginal(ATTEMPT_B, mediaId);
      if (ownership === "cross-frame" || ownership === "cross-both")
        insertFrame(ATTEMPT_B, frameBatchId);
      if (ownership === "cross-media" || ownership === "cross-frame") {
        if (ownership === "cross-media") insertFrame(ATTEMPT_A, frameBatchId);
        if (ownership === "cross-frame") insertOriginal(ATTEMPT_A, mediaId);
      }
      if (ownership === "wrong-frame-kind") {
        insertOriginal(ATTEMPT_A, mediaId);
        insertFrame(ATTEMPT_A, frameBatchId, "temporary");
      }
      if (ownership === "swapped-pair") {
        insertOriginal(ATTEMPT_A, swappedMediaId);
        insertFrame(ATTEMPT_A, swappedFrameId);
      }
      predecessor.close();

      const upgraded = openSqliteDatabase(filename);
      expect(
        upgraded.raw
          .prepare(
            "SELECT status, processing_generation, media_json, media_sha256, processing_context_json, processing_receipt_id, processing_receipt_sha256 FROM attempts WHERE id = ?",
          )
          .get(ATTEMPT_A),
      ).toEqual({
        status: "awaiting-upload",
        processing_generation: 2,
        media_json: null,
        media_sha256: null,
        processing_context_json: null,
        processing_receipt_id: null,
        processing_receipt_sha256: null,
      });
      expect(
        upgraded.raw
          .prepare(
            "SELECT COUNT(*) AS count FROM media_delivery_recovery_records WHERE attempt_id = ?",
          )
          .get(ATTEMPT_A),
      ).toEqual({ count: 0 });
      upgraded.close();
    },
  );

  it("retains only an exact owned v18 tombstone pair as cleanup recovery across reopen", () => {
    const filename = join(
      fixture.directory,
      "delivery-recovery-v18-tombstone-owned.sqlite",
    );
    const predecessor = openSqliteDatabaseAtVersionForTest(filename, 18);
    const now = fixture.clock.now();
    const mediaId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const frameBatchId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    predecessor.raw
      .prepare("INSERT INTO athletes (id, created_at) VALUES (?, ?)")
      .run(ATHLETE_A, now);
    predecessor.raw
      .prepare(
        "INSERT INTO attempts (id, athlete_id, mode, status, deletion_state, processing_generation, created_at, updated_at, tombstoned_at) VALUES (?, ?, 'free', 'awaiting-upload', 'tombstoned', 2, ?, ?, ?)",
      )
      .run(ATTEMPT_A, ATHLETE_A, now, now, now);
    predecessor.raw
      .prepare(
        "INSERT INTO media_delivery_recovery_records (attempt_id, generation, media_id, frame_batch_id, state, requires_rollback, created_at, updated_at) VALUES (?, 1, ?, ?, 'queued', 0, ?, ?)",
      )
      .run(ATTEMPT_A, mediaId, frameBatchId, now, now);
    predecessor.raw
      .prepare(
        "INSERT INTO media_retention_records (media_id, attempt_id, metadata_json, delete_at, created_at) VALUES (?, ?, '{}', ?, ?)",
      )
      .run(mediaId, ATTEMPT_A, "2030-01-16T12:00:00.000Z", now);
    predecessor.raw
      .prepare(
        "INSERT INTO retention_cleanup_records (resource_id, attempt_id, resource_kind, delete_at, created_at) VALUES (?, ?, 'frame', ?, ?)",
      )
      .run(frameBatchId, ATTEMPT_A, "2030-01-16T12:00:00.000Z", now);
    predecessor.close();

    const upgraded = openSqliteDatabase(filename);
    expect(
      upgraded.raw
        .prepare(
          "SELECT state, requires_rollback, media_id, frame_batch_id FROM media_delivery_recovery_records WHERE attempt_id = ?",
        )
        .get(ATTEMPT_A),
    ).toEqual({
      state: "cleanup-recoverable",
      requires_rollback: 0,
      media_id: mediaId,
      frame_batch_id: frameBatchId,
    });
    upgraded.close();

    const reopened = openSqliteDatabase(filename);
    expect(
      reopened.raw
        .prepare(
          "SELECT COUNT(*) AS count FROM media_delivery_recovery_records WHERE attempt_id = ?",
        )
        .get(ATTEMPT_A),
    ).toEqual({ count: 1 });
    reopened.close();
  });

  it("resets contextless legacy uploads for a fresh generation during repeated reopen", async () => {
    const filename = join(fixture.directory, "legacy-c5-v10.sqlite");
    const legacy = openSqliteDatabaseAtVersionForTest(filename, 10);
    const uploadedAt = fixture.clock.now();
    const deleteAt = "2030-01-16T11:00:00.000Z";
    const temporaryDeleteAt = "2030-01-15T13:00:00.000Z";
    legacy.raw
      .prepare("INSERT INTO athletes (id, created_at) VALUES (?, ?)")
      .run(ATHLETE_A, uploadedAt);
    const insert = legacy.raw.prepare(
      "INSERT INTO attempts (id, athlete_id, mode, challenge_id, challenge_version, calibration_session_id, status, deletion_state, media_json, processing_generation, created_at, updated_at) VALUES (?, ?, 'free', NULL, NULL, NULL, 'uploaded', 'active', ?, 1, ?, ?)",
    );
    const transitionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const richId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const canonicalId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    insert.run(
      ATTEMPT_A,
      ATHLETE_A,
      JSON.stringify({
        id: transitionId,
        contentType: "video/mp4",
        bytes: 10,
        uploadedAt,
        deleteAt,
        transitionResourceId: transitionId,
      }),
      uploadedAt,
      uploadedAt,
    );
    insert.run(
      ATTEMPT_B,
      ATHLETE_A,
      JSON.stringify({
        id: richId,
        contentType: "video/mp4",
        bytes: 11,
        uploadedAt,
        deleteAt,
        sha256: "a".repeat(64),
        probe: { container: "mp4" },
        manifest: { extractionVersion: "c5" },
        transition: {
          kind: "upload-transition",
          resourceId: richId,
          deleteAt: temporaryDeleteAt,
        },
      }),
      uploadedAt,
      uploadedAt,
    );
    insert.run(
      ATTEMPT_C,
      ATHLETE_A,
      JSON.stringify({
        id: canonicalId,
        contentType: "video/mp4",
        bytes: 12,
        uploadedAt,
        deleteAt,
        transition: {
          kind: "upload-transition",
          resourceId: canonicalId,
          deleteAt: temporaryDeleteAt,
        },
      }),
      uploadedAt,
      uploadedAt,
    );
    legacy.close();

    const upgraded = openSqliteDatabase(filename);
    const repository = SQLiteAttemptRepository.forReadOnlyTest({
      database: upgraded,
      clock: fixture.clock,
      ids: new TestIds(LEASE_A),
    });
    for (const [attemptId] of [
      [ATTEMPT_A, transitionId],
      [ATTEMPT_B, richId],
      [ATTEMPT_C, canonicalId],
    ] as const) {
      await expect(
        repository.getAttempt({ attemptId, athleteId: ATHLETE_A }),
      ).resolves.toMatchObject({
        status: "awaiting-upload",
        media: null,
      });
      expect(
        upgraded.raw
          .prepare(
            "SELECT media_json, processing_context_json, processing_generation FROM attempts WHERE id = ?",
          )
          .get(attemptId),
      ).toEqual({
        media_json: null,
        processing_context_json: null,
        processing_generation: 2,
      });
      await expect(
        repository.claimProcessing({ attemptId, generation: 1 }),
      ).resolves.toBeNull();
    }
    const reopened = upgraded.reopen();
    expect(
      reopened.raw
        .prepare("SELECT COUNT(*) AS count FROM schema_migrations")
        .get(),
    ).toMatchObject({ count: 22 });
    reopened.close();
    upgraded.close();

    const malformedFilename = join(
      fixture.directory,
      "legacy-c5-v15-malformed.sqlite",
    );
    const malformed = openSqliteDatabaseAtVersionForTest(malformedFilename, 15);
    malformed.raw.exec(
      "DROP TRIGGER attempts_media_json_requires_c5_transition",
    );
    malformed.raw.exec(
      "DROP TRIGGER attempts_media_json_insert_requires_c5_transition",
    );
    malformed.raw
      .prepare("INSERT INTO athletes (id, created_at) VALUES (?, ?)")
      .run(ATHLETE_A, uploadedAt);
    malformed.raw
      .prepare(
        "INSERT INTO attempts (id, athlete_id, mode, challenge_id, challenge_version, calibration_session_id, status, deletion_state, media_json, processing_generation, created_at, updated_at) VALUES (?, ?, 'free', NULL, NULL, NULL, 'uploaded', 'active', ?, 1, ?, ?)",
      )
      .run(ATTEMPT_A, ATHLETE_A, "{not-json", uploadedAt, uploadedAt);
    malformed.close();
    const malformedUpgraded = openSqliteDatabase(malformedFilename);
    const malformedRepository = SQLiteAttemptRepository.forReadOnlyTest({
      database: malformedUpgraded,
      clock: fixture.clock,
      ids: new TestIds(LEASE_A),
    });
    await expect(
      malformedRepository.getAttempt({
        attemptId: ATTEMPT_A,
        athleteId: ATHLETE_A,
      }),
    ).resolves.toMatchObject({ status: "awaiting-upload", media: null });
    malformedUpgraded.close();
  });

  it("fails startup rather than marking conflicting legacy C5 media as migrated", () => {
    const filename = join(fixture.directory, "invalid-c5-v11.sqlite");
    const legacy = openSqliteDatabaseAtVersionForTest(filename, 11);
    const uploadedAt = fixture.clock.now();
    legacy.raw
      .prepare("INSERT INTO athletes (id, created_at) VALUES (?, ?)")
      .run(ATHLETE_A, uploadedAt);
    legacy.raw
      .prepare(
        "INSERT INTO attempts (id, athlete_id, mode, challenge_id, challenge_version, calibration_session_id, status, deletion_state, media_json, processing_generation, created_at, updated_at) VALUES (?, ?, 'free', NULL, NULL, NULL, 'uploaded', 'active', ?, 1, ?, ?)",
      )
      .run(
        ATTEMPT_A,
        ATHLETE_A,
        JSON.stringify({
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          contentType: "video/mp4",
          bytes: 10,
          uploadedAt,
          deleteAt: "2030-01-16T11:00:00.000Z",
          transition: {
            kind: "upload-transition",
            resourceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            deleteAt: "2030-01-15T13:00:00.000Z",
          },
        }),
        uploadedAt,
        uploadedAt,
      );
    legacy.close();

    expect(() => openSqliteDatabase(filename)).toThrow(
      "invalid legacy C5 media record",
    );
  });

  it("fails a complete v10-to-current upgrade for every unknown five-field C5 near miss", () => {
    const filename = join(fixture.directory, "invalid-c5-v10-near-miss.sqlite");
    const legacy = openSqliteDatabaseAtVersionForTest(filename, 10);
    const uploadedAt = fixture.clock.now();
    legacy.raw
      .prepare("INSERT INTO athletes (id, created_at) VALUES (?, ?)")
      .run(ATHLETE_A, uploadedAt);
    legacy.raw
      .prepare(
        "INSERT INTO attempts (id, athlete_id, mode, challenge_id, challenge_version, calibration_session_id, status, deletion_state, media_json, processing_generation, created_at, updated_at) VALUES (?, ?, 'free', NULL, NULL, NULL, 'uploaded', 'active', ?, 1, ?, ?)",
      )
      .run(
        ATTEMPT_A,
        ATHLETE_A,
        JSON.stringify({
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          contentType: "video/mp4",
          bytes: 10,
          deleteAt: "2030-01-16T11:00:00.000Z",
          transitionResourceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        }),
        uploadedAt,
        uploadedAt,
      );
    legacy.close();

    expect(() => openSqliteDatabase(filename)).toThrow(
      "invalid legacy C5 media record",
    );
  });

  it("fails closed and remains unreopenable for an uploaded-at-only near miss at every predecessor version", () => {
    for (const version of [10, 11, 12] as const) {
      const filename = join(
        fixture.directory,
        `invalid-c5-v${version}-uploaded-at-only.sqlite`,
      );
      const legacy = openSqliteDatabaseAtVersionForTest(filename, version);
      const uploadedAt = fixture.clock.now();
      legacy.raw
        .prepare("INSERT INTO athletes (id, created_at) VALUES (?, ?)")
        .run(ATHLETE_A, uploadedAt);
      if (version === 12)
        legacy.raw.exec(
          "DROP TRIGGER attempts_media_json_requires_c5_transition; DROP TRIGGER attempts_media_json_insert_requires_c5_transition;",
        );
      legacy.raw
        .prepare(
          "INSERT INTO attempts (id, athlete_id, mode, challenge_id, challenge_version, calibration_session_id, status, deletion_state, media_json, processing_generation, created_at, updated_at) VALUES (?, ?, 'free', NULL, NULL, NULL, 'uploaded', 'active', ?, 1, ?, ?)",
        )
        .run(
          ATTEMPT_A,
          ATHLETE_A,
          JSON.stringify({
            id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            contentType: "video/mp4",
            bytes: 10,
            uploadedAt,
            deleteAt: "2030-01-16T11:00:00.000Z",
          }),
          uploadedAt,
          uploadedAt,
        );
      legacy.close();

      expect(() => openSqliteDatabase(filename)).toThrow(
        "invalid legacy C5 media record",
      );
      expect(() => openSqliteDatabase(filename)).toThrow(
        "invalid legacy C5 media record",
      );
    }
  });

  it("rejects a v12 nested transition shape instead of reopening persisted corruption", () => {
    const filename = join(fixture.directory, "invalid-c5-v12.sqlite");
    const legacy = openSqliteDatabaseAtVersionForTest(filename, 12);
    const uploadedAt = fixture.clock.now();
    legacy.raw
      .prepare("INSERT INTO athletes (id, created_at) VALUES (?, ?)")
      .run(ATHLETE_A, uploadedAt);
    // v12's top-level trigger admits this nested extra. The following
    // migration must fail closed rather than leave a parser-invalid row.
    legacy.raw
      .prepare(
        "INSERT INTO attempts (id, athlete_id, mode, challenge_id, challenge_version, calibration_session_id, status, deletion_state, media_json, processing_generation, created_at, updated_at) VALUES (?, ?, 'free', NULL, NULL, NULL, 'uploaded', 'active', ?, 1, ?, ?)",
      )
      .run(
        ATTEMPT_A,
        ATHLETE_A,
        JSON.stringify({
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          contentType: "video/mp4",
          bytes: 10,
          uploadedAt,
          deleteAt: "2030-01-16T11:00:00.000Z",
          transition: {
            kind: "upload-transition",
            resourceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            deleteAt: "2030-01-15T13:00:00.000Z",
            unexpected: true,
          },
        }),
        uploadedAt,
        uploadedAt,
      );
    legacy.close();

    expect(() => openSqliteDatabase(filename)).toThrow(
      "invalid legacy C5 media record",
    );
  });

  it("enforces canonical C5 media identity and deadlines on both direct INSERT and UPDATE", async () => {
    await fixture.repository.createAttempt({
      id: ATTEMPT_A,
      athleteId: ATHLETE_A,
      input: { mode: "free" },
    });
    const canonical = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      contentType: "video/mp4",
      bytes: 10,
      uploadedAt: fixture.clock.now(),
      deleteAt: "2030-01-16T11:00:00.000Z",
      transition: {
        kind: "upload-transition",
        resourceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        deleteAt: "2030-01-15T13:00:00.000Z",
      },
    } as const;
    const invalidValues = [
      { ...canonical, transition: undefined },
      {
        ...canonical,
        transition: { ...canonical.transition, resourceId: "media-other" },
      },
      {
        ...canonical,
        transition: { ...canonical.transition, unexpected: true },
      },
      { ...canonical, deleteAt: "2030-01-16T10:59:59.000Z" },
      {
        ...canonical,
        uploadedAt: "2030-01-15T24:00:00.000Z",
        deleteAt: "2030-01-16T23:00:00.000Z",
        transition: {
          ...canonical.transition,
          deleteAt: "2030-01-16T01:00:00.000Z",
        },
      },
    ];
    const insert = fixture.database.raw.prepare(
      "INSERT INTO attempts (id, athlete_id, mode, challenge_id, challenge_version, calibration_session_id, status, deletion_state, media_json, processing_generation, created_at, updated_at) VALUES (?, ?, 'free', NULL, NULL, NULL, 'uploaded', 'active', ?, 1, ?, ?)",
    );
    for (const [index, invalid] of invalidValues.entries())
      expect(() =>
        insert.run(
          `raw-${index}`,
          ATHLETE_A,
          JSON.stringify(invalid),
          fixture.clock.now(),
          fixture.clock.now(),
        ),
      ).toThrow("invalid C5 media transition");
    expect(() =>
      insert.run(
        ATTEMPT_B,
        ATHLETE_A,
        JSON.stringify(canonical),
        fixture.clock.now(),
        fixture.clock.now(),
      ),
    ).not.toThrow();
    for (const invalid of invalidValues)
      expect(() =>
        fixture.database.raw
          .prepare("UPDATE attempts SET media_json = ? WHERE id = ?")
          .run(JSON.stringify(invalid), ATTEMPT_B),
      ).toThrow("invalid C5 media transition");
    await expect(
      fixture.repository.getAttempt({
        attemptId: ATTEMPT_B,
        athleteId: ATHLETE_A,
      }),
    ).resolves.toMatchObject({ media: canonical });
  });

  it("canonicalizes a v4 ranked request into its candidate so upgraded redelivery stays idempotent", async () => {
    const filename = join(fixture.directory, "legacy-v4.sqlite");
    const legacy = openSqliteDatabaseAtVersionForTest(filename, 4);
    const completedAt = fixture.clock.now();
    const legacyOutcome = legacyRankedOutcome(ATTEMPT_A, completedAt, 80);
    legacy.raw
      .prepare("INSERT INTO athletes (id, created_at) VALUES (?, ?)")
      .run(ATHLETE_A, completedAt);
    legacy.raw
      .prepare(
        "INSERT INTO calibration_sessions (id, athlete_id, nonce, challenge_id, challenge_version, state, issued_at, expires_at, consumed_at) VALUES (?, ?, ?, 'wall-pass', 1, 'consumed', ?, ?, ?)",
      )
      .run(
        SESSION_A,
        ATHLETE_A,
        "a".repeat(43),
        completedAt,
        "2030-01-15T12:15:00.000Z",
        completedAt,
      );
    legacy.raw
      .prepare(
        "INSERT INTO attempts (id, athlete_id, mode, challenge_id, challenge_version, calibration_session_id, status, deletion_state, media_json, processing_generation, processing_lease_id, processing_lease_expires_at, created_at, updated_at) VALUES (?, ?, 'verified', 'wall-pass', 1, ?, 'processing', 'active', ?, 1, ?, ?, ?, ?)",
      )
      .run(
        ATTEMPT_A,
        ATHLETE_A,
        SESSION_A,
        JSON.stringify({
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          contentType: "video/mp4",
          bytes: 10,
          deleteAt: "2030-01-16T12:00:00.000Z",
        }),
        LEASE_A,
        "2030-01-15T12:05:00.000Z",
        completedAt,
        completedAt,
      );
    legacy.raw
      .prepare(
        "INSERT INTO terminal_results (id, attempt_id, lease_id, generation, terminal_state, outcome_json, completed_at, created_at, request_outcome_json) VALUES (?, ?, ?, 1, 'valid', ?, ?, ?, ?)",
      )
      .run(
        "legacy-result",
        ATTEMPT_A,
        LEASE_A,
        JSON.stringify(legacyOutcome),
        completedAt,
        completedAt,
        JSON.stringify(legacyOutcome),
      );
    legacy.close();

    const upgraded = openSqliteDatabase(filename);
    const repository = SQLiteAttemptRepository.forReadOnlyTest({
      database: upgraded,
      clock: fixture.clock,
      ids: new TestIds(ENTRY_A),
    });
    const candidate = rankedOutcome(ATTEMPT_A, completedAt, 80);
    const duplicate = await repository.finalizeTerminalResult({
      attemptId: ATTEMPT_A,
      leaseId: LEASE_A,
      generation: 1,
      candidate,
    });

    expect(duplicate).toMatchObject({
      kind: "idempotent",
      finalized: { outcome: legacyOutcome },
    });
    expect(
      upgraded.raw
        .prepare(
          "SELECT candidate_json FROM terminal_results WHERE attempt_id = ?",
        )
        .get(ATTEMPT_A),
    ).toMatchObject({
      candidate_json: expect.not.stringContaining("rankingSnapshot"),
    });
    await expect(
      repository.finalizeTerminalResult({
        attemptId: ATTEMPT_A,
        leaseId: LEASE_A,
        generation: 1,
        candidate: rankedOutcome(ATTEMPT_A, completedAt, 81),
      }),
    ).rejects.toMatchObject({ code: "terminal_result_conflict" });
    upgraded.close();
  });

  it("canonicalizes an already-applied v5 ranked candidate on a later idempotent migration", async () => {
    const filename = join(fixture.directory, "legacy-v5.sqlite");
    const legacy = openSqliteDatabaseAtVersionForTest(filename, 6);
    const completedAt = fixture.clock.now();
    const legacyOutcome = legacyRankedOutcome(ATTEMPT_A, completedAt, 80);
    legacy.raw
      .prepare("INSERT INTO athletes (id, created_at) VALUES (?, ?)")
      .run(ATHLETE_A, completedAt);
    legacy.raw
      .prepare(
        "INSERT INTO calibration_sessions (id, athlete_id, nonce, challenge_id, challenge_version, state, issued_at, expires_at, consumed_at) VALUES (?, ?, ?, 'wall-pass', 1, 'consumed', ?, ?, ?)",
      )
      .run(
        SESSION_A,
        ATHLETE_A,
        "a".repeat(43),
        completedAt,
        "2030-01-15T12:15:00.000Z",
        completedAt,
      );
    legacy.raw
      .prepare(
        "INSERT INTO attempts (id, athlete_id, mode, challenge_id, challenge_version, calibration_session_id, status, deletion_state, media_json, processing_generation, processing_lease_id, processing_lease_expires_at, created_at, updated_at) VALUES (?, ?, 'verified', 'wall-pass', 1, ?, 'processing', 'active', ?, 1, ?, ?, ?, ?)",
      )
      .run(
        ATTEMPT_A,
        ATHLETE_A,
        SESSION_A,
        JSON.stringify({
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          contentType: "video/mp4",
          bytes: 10,
          deleteAt: "2030-01-16T12:00:00.000Z",
        }),
        LEASE_A,
        "2030-01-15T12:05:00.000Z",
        completedAt,
        completedAt,
      );
    legacy.raw
      .prepare(
        "INSERT INTO terminal_results (id, attempt_id, lease_id, generation, terminal_state, outcome_json, candidate_json, completed_at, created_at) VALUES (?, ?, ?, 1, 'valid', ?, ?, ?, ?)",
      )
      .run(
        "legacy-result",
        ATTEMPT_A,
        LEASE_A,
        JSON.stringify(legacyOutcome),
        JSON.stringify(legacyOutcome),
        completedAt,
        completedAt,
      );
    legacy.close();

    const upgraded = openSqliteDatabase(filename);
    const repository = SQLiteAttemptRepository.forReadOnlyTest({
      database: upgraded,
      clock: fixture.clock,
      ids: new TestIds(ENTRY_A),
    });
    const candidate = rankedOutcome(ATTEMPT_A, completedAt, 80);
    expect(
      upgraded.raw
        .prepare(
          "SELECT candidate_json FROM terminal_results WHERE attempt_id = ?",
        )
        .get(ATTEMPT_A),
    ).toMatchObject({
      candidate_json: expect.not.stringContaining("rankingSnapshot"),
    });
    await expect(
      repository.finalizeTerminalResult({
        attemptId: ATTEMPT_A,
        leaseId: LEASE_A,
        generation: 1,
        candidate,
      }),
    ).resolves.toMatchObject({
      kind: "idempotent",
      finalized: { outcome: legacyOutcome },
    });
    await expect(
      repository.finalizeTerminalResult({
        attemptId: ATTEMPT_A,
        leaseId: LEASE_A,
        generation: 1,
        candidate: rankedOutcome(ATTEMPT_A, completedAt, 81),
      }),
    ).rejects.toMatchObject({ code: "terminal_result_conflict" });
    const reopened = upgraded.reopen();
    expect(
      reopened.raw
        .prepare("SELECT COUNT(*) AS count FROM schema_migrations")
        .get(),
    ).toMatchObject({ count: 22 });
    reopened.close();
    upgraded.close();
  });

  it("quarantines v6-only invalidation timestamps so upgrade remains total and policies stay inactive", async () => {
    const filename = join(fixture.directory, "legacy-v6-invalidations.sqlite");
    const legacy = openSqliteDatabaseAtVersionForTest(filename, 6);
    const legacyPolicy = new SQLiteCompetitivePolicyRepository({
      database: legacy,
      clock: fixture.clock,
    });
    await legacyPolicy.storeBenchmarkReceipt(
      passingWorkflowBenchmarkReceiptFixture,
    );
    legacy.raw
      .prepare(
        "INSERT INTO approved_competitive_model_policies (id, receipt_id, receipt_sha256, receipt_schema_version, model_bundle_id, workflow_id, workflow_version, provider_version, calibration_evidence_version, challenge_id, challenge_version, rule_version, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'wall-pass', 1, 'wall-pass-v1-score-1', 1, ?)",
      )
      .run(
        "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        passingWorkflowBenchmarkReceiptFixture.id,
        passingWorkflowBenchmarkReceiptFixture.receiptSha256,
        passingWorkflowBenchmarkReceiptFixture.schemaVersion,
        passingWorkflowBenchmarkReceiptFixture.workflow.modelBundleId,
        passingWorkflowBenchmarkReceiptFixture.workflow.workflowId,
        passingWorkflowBenchmarkReceiptFixture.workflow.workflowVersion,
        passingWorkflowBenchmarkReceiptFixture.workflow.providerVersion,
        "wall-pass-calibration-evidence-v1",
        fixture.clock.now(),
      );
    legacy.raw
      .prepare(
        "INSERT INTO workflow_benchmark_receipt_invalidations (receipt_id, invalidated_at, reason, created_at) VALUES (?, ?, 'operator_revoked', ?)",
      )
      .run(
        passingWorkflowBenchmarkReceiptFixture.id,
        "2030-01-15T24:00:00.000Z",
        fixture.clock.now(),
      );
    legacy.close();

    const upgraded = openSqliteDatabase(filename);
    const upgradedPolicy = new SQLiteCompetitivePolicyRepository({
      database: upgraded,
      clock: fixture.clock,
    });
    const tuple = {
      workspaceId: passingWorkflowBenchmarkReceiptFixture.workflow.workspaceId,
      modelBundleId:
        passingWorkflowBenchmarkReceiptFixture.workflow.modelBundleId,
      workflowId: passingWorkflowBenchmarkReceiptFixture.workflow.workflowId,
      workflowVersion:
        passingWorkflowBenchmarkReceiptFixture.workflow.workflowVersion,
      providerVersion:
        passingWorkflowBenchmarkReceiptFixture.workflow.providerVersion,
      calibrationEvidenceVersion: "wall-pass-calibration-evidence-v1",
      extractionEvidenceVersion: "c5-frame-manifest-v1" as const,
      observationEvidenceVersion: "wall-pass-geometry-evidence-v1" as const,
      challengeId: "wall-pass" as const,
      challengeVersion: 1 as const,
      ruleVersion: "wall-pass-v1-score-1" as const,
    };

    expect(
      upgraded.raw
        .prepare(
          "SELECT invalidated_at, quarantine_reason FROM workflow_benchmark_receipt_invalidation_quarantine WHERE receipt_id = ?",
        )
        .get(passingWorkflowBenchmarkReceiptFixture.id),
    ).toEqual({
      invalidated_at: "2030-01-15T24:00:00.000Z",
      quarantine_reason: "invalid_v6_timestamp",
    });
    await expect(
      upgradedPolicy.getActiveCompetitivePolicy(tuple),
    ).resolves.toBeNull();
    expect(
      upgraded.raw
        .prepare("SELECT COUNT(*) AS count FROM schema_migrations")
        .get(),
    ).toMatchObject({ count: 22 });
    upgraded.close();

    const reopened = openSqliteDatabase(filename);
    expect(
      reopened.raw
        .prepare(
          "SELECT COUNT(*) AS count FROM workflow_benchmark_receipt_invalidation_quarantine",
        )
        .get(),
    ).toMatchObject({ count: 1 });
    reopened.close();
  });

  it("rolls back v14 when a legacy receipt payload mismatches its receipt row", async () => {
    const filename = join(
      fixture.directory,
      "legacy-v13-receipt-mismatch.sqlite",
    );
    const legacy = openSqliteDatabaseAtVersionForTest(filename, 13);
    const policy = new SQLiteCompetitivePolicyRepository({
      database: legacy,
      clock: fixture.clock,
    });
    const actual = passingWorkflowBenchmarkReceiptFixture;
    const substituted = renewedReceipt();
    await policy.storeBenchmarkReceipt(actual);
    await policy.storeBenchmarkReceipt(substituted);
    legacy.raw
      .prepare(
        "INSERT INTO approved_competitive_model_policies (id, receipt_id, receipt_sha256, receipt_schema_version, model_bundle_id, workflow_id, workflow_version, provider_version, calibration_evidence_version, challenge_id, challenge_version, rule_version, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'wall-pass', 1, 'wall-pass-v1-score-1', 1, ?)",
      )
      .run(
        "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        actual.id,
        actual.receiptSha256,
        actual.schemaVersion,
        actual.workflow.modelBundleId,
        actual.workflow.workflowId,
        actual.workflow.workflowVersion,
        actual.workflow.providerVersion,
        "wall-pass-calibration-evidence-v1",
        fixture.clock.now(),
      );
    legacy.raw
      .prepare(
        "UPDATE workflow_benchmark_receipts SET receipt_json = ? WHERE id = ?",
      )
      .run(JSON.stringify(substituted), actual.id);
    legacy.close();

    expect(() => openSqliteDatabase(filename)).toThrow(
      "competitive_policy_persisted_data_corrupt",
    );

    const beforeRetry = openSqliteDatabaseAtVersionForTest(filename, 13);
    expect(
      beforeRetry.raw
        .prepare("SELECT COUNT(*) AS count FROM schema_migrations")
        .get(),
    ).toMatchObject({ count: 13 });
    const policyColumns = beforeRetry.raw
      .prepare("PRAGMA table_info(approved_competitive_model_policies)")
      .all() as readonly Readonly<{ name: string }>[];
    expect(policyColumns.some((column) => column.name === "workspace_id")).toBe(
      false,
    );
    beforeRetry.close();
  });

  it("upgrades the exact v14 receipt predecessor with durable C5/C6 versions and reopens", async () => {
    const filename = join(fixture.directory, "legacy-v14-evidence.sqlite");
    const legacy = openSqliteDatabaseAtVersionForTest(filename, 14);
    const {
      receiptSha256: _hash,
      evidence: _evidence,
      ...oldPayload
    } = passingWorkflowBenchmarkReceiptFixture;
    void _hash;
    void _evidence;
    const oldHash = workflowBenchmarkReceiptDigest(oldPayload as never);
    const oldReceipt = { ...oldPayload, receiptSha256: oldHash };
    legacy.raw
      .prepare(
        "INSERT INTO workflow_benchmark_receipts (id, receipt_sha256, schema_version, workflow_id, workflow_version, model_bundle_id, provider_version, status, run_at, valid_until, invalidated_at, receipt_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        oldReceipt.id,
        oldReceipt.receiptSha256,
        oldReceipt.schemaVersion,
        oldReceipt.workflow.workflowId,
        oldReceipt.workflow.workflowVersion,
        oldReceipt.workflow.modelBundleId,
        oldReceipt.workflow.providerVersion,
        oldReceipt.status,
        oldReceipt.runAt,
        oldReceipt.validUntil,
        oldReceipt.invalidatedAt,
        JSON.stringify(oldReceipt),
        fixture.clock.now(),
      );
    legacy.raw
      .prepare(
        "INSERT INTO approved_competitive_model_policies (id, receipt_id, receipt_sha256, receipt_schema_version, model_bundle_id, workflow_id, workflow_version, provider_version, calibration_evidence_version, challenge_id, challenge_version, rule_version, active, created_at, workspace_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'wall-pass', 1, 'wall-pass-v1-score-1', 1, ?, ?)",
      )
      .run(
        "edededed-eded-4ded-8ded-edededededed",
        oldReceipt.id,
        oldReceipt.receiptSha256,
        oldReceipt.schemaVersion,
        oldReceipt.workflow.modelBundleId,
        oldReceipt.workflow.workflowId,
        oldReceipt.workflow.workflowVersion,
        oldReceipt.workflow.providerVersion,
        "wall-pass-calibration-evidence-v1",
        fixture.clock.now(),
        oldReceipt.workflow.workspaceId,
      );
    legacy.close();

    const upgraded = openSqliteDatabase(filename);
    const repository = new SQLiteCompetitivePolicyRepository({
      database: upgraded,
      clock: fixture.clock,
    });
    const tuple = {
      workspaceId: oldReceipt.workflow.workspaceId,
      modelBundleId: oldReceipt.workflow.modelBundleId,
      workflowId: oldReceipt.workflow.workflowId,
      workflowVersion: oldReceipt.workflow.workflowVersion,
      providerVersion: oldReceipt.workflow.providerVersion,
      calibrationEvidenceVersion: "wall-pass-calibration-evidence-v1",
      extractionEvidenceVersion: "c5-frame-manifest-v1" as const,
      observationEvidenceVersion: "wall-pass-geometry-evidence-v1" as const,
      challengeId: "wall-pass" as const,
      challengeVersion: 1 as const,
      ruleVersion: "wall-pass-v1-score-1" as const,
    };
    await expect(
      repository.getActiveCompetitivePolicy(tuple),
    ).resolves.toMatchObject({
      receipt: passingWorkflowBenchmarkReceiptFixture,
      extractionEvidenceVersion: "c5-frame-manifest-v1",
      observationEvidenceVersion: "wall-pass-geometry-evidence-v1",
    });
    upgraded.close();

    const reopened = openSqliteDatabase(filename);
    expect(
      reopened.raw
        .prepare("SELECT COUNT(*) AS count FROM schema_migrations")
        .get(),
    ).toMatchObject({ count: 22 });
    reopened.close();
  });

  it("rolls back v15 when a v14 receipt JSON id does not match its durable row", async () => {
    const filename = join(
      fixture.directory,
      "legacy-v14-receipt-id-mismatch.sqlite",
    );
    const legacy = openSqliteDatabaseAtVersionForTest(filename, 14);
    const {
      receiptSha256: _hash,
      evidence: _evidence,
      ...oldPayload
    } = passingWorkflowBenchmarkReceiptFixture;
    void _hash;
    void _evidence;
    const oldHash = workflowBenchmarkReceiptDigest(oldPayload as never);
    const oldReceipt = { ...oldPayload, receiptSha256: oldHash };
    legacy.raw
      .prepare(
        "INSERT INTO workflow_benchmark_receipts (id, receipt_sha256, schema_version, workflow_id, workflow_version, model_bundle_id, provider_version, status, run_at, valid_until, invalidated_at, receipt_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        oldReceipt.receiptSha256,
        oldReceipt.schemaVersion,
        oldReceipt.workflow.workflowId,
        oldReceipt.workflow.workflowVersion,
        oldReceipt.workflow.modelBundleId,
        oldReceipt.workflow.providerVersion,
        oldReceipt.status,
        oldReceipt.runAt,
        oldReceipt.validUntil,
        oldReceipt.invalidatedAt,
        JSON.stringify(oldReceipt),
        fixture.clock.now(),
      );
    legacy.close();

    expect(() => openSqliteDatabase(filename)).toThrow(
      "competitive_policy_persisted_data_corrupt",
    );
    const beforeRetry = openSqliteDatabaseAtVersionForTest(filename, 14);
    expect(
      beforeRetry.raw
        .prepare("SELECT COUNT(*) AS count FROM schema_migrations")
        .get(),
    ).toMatchObject({ count: 14 });
    beforeRetry.close();
  });

  it.each([
    [
      "status",
      "failed",
      passingWorkflowBenchmarkReceiptFixture.runAt,
      passingWorkflowBenchmarkReceiptFixture.validUntil,
      null,
    ],
    [
      "run_at",
      "passed",
      "2030-01-01T00:00:01.000Z",
      passingWorkflowBenchmarkReceiptFixture.validUntil,
      null,
    ],
    [
      "valid_until",
      "passed",
      passingWorkflowBenchmarkReceiptFixture.runAt,
      "2030-01-30T00:00:00.000Z",
      null,
    ],
    [
      "invalidated_at",
      "passed",
      passingWorkflowBenchmarkReceiptFixture.runAt,
      passingWorkflowBenchmarkReceiptFixture.validUntil,
      "2030-01-15T12:00:00.000Z",
    ],
  ] as const)(
    "rolls back and reopens at v14 when v15 receipt JSON contradicts durable %s",
    async (_, status, runAt, validUntil, invalidatedAt) => {
      const filename = join(
        fixture.directory,
        `legacy-v14-receipt-${_}-mismatch.sqlite`,
      );
      const legacy = openSqliteDatabaseAtVersionForTest(filename, 14);
      const {
        receiptSha256: _hash,
        evidence: _evidence,
        ...oldPayload
      } = passingWorkflowBenchmarkReceiptFixture;
      void _hash;
      void _evidence;
      const oldHash = workflowBenchmarkReceiptDigest(oldPayload as never);
      const oldReceipt = { ...oldPayload, receiptSha256: oldHash };
      legacy.raw
        .prepare(
          "INSERT INTO workflow_benchmark_receipts (id, receipt_sha256, schema_version, workflow_id, workflow_version, model_bundle_id, provider_version, status, run_at, valid_until, invalidated_at, receipt_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          oldReceipt.id,
          oldReceipt.receiptSha256,
          oldReceipt.schemaVersion,
          oldReceipt.workflow.workflowId,
          oldReceipt.workflow.workflowVersion,
          oldReceipt.workflow.modelBundleId,
          oldReceipt.workflow.providerVersion,
          status,
          runAt,
          validUntil,
          invalidatedAt,
          JSON.stringify(oldReceipt),
          fixture.clock.now(),
        );
      legacy.close();

      for (let attempt = 0; attempt < 2; attempt += 1)
        expect(() => openSqliteDatabase(filename)).toThrow(
          "competitive_policy_persisted_data_corrupt",
        );
      const beforeRetry = openSqliteDatabaseAtVersionForTest(filename, 14);
      expect(
        beforeRetry.raw
          .prepare("SELECT COUNT(*) AS count FROM schema_migrations")
          .get(),
      ).toMatchObject({ count: 14 });
      beforeRetry.close();
    },
  );

  it("upgrades an already-applied v7/v8 database with quarantine, policy, and invalidation invariants", async () => {
    const filename = join(
      fixture.directory,
      "legacy-v8-without-quarantine.sqlite",
    );
    const legacy = openSqliteDatabaseAtVersionForTest(filename, 8);
    const validReceipt = passingWorkflowBenchmarkReceiptFixture;
    const invalidReceipt = renewedReceipt();
    const legacyPolicy = new SQLiteCompetitivePolicyRepository({
      database: legacy,
      clock: fixture.clock,
    });
    await legacyPolicy.storeBenchmarkReceipt(validReceipt);
    await legacyPolicy.storeBenchmarkReceipt(invalidReceipt);
    legacy.raw.exec(
      "DROP TABLE workflow_benchmark_receipt_invalidation_quarantine",
    );
    const insertPolicy = legacy.raw.prepare(
      "INSERT INTO approved_competitive_model_policies (id, receipt_id, receipt_sha256, receipt_schema_version, model_bundle_id, workflow_id, workflow_version, provider_version, calibration_evidence_version, challenge_id, challenge_version, rule_version, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'wall-pass', 1, 'wall-pass-v1-score-1', 1, ?)",
    );
    insertPolicy.run(
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      validReceipt.id,
      validReceipt.receiptSha256,
      validReceipt.schemaVersion,
      validReceipt.workflow.modelBundleId,
      validReceipt.workflow.workflowId,
      validReceipt.workflow.workflowVersion,
      validReceipt.workflow.providerVersion,
      "valid-evidence-v1",
      fixture.clock.now(),
    );
    insertPolicy.run(
      "ffffffff-ffff-4fff-8fff-ffffffffffff",
      invalidReceipt.id,
      invalidReceipt.receiptSha256,
      invalidReceipt.schemaVersion,
      invalidReceipt.workflow.modelBundleId,
      invalidReceipt.workflow.workflowId,
      invalidReceipt.workflow.workflowVersion,
      invalidReceipt.workflow.providerVersion,
      "invalid-evidence-v1",
      fixture.clock.now(),
    );
    legacy.raw.pragma("ignore_check_constraints = ON");
    legacy.raw
      .prepare(
        "INSERT INTO workflow_benchmark_receipt_invalidations (receipt_id, invalidated_at, reason, created_at) VALUES (?, '2030-01-15T24:00:00.000Z', 'operator_revoked', ?)",
      )
      .run(invalidReceipt.id, fixture.clock.now());
    legacy.raw.pragma("ignore_check_constraints = OFF");
    legacy.close();

    const upgraded = openSqliteDatabase(filename);
    const policy = new SQLiteCompetitivePolicyRepository({
      database: upgraded,
      clock: fixture.clock,
    });
    const validTuple = {
      workspaceId: validReceipt.workflow.workspaceId,
      modelBundleId: validReceipt.workflow.modelBundleId,
      workflowId: validReceipt.workflow.workflowId,
      workflowVersion: validReceipt.workflow.workflowVersion,
      providerVersion: validReceipt.workflow.providerVersion,
      calibrationEvidenceVersion: "wall-pass-calibration-evidence-v1",
      extractionEvidenceVersion: "c5-frame-manifest-v1" as const,
      observationEvidenceVersion: "wall-pass-geometry-evidence-v1" as const,
      challengeId: "wall-pass" as const,
      challengeVersion: 1 as const,
      ruleVersion: "wall-pass-v1-score-1" as const,
    };
    const invalidTuple = {
      workspaceId: invalidReceipt.workflow.workspaceId,
      modelBundleId: invalidReceipt.workflow.modelBundleId,
      workflowId: invalidReceipt.workflow.workflowId,
      workflowVersion: invalidReceipt.workflow.workflowVersion,
      providerVersion: invalidReceipt.workflow.providerVersion,
      calibrationEvidenceVersion: "wall-pass-calibration-evidence-v1",
      extractionEvidenceVersion: "c5-frame-manifest-v1" as const,
      observationEvidenceVersion: "wall-pass-geometry-evidence-v1" as const,
      challengeId: "wall-pass" as const,
      challengeVersion: 1 as const,
      ruleVersion: "wall-pass-v1-score-1" as const,
    };

    await policy.activateCompetitivePolicy({
      id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      receiptId: validReceipt.id,
      receiptSha256: validReceipt.receiptSha256,
      receiptSchemaVersion: validReceipt.schemaVersion,
      ...validTuple,
    });
    await expect(
      policy.getActiveCompetitivePolicy(validTuple),
    ).resolves.toMatchObject({
      id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    });
    await expect(
      policy.activateCompetitivePolicy({
        id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        receiptId: invalidReceipt.id,
        receiptSha256: invalidReceipt.receiptSha256,
        receiptSchemaVersion: invalidReceipt.schemaVersion,
        ...invalidTuple,
      }),
    ).rejects.toMatchObject({
      code: "competitive_policy_receipt_not_approved",
    });
    await expect(
      policy.invalidateBenchmarkReceipt({
        receiptId: invalidReceipt.id,
        invalidatedAt: "2030-01-16T00:00:00.000Z",
        reason: "operator_revoked",
      }),
    ).resolves.toBeUndefined();
    await expect(
      policy.invalidateBenchmarkReceipt({
        receiptId: invalidReceipt.id,
        invalidatedAt: "2030-01-16T00:00:01.000Z",
        reason: "operator_revoked",
      }),
    ).rejects.toMatchObject({ code: "competitive_policy_conflict" });
    expect(
      upgraded.raw
        .prepare(
          "SELECT COUNT(*) AS count FROM workflow_benchmark_receipt_invalidations WHERE receipt_id = ?",
        )
        .get(invalidReceipt.id),
    ).toMatchObject({ count: 0 });
    expect(
      upgraded.raw
        .prepare(
          "SELECT COUNT(*) AS count FROM workflow_benchmark_receipt_invalidation_quarantine WHERE receipt_id = ?",
        )
        .get(invalidReceipt.id),
    ).toMatchObject({ count: 1 });
    expect(
      upgraded.raw
        .prepare("SELECT COUNT(*) AS count FROM schema_migrations")
        .get(),
    ).toMatchObject({ count: 22 });
    upgraded.close();

    const reopened = openSqliteDatabase(filename);
    const reopenedPolicy = new SQLiteCompetitivePolicyRepository({
      database: reopened,
      clock: fixture.clock,
    });
    await expect(
      reopenedPolicy.invalidateBenchmarkReceipt({
        receiptId: invalidReceipt.id,
        invalidatedAt: "2030-01-16T00:00:00.000Z",
        reason: "operator_revoked",
      }),
    ).resolves.toBeUndefined();
    await expect(
      reopenedPolicy.invalidateBenchmarkReceipt({
        receiptId: invalidReceipt.id,
        invalidatedAt: "2030-01-16T00:00:01.000Z",
        reason: "operator_revoked",
      }),
    ).rejects.toMatchObject({ code: "competitive_policy_conflict" });
    expect(() =>
      reopened.raw
        .prepare(
          "INSERT INTO workflow_benchmark_receipt_invalidations (receipt_id, invalidated_at, reason, created_at) VALUES (?, ?, 'operator_revoked', ?)",
        )
        .run(
          invalidReceipt.id,
          "2030-01-16T00:00:00.000Z",
          fixture.clock.now(),
        ),
    ).toThrow();
    expect(
      reopened.raw
        .prepare(
          "SELECT COUNT(*) AS count FROM workflow_benchmark_receipt_invalidation_quarantine WHERE receipt_id = ?",
        )
        .get(invalidReceipt.id),
    ).toMatchObject({ count: 1 });
    reopened.close();
  });

  it("reconciles a reachable legacy dual invalidation to quarantine before policy lookup", async () => {
    const filename = join(
      fixture.directory,
      "legacy-dual-invalidation-v21.sqlite",
    );
    const legacy = openSqliteDatabaseAtVersionForTest(filename, 21);
    const policy = new SQLiteCompetitivePolicyRepository({
      database: legacy,
      clock: fixture.clock,
    });
    const primaryReceipt = passingWorkflowBenchmarkReceiptFixture;
    const quarantinedReceipt = renewedReceipt();
    await policy.storeBenchmarkReceipt(primaryReceipt);
    await policy.storeBenchmarkReceipt(quarantinedReceipt);
    legacy.raw
      .prepare(
        "INSERT INTO workflow_benchmark_receipt_invalidations (receipt_id, invalidated_at, reason, created_at) VALUES (?, ?, 'operator_revoked', ?)",
      )
      .run(primaryReceipt.id, fixture.clock.now(), fixture.clock.now());
    legacy.raw
      .prepare(
        "INSERT INTO workflow_benchmark_receipt_invalidation_quarantine (receipt_id, invalidated_at, reason, created_at, quarantine_reason) VALUES (?, ?, 'operator_revoked', ?, 'invalid_v6_timestamp')",
      )
      .run(quarantinedReceipt.id, fixture.clock.now(), fixture.clock.now());
    // v9 protected INSERT but its historical triggers did not protect this
    // reachable UPDATE path, leaving both invalidation tables authoritative.
    legacy.raw
      .prepare(
        "UPDATE workflow_benchmark_receipt_invalidations SET receipt_id = ? WHERE receipt_id = ?",
      )
      .run(quarantinedReceipt.id, primaryReceipt.id);
    legacy.close();

    const upgraded = openSqliteDatabase(filename);
    const upgradedPolicy = new SQLiteCompetitivePolicyRepository({
      database: upgraded,
      clock: fixture.clock,
    });
    const quarantinedTuple = competitivePolicyActivation(
      quarantinedReceipt,
      "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    );
    expect(
      upgraded.raw
        .prepare(
          "SELECT COUNT(*) AS count FROM workflow_benchmark_receipt_invalidations WHERE receipt_id = ?",
        )
        .get(quarantinedReceipt.id),
    ).toEqual({ count: 0 });
    expect(
      upgraded.raw
        .prepare(
          "SELECT COUNT(*) AS count FROM workflow_benchmark_receipt_invalidation_quarantine WHERE receipt_id = ?",
        )
        .get(quarantinedReceipt.id),
    ).toEqual({ count: 1 });
    expect(
      upgraded.raw
        .prepare("SELECT COUNT(*) AS count FROM schema_migrations")
        .get(),
    ).toEqual({ count: 22 });
    await expect(
      upgradedPolicy.storeBenchmarkReceipt(quarantinedReceipt),
    ).resolves.toEqual(quarantinedReceipt);
    await expect(
      upgradedPolicy.getActiveCompetitivePolicy(quarantinedTuple),
    ).resolves.toBeNull();
    upgraded.raw
      .prepare(
        "INSERT INTO workflow_benchmark_receipt_invalidations (receipt_id, invalidated_at, reason, created_at) VALUES (?, ?, 'operator_revoked', ?)",
      )
      .run(primaryReceipt.id, fixture.clock.now(), fixture.clock.now());
    expect(() =>
      upgraded.raw
        .prepare(
          "UPDATE workflow_benchmark_receipt_invalidations SET receipt_id = ? WHERE receipt_id = ?",
        )
        .run(quarantinedReceipt.id, primaryReceipt.id),
    ).toThrow("invalidation already quarantined");
    expect(() =>
      upgraded.raw
        .prepare(
          "UPDATE workflow_benchmark_receipt_invalidation_quarantine SET receipt_id = ? WHERE receipt_id = ?",
        )
        .run(primaryReceipt.id, quarantinedReceipt.id),
    ).toThrow("invalidation already recorded");
    upgraded.close();

    const reopened = openSqliteDatabase(filename);
    const reopenedPolicy = new SQLiteCompetitivePolicyRepository({
      database: reopened,
      clock: fixture.clock,
    });
    await expect(
      reopenedPolicy.getActiveCompetitivePolicy(quarantinedTuple),
    ).resolves.toBeNull();
    await expect(
      reopenedPolicy.invalidateBenchmarkReceipt({
        receiptId: quarantinedReceipt.id,
        invalidatedAt: fixture.clock.now(),
        reason: "operator_revoked",
      }),
    ).rejects.toMatchObject({ code: "competitive_policy_conflict" });
    await expect(
      reopenedPolicy.invalidateBenchmarkReceipt({
        receiptId: quarantinedReceipt.id,
        invalidatedAt: "2030-01-15T12:00:01.000Z",
        reason: "operator_revoked",
      }),
    ).rejects.toMatchObject({ code: "competitive_policy_conflict" });
    reopened.close();
  });

  it("drops corrupt legacy recovery states instead of aborting v9 startup", () => {
    const filename = join(
      fixture.directory,
      "legacy-corrupt-recovery-state-v8.sqlite",
    );
    const legacy = openSqliteDatabaseAtVersionForTest(filename, 8);
    legacy.raw.pragma("foreign_keys = OFF");
    legacy.raw.pragma("ignore_check_constraints = ON");
    legacy.raw
      .prepare(
        "INSERT INTO processing_recovery_records (attempt_id, generation, retry_attempts, state, created_at, updated_at) VALUES (?, 1, 0, 'corrupt-recovery-state', ?, ?)",
      )
      .run(
        "99999999-9999-4999-8999-999999999999",
        fixture.clock.now(),
        fixture.clock.now(),
      );
    legacy.raw.pragma("ignore_check_constraints = OFF");
    legacy.close();

    const upgraded = openSqliteDatabase(filename);
    expect(
      upgraded.raw
        .prepare("SELECT COUNT(*) AS count FROM processing_recovery_records")
        .get(),
    ).toEqual({ count: 0 });
    expect(
      upgraded.raw
        .prepare("SELECT COUNT(*) AS count FROM schema_migrations")
        .get(),
    ).toEqual({ count: 22 });
    upgraded.close();
  });

  it("stores parsed receipts but activates only a current passed exact tuple", async () => {
    await fixture.policy.storeBenchmarkReceipt(
      passingWorkflowBenchmarkReceiptFixture,
    );
    await fixture.policy.storeBenchmarkReceipt(
      failedWorkflowBenchmarkReceiptFixture,
    );
    await fixture.policy.storeBenchmarkReceipt(
      staleWorkflowBenchmarkReceiptFixture,
    );
    const policy = {
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      receiptId: passingWorkflowBenchmarkReceiptFixture.id,
      receiptSha256: passingWorkflowBenchmarkReceiptFixture.receiptSha256,
      receiptSchemaVersion:
        passingWorkflowBenchmarkReceiptFixture.schemaVersion,
      workspaceId: passingWorkflowBenchmarkReceiptFixture.workflow.workspaceId,
      modelBundleId:
        passingWorkflowBenchmarkReceiptFixture.workflow.modelBundleId,
      workflowId: passingWorkflowBenchmarkReceiptFixture.workflow.workflowId,
      workflowVersion:
        passingWorkflowBenchmarkReceiptFixture.workflow.workflowVersion,
      providerVersion:
        passingWorkflowBenchmarkReceiptFixture.workflow.providerVersion,
      calibrationEvidenceVersion: "wall-pass-calibration-evidence-v1",
      extractionEvidenceVersion: "c5-frame-manifest-v1" as const,
      observationEvidenceVersion: "wall-pass-geometry-evidence-v1" as const,
      challengeId: "wall-pass" as const,
      challengeVersion: 1 as const,
      ruleVersion: "wall-pass-v1-score-1" as const,
    };

    await expect(
      fixture.policy.activateCompetitivePolicy({
        ...policy,
        receiptId: failedWorkflowBenchmarkReceiptFixture.id,
      }),
    ).rejects.toMatchObject({
      code: "competitive_policy_receipt_not_approved",
    });
    await expect(
      fixture.policy.activateCompetitivePolicy({
        ...policy,
        receiptId: staleWorkflowBenchmarkReceiptFixture.id,
      }),
    ).rejects.toMatchObject({
      code: "competitive_policy_receipt_not_approved",
    });
    await expect(
      fixture.policy.activateCompetitivePolicy({
        ...policy,
        receiptId: "missing-receipt",
      }),
    ).rejects.toMatchObject({
      code: "competitive_policy_receipt_not_found",
    });
    await expect(
      fixture.policy.activateCompetitivePolicy({
        ...policy,
        receiptSha256: "0".repeat(64),
      }),
    ).rejects.toMatchObject({
      code: "competitive_policy_receipt_mismatch",
    });
    await fixture.policy.activateCompetitivePolicy(policy);
    expect(
      await fixture.policy.getActiveCompetitivePolicy(policy),
    ).toMatchObject({ id: policy.id });

    fixture.clock.advance(
      Date.parse(passingWorkflowBenchmarkReceiptFixture.validUntil) -
        Date.parse(fixture.clock.now()) -
        1,
    );
    expect(
      await fixture.policy.getActiveCompetitivePolicy(policy),
    ).toMatchObject({ id: policy.id });
    fixture.clock.advance(1);
    await expect(
      fixture.policy.getActiveCompetitivePolicy(policy),
    ).resolves.toBeNull();

    const renewal = renewedReceipt();
    await fixture.policy.storeBenchmarkReceipt(renewal);
    const renewedPolicy = {
      ...policy,
      id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      receiptId: renewal.id,
      receiptSha256: renewal.receiptSha256,
    };
    await fixture.policy.activateCompetitivePolicy(renewedPolicy);
    expect(
      await fixture.policy.getActiveCompetitivePolicy(policy),
    ).toMatchObject({ id: renewedPolicy.id });
    await fixture.policy.invalidateBenchmarkReceipt({
      receiptId: renewal.id,
      invalidatedAt: fixture.clock.now(),
      reason: "operator_revoked",
    });
    await expect(
      fixture.policy.getActiveCompetitivePolicy(policy),
    ).resolves.toBeNull();
    await expect(
      fixture.policy.invalidateBenchmarkReceipt({
        receiptId: renewal.id,
        invalidatedAt: fixture.clock.now(),
        reason: "operator_revoked",
      }),
    ).resolves.toBeUndefined();
    await expect(
      fixture.policy.invalidateBenchmarkReceipt({
        receiptId: renewal.id,
        invalidatedAt: "2030-01-31T00:00:01.000Z",
        reason: "operator_revoked",
      }),
    ).rejects.toMatchObject({ code: "competitive_policy_conflict" });
    await expect(
      fixture.policy.invalidateBenchmarkReceipt({
        receiptId: renewal.id,
        invalidatedAt: "not-a-timestamp",
        reason: "not-a-reason" as never,
      }),
    ).rejects.toMatchObject({
      code: "competitive_policy_invalid_invalidation",
    });
    await fixture.policy.deactivateCompetitivePolicy({ id: renewedPolicy.id });
  });

  it.each([
    ["status", "status", "failed"],
    ["run time", "run_at", "2030-01-01T12:00:01.000Z"],
    ["expiry", "valid_until", "2030-01-31T12:00:01.000Z"],
    ["invalidation time", "invalidated_at", "2030-01-15T12:00:00.000Z"],
  ] as const)(
    "rejects idempotent receipt storage when the durable %s contradicts its canonical JSON",
    async (_, column, contradiction) => {
      await fixture.policy.storeBenchmarkReceipt(
        passingWorkflowBenchmarkReceiptFixture,
      );
      fixture.database.raw
        .prepare(
          `UPDATE workflow_benchmark_receipts SET ${column} = ? WHERE id = ?`,
        )
        .run(contradiction, passingWorkflowBenchmarkReceiptFixture.id);

      await expect(
        fixture.policy.storeBenchmarkReceipt(
          passingWorkflowBenchmarkReceiptFixture,
        ),
      ).rejects.toMatchObject({
        code: "competitive_policy_persisted_data_corrupt",
      });
      expect(
        fixture.database.raw
          .prepare(
            `SELECT ${column} AS value FROM workflow_benchmark_receipts WHERE id = ?`,
          )
          .get(passingWorkflowBenchmarkReceiptFixture.id),
      ).toMatchObject({ value: contradiction });
    },
  );

  it("accepts an idempotent receipt store only when every durable duplicate matches", async () => {
    await fixture.policy.storeBenchmarkReceipt(
      passingWorkflowBenchmarkReceiptFixture,
    );

    await expect(
      fixture.policy.storeBenchmarkReceipt(
        passingWorkflowBenchmarkReceiptFixture,
      ),
    ).resolves.toEqual(passingWorkflowBenchmarkReceiptFixture);
  });

  it("normalizes optional-millisecond invalidation timestamps before persistence", async () => {
    await fixture.policy.storeBenchmarkReceipt(
      passingWorkflowBenchmarkReceiptFixture,
    );
    await expect(
      fixture.policy.invalidateBenchmarkReceipt({
        receiptId: passingWorkflowBenchmarkReceiptFixture.id,
        invalidatedAt: "2030-01-15T12:00:00Z",
        reason: "operator_revoked",
      }),
    ).resolves.toBeUndefined();
    expect(
      fixture.database.raw
        .prepare(
          "SELECT invalidated_at FROM workflow_benchmark_receipt_invalidations WHERE receipt_id = ?",
        )
        .get(passingWorkflowBenchmarkReceiptFixture.id),
    ).toMatchObject({ invalidated_at: "2030-01-15T12:00:00.000Z" });
    await expect(
      fixture.policy.invalidateBenchmarkReceipt({
        receiptId: passingWorkflowBenchmarkReceiptFixture.id,
        invalidatedAt: "2030-01-15T12:00:00.000Z",
        reason: "operator_revoked",
      }),
    ).resolves.toBeUndefined();
  });

  it("does not return a policy whose persisted receipt payload is corrupt", async () => {
    await fixture.policy.storeBenchmarkReceipt(
      passingWorkflowBenchmarkReceiptFixture,
    );
    const policy = {
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      receiptId: passingWorkflowBenchmarkReceiptFixture.id,
      receiptSha256: passingWorkflowBenchmarkReceiptFixture.receiptSha256,
      receiptSchemaVersion:
        passingWorkflowBenchmarkReceiptFixture.schemaVersion,
      workspaceId: passingWorkflowBenchmarkReceiptFixture.workflow.workspaceId,
      modelBundleId:
        passingWorkflowBenchmarkReceiptFixture.workflow.modelBundleId,
      workflowId: passingWorkflowBenchmarkReceiptFixture.workflow.workflowId,
      workflowVersion:
        passingWorkflowBenchmarkReceiptFixture.workflow.workflowVersion,
      providerVersion:
        passingWorkflowBenchmarkReceiptFixture.workflow.providerVersion,
      calibrationEvidenceVersion: "wall-pass-calibration-evidence-v1",
      extractionEvidenceVersion: "c5-frame-manifest-v1" as const,
      observationEvidenceVersion: "wall-pass-geometry-evidence-v1" as const,
      challengeId: "wall-pass" as const,
      challengeVersion: 1 as const,
      ruleVersion: "wall-pass-v1-score-1" as const,
    };
    await fixture.policy.activateCompetitivePolicy(policy);
    fixture.database.raw
      .prepare(
        "UPDATE workflow_benchmark_receipts SET receipt_json = ? WHERE id = ?",
      )
      .run("{bad-json", policy.receiptId);

    await expect(
      fixture.policy.getActiveCompetitivePolicy(policy),
    ).rejects.toMatchObject({
      code: "competitive_policy_persisted_data_corrupt",
    });
  });

  it("returns a strictly parsed receipt only for the receipt workspace", async () => {
    await fixture.policy.storeBenchmarkReceipt(
      passingWorkflowBenchmarkReceiptFixture,
    );
    const policy = {
      id: "abababab-abab-4bab-8bab-abababababab",
      receiptId: passingWorkflowBenchmarkReceiptFixture.id,
      receiptSha256: passingWorkflowBenchmarkReceiptFixture.receiptSha256,
      receiptSchemaVersion:
        passingWorkflowBenchmarkReceiptFixture.schemaVersion,
      workspaceId: passingWorkflowBenchmarkReceiptFixture.workflow.workspaceId,
      modelBundleId:
        passingWorkflowBenchmarkReceiptFixture.workflow.modelBundleId,
      workflowId: passingWorkflowBenchmarkReceiptFixture.workflow.workflowId,
      workflowVersion:
        passingWorkflowBenchmarkReceiptFixture.workflow.workflowVersion,
      providerVersion:
        passingWorkflowBenchmarkReceiptFixture.workflow.providerVersion,
      calibrationEvidenceVersion: "wall-pass-calibration-evidence-v1",
      extractionEvidenceVersion: "c5-frame-manifest-v1" as const,
      observationEvidenceVersion: "wall-pass-geometry-evidence-v1" as const,
      challengeId: "wall-pass" as const,
      challengeVersion: 1 as const,
      ruleVersion: "wall-pass-v1-score-1" as const,
    };
    await fixture.policy.activateCompetitivePolicy(policy);

    await expect(
      fixture.policy.getActiveCompetitivePolicy(policy),
    ).resolves.toMatchObject({
      workspaceId: policy.workspaceId,
      receipt: passingWorkflowBenchmarkReceiptFixture,
    });
    await expect(
      fixture.policy.getActiveCompetitivePolicy({
        ...policy,
        workspaceId: "wrong-workspace",
      }),
    ).resolves.toBeNull();
  });

  it("snapshots the exact database and statement reader before later policy lookup mutations", async () => {
    let databaseReads = 0;
    const raw = fixture.database.raw;
    const prepare = raw.prepare.bind(raw);
    const rawPrepareDescriptor = Object.getOwnPropertyDescriptor(
      raw,
      "prepare",
    );
    let policyStatement: object | undefined;
    Object.defineProperty(raw, "prepare", {
      configurable: true,
      value(source: string) {
        const statement = prepare(source);
        if (source.includes("FROM approved_competitive_model_policies"))
          policyStatement = statement;
        return statement;
      },
    });
    let policy: SQLiteCompetitivePolicyRepository;
    try {
      policy = new SQLiteCompetitivePolicyRepository({
        get database() {
          databaseReads += 1;
          if (databaseReads > 1) throw new Error("policy database re-read");
          return fixture.database;
        },
        clock: fixture.clock,
      });
    } finally {
      if (rawPrepareDescriptor)
        Object.defineProperty(raw, "prepare", rawPrepareDescriptor);
      else Reflect.deleteProperty(raw, "prepare");
    }
    expect(databaseReads).toBe(1);
    const tuple = competitivePolicyActivation(
      passingWorkflowBenchmarkReceiptFixture,
      "abababab-abab-4bab-8bab-abababababab",
    );
    await policy.storeBenchmarkReceipt(passingWorkflowBenchmarkReceiptFixture);
    await policy.activateCompetitivePolicy(tuple);
    const port = resolveProductionSQLiteCompetitivePolicyLookupPort(policy);
    if (!port) throw new Error("expected a factory-issued policy lookup port");

    const statementPrototype = Object.getPrototypeOf(
      raw.prepare("SELECT 1"),
    ) as { get: (...parameters: unknown[]) => unknown };
    const getDescriptor = Object.getOwnPropertyDescriptor(
      statementPrototype,
      "get",
    );
    if (!getDescriptor || typeof getDescriptor.value !== "function")
      throw new Error("expected a SQLite statement get method");
    try {
      Object.defineProperty(statementPrototype, "get", {
        configurable: true,
        value: () => undefined,
      });
      // This is the first lazy policy lookup. Its statement reader must have
      // been captured at adapter issuance, before this prototype mutation.
      await expect(port.lookup.getActivePolicy(tuple)).resolves.toMatchObject({
        id: tuple.id,
      });
    } finally {
      Object.defineProperty(statementPrototype, "get", getDescriptor);
    }

    const ownPrepare = raw.prepare;
    Object.defineProperty(raw, "prepare", {
      configurable: true,
      value: () => {
        throw new Error("mutated raw prepare");
      },
    });
    await expect(port.lookup.getActivePolicy(tuple)).resolves.toMatchObject({
      id: tuple.id,
    });
    Reflect.deleteProperty(raw, "prepare");

    const prototype = Object.getPrototypeOf(raw) as {
      prepare: typeof raw.prepare;
    };
    const prototypeDescriptor = Object.getOwnPropertyDescriptor(
      prototype,
      "prepare",
    );
    Object.defineProperty(prototype, "prepare", {
      configurable: true,
      value: () => {
        throw new Error("mutated raw prototype prepare");
      },
    });
    await expect(port.lookup.getActivePolicy(tuple)).resolves.toMatchObject({
      id: tuple.id,
    });
    if (prototypeDescriptor)
      Object.defineProperty(prototype, "prepare", prototypeDescriptor);
    else Reflect.deleteProperty(prototype, "prepare");
    expect(ownPrepare).toBeTypeOf("function");

    const originalGet = getDescriptor.value as (
      this: object,
      ...parameters: unknown[]
    ) => unknown;
    try {
      if (!policyStatement)
        throw new Error("expected a policy lookup statement");
      const staleRow = Reflect.apply(originalGet, policyStatement, [
        fixture.clock.current,
        tuple.workspaceId,
        tuple.modelBundleId,
        tuple.workflowId,
        tuple.workflowVersion,
        tuple.providerVersion,
        tuple.calibrationEvidenceVersion,
        tuple.extractionEvidenceVersion,
        tuple.observationEvidenceVersion,
        tuple.challengeId,
        tuple.challengeVersion,
        tuple.ruleVersion,
      ]);
      Object.defineProperty(policyStatement, "get", {
        configurable: true,
        value: () => staleRow,
      });
      await policy.deactivateCompetitivePolicy({ id: tuple.id });
      await expect(port.lookup.getActivePolicy(tuple)).resolves.toBeNull();
    } finally {
      if (policyStatement) Reflect.deleteProperty(policyStatement, "get");
      Object.defineProperty(statementPrototype, "get", getDescriptor);
    }
  });

  it("downgrades an already-eligible ranked candidate when its policy deactivates before C4 finalization", async () => {
    await fixture.repository.issueCalibrationSession({
      id: SESSION_A,
      athleteId: ATHLETE_A,
      nonce: "a".repeat(43),
      challengeId: "wall-pass",
      challengeVersion: 1,
    });
    await fixture.repository.readyCalibrationSession({
      id: SESSION_A,
      athleteId: ATHLETE_A,
      requiredGates: ["device", "space", "athlete", "rehearsal", "record"],
    });
    await fixture.repository.createAttempt({
      id: ATTEMPT_A,
      athleteId: ATHLETE_A,
      input: {
        mode: "verified",
        challengeId: "wall-pass",
        challengeVersion: 1,
        calibrationSessionId: SESSION_A,
      },
    });
    const job = await attachMedia(fixture, {
      attemptId: ATTEMPT_A,
      athleteId: ATHLETE_A,
      media: {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        contentType: "video/mp4",
        bytes: 10,
        deleteAt: "2030-01-16T12:00:00.000Z",
      },
    });
    const claim = (await fixture.repository.claimProcessing(job))!;
    const policy = competitivePolicyActivation(
      passingWorkflowBenchmarkReceiptFixture,
      "abababab-abab-4bab-8bab-abababababab",
    );
    await fixture.policy.storeBenchmarkReceipt(
      passingWorkflowBenchmarkReceiptFixture,
    );
    await fixture.policy.activateCompetitivePolicy(policy);
    const port = resolveProductionSQLiteCompetitivePolicyLookupPort(
      fixture.policy,
    );
    if (!port) throw new Error("expected a factory-issued policy lookup port");
    const activation = await fixture.policy.getActiveCompetitivePolicy(policy);
    if (!activation) throw new Error("expected active policy activation");
    const rankedPolicy = issueRankedPolicyFinalization(
      port.finalization,
      activation,
    );
    if (!rankedPolicy) throw new Error("expected ranked policy finalization");
    await fixture.policy.deactivateCompetitivePolicy({ id: policy.id });

    await expect(
      fixture.repository.finalizeTerminalResult({
        attemptId: ATTEMPT_A,
        leaseId: claim.leaseId,
        generation: claim.generation,
        candidate: rankedOutcome(ATTEMPT_A, fixture.clock.now(), 80),
        rankedPolicy,
      }),
    ).resolves.toMatchObject({
      kind: "finalized",
      finalized: {
        outcome: {
          state: "valid",
          result: {
            competitiveStatus: "experimental",
            competitiveEligible: false,
          },
        },
      },
    });
    expect(
      fixture.database.raw
        .prepare("SELECT COUNT(*) AS count FROM leaderboard_entries")
        .get(),
    ).toEqual({ count: 0 });
  });

  it("fails safe when a ranked C4 candidate has no bound policy authority", async () => {
    const claim = await claimVerifiedAttempt(fixture, {
      attemptId: ATTEMPT_A,
      athleteId: ATHLETE_A,
      sessionId: SESSION_A,
      mediaId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    });
    await activatePassingCompetitivePolicy(fixture);

    await expect(
      fixture.repository.finalizeTerminalResult({
        attemptId: ATTEMPT_A,
        leaseId: claim.leaseId,
        generation: claim.generation,
        candidate: rankedOutcome(ATTEMPT_A, fixture.clock.now(), 80),
      }),
    ).resolves.toMatchObject({
      kind: "finalized",
      finalized: {
        outcome: {
          state: "valid",
          result: {
            competitiveStatus: "experimental",
            competitiveEligible: false,
          },
        },
      },
    });
    expect(
      fixture.database.raw
        .prepare("SELECT COUNT(*) AS count FROM leaderboard_entries")
        .get(),
    ).toEqual({ count: 0 });
  });

  it("rejects a same-tuple replacement policy when C7 approved a different receipt", async () => {
    const claim = await claimVerifiedAttempt(fixture, {
      attemptId: ATTEMPT_A,
      athleteId: ATHLETE_A,
      sessionId: SESSION_A,
      mediaId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    });
    const { rankedPolicy } = await activatePassingCompetitivePolicy(fixture);
    const renewal = renewedReceipt();
    await fixture.policy.storeBenchmarkReceipt(renewal);
    await fixture.policy.activateCompetitivePolicy(
      competitivePolicyActivation(
        renewal,
        "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      ),
    );

    await expect(
      fixture.repository.finalizeTerminalResult({
        attemptId: ATTEMPT_A,
        leaseId: claim.leaseId,
        generation: claim.generation,
        candidate: rankedOutcome(ATTEMPT_A, fixture.clock.now(), 80),
        rankedPolicy,
      }),
    ).resolves.toMatchObject({
      kind: "finalized",
      finalized: {
        outcome: {
          state: "valid",
          result: {
            competitiveStatus: "experimental",
            competitiveEligible: false,
          },
        },
      },
    });
    expect(
      fixture.database.raw
        .prepare("SELECT COUNT(*) AS count FROM leaderboard_entries")
        .get(),
    ).toEqual({ count: 0 });
  });

  it("revalidates invalidated receipts and the exact expiry boundary before ranking", async () => {
    const firstClaim = await claimVerifiedAttempt(fixture, {
      attemptId: ATTEMPT_A,
      athleteId: ATHLETE_A,
      sessionId: SESSION_A,
      mediaId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    });
    const { policy, rankedPolicy } =
      await activatePassingCompetitivePolicy(fixture);
    await fixture.policy.invalidateBenchmarkReceipt({
      receiptId: policy.receiptId,
      invalidatedAt: fixture.clock.now(),
      reason: "operator_revoked",
    });
    await expect(
      fixture.repository.finalizeTerminalResult({
        attemptId: ATTEMPT_A,
        leaseId: firstClaim.leaseId,
        generation: firstClaim.generation,
        candidate: rankedOutcome(ATTEMPT_A, fixture.clock.now(), 80),
        rankedPolicy,
      }),
    ).resolves.toMatchObject({
      kind: "finalized",
      finalized: {
        outcome: {
          state: "valid",
          result: { competitiveStatus: "experimental" },
        },
      },
    });

    const renewal = renewedReceipt();
    fixture.clock.current = new Date(
      Date.parse(renewal.validUntil) - 60_000,
    ).toISOString();
    const secondClaim = await claimVerifiedAttempt(fixture, {
      attemptId: ATTEMPT_B,
      athleteId: ATHLETE_B,
      sessionId: SESSION_B,
      mediaId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    });
    const renewalPolicy = competitivePolicyActivation(
      renewal,
      "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    );
    await fixture.policy.storeBenchmarkReceipt(renewal);
    await fixture.policy.activateCompetitivePolicy(renewalPolicy);
    const renewedPort = resolveProductionSQLiteCompetitivePolicyLookupPort(
      fixture.policy,
    );
    if (!renewedPort) throw new Error("Expected a factory-issued policy port");
    const renewedActivation =
      await fixture.policy.getActiveCompetitivePolicy(renewalPolicy);
    if (!renewedActivation) throw new Error("Expected active renewed policy");
    const renewedRankedPolicy = issueRankedPolicyFinalization(
      renewedPort.finalization,
      renewedActivation,
    );
    if (!renewedRankedPolicy)
      throw new Error("Expected renewed ranked policy finalization");
    fixture.clock.advance(
      Date.parse(renewal.validUntil) - Date.parse(fixture.clock.now()),
    );
    await expect(
      fixture.repository.finalizeTerminalResult({
        attemptId: ATTEMPT_B,
        leaseId: secondClaim.leaseId,
        generation: secondClaim.generation,
        candidate: rankedOutcome(ATTEMPT_B, fixture.clock.now(), 80),
        rankedPolicy: renewedRankedPolicy,
      }),
    ).resolves.toMatchObject({
      kind: "finalized",
      finalized: {
        outcome: {
          state: "valid",
          result: { competitiveStatus: "experimental" },
        },
      },
    });
    expect(
      fixture.database.raw
        .prepare("SELECT COUNT(*) AS count FROM leaderboard_entries")
        .get(),
    ).toEqual({ count: 0 });
  });

  it("keeps a committed ranked result frozen through duplicate finalization after revocation", async () => {
    const claim = await claimVerifiedAttempt(fixture, {
      attemptId: ATTEMPT_A,
      athleteId: ATHLETE_A,
      sessionId: SESSION_A,
      mediaId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    });
    const { policy, rankedPolicy } =
      await activatePassingCompetitivePolicy(fixture);
    const input = {
      attemptId: ATTEMPT_A,
      leaseId: claim.leaseId,
      generation: claim.generation,
      candidate: rankedOutcome(ATTEMPT_A, fixture.clock.now(), 80),
      rankedPolicy,
    };
    await expect(
      fixture.repository.finalizeTerminalResult(input),
    ).resolves.toMatchObject({
      kind: "finalized",
      finalized: {
        outcome: {
          result: { competitiveStatus: "ranked", rankingSnapshot: { rank: 1 } },
        },
      },
    });
    await fixture.policy.deactivateCompetitivePolicy({ id: policy.id });
    await expect(
      fixture.repository.finalizeTerminalResult(input),
    ).resolves.toMatchObject({
      kind: "idempotent",
      finalized: {
        outcome: {
          result: { competitiveStatus: "ranked", rankingSnapshot: { rank: 1 } },
        },
      },
    });
    expect(
      fixture.database.raw
        .prepare("SELECT COUNT(*) AS count FROM leaderboard_entries")
        .get(),
    ).toEqual({ count: 1 });
  });

  it("revalidates the same authority for tied ranked finalizations", async () => {
    const tieFixture = await makeRepository(
      new TestIds(
        LEASE_A,
        LEASE_B,
        ENTRY_A,
        ENTRY_B,
        "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      ),
    );
    try {
      const first = await claimVerifiedAttempt(tieFixture, {
        attemptId: ATTEMPT_A,
        athleteId: ATHLETE_A,
        sessionId: SESSION_A,
        mediaId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      });
      const second = await claimVerifiedAttempt(tieFixture, {
        attemptId: ATTEMPT_B,
        athleteId: ATHLETE_B,
        sessionId: SESSION_B,
        mediaId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      });
      const { rankedPolicy } =
        await activatePassingCompetitivePolicy(tieFixture);
      const completedAt = tieFixture.clock.now();
      const [firstResult, secondResult] = await Promise.all([
        tieFixture.repository.finalizeTerminalResult({
          attemptId: ATTEMPT_A,
          leaseId: first.leaseId,
          generation: first.generation,
          candidate: rankedOutcome(ATTEMPT_A, completedAt, 80),
          rankedPolicy,
        }),
        tieFixture.repository.finalizeTerminalResult({
          attemptId: ATTEMPT_B,
          leaseId: second.leaseId,
          generation: second.generation,
          candidate: rankedOutcome(ATTEMPT_B, completedAt, 80),
          rankedPolicy,
        }),
      ]);
      expect([firstResult, secondResult]).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: "finalized" }),
          expect.objectContaining({ kind: "finalized" }),
        ]),
      );
      const outcomes = tieFixture.database.raw
        .prepare(
          "SELECT outcome_json FROM terminal_results WHERE attempt_id IN (?, ?) ORDER BY attempt_id",
        )
        .all(ATTEMPT_A, ATTEMPT_B) as readonly Readonly<{
        outcome_json: string;
      }>[];
      expect(
        outcomes.map(({ outcome_json }) => JSON.parse(outcome_json)),
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            result: expect.objectContaining({
              competitiveStatus: "ranked",
              rankingSnapshot: expect.objectContaining({ rank: 1 }),
            }),
          }),
          expect.objectContaining({
            result: expect.objectContaining({ competitiveStatus: "ranked" }),
          }),
        ]),
      );
      expect(
        tieFixture.database.raw
          .prepare("SELECT COUNT(*) AS count FROM leaderboard_entries")
          .get(),
      ).toEqual({ count: 2 });
    } finally {
      tieFixture.database.close();
      await rm(tieFixture.directory, { recursive: true, force: true });
    }
  });

  it("rolls back ranked finalization atomically when the leaderboard insert rejects", async () => {
    const claim = await claimVerifiedAttempt(fixture, {
      attemptId: ATTEMPT_A,
      athleteId: ATHLETE_A,
      sessionId: SESSION_A,
      mediaId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    });
    const { rankedPolicy } = await activatePassingCompetitivePolicy(fixture);
    fixture.database.raw.exec(`
      CREATE TRIGGER reject_ranked_leaderboard_insert
      BEFORE INSERT ON leaderboard_entries
      BEGIN
        SELECT RAISE(ABORT, 'forced leaderboard rejection');
      END;
    `);
    await expect(
      fixture.repository.finalizeTerminalResult({
        attemptId: ATTEMPT_A,
        leaseId: claim.leaseId,
        generation: claim.generation,
        candidate: rankedOutcome(ATTEMPT_A, fixture.clock.now(), 80),
        rankedPolicy,
      }),
    ).rejects.toThrow("forced leaderboard rejection");
    expect(
      fixture.database.raw
        .prepare("SELECT COUNT(*) AS count FROM terminal_results")
        .get(),
    ).toEqual({ count: 0 });
    expect(
      fixture.database.raw
        .prepare("SELECT COUNT(*) AS count FROM leaderboard_entries")
        .get(),
    ).toEqual({ count: 0 });
    expect(
      fixture.database.raw
        .prepare("SELECT status FROM attempts WHERE id = ?")
        .get(ATTEMPT_A),
    ).toEqual({ status: "processing" });
  });

  it("downgrades when a concurrent policy deactivation wins the SQLite write lock", async () => {
    const claim = await claimVerifiedAttempt(fixture, {
      attemptId: ATTEMPT_A,
      athleteId: ATHLETE_A,
      sessionId: SESSION_A,
      mediaId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    });
    const { policy, activation } =
      await activatePassingCompetitivePolicy(fixture);
    const deactivationHold = new SharedArrayBuffer(
      Int32Array.BYTES_PER_ELEMENT,
    );
    const deactivator = startRepositoryActor({
      filename: join(fixture.directory, "api.sqlite"),
      now: fixture.clock.now(),
      ids: [],
      delayMilliseconds: 0,
      holdAtBegin: deactivationHold,
      action: "deactivate-policy",
      input: { id: policy.id },
    });
    const finalizer = startRepositoryActor({
      filename: join(fixture.directory, "api.sqlite"),
      now: fixture.clock.now(),
      ids: [ENTRY_A, "dddddddd-dddd-4ddd-8ddd-dddddddddddd"],
      delayMilliseconds: 0,
      action: "finalize-with-current-policy",
      input: {
        attemptId: ATTEMPT_A,
        leaseId: claim.leaseId,
        generation: claim.generation,
        candidate: rankedOutcome(ATTEMPT_A, fixture.clock.now(), 80),
        activation,
      },
    });
    await Promise.all([deactivator.ready, finalizer.ready]);
    deactivator.start();
    await deactivator.acquired;
    finalizer.start();
    await finalizer.attempting;
    Atomics.store(new Int32Array(deactivationHold), 0, 1);
    Atomics.notify(new Int32Array(deactivationHold), 0);
    const [deactivated, finalized] = await Promise.all([
      deactivator.done,
      finalizer.done,
    ]);
    expect(deactivated.error).toBeUndefined();
    expect(finalized.error).toBeUndefined();
    expect(finalized.value).toMatchObject({
      kind: "finalized",
      finalized: {
        outcome: {
          result: {
            competitiveStatus: "experimental",
            competitiveEligible: false,
          },
        },
      },
    });
    expect(
      fixture.database.raw
        .prepare("SELECT COUNT(*) AS count FROM leaderboard_entries")
        .get(),
    ).toEqual({ count: 0 });
  });

  it("freezes ranked results when C4 finalization wins the concurrent deactivation lock", async () => {
    const claim = await claimVerifiedAttempt(fixture, {
      attemptId: ATTEMPT_A,
      athleteId: ATHLETE_A,
      sessionId: SESSION_A,
      mediaId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    });
    const { policy, activation } =
      await activatePassingCompetitivePolicy(fixture);
    const finalizationHold = new SharedArrayBuffer(
      Int32Array.BYTES_PER_ELEMENT,
    );
    const finalizer = startRepositoryActor({
      filename: join(fixture.directory, "api.sqlite"),
      now: fixture.clock.now(),
      ids: [ENTRY_A, "dddddddd-dddd-4ddd-8ddd-dddddddddddd"],
      delayMilliseconds: 0,
      holdAtBegin: finalizationHold,
      action: "finalize-with-current-policy",
      input: {
        attemptId: ATTEMPT_A,
        leaseId: claim.leaseId,
        generation: claim.generation,
        candidate: rankedOutcome(ATTEMPT_A, fixture.clock.now(), 80),
        activation,
      },
    });
    const deactivator = startRepositoryActor({
      filename: join(fixture.directory, "api.sqlite"),
      now: fixture.clock.now(),
      ids: [],
      delayMilliseconds: 0,
      action: "deactivate-policy",
      input: { id: policy.id },
    });
    await Promise.all([finalizer.ready, deactivator.ready]);
    finalizer.start();
    await finalizer.acquired;
    deactivator.start();
    await deactivator.attempting;
    Atomics.store(new Int32Array(finalizationHold), 0, 1);
    Atomics.notify(new Int32Array(finalizationHold), 0);
    const [finalized, deactivated] = await Promise.all([
      finalizer.done,
      deactivator.done,
    ]);
    expect(finalized.error).toBeUndefined();
    expect(deactivated.error).toBeUndefined();
    expect(finalized.value).toMatchObject({
      kind: "finalized",
      finalized: {
        outcome: {
          result: {
            competitiveStatus: "ranked",
            rankingSnapshot: { rank: 1 },
          },
        },
      },
    });
    expect(
      fixture.database.raw
        .prepare("SELECT COUNT(*) AS count FROM leaderboard_entries")
        .get(),
    ).toEqual({ count: 1 });
  });

  it("enforces compound ownership, one-use, result linkage, policy provenance, and leaderboard checks in SQLite", async () => {
    const now = fixture.clock.now();
    fixture.database.raw
      .prepare("INSERT INTO athletes (id, created_at) VALUES (?, ?)")
      .run(ATHLETE_A, now);
    expect(() =>
      fixture.database.raw
        .prepare(
          "INSERT INTO attempts (id, athlete_id, mode, challenge_id, challenge_version, calibration_session_id, status, deletion_state, created_at, updated_at) VALUES (?, ?, 'verified', 'wall-pass', 1, 'missing-session', 'awaiting-upload', 'active', ?, ?)",
        )
        .run(ATTEMPT_A, ATHLETE_A, now, now),
    ).toThrow();
    fixture.database.raw
      .prepare(
        "INSERT INTO calibration_sessions (id, athlete_id, nonce, challenge_id, challenge_version, state, issued_at, expires_at) VALUES (?, ?, ?, 'wall-pass', 1, 'ready', ?, ?)",
      )
      .run(
        SESSION_A,
        ATHLETE_A,
        "a".repeat(43),
        now,
        "2030-01-15T12:15:00.000Z",
      );
    fixture.database.raw
      .prepare(
        "INSERT INTO attempts (id, athlete_id, mode, challenge_id, challenge_version, calibration_session_id, status, deletion_state, created_at, updated_at) VALUES (?, ?, 'verified', 'wall-pass', 1, ?, 'awaiting-upload', 'active', ?, ?)",
      )
      .run(ATTEMPT_A, ATHLETE_A, SESSION_A, now, now);
    expect(() =>
      fixture.database.raw
        .prepare(
          "INSERT INTO attempts (id, athlete_id, mode, challenge_id, challenge_version, calibration_session_id, status, deletion_state, created_at, updated_at) VALUES (?, ?, 'verified', 'wall-pass', 1, ?, 'awaiting-upload', 'active', ?, ?)",
        )
        .run(ATTEMPT_B, ATHLETE_A, SESSION_A, now, now),
    ).toThrow();
    fixture.database.raw
      .prepare(
        "INSERT INTO attempts (id, athlete_id, mode, status, deletion_state, created_at, updated_at) VALUES (?, ?, 'free', 'awaiting-upload', 'active', ?, ?)",
      )
      .run(ATTEMPT_B, ATHLETE_A, now, now);
    fixture.database.raw
      .prepare(
        "INSERT INTO terminal_results (id, attempt_id, lease_id, generation, terminal_state, outcome_json, candidate_json, completed_at, created_at) VALUES (?, ?, ?, 1, 'failed', '{}', '{}', ?, ?)",
      )
      .run("result-a", ATTEMPT_A, LEASE_A, now, now);
    expect(() =>
      fixture.database.raw
        .prepare(
          "INSERT INTO leaderboard_entries (id, result_id, attempt_id, challenge_id, challenge_version, rule_version, score, completed_at, ranking_snapshot_json, created_at) VALUES (?, ?, ?, 'wall-pass', 1, 'wall-pass-v1-score-1', 80, ?, '{}', ?)",
        )
        .run(ENTRY_A, "result-a", ATTEMPT_B, now, now),
    ).toThrow();
    expect(() =>
      fixture.database.raw
        .prepare(
          "INSERT INTO workflow_benchmark_receipt_invalidations (receipt_id, invalidated_at, reason, created_at) VALUES (?, ?, ?, ?)",
        )
        .run(
          passingWorkflowBenchmarkReceiptFixture.id,
          "2030-01-15T24:00:00.000Z",
          "operator_revoked",
          now,
        ),
    ).toThrow();
    expect(() =>
      fixture.database.raw
        .prepare(
          "INSERT INTO workflow_benchmark_receipt_invalidations (receipt_id, invalidated_at, reason, created_at) VALUES (?, ?, ?, ?)",
        )
        .run(
          passingWorkflowBenchmarkReceiptFixture.id,
          "2030-02-30T12:00:00.000Z",
          "operator_revoked",
          now,
        ),
    ).toThrow();
    expect(() =>
      fixture.database.raw
        .prepare(
          "INSERT INTO leaderboard_entries (id, result_id, attempt_id, challenge_id, challenge_version, rule_version, score, completed_at, ranking_snapshot_json, created_at) VALUES (?, ?, ?, 'wall-pass', 1, 'not-a-rule', 101, ?, '{}', ?)",
        )
        .run(ENTRY_A, "result-a", ATTEMPT_A, now, now),
    ).toThrow();
    await fixture.policy.storeBenchmarkReceipt(
      passingWorkflowBenchmarkReceiptFixture,
    );
    expect(() =>
      fixture.database.raw
        .prepare(
          "INSERT INTO workflow_benchmark_receipt_invalidations (receipt_id, invalidated_at, reason, created_at) VALUES (?, ?, ?, ?)",
        )
        .run(
          passingWorkflowBenchmarkReceiptFixture.id,
          "not-a-timestamp",
          "operator_revoked",
          now,
        ),
    ).toThrow();
    expect(() =>
      fixture.database.raw
        .prepare(
          "INSERT INTO workflow_benchmark_receipt_invalidations (receipt_id, invalidated_at, reason, created_at) VALUES (?, ?, ?, ?)",
        )
        .run(
          passingWorkflowBenchmarkReceiptFixture.id,
          now,
          "not-a-reason",
          now,
        ),
    ).toThrow();
    expect(() =>
      fixture.database.raw
        .prepare(
          "INSERT INTO approved_competitive_model_policies (id, receipt_id, receipt_sha256, receipt_schema_version, model_bundle_id, workflow_id, workflow_version, provider_version, calibration_evidence_version, challenge_id, challenge_version, rule_version, active, created_at) VALUES (?, ?, ?, 'workflow-benchmark-receipt-v1', ?, 'revelai-wall-pass-geometry-v1', '1.0.0', ?, 'wall-pass-calibration-evidence-v1', 'wall-pass', 1, 'wall-pass-v1-score-1', 1, ?)",
        )
        .run(
          "policy-a",
          passingWorkflowBenchmarkReceiptFixture.id,
          "mismatched-hash",
          passingWorkflowBenchmarkReceiptFixture.workflow.modelBundleId,
          passingWorkflowBenchmarkReceiptFixture.workflow.providerVersion,
          now,
        ),
    ).toThrow();
  });

  it("enforces safe integer recovery generations and retry counters in SQLite", async () => {
    const now = fixture.clock.now();
    await fixture.repository.createAttempt({
      id: ATTEMPT_A,
      athleteId: ATHLETE_A,
      input: { mode: "free" },
    });
    const insert = (generation: number, retryAttempts: number) =>
      fixture.database.raw
        .prepare(
          "INSERT INTO processing_recovery_records (attempt_id, generation, retry_attempts, state, created_at, updated_at) VALUES (?, ?, ?, 'retrying', ?, ?)",
        )
        .run(ATTEMPT_A, generation, retryAttempts, now, now);

    expect(() => insert(1.5, 0)).toThrow();
    expect(() => insert(1, 0.5)).toThrow();
    expect(() => insert(-1, 0)).toThrow();
    expect(() => insert(1, -1)).toThrow();
    expect(() => insert(9_007_199_254_740_992, 0)).toThrow();
    expect(() => insert(1, 9_007_199_254_740_992)).toThrow();
  });
});

function tamperCanonicalAesGcmCursor(cursor: string): string {
  const encoded = Buffer.from(cursor, "base64url");
  if (encoded.length <= 12) throw new Error("cursor envelope is incomplete");
  encoded[12] = encoded[12]! ^ 1;
  const tampered = encoded.toString("base64url");
  if (tampered === cursor) throw new Error("cursor tampering was ineffective");
  return tampered;
}
