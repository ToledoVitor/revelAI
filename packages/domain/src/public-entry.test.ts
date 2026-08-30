import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DomainError,
  advanceAttempt,
  calculateFrozenWallPassSnapshot,
  calculateLiveWallPassLeaderboard,
  createFreeAttempt,
  createVerifiedAttempt,
  evaluateWallPassV1,
  roundHalfUp,
  retryAttempt,
  scoreWallPassV1,
  tombstoneAttempt,
  WALL_PASS_CHALLENGE_ID,
  WALL_PASS_CHALLENGE_VERSION,
  WALL_PASS_RULE_VERSION,
  WALL_PASS_V1_CHALLENGE,
  WALL_PASS_V1_SCORE_RULE,
  type AttemptEvent,
  type AttemptLifecycleState,
  type CanonicalOutboundMovement,
  type FootSide,
  type WallPassCanonicalContact,
  type WallPassCanonicalEvidence,
  type WallPassCanonicalImpact,
  type WallPassRankableResult,
} from "./index.js";

const activeStartMs = 4_000;

function noOutbound(): CanonicalOutboundMovement {
  return { kind: "not-outbound" };
}

function outbound(
  movementTowardWallMeters = 0.25,
  observedWithinMs = 700,
): CanonicalOutboundMovement {
  return {
    kind: "outbound",
    movementTowardWallMeters,
    observedWithinMs,
  };
}

function contact(
  timestampMs: number,
  side: FootSide,
  movement: CanonicalOutboundMovement = noOutbound(),
  sideConfidence = 0.65,
): WallPassCanonicalContact {
  return { timestampMs, side, sideConfidence, outbound: movement };
}

function impact(
  timestampMs: number,
  confidence = 0.7,
): WallPassCanonicalImpact {
  return { timestampMs, confidence };
}

function continuousEvidence(
  passCount: number,
  intervalMs = 750,
  startSide: FootSide = "left",
): WallPassCanonicalEvidence {
  const contacts = Array.from({ length: passCount + 1 }, (_, index) => {
    const side =
      (index % 2 === 0) === (startSide === "left") ? "left" : "right";
    return contact(
      activeStartMs + index * intervalMs,
      side,
      index < passCount ? outbound() : noOutbound(),
    );
  });
  const wallImpacts = Array.from({ length: passCount }, (_, index) =>
    impact(activeStartMs + index * intervalMs + 200),
  );

  return { contacts, wallImpacts };
}

function completedAttempt(
  outcome: "valid" | "invalid" | "failed",
): AttemptLifecycleState {
  return advanceAttempt(
    advanceAttempt(
      advanceAttempt(createFreeAttempt("attempt-terminal"), {
        type: "media-accepted",
      }),
      { type: "queue-claimed" },
    ),
    { type: "finalized", outcome },
  );
}

function expectDomainError(
  operation: () => unknown,
  code: "invalid_attempt_transition" | "invalid_wall_pass_evidence",
): void {
  try {
    operation();
    throw new Error("Expected the operation to throw a domain error.");
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(DomainError);
    if (error instanceof DomainError) {
      expect(error.code).toBe(code);
    }
  }
}

function rankable(
  attemptId: string,
  score: number,
  completedAt: string,
  overrides: Partial<WallPassRankableResult> = {},
): WallPassRankableResult {
  return {
    attemptId,
    entryId: `entry-${attemptId}`,
    score,
    completedAt,
    state: "valid",
    active: true,
    competitiveEligible: true,
    challengeId: "wall-pass",
    challengeVersion: 1,
    ruleVersion: "wall-pass-v1-score-1",
    ...overrides,
  };
}

