import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  failedWorkflowBenchmarkReceiptFixture,
  passingWorkflowBenchmarkReceiptFixture,
  staleWorkflowBenchmarkReceiptFixture,
  type AttemptOutcome,
} from "@revelai/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import { openSqliteDatabase } from "../database/sqlite-database.js";
import {
  SQLiteAttemptRepository,
  type Clock,
  type IdGenerator,
} from "./sqlite-attempt-repository.js";
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

function freeOutcome(attemptId: string, completedAt: string): AttemptOutcome {
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
): AttemptOutcome {
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
        asOfAttemptId: attemptId,
        calculatedAt: completedAt,
      },
    },
  };
}

async function makeRepository(
  ids = new TestIds(LEASE_A, ENTRY_A, LEASE_B, ENTRY_B),
) {
  const directory = await mkdtemp(join(tmpdir(), "revelai-c4-"));
  const database = openSqliteDatabase(join(directory, "api.sqlite"));
  const clock = new TestClock();
  const repository = new SQLiteAttemptRepository({ database, clock, ids });
  const policy = new SQLiteCompetitivePolicyRepository({ database, clock });
  return { clock, database, directory, ids, policy, repository };
}

describe("SQLiteAttemptRepository", () => {
  let fixture: Awaited<ReturnType<typeof makeRepository>>;

  beforeEach(async () => {
    fixture = await makeRepository();
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
    expect(job).toEqual({ attemptId: ATTEMPT_A });

    await fixture.repository.rollbackMediaAttachment({
      attemptId: ATTEMPT_A,
      athleteId: ATHLETE_A,
      mediaId: "media-a",
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
    const claim = await fixture.repository.claimProcessing({
      attemptId: ATTEMPT_A,
    });

    expect(claim).toMatchObject({ leaseId: LEASE_A, generation: 1 });
    expect(
      await fixture.repository.claimProcessing({ attemptId: ATTEMPT_A }),
    ).toBeNull();
    expect(
      await fixture.repository.finalizeTerminalResult({
        attemptId: ATTEMPT_A,
        leaseId: "stale-lease",
        generation: 0,
        outcome: freeOutcome(ATTEMPT_A, fixture.clock.now()),
      }),
    ).toBeNull();
  });

  it("finalizes one terminal fact idempotently and does not leaderboard a Free result", async () => {
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
    const claim = (await fixture.repository.claimProcessing({
      attemptId: ATTEMPT_A,
    }))!;
    const input = {
      attemptId: ATTEMPT_A,
      leaseId: claim.leaseId,
      generation: claim.generation,
      outcome: freeOutcome(ATTEMPT_A, fixture.clock.now()),
    };

    const first = await fixture.repository.finalizeTerminalResult(input);
    const duplicate = await fixture.repository.finalizeTerminalResult(input);
    expect(duplicate).toEqual(first);
    expect(
      (
        await fixture.repository.listLiveLeaderboard({
          calculatedAt: fixture.clock.now(),
        })
      ).entries,
    ).toEqual([]);
  });

  it("serializes ranked completions into frozen same-score snapshots and one entry per result", async () => {
    const second = new SQLiteAttemptRepository({
      database: fixture.database.reopen(),
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
    const firstClaim = (await fixture.repository.claimProcessing({
      attemptId: ATTEMPT_A,
    }))!;
    const secondClaim = (await second.claimProcessing({
      attemptId: ATTEMPT_B,
    }))!;
    const completedAt = fixture.clock.now();
    await fixture.repository.finalizeTerminalResult({
      attemptId: ATTEMPT_A,
      leaseId: firstClaim.leaseId,
      generation: firstClaim.generation,
      outcome: rankedOutcome(ATTEMPT_A, completedAt, 80),
    });
    const secondInput = {
      attemptId: ATTEMPT_B,
      leaseId: secondClaim.leaseId,
      generation: secondClaim.generation,
      outcome: rankedOutcome(ATTEMPT_B, completedAt, 80),
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

  it("lets tombstoning win over a claimed worker so a deleted attempt cannot resurrect", async () => {
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
    const claim = (await fixture.repository.claimProcessing({
      attemptId: ATTEMPT_A,
    }))!;
    await fixture.repository.tombstoneAttempt({
      attemptId: ATTEMPT_A,
      athleteId: ATHLETE_A,
    });

    expect(
      await fixture.repository.finalizeTerminalResult({
        attemptId: ATTEMPT_A,
        leaseId: claim.leaseId,
        generation: claim.generation,
        outcome: freeOutcome(ATTEMPT_A, fixture.clock.now()),
      }),
    ).toBeNull();
    expect(
      await fixture.repository.getAttempt({
        attemptId: ATTEMPT_A,
        athleteId: ATHLETE_A,
      }),
    ).toBeNull();
  });

  it("reopens persisted attempts and applies migrations idempotently", async () => {
    await fixture.repository.createAttempt({
      id: ATTEMPT_A,
      athleteId: ATHLETE_A,
      input: { mode: "free" },
    });
    const reopened = fixture.database.reopen();
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
    await fixture.policy.activateCompetitivePolicy(policy);
    expect(
      await fixture.policy.getActiveCompetitivePolicy(policy),
    ).toMatchObject({ id: policy.id });
  });
});
