import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
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
} from "../database/sqlite-database.js";
import {
  InMemoryAnalysisQueue,
  type QueueScheduler,
} from "../queue/in-memory-analysis-queue.js";
import {
  AnalysisWorker,
  ExpectedProcessingFailure,
} from "../workers/analysis-worker.js";
import {
  SQLiteAttemptRepository,
  type Clock,
  type IdGenerator,
} from "./sqlite-attempt-repository.js";
import type { TerminalCandidate } from "./attempt-repository.js";
import { SQLiteCompetitivePolicyRepository } from "./sqlite-competitive-policy-repository.js";

const ATHLETE_A = "11111111-1111-4111-8111-111111111111";
const ATHLETE_B = "22222222-2222-4222-8222-222222222222";
const ATTEMPT_A = "33333333-3333-4333-8333-333333333333";
const ATTEMPT_B = "44444444-4444-4444-8444-444444444444";
const ATTEMPT_C = "55555555-5555-4555-8555-555555555555";
const SESSION_A = "66666666-6666-4666-8666-666666666666";
const SESSION_B = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const LEASE_A = "77777777-7777-4777-8777-777777777777";
const LEASE_B = "88888888-8888-4888-8888-888888888888";
const ENTRY_A = "99999999-9999-4999-8999-999999999999";
const ENTRY_B = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

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
  action: "finalize" | "tombstone" | "create-verified";
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
      const repository = new SQLiteAttemptRepository({
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
  const repository = new SQLiteAttemptRepository({ database, clock, ids });
  const policy = new SQLiteCompetitivePolicyRepository({ database, clock });
  return {
    clock,
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
    const second = await fixture.repository.listAttempts({
      athleteId: ATHLETE_A,
      limit: 1,
      cursor: first.nextCursor!,
    });
    expect(second.items.map((attempt) => attempt.id)).toEqual([ATTEMPT_A]);
    expect(second.nextCursor).toBeNull();
  });

  it("rolls back a just-attached media record when queue delivery cannot be enqueued", async () => {
    await fixture.repository.createAttempt({
      id: ATTEMPT_A,
      athleteId: ATHLETE_A,
      input: { mode: "free" },
    });
    const job = await fixture.repository.attachValidatedMedia({
      attemptId: ATTEMPT_A,
      athleteId: ATHLETE_A,
      media: {
        id: "media-a",
        contentType: "video/mp4",
        bytes: 10,
        deleteAt: "2030-01-16T12:00:00.000Z",
      },
    });
    expect(job).toEqual({ attemptId: ATTEMPT_A, generation: 1 });

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
  });

  it("uses a generation and lease to reject duplicate and stale processing delivery", async () => {
    await fixture.repository.createAttempt({
      id: ATTEMPT_A,
      athleteId: ATHLETE_A,
      input: { mode: "free" },
    });
    const job = await fixture.repository.attachValidatedMedia({
      attemptId: ATTEMPT_A,
      athleteId: ATHLETE_A,
      media: {
        id: "media-a",
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
    const job = await fixture.repository.attachValidatedMedia({
      attemptId: ATTEMPT_A,
      athleteId: ATHLETE_A,
      media: {
        id: "media-a",
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
          calculatedAt: fixture.clock.now(),
        })
      ).entries,
    ).toEqual([]);
  });

  it("serializes independently-run ranked completions into frozen cohorts while preserving live ties", async () => {
    const secondDatabase = fixture.openSecondaryDatabase();
    const second = new SQLiteAttemptRepository({
      database: secondDatabase,
      clock: fixture.clock,
      ids: new TestIds(
        LEASE_B,
        ENTRY_B,
        "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      ),
    });
    for (const [id, athlete, sessionId, nonce] of [
      [ATTEMPT_A, ATHLETE_A, SESSION_A, "a".repeat(43)],
      [ATTEMPT_B, ATHLETE_B, SESSION_B, "b".repeat(43)],
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
      await fixture.repository.attachValidatedMedia({
        attemptId: id,
        athleteId: athlete,
        media: {
          id: `media-${id}`,
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
    const completedAt = fixture.clock.now();
    const first = startRepositoryActor({
      filename: join(fixture.directory, "api.sqlite"),
      now: completedAt,
      ids: [ENTRY_A, "dddddddd-dddd-4ddd-8ddd-dddddddddddd"],
      delayMilliseconds: 0,
      action: "finalize",
      input: {
        attemptId: ATTEMPT_A,
        leaseId: firstClaim.leaseId,
        generation: firstClaim.generation,
        candidate: rankedOutcome(ATTEMPT_A, completedAt, 80),
      },
    });
    const secondActor = startRepositoryActor({
      filename: join(fixture.directory, "api.sqlite"),
      now: completedAt,
      ids: [ENTRY_B, "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"],
      delayMilliseconds: 50,
      action: "finalize",
      input: {
        attemptId: ATTEMPT_B,
        leaseId: secondClaim.leaseId,
        generation: secondClaim.generation,
        candidate: rankedOutcome(ATTEMPT_B, completedAt, 80),
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
    const leaderboard = await fixture.repository.listLiveLeaderboard({
      calculatedAt: completedAt,
    });
    expect(leaderboard).toMatchObject({ cohortSize: 2 });
    expect(leaderboard.entries).toEqual([
      expect.objectContaining({ entryId: ENTRY_A, rank: 1, score: 80 }),
      expect.objectContaining({ entryId: ENTRY_B, rank: 1, score: 80 }),
    ]);
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
    for (const [attemptId, athleteId, sessionId, candidate] of [
      [ATTEMPT_A, ATHLETE_A, SESSION_A, candidates[0]],
      [ATTEMPT_B, ATHLETE_B, SESSION_B, candidates[1]],
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
      const job = await fixture.repository.attachValidatedMedia({
        attemptId,
        athleteId,
        media: {
          id: `media-${attemptId}`,
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
          calculatedAt: fixture.clock.now(),
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
    const job = await fixture.repository.attachValidatedMedia({
      attemptId: ATTEMPT_A,
      athleteId: ATHLETE_A,
      media: {
        id: "media-a",
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
    const job = await fixture.repository.attachValidatedMedia({
      attemptId: ATTEMPT_A,
      athleteId: ATHLETE_A,
      media: {
        id: "media-a",
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
    const job = await fixture.repository.attachValidatedMedia({
      attemptId: ATTEMPT_A,
      athleteId: ATHLETE_A,
      media: {
        id: "media-a",
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
    const job = await fixture.repository.attachValidatedMedia({
      attemptId: ATTEMPT_A,
      athleteId: ATHLETE_A,
      media: {
        id: "media-a",
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

  it("guards rollback and claims by attachment generation, then reclaims only after the exclusive lease boundary", async () => {
    await fixture.repository.createAttempt({
      id: ATTEMPT_A,
      athleteId: ATHLETE_A,
      input: { mode: "free" },
    });
    const firstJob = await fixture.repository.attachValidatedMedia({
      attemptId: ATTEMPT_A,
      athleteId: ATHLETE_A,
      media: {
        id: "media-a",
        contentType: "video/mp4",
        bytes: 10,
        deleteAt: "2030-01-16T12:00:00.000Z",
      },
    });
    await fixture.repository.rollbackMediaAttachment({
      attemptId: ATTEMPT_A,
      generation: firstJob.generation,
    });
    const secondJob = await fixture.repository.attachValidatedMedia({
      attemptId: ATTEMPT_A,
      athleteId: ATHLETE_A,
      media: {
        id: "media-b",
        contentType: "video/mp4",
        bytes: 10,
        deleteAt: "2030-01-16T12:00:00.000Z",
      },
    });
    await fixture.repository.rollbackMediaAttachment({
      attemptId: ATTEMPT_A,
      generation: firstJob.generation,
    });

    expect(secondJob).toEqual({ attemptId: ATTEMPT_A, generation: 2 });
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
    const job = await fixture.repository.attachValidatedMedia({
      attemptId: ATTEMPT_A,
      athleteId: ATHLETE_A,
      media: {
        id: "media-a",
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
        if (calls === 1) throw new Error("temporary processor rejection");
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
    const job = await fixture.repository.attachValidatedMedia({
      attemptId: ATTEMPT_A,
      athleteId: ATHLETE_A,
      media: {
        id: "media-a",
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
        throw new Error("permanent processor failure");
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

  it("settles an invalid classified candidate through fallback terminalization instead of acknowledging a live claim", async () => {
    await fixture.repository.createAttempt({
      id: ATTEMPT_A,
      athleteId: ATHLETE_A,
      input: { mode: "free" },
    });
    const job = await fixture.repository.attachValidatedMedia({
      attemptId: ATTEMPT_A,
      athleteId: ATHLETE_A,
      media: {
        id: "media-a",
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
        throw new ExpectedProcessingFailure(
          freeOutcome(ATTEMPT_B, fixture.clock.now()),
        );
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

  it("recovers a transient finalizer rejection through a new claim and terminalizes once", async () => {
    await fixture.repository.createAttempt({
      id: ATTEMPT_A,
      athleteId: ATHLETE_A,
      input: { mode: "free" },
    });
    const job = await fixture.repository.attachValidatedMedia({
      attemptId: ATTEMPT_A,
      athleteId: ATHLETE_A,
      media: {
        id: "media-a",
        contentType: "video/mp4",
        bytes: 10,
        deleteAt: "2030-01-16T12:00:00.000Z",
      },
    });
    const scheduler = new ManualScheduler();
    const queue = new InMemoryAnalysisQueue({ scheduler });
    let processCalls = 0;
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
      scheduled: scheduler.tasks.length,
    }).toEqual({
      processCalls: 2,
      finalizerCalls: 2,
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

  it("settles permanent candidate finalizer rejections through its bounded fallback", async () => {
    await fixture.repository.createAttempt({
      id: ATTEMPT_A,
      athleteId: ATHLETE_A,
      input: { mode: "free" },
    });
    const job = await fixture.repository.attachValidatedMedia({
      attemptId: ATTEMPT_A,
      athleteId: ATHLETE_A,
      media: {
        id: "media-a",
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
      finalizerCalls: 3,
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

  it("dead-letters a permanently broken fallback builder without leaving a live claim", async () => {
    await fixture.repository.createAttempt({
      id: ATTEMPT_A,
      athleteId: ATHLETE_A,
      input: { mode: "free" },
    });
    const job = await fixture.repository.attachValidatedMedia({
      attemptId: ATTEMPT_A,
      athleteId: ATHLETE_A,
      media: {
        id: "media-a",
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
        throw new Error("permanent processor failure");
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
    ).toMatchObject({ status: "uploaded", outcome: { state: "pending" } });
    expect(
      fixture.database.raw
        .prepare(
          "SELECT state FROM processing_recovery_records WHERE attempt_id = ? AND generation = ?",
        )
        .get(ATTEMPT_A, job.generation),
    ).toEqual({ state: "dead-lettered" });
    expect(await fixture.repository.claimProcessing(job)).toBeNull();
    expect(
      fixture.database.raw
        .prepare(
          "SELECT COUNT(*) AS count FROM terminal_results WHERE attempt_id = ?",
        )
        .get(ATTEMPT_A),
    ).toMatchObject({ count: 0 });
  });

  it("dead-letters an invalid fallback candidate without leaving a live claim", async () => {
    await fixture.repository.createAttempt({
      id: ATTEMPT_A,
      athleteId: ATHLETE_A,
      input: { mode: "free" },
    });
    const job = await fixture.repository.attachValidatedMedia({
      attemptId: ATTEMPT_A,
      athleteId: ATHLETE_A,
      media: {
        id: "media-a",
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
        throw new Error("permanent processor failure");
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
    ).toMatchObject({ status: "uploaded", outcome: { state: "pending" } });
    expect(
      fixture.database.raw
        .prepare(
          "SELECT state FROM processing_recovery_records WHERE attempt_id = ? AND generation = ?",
        )
        .get(ATTEMPT_A, job.generation),
    ).toEqual({ state: "dead-lettered" });
  });

  it("dead-letters a permanently rejecting fallback finalizer without automatic redelivery", async () => {
    await fixture.repository.createAttempt({
      id: ATTEMPT_A,
      athleteId: ATHLETE_A,
      input: { mode: "free" },
    });
    const job = await fixture.repository.attachValidatedMedia({
      attemptId: ATTEMPT_A,
      athleteId: ATHLETE_A,
      media: {
        id: "media-a",
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
    ).toMatchObject({ status: "uploaded", outcome: { state: "pending" } });
    expect(
      fixture.database.raw
        .prepare(
          "SELECT state FROM processing_recovery_records WHERE attempt_id = ? AND generation = ?",
        )
        .get(ATTEMPT_A, job.generation),
    ).toEqual({ state: "dead-lettered" });
  });

  it("reclaims an exact-boundary lease instead of acknowledging its unfinished result", async () => {
    await fixture.repository.createAttempt({
      id: ATTEMPT_A,
      athleteId: ATHLETE_A,
      input: { mode: "free" },
    });
    const job = await fixture.repository.attachValidatedMedia({
      attemptId: ATTEMPT_A,
      athleteId: ATHLETE_A,
      media: {
        id: "media-a",
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
    const job = await fixture.repository.attachValidatedMedia({
      attemptId: ATTEMPT_A,
      athleteId: ATHLETE_A,
      media: {
        id: "media-a",
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
    const job = await fixture.repository.attachValidatedMedia({
      attemptId: ATTEMPT_A,
      athleteId: ATHLETE_A,
      media: {
        id: "media-a",
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
    const job = await fixture.repository.attachValidatedMedia({
      attemptId: ATTEMPT_A,
      athleteId: ATHLETE_A,
      media: {
        id: "media-a",
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
        throw new Error("processor fault after exhausted recovery budget");
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
    const resumed = new SQLiteAttemptRepository({
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

  it("releases a claim and preserves redelivery when SQLite rejects recovery accounting", async () => {
    await fixture.repository.createAttempt({
      id: ATTEMPT_A,
      athleteId: ATHLETE_A,
      input: { mode: "free" },
    });
    const job = await fixture.repository.attachValidatedMedia({
      attemptId: ATTEMPT_A,
      athleteId: ATHLETE_A,
      media: {
        id: "media-a",
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
        throw new Error("processor failure");
      },
      retryWaiter: { wait: async () => undefined },
    });
    const stop = worker.start();

    await queue.enqueue(job);
    await scheduler.tasks.shift()!();
    stop();

    expect(scheduler.tasks).toHaveLength(1);
    expect(
      await fixture.repository.getAttempt({
        attemptId: ATTEMPT_A,
        athleteId: ATHLETE_A,
      }),
    ).toMatchObject({ status: "uploaded", outcome: { state: "pending" } });
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
    const job = await fixture.repository.attachValidatedMedia({
      attemptId: ATTEMPT_A,
      athleteId: ATHLETE_A,
      media: {
        id: "media-a",
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
    const resumed = new SQLiteAttemptRepository({
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
    const job = await fixture.repository.attachValidatedMedia({
      attemptId: ATTEMPT_A,
      athleteId: ATHLETE_A,
      media: {
        id: "media-a",
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
      candidate: rankedOutcome(ATTEMPT_A, fixture.clock.now(), 80),
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
    await fixture.repository.attachValidatedMedia({
      attemptId: ATTEMPT_A,
      athleteId: ATHLETE_A,
      media: {
        id: "media-a",
        contentType: "video/mp4",
        bytes: 10,
        deleteAt: "2030-01-16T12:00:00.000Z",
      },
    });
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
    const repository = new SQLiteAttemptRepository({
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
          id: "media-a",
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
    const repository = new SQLiteAttemptRepository({
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
          id: "media-a",
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
    const repository = new SQLiteAttemptRepository({
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
    ).toMatchObject({ count: 10 });
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
      modelBundleId:
        passingWorkflowBenchmarkReceiptFixture.workflow.modelBundleId,
      workflowId: passingWorkflowBenchmarkReceiptFixture.workflow.workflowId,
      workflowVersion:
        passingWorkflowBenchmarkReceiptFixture.workflow.workflowVersion,
      providerVersion:
        passingWorkflowBenchmarkReceiptFixture.workflow.providerVersion,
      calibrationEvidenceVersion: "wall-pass-calibration-evidence-v1",
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
    ).toMatchObject({ count: 10 });
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
      modelBundleId: validReceipt.workflow.modelBundleId,
      workflowId: validReceipt.workflow.workflowId,
      workflowVersion: validReceipt.workflow.workflowVersion,
      providerVersion: validReceipt.workflow.providerVersion,
      calibrationEvidenceVersion: "valid-evidence-v1",
      challengeId: "wall-pass" as const,
      challengeVersion: 1 as const,
      ruleVersion: "wall-pass-v1-score-1" as const,
    };
    const invalidTuple = {
      modelBundleId: invalidReceipt.workflow.modelBundleId,
      workflowId: invalidReceipt.workflow.workflowId,
      workflowVersion: invalidReceipt.workflow.workflowVersion,
      providerVersion: invalidReceipt.workflow.providerVersion,
      calibrationEvidenceVersion: "invalid-evidence-v1",
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
      policy.getActiveCompetitivePolicy(invalidTuple),
    ).resolves.toBeNull();
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
    ).toMatchObject({ count: 10 });
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
      modelBundleId:
        passingWorkflowBenchmarkReceiptFixture.workflow.modelBundleId,
      workflowId: passingWorkflowBenchmarkReceiptFixture.workflow.workflowId,
      workflowVersion:
        passingWorkflowBenchmarkReceiptFixture.workflow.workflowVersion,
      providerVersion:
        passingWorkflowBenchmarkReceiptFixture.workflow.providerVersion,
      calibrationEvidenceVersion: "wall-pass-calibration-evidence-v1",
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
      modelBundleId:
        passingWorkflowBenchmarkReceiptFixture.workflow.modelBundleId,
      workflowId: passingWorkflowBenchmarkReceiptFixture.workflow.workflowId,
      workflowVersion:
        passingWorkflowBenchmarkReceiptFixture.workflow.workflowVersion,
      providerVersion:
        passingWorkflowBenchmarkReceiptFixture.workflow.providerVersion,
      calibrationEvidenceVersion: "wall-pass-calibration-evidence-v1",
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