describe("attempt reducer public behavior", () => {
  it("creates free and verified attempts in the only initial public state", () => {
    expect(createFreeAttempt("free-1")).toEqual({
      id: "free-1",
      mode: "free",
      status: "awaiting-upload",
      deletionState: "active",
    });
    expect(createVerifiedAttempt("verified-1")).toEqual({
      id: "verified-1",
      mode: "verified",
      status: "awaiting-upload",
      deletionState: "active",
      challenge: { id: "wall-pass", version: 1 },
    });
  });

  it("accepts media only from awaiting-upload and claims its queue work", () => {
    const uploaded = advanceAttempt(createFreeAttempt("attempt-1"), {
      type: "media-accepted",
    });
    expect(uploaded.status).toBe("uploaded");
    expect(advanceAttempt(uploaded, { type: "queue-claimed" }).status).toBe(
      "processing",
    );
  });

  for (const outcome of ["valid", "invalid", "failed"] as const) {
    it(`finalizes processing as ${outcome}`, () => {
      const processing = advanceAttempt(
        advanceAttempt(createFreeAttempt(`attempt-${outcome}`), {
          type: "media-accepted",
        }),
        { type: "queue-claimed" },
      );
      expect(
        advanceAttempt(processing, { type: "finalized", outcome }).status,
      ).toBe(outcome);
    });
  }

  for (const status of ["awaiting-upload", "uploaded", "processing"] as const) {
    it(`tombstones an active ${status} attempt without exposing a seventh status`, () => {
      const state =
        status === "awaiting-upload"
          ? createFreeAttempt(`attempt-${status}`)
          : status === "uploaded"
            ? advanceAttempt(createFreeAttempt(`attempt-${status}`), {
                type: "media-accepted",
              })
            : advanceAttempt(
                advanceAttempt(createFreeAttempt(`attempt-${status}`), {
                  type: "media-accepted",
                }),
                { type: "queue-claimed" },
              );
      const tombstoned = tombstoneAttempt(state);

      expect(tombstoned.status).toBe(status);
      expect(tombstoned.deletionState).toBe("tombstoned");
    });
  }

  for (const outcome of ["valid", "invalid", "failed"] as const) {
    it(`retries a terminal ${outcome} attempt by creating a distinct initial attempt`, () => {
      const retried = retryAttempt(
        completedAttempt(outcome),
        `retry-${outcome}`,
      );

      expect(retried).toEqual({
        id: `retry-${outcome}`,
        mode: "free",
        status: "awaiting-upload",
        deletionState: "active",
      });
    });
  }

  it("rejects every forbidden lifecycle change with one stable domain error", () => {
    const awaiting = createFreeAttempt("attempt-awaiting");
    const uploaded = advanceAttempt(awaiting, { type: "media-accepted" });
    const processing = advanceAttempt(uploaded, { type: "queue-claimed" });
    const terminal = advanceAttempt(processing, {
      type: "finalized",
      outcome: "valid",
    });
    const tombstoned = tombstoneAttempt(uploaded);

    for (const invalidOperation of [
      () => advanceAttempt(awaiting, { type: "queue-claimed" }),
      () => advanceAttempt(uploaded, { type: "media-accepted" }),
      () => advanceAttempt(uploaded, { type: "finalized", outcome: "valid" }),
      () => advanceAttempt(processing, { type: "media-accepted" }),
      () => advanceAttempt(terminal, { type: "queue-claimed" }),
      () => advanceAttempt(terminal, { type: "finalized", outcome: "failed" }),
      () => tombstoneAttempt(terminal),
      () => retryAttempt(uploaded, "retry-active"),
      () => advanceAttempt(tombstoned, { type: "queue-claimed" }),
      () => tombstoneAttempt(tombstoned),
    ]) {
      expectDomainError(invalidOperation, "invalid_attempt_transition");
    }
  });

  it("rejects every reducer event outside its one normative prior state", () => {
    const awaiting = createFreeAttempt("matrix-awaiting");
    const uploaded = advanceAttempt(awaiting, { type: "media-accepted" });
    const processing = advanceAttempt(uploaded, { type: "queue-claimed" });
    const states = [
      { status: "awaiting-upload", state: awaiting },
      { status: "uploaded", state: uploaded },
      { status: "processing", state: processing },
      { status: "valid", state: completedAttempt("valid") },
      { status: "invalid", state: completedAttempt("invalid") },
      { status: "failed", state: completedAttempt("failed") },
    ];
    const events: readonly AttemptEvent[] = [
      { type: "media-accepted" },
      { type: "queue-claimed" },
      { type: "finalized", outcome: "valid" },
      { type: "finalized", outcome: "invalid" },
      { type: "finalized", outcome: "failed" },
    ];

    for (const { status, state } of states) {
      for (const event of events) {
        const allowed =
          (status === "awaiting-upload" && event.type === "media-accepted") ||
          (status === "uploaded" && event.type === "queue-claimed") ||
          (status === "processing" && event.type === "finalized");

        if (allowed) {
          expect(() => advanceAttempt(state, event)).not.toThrow();
        } else {
          expectDomainError(
            () => advanceAttempt(state, event),
            "invalid_attempt_transition",
          );
        }
      }
    }
  });

  it("replays the same event sequence without mutating an earlier state", () => {
    const initial = createVerifiedAttempt("attempt-replay");
    const replay = (): AttemptLifecycleState =>
      advanceAttempt(
        advanceAttempt(advanceAttempt(initial, { type: "media-accepted" }), {
          type: "queue-claimed",
        }),
        { type: "finalized", outcome: "valid" },
      );

    expect(replay()).toEqual(replay());
    expect(initial.status).toBe("awaiting-upload");
  });
});

