import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import {
  failedWorkflowBenchmarkReceiptFixture,
  passingWorkflowBenchmarkReceiptFixture,
  staleWorkflowBenchmarkReceiptFixture,
  workflowBenchmarkReceiptDigest,
} from "@revelai/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openSqliteDatabase } from "../database/sqlite-database.js";
import {
  InMemoryAnalysisQueue,
  type QueueScheduler,
} from "../queue/in-memory-analysis-queue.js";
import { AnalysisWorker } from "../workers/analysis-worker.js";
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

function startLockingSqliteActor(
  input: Readonly<{
    filename: string;
    action: "finalize" | "tombstone";
    attemptId: string;
    generation: number;
    now: string;
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
          if (workerData.action === "finalize") {
            const outcome = JSON.stringify({ state: "failed", attemptId: workerData.attemptId, mode: "free", code: "analysis_temporary_unavailable", message: "A análise está indisponível temporariamente.", retryable: true });
            database.prepare("INSERT INTO terminal_results (id, attempt_id, lease_id, generation, terminal_state, outcome_json, candidate_json, completed_at, created_at) VALUES (?, ?, 'worker-lease', ?, 'failed', ?, ?, ?, ?)").run("worker-result", workerData.attemptId, workerData.generation, outcome, outcome, workerData.now, workerData.now);
            database.prepare("UPDATE attempts SET status = 'failed' WHERE id = ?").run(workerData.attemptId);
          } else {
            database.prepare("DELETE FROM leaderboard_entries WHERE attempt_id = ?").run(workerData.attemptId);
            database.prepare("DELETE FROM terminal_results WHERE attempt_id = ?").run(workerData.attemptId);
            database.prepare("UPDATE attempts SET deletion_state = 'tombstoned', processing_generation = processing_generation + 1, processing_lease_id = NULL, processing_lease_expires_at = NULL WHERE id = ?").run(workerData.attemptId);
          }
          database.exec("COMMIT");
          database.close();
          parentPort.postMessage({ type: "done" });
        } catch (error) {
          try { database.exec("ROLLBACK"); } catch {}
          database.close();
          parentPort.postMessage({ type: "error", message: String(error) });
        }
      }, 75);
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
      athleteId: ATHLETE_A,
      mediaId: "media-a",
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
    ).toBeNull();
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
    expect(duplicate).toEqual(first);
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

  it("serializes ranked completions into frozen same-score snapshots and one entry per result", async () => {
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
    await fixture.repository.finalizeTerminalResult({
      attemptId: ATTEMPT_A,
      leaseId: firstClaim.leaseId,
      generation: firstClaim.generation,
      candidate: rankedOutcome(ATTEMPT_A, completedAt, 80),
    });
    const secondInput = {
      attemptId: ATTEMPT_B,
      leaseId: secondClaim.leaseId,
      generation: secondClaim.generation,
      candidate: rankedOutcome(ATTEMPT_B, completedAt, 80),
    };
    const finalized = await second.finalizeTerminalResult(secondInput);
    const duplicate = await second.finalizeTerminalResult(secondInput);

    expect(finalized?.outcome).toMatchObject({
      state: "valid",
      result: { rankingSnapshot: { cohortSize: 2, rank: 1 } },
    });
    expect(duplicate).toEqual(finalized);
    const leaderboard = await fixture.repository.listLiveLeaderboard({
      calculatedAt: completedAt,
    });
    expect(leaderboard.entries).toHaveLength(2);
    expect(
      new Set(leaderboard.entries.map((entry) => entry.entryId)).size,
    ).toBe(2);
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
    ).toBeNull();
    expect(
      await fixture.repository.getAttempt({
        attemptId: ATTEMPT_A,
        athleteId: ATHLETE_A,
      }),
    ).toBeNull();
  });

  it("uses SQLite's write lock to make one overlapping finalizer the sole terminal winner", async () => {
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
    const actor = startLockingSqliteActor({
      filename: join(fixture.directory, "api.sqlite"),
      action: "finalize",
      attemptId: ATTEMPT_A,
      generation: claim.generation,
      now: fixture.clock.now(),
    });
    await actor.locked;

    await expect(
      fixture.repository.finalizeTerminalResult({
        attemptId: ATTEMPT_A,
        leaseId: claim.leaseId,
        generation: claim.generation,
        candidate: freeOutcome(ATTEMPT_A, fixture.clock.now()),
      }),
    ).rejects.toMatchObject({ code: "terminal_result_conflict" });
    await actor.done;
    expect(
      fixture.database.raw
        .prepare(
          "SELECT COUNT(*) AS count FROM terminal_results WHERE attempt_id = ?",
        )
        .get(ATTEMPT_A),
    ).toMatchObject({ count: 1 });
  });

  it("lets an overlapping SQLite deletion lock win without permitting terminal resurrection", async () => {
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
    const actor = startLockingSqliteActor({
      filename: join(fixture.directory, "api.sqlite"),
      action: "tombstone",
      attemptId: ATTEMPT_A,
      generation: claim.generation,
      now: fixture.clock.now(),
    });
    await actor.locked;

    await expect(
      fixture.repository.finalizeTerminalResult({
        attemptId: ATTEMPT_A,
        leaseId: claim.leaseId,
        generation: claim.generation,
        candidate: freeOutcome(ATTEMPT_A, fixture.clock.now()),
      }),
    ).resolves.toBeNull();
    await actor.done;
    expect(
      await fixture.repository.getAttempt({
        attemptId: ATTEMPT_A,
        athleteId: ATHLETE_A,
      }),
    ).toBeNull();
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
      athleteId: ATHLETE_A,
      mediaId: "media-a",
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
      athleteId: ATHLETE_A,
      mediaId: "media-b",
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
    ).toBeNull();
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

  it("retracts a terminal fact atomically with its ranked projection", async () => {
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
    await fixture.repository.finalizeTerminalResult({
      attemptId: ATTEMPT_A,
      leaseId: claim.leaseId,
      generation: claim.generation,
      candidate: freeOutcome(ATTEMPT_A, fixture.clock.now()),
    });
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
      reason: "benchmark revoked",
    });
    await expect(
      fixture.policy.getActiveCompetitivePolicy(policy),
    ).resolves.toBeNull();
    await fixture.policy.deactivateCompetitivePolicy({ id: renewedPolicy.id });
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
});