describe("wall-pass metrics and score", () => {
  it("exports immutable wall-pass and score-rule constants with exact versions", () => {
    expect(WALL_PASS_CHALLENGE_ID).toBe("wall-pass");
    expect(WALL_PASS_CHALLENGE_VERSION).toBe(1);
    expect(WALL_PASS_RULE_VERSION).toBe("wall-pass-v1-score-1");
    expect(Object.isFrozen(WALL_PASS_V1_CHALLENGE)).toBe(true);
    expect(Object.isFrozen(WALL_PASS_V1_CHALLENGE.activeWindow)).toBe(true);
    expect(Object.isFrozen(WALL_PASS_V1_SCORE_RULE)).toBe(true);
    expect(Object.isFrozen(WALL_PASS_V1_SCORE_RULE.scoring.weights)).toBe(true);
  });

  it("scores a 40-pass, alternating, 0.75-second sequence perfectly", () => {
    const result = evaluateWallPassV1(continuousEvidence(40));

    expect(result).toEqual({
      challengeId: "wall-pass",
      challengeVersion: 1,
      ruleVersion: "wall-pass-v1-score-1",
      opportunities: 40,
      missedPasses: 0,
      metrics: {
        validPasses: 40,
        accuracyPercent: 100,
        meanCadenceSeconds: 0.75,
        leftFootPercent: 50,
        rightFootPercent: 50,
      },
      score: 100,
    });
  });

  it("reports asymmetric foot use with exact two-decimal reconciliation", () => {
    const evidence: WallPassCanonicalEvidence = {
      contacts: [
        contact(4_000, "left", outbound()),
        contact(5_000, "left", outbound()),
        contact(6_000, "right", outbound()),
        contact(7_000, "left"),
      ],
      wallImpacts: [impact(4_300), impact(5_300), impact(6_300)],
    };

    const result = evaluateWallPassV1(evidence);

    expect(result.metrics).toEqual({
      validPasses: 3,
      accuracyPercent: 100,
      meanCadenceSeconds: 1,
      leftFootPercent: 66.67,
      rightFootPercent: 33.33,
    });
    expect(result.score).toBe(58);
  });

  it("counts a completed opportunity and three misses as low accuracy", () => {
    const result = evaluateWallPassV1({
      contacts: [
        contact(4_000, "left", outbound()),
        contact(5_000, "left", outbound()),
        contact(6_000, "left", outbound()),
        contact(7_000, "left", outbound()),
      ],
      wallImpacts: [impact(5_200)],
    });

    expect(result.opportunities).toBe(4);
    expect(result.missedPasses).toBe(3);
    expect(result.metrics).toEqual({
      validPasses: 1,
      accuracyPercent: 25,
      meanCadenceSeconds: 0,
      leftFootPercent: 100,
      rightFootPercent: 0,
    });
    expect(result.score).toBe(9);
  });

  it("returns zero metrics and score when contacts provide no outbound opportunity", () => {
    const result = evaluateWallPassV1({
      contacts: [contact(4_000, "left"), contact(5_000, "right")],
      wallImpacts: [],
    });

    expect(result.opportunities).toBe(0);
    expect(result.missedPasses).toBe(0);
    expect(result.metrics).toEqual({
      validPasses: 0,
      accuracyPercent: 0,
      meanCadenceSeconds: 0,
      leftFootPercent: 0,
      rightFootPercent: 0,
    });
    expect(result.score).toBe(0);
  });

  it("uses zero cadence for one valid pass", () => {
    const result = evaluateWallPassV1(continuousEvidence(1));

    expect(result.metrics.meanCadenceSeconds).toBe(0);
    expect(result.score).toBe(31);
  });

  it("accepts exact outbound and pass timing thresholds", () => {
    const result = evaluateWallPassV1({
      contacts: [
        contact(4_000, "left", outbound(0.25, 700)),
        contact(10_000, "right"),
      ],
      wallImpacts: [impact(6_000)],
    });

    expect(result.opportunities).toBe(1);
    expect(result.metrics.validPasses).toBe(1);
    expect(result.metrics.accuracyPercent).toBe(100);
  });

  it("uses every adjacent return contact in a continuous alternating-foot sequence", () => {
    const result = evaluateWallPassV1(continuousEvidence(6));

    expect(result.opportunities).toBe(6);
    expect(result.metrics.validPasses).toBe(6);
    expect(result.metrics.leftFootPercent).toBe(50);
    expect(result.metrics.rightFootPercent).toBe(50);
  });

  it("counts an outbound with a missed return as a miss", () => {
    const result = evaluateWallPassV1({
      contacts: [contact(4_000, "left", outbound()), contact(8_301, "right")],
      wallImpacts: [impact(4_300)],
    });

    expect(result.opportunities).toBe(1);
    expect(result.missedPasses).toBe(1);
    expect(result.metrics.validPasses).toBe(0);
  });

  it("counts an end-window outbound contact without a return as a miss", () => {
    const result = evaluateWallPassV1({
      contacts: [contact(63_000, "left", outbound())],
      wallImpacts: [impact(63_200)],
    });

    expect(result.opportunities).toBe(1);
    expect(result.missedPasses).toBe(1);
  });

  it("does not count a non-outbound contact as an opportunity or miss", () => {
    const result = evaluateWallPassV1({
      contacts: [contact(4_000, "left"), contact(5_000, "right")],
      wallImpacts: [impact(4_300)],
    });

    expect(result.opportunities).toBe(0);
    expect(result.missedPasses).toBe(0);
  });

  it("shares a return only with the immediately adjacent next pass", () => {
    const result = evaluateWallPassV1({
      contacts: [
        contact(4_000, "left", outbound()),
        contact(5_000, "right", outbound()),
        contact(6_000, "left"),
      ],
      wallImpacts: [impact(4_300), impact(5_300)],
    });

    expect(result.metrics.validPasses).toBe(2);
    expect(result.missedPasses).toBe(0);
  });

  it("forbids a non-adjacent contact from completing an earlier pass", () => {
    const result = evaluateWallPassV1({
      contacts: [
        contact(4_000, "left", outbound()),
        contact(4_600, "right"),
        contact(5_000, "left"),
      ],
      wallImpacts: [impact(4_500)],
    });

    expect(result.metrics.validPasses).toBe(0);
    expect(result.missedPasses).toBe(1);
  });

  it("accepts canonical confidence boundaries and rejects lower confidence", () => {
    expect(
      evaluateWallPassV1({
        contacts: [
          contact(4_000, "left", outbound(), 0.65),
          contact(5_000, "right"),
        ],
        wallImpacts: [impact(4_300, 0.7)],
      }).metrics.validPasses,
    ).toBe(1);

    expectDomainError(
      () =>
        evaluateWallPassV1({
          contacts: [
            contact(4_000, "left", outbound(), 0.649),
            contact(5_000, "right"),
          ],
          wallImpacts: [impact(4_300)],
        }),
      "invalid_wall_pass_evidence",
    );
  });

  it("rounds final score half up and caps every score component", () => {
    expect(roundHalfUp(1.005, 2)).toBe(1.01);
    expect(
      scoreWallPassV1({
        validPasses: 1,
        accuracyPercent: 35,
        meanCadenceSeconds: 0,
        leftFootPercent: 100,
        rightFootPercent: 0,
      }).score,
    ).toBe(12);
    expect(
      scoreWallPassV1({
        validPasses: 100,
        accuracyPercent: 100,
        meanCadenceSeconds: 0.5,
        leftFootPercent: 50,
        rightFootPercent: 50,
      }).score,
    ).toBe(100);
  });

  it("is deterministic and leaves canonical evidence unchanged", () => {
    const evidence = continuousEvidence(4);
    const before = structuredClone(evidence);
    const evaluations = Array.from({ length: 25 }, () =>
      evaluateWallPassV1(evidence),
    );

    expect(
      evaluations.every((evaluation) => evaluation === evaluations[0]),
    ).toBe(false);
    expect(evaluations).toEqual(
      Array.from({ length: 25 }, () => evaluations[0]),
    );
    expect(evidence).toEqual(before);
  });
});

describe("wall-pass ranking", () => {
  it("uses competition ranks while ordering ties by completion time then attempt UUID", () => {
    const leaderboard = calculateLiveWallPassLeaderboard(
      [
        rankable(
          "00000000-0000-4000-8000-000000000003",
          80,
          "2026-08-30T12:00:02.000Z",
        ),
        rankable(
          "00000000-0000-4000-8000-000000000002",
          80,
          "2026-08-30T12:00:01.000Z",
        ),
        rankable(
          "00000000-0000-4000-8000-000000000001",
          80,
          "2026-08-30T12:00:01.000Z",
        ),
        rankable(
          "00000000-0000-4000-8000-000000000004",
          79,
          "2026-08-30T12:00:00.000Z",
        ),
      ],
      "2026-08-30T13:00:00.000Z",
    );

    expect(leaderboard.entries).toEqual([
      {
        entryId: "entry-00000000-0000-4000-8000-000000000001",
        rank: 1,
        score: 80,
        completedAt: "2026-08-30T12:00:01.000Z",
      },
      {
        entryId: "entry-00000000-0000-4000-8000-000000000002",
        rank: 1,
        score: 80,
        completedAt: "2026-08-30T12:00:01.000Z",
      },
      {
        entryId: "entry-00000000-0000-4000-8000-000000000003",
        rank: 1,
        score: 80,
        completedAt: "2026-08-30T12:00:02.000Z",
      },
      {
        entryId: "entry-00000000-0000-4000-8000-000000000004",
        rank: 4,
        score: 79,
        completedAt: "2026-08-30T12:00:00.000Z",
      },
    ]);
  });

  it("isolates a live cohort to the exact wall-pass challenge and rule version", () => {
    const leaderboard = calculateLiveWallPassLeaderboard(
      [
        rankable("eligible", 50, "2026-08-30T12:00:00.000Z"),
        rankable("other-rule", 100, "2026-08-30T11:00:00.000Z", {
          ruleVersion: "wall-pass-v2-score-1",
        }),
        rankable("other-challenge", 100, "2026-08-30T10:00:00.000Z", {
          challengeId: "other-challenge",
          challengeVersion: 2,
        }),
      ],
      "2026-08-30T13:00:00.000Z",
    );

    expect(leaderboard.cohortSize).toBe(1);
    expect(leaderboard.entries[0]?.entryId).toBe("entry-eligible");
  });

  it("creates normative one-member frozen values", () => {
    const result = rankable("solo", 77, "2026-08-30T12:00:00.000Z");
    const snapshot = calculateFrozenWallPassSnapshot(
      [result],
      "solo",
      "2026-08-30T12:00:01.000Z",
    );

    expect(snapshot).toEqual({
      kind: "frozen",
      challengeId: "wall-pass",
      challengeVersion: 1,
      ruleVersion: "wall-pass-v1-score-1",
      rank: 1,
      cohortSize: 1,
      percentile: 100,
      topPercent: 0,
      scoreCountAtFinalization: 1,
      asOfAttemptId: "solo",
      calculatedAt: "2026-08-30T12:00:01.000Z",
    });
  });

  it("distinguishes percentile from the top-percent phrase", () => {
    const cohort = [
      rankable("high", 100, "2026-08-30T12:00:00.000Z"),
      rankable("middle", 50, "2026-08-30T12:01:00.000Z"),
      rankable("low", 10, "2026-08-30T12:02:00.000Z"),
    ];
    const snapshot = calculateFrozenWallPassSnapshot(
      cohort,
      "middle",
      "2026-08-30T13:00:00.000Z",
    );

    expect(snapshot.rank).toBe(2);
    expect(snapshot.percentile).toBe(66.67);
    expect(snapshot.topPercent).toBe(33.33);
  });

  it("does not mutate a frozen snapshot when a later live cohort changes", () => {
    const original = rankable("original", 50, "2026-08-30T12:00:00.000Z");
    const snapshot = calculateFrozenWallPassSnapshot(
      [original],
      "original",
      "2026-08-30T12:00:01.000Z",
    );
    const laterLeaderboard = calculateLiveWallPassLeaderboard(
      [original, rankable("later", 100, "2026-08-30T12:01:00.000Z")],
      "2026-08-30T12:02:00.000Z",
    );

    expect(snapshot.rank).toBe(1);
    expect(snapshot.cohortSize).toBe(1);
    expect(
      laterLeaderboard.entries.find(
        (entry) => entry.entryId === "entry-original",
      )?.rank,
    ).toBe(2);
  });

  it("does not mutate ranking input arrays or result records", () => {
    const input = [
      rankable("second", 50, "2026-08-30T12:01:00.000Z"),
      rankable("first", 60, "2026-08-30T12:00:00.000Z"),
    ];
    const before = structuredClone(input);

    calculateLiveWallPassLeaderboard(input, "2026-08-30T13:00:00.000Z");

    expect(input).toEqual(before);
  });
});

describe("domain dependency boundary", () => {
  it("keeps production domain modules free of network, filesystem, provider, media, and API imports", () => {
    const productionFiles = [
      "attempt-machine.ts",
      "wall-pass-v1.ts",
      "scoring.ts",
      "ranking.ts",
      "index.ts",
    ];
    const forbiddenImport =
      /from\s+["'](?:node:|https?:|@revelai\/contracts|@revelai\/vision|.*(?:provider|media|api))["']/;

    for (const file of productionFiles) {
      const source = readFileSync(
        fileURLToPath(new URL(`./${file}`, import.meta.url)),
        "utf8",
      );
      expect(source).not.toMatch(forbiddenImport);
    }
  });
});
