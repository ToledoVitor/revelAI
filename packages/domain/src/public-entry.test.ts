import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import * as publicDomain from "./index.js";
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
  tombstoneAttempt,
  WALL_PASS_CHALLENGE_ID,
  WALL_PASS_CHALLENGE_VERSION,
  WALL_PASS_RULE_VERSION,
  WALL_PASS_V1_CHALLENGE,
  WALL_PASS_V1_SCORE_RULE,
  type AttemptEvent,
  type AttemptLifecycleState,
  type CanonicalOutboundMovement,
  type DomainErrorCode,
  type FootSide,
  type WallPassCanonicalContact,
  type WallPassCanonicalEvidence,
  type WallPassCanonicalImpact,
  type WallPassRankableResult,
} from "./index.js";

const activeStartMs = 4_000;

type IsExactly<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <
    Value,
  >() => Value extends Right ? 1 : 2
    ? true
    : false;
const advanceAttemptEventParameterIsExact: IsExactly<
  Parameters<typeof advanceAttempt>[1],
  AttemptEvent
> = true;

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

function canonicalEvidenceForCounts(
  opportunities: number,
  validPasses: number,
  leftPasses: number,
): WallPassCanonicalEvidence {
  if (
    !Number.isInteger(opportunities) ||
    !Number.isInteger(validPasses) ||
    !Number.isInteger(leftPasses) ||
    opportunities < validPasses ||
    validPasses < leftPasses ||
    leftPasses < 0
  ) {
    throw new Error("Fixture count inputs must be coherent.");
  }

  if (opportunities === 0) {
    return { contacts: [contact(activeStartMs, "left")], wallImpacts: [] };
  }

  const completedContacts = Array.from(
    { length: validPasses + 1 },
    (_, index) =>
      contact(
        activeStartMs + index * 1_000,
        index < leftPasses ? "left" : "right",
        index < validPasses ? outbound() : noOutbound(),
      ),
  );
  const missedContacts = Array.from(
    { length: opportunities - validPasses },
    (_, index) =>
      contact(
        activeStartMs + (validPasses + 1 + index) * 1_000,
        "right",
        outbound(),
      ),
  );
  const contacts =
    validPasses === 0
      ? missedContacts
      : [...completedContacts, ...missedContacts];
  const wallImpacts = Array.from({ length: validPasses }, (_, index) =>
    impact(activeStartMs + index * 1_000 + 300),
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
  code: DomainErrorCode,
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
    entryId: `f${attemptId.slice(1)}`,
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

function attemptWithStatus(
  status: AttemptLifecycleState["status"],
): AttemptLifecycleState {
  const awaitingUpload = createFreeAttempt(`attempt-${status}`);

  switch (status) {
    case "awaiting-upload":
      return awaitingUpload;
    case "uploaded":
      return advanceAttempt(awaitingUpload, { type: "media-accepted" });
    case "processing":
      return advanceAttempt(
        advanceAttempt(awaitingUpload, { type: "media-accepted" }),
        { type: "queue-claimed" },
      );
    case "valid":
    case "invalid":
    case "failed":
      return completedAttempt(status);
  }
}

function advanceAtRuntime(
  state: AttemptLifecycleState,
  event: unknown,
): unknown {
  return Reflect.apply(advanceAttempt, undefined, [state, event]);
}

describe("attempt reducer public behavior", () => {
  it("creates free and verified attempts in the only initial public state", () => {
    expect(advanceAttemptEventParameterIsExact).toBe(true);
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

  for (const status of [
    "awaiting-upload",
    "uploaded",
    "processing",
    "valid",
    "invalid",
    "failed",
  ] as const) {
    it(`tombstones an active ${status} attempt without exposing a seventh status`, () => {
      const state = attemptWithStatus(status);
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
      () => retryAttempt(uploaded, "retry-active"),
      () => advanceAttempt(tombstoned, { type: "queue-claimed" }),
      () => tombstoneAttempt(tombstoned),
    ]) {
      expectDomainError(invalidOperation, "invalid_attempt_transition");
    }
  });

  it("rejects every event after tombstoning while preserving the terminal public status", () => {
    for (const status of [
      "awaiting-upload",
      "uploaded",
      "processing",
      "valid",
      "invalid",
      "failed",
    ] as const) {
      const tombstoned = tombstoneAttempt(attemptWithStatus(status));

      expect(tombstoned.status).toBe(status);
      expectDomainError(
        () => advanceAttempt(tombstoned, { type: "media-accepted" }),
        "invalid_attempt_transition",
      );
      if (status === "valid" || status === "invalid" || status === "failed") {
        expectDomainError(
          () => retryAttempt(tombstoned, `retry-tombstoned-${status}`),
          "invalid_attempt_transition",
        );
      }
    }
  });

  it("rejects malformed finalized outcomes, unknown event types, and non-events at runtime", () => {
    const processing = attemptWithStatus("processing");

    expectDomainError(
      () =>
        advanceAtRuntime(processing, {
          type: "finalized",
          outcome: "bogus",
        }),
      "invalid_attempt_transition",
    );
    expectDomainError(
      () => advanceAtRuntime(processing, { type: "unknown" }),
      "invalid_attempt_transition",
    );
    expectDomainError(
      () => advanceAtRuntime(processing, null),
      "invalid_attempt_transition",
    );
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
        contact(7_000, "right"),
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

  it("attributes a one-pass left-to-right sequence to its starting left foot", () => {
    const result = evaluateWallPassV1(continuousEvidence(1));

    expect(result.metrics.meanCadenceSeconds).toBe(0);
    expect(result.metrics.leftFootPercent).toBe(100);
    expect(result.metrics.rightFootPercent).toBe(0);
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

  it("rounds final score half up and caps every component from canonical evidence", () => {
    expect(roundHalfUp(1.005, 2)).toBe(1.01);
    expect(evaluateWallPassV1(canonicalEvidenceForCounts(4, 1, 1)).score).toBe(
      9,
    );
    expect(evaluateWallPassV1(continuousEvidence(100, 500)).score).toBe(100);
  });

  it("scores every coherent small count matrix without inferring counts from floats", () => {
    for (let opportunities = 0; opportunities <= 7; opportunities += 1) {
      for (
        let validPasses = 0;
        validPasses <= opportunities;
        validPasses += 1
      ) {
        for (let leftPasses = 0; leftPasses <= validPasses; leftPasses += 1) {
          const result = evaluateWallPassV1(
            canonicalEvidenceForCounts(opportunities, validPasses, leftPasses),
          );

          expect(result.opportunities).toBe(opportunities);
          expect(result.missedPasses).toBe(opportunities - validPasses);
          expect(result.metrics.validPasses).toBe(validPasses);
          expect(result.score).toBeGreaterThanOrEqual(0);
          expect(result.score).toBeLessThanOrEqual(100);
          expect(
            result.metrics.leftFootPercent + result.metrics.rightFootPercent,
          ).toBe(validPasses === 0 ? 0 : 100);
        }
      }
    }
  });

  it("scores canonical three-of-seven evidence with asymmetric rounded metrics", () => {
    const result = evaluateWallPassV1(canonicalEvidenceForCounts(7, 3, 2));

    expect(result.metrics).toEqual({
      validPasses: 3,
      accuracyPercent: 42.86,
      meanCadenceSeconds: 1,
      leftFootPercent: 66.67,
      rightFootPercent: 33.33,
    });
    expect(result.score).toBe(41);
  });

  it("keeps canonical scoring internal instead of accepting rounded public metrics", () => {
    expect(publicDomain).not.toHaveProperty("scoreWallPassV1");
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
        entryId: "f0000000-0000-4000-8000-000000000001",
        rank: 1,
        score: 80,
        completedAt: "2026-08-30T12:00:01.000Z",
      },
      {
        entryId: "f0000000-0000-4000-8000-000000000002",
        rank: 1,
        score: 80,
        completedAt: "2026-08-30T12:00:01.000Z",
      },
      {
        entryId: "f0000000-0000-4000-8000-000000000003",
        rank: 1,
        score: 80,
        completedAt: "2026-08-30T12:00:02.000Z",
      },
      {
        entryId: "f0000000-0000-4000-8000-000000000004",
        rank: 4,
        score: 79,
        completedAt: "2026-08-30T12:00:00.000Z",
      },
    ]);
  });

  it("isolates a live cohort to the exact wall-pass challenge and rule version", () => {
    const leaderboard = calculateLiveWallPassLeaderboard(
      [
        rankable(
          "00000000-0000-4000-8000-000000000010",
          50,
          "2026-08-30T12:00:00.000Z",
        ),
        rankable(
          "00000000-0000-4000-8000-000000000011",
          100,
          "2026-08-30T11:00:00.000Z",
          { ruleVersion: "wall-pass-v2-score-1" },
        ),
        rankable(
          "00000000-0000-4000-8000-000000000012",
          100,
          "2026-08-30T10:00:00.000Z",
          { challengeId: "other-challenge", challengeVersion: 2 },
        ),
      ],
      "2026-08-30T13:00:00.000Z",
    );

    expect(leaderboard.cohortSize).toBe(1);
    expect(leaderboard.entries[0]?.entryId).toBe(
      "f0000000-0000-4000-8000-000000000010",
    );
  });

  it("creates normative one-member frozen values", () => {
    const result = rankable(
      "00000000-0000-4000-8000-000000000020",
      77,
      "2026-08-30T12:00:00.000Z",
    );
    const snapshot = calculateFrozenWallPassSnapshot(
      [result],
      "00000000-0000-4000-8000-000000000020",
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
      asOfAttemptId: "00000000-0000-4000-8000-000000000020",
      calculatedAt: "2026-08-30T12:00:01.000Z",
    });
  });

  it("distinguishes percentile from the top-percent phrase", () => {
    const cohort = [
      rankable(
        "00000000-0000-4000-8000-000000000030",
        100,
        "2026-08-30T12:00:00.000Z",
      ),
      rankable(
        "00000000-0000-4000-8000-000000000031",
        50,
        "2026-08-30T12:01:00.000Z",
      ),
      rankable(
        "00000000-0000-4000-8000-000000000032",
        10,
        "2026-08-30T12:02:00.000Z",
      ),
    ];
    const snapshot = calculateFrozenWallPassSnapshot(
      cohort,
      "00000000-0000-4000-8000-000000000031",
      "2026-08-30T13:00:00.000Z",
    );

    expect(snapshot.rank).toBe(2);
    expect(snapshot.percentile).toBe(66.67);
    expect(snapshot.topPercent).toBe(33.33);
  });

  it("does not mutate a frozen snapshot when a later live cohort changes", () => {
    const original = rankable(
      "00000000-0000-4000-8000-000000000040",
      50,
      "2026-08-30T12:00:00.000Z",
    );
    const snapshot = calculateFrozenWallPassSnapshot(
      [original],
      "00000000-0000-4000-8000-000000000040",
      "2026-08-30T12:00:01.000Z",
    );
    const laterLeaderboard = calculateLiveWallPassLeaderboard(
      [
        original,
        rankable(
          "00000000-0000-4000-8000-000000000041",
          100,
          "2026-08-30T12:01:00.000Z",
        ),
      ],
      "2026-08-30T12:02:00.000Z",
    );

    expect(snapshot.rank).toBe(1);
    expect(snapshot.cohortSize).toBe(1);
    expect(
      laterLeaderboard.entries.find(
        (entry) => entry.entryId === "f0000000-0000-4000-8000-000000000040",
      )?.rank,
    ).toBe(2);
  });

  it("rejects invalid UUIDs, non-canonical UTC instants, and duplicate cohort identifiers", () => {
    const valid = rankable(
      "00000000-0000-4000-8000-000000000060",
      50,
      "2026-08-30T12:00:00.000Z",
    );

    expectDomainError(
      () =>
        calculateLiveWallPassLeaderboard(
          [rankable("not-a-uuid", 50, "2026-08-30T12:00:00.000Z")],
          "2026-08-30T13:00:00.000Z",
        ),
      "invalid_wall_pass_ranking_input",
    );
    expectDomainError(
      () =>
        calculateLiveWallPassLeaderboard(
          [
            rankable(
              "00000000-0000-4000-8000-000000000061",
              50,
              "2026-02-31T12:00:00.000Z",
            ),
          ],
          "2026-08-30T13:00:00.000Z",
        ),
      "invalid_wall_pass_ranking_input",
    );
    expectDomainError(
      () =>
        calculateLiveWallPassLeaderboard(
          [
            valid,
            { ...valid, entryId: "f0000000-0000-4000-8000-000000000061" },
          ],
          "2026-08-30T13:00:00.000Z",
        ),
      "invalid_wall_pass_ranking_input",
    );
    expectDomainError(
      () =>
        calculateLiveWallPassLeaderboard(
          [
            valid,
            rankable(
              "00000000-0000-4000-8000-000000000062",
              50,
              "2026-08-30T12:01:00.000Z",
              { entryId: valid.entryId },
            ),
          ],
          "2026-08-30T13:00:00.000Z",
        ),
      "invalid_wall_pass_ranking_input",
    );
  });

  it("accepts non-empty opaque entry identifiers while enforcing their uniqueness", () => {
    const result = rankable(
      "00000000-0000-4000-8000-000000000070",
      50,
      "2026-08-30T12:00:00.000Z",
      { entryId: "entry-1" },
    );

    expect(
      calculateLiveWallPassLeaderboard([result], "2026-08-30T13:00:00.000Z")
        .entries[0]?.entryId,
    ).toBe("entry-1");
    expectDomainError(
      () =>
        calculateLiveWallPassLeaderboard(
          [
            rankable(
              "00000000-0000-4000-8000-000000000071",
              50,
              "2026-08-30T12:00:00.000Z",
              { entryId: "   " },
            ),
          ],
          "2026-08-30T13:00:00.000Z",
        ),
      "invalid_wall_pass_ranking_input",
    );
    expectDomainError(
      () =>
        calculateLiveWallPassLeaderboard(
          [
            result,
            rankable(
              "00000000-0000-4000-8000-000000000072",
              50,
              "2026-08-30T12:01:00.000Z",
              { entryId: "entry-1" },
            ),
          ],
          "2026-08-30T13:00:00.000Z",
        ),
      "invalid_wall_pass_ranking_input",
    );
  });

  it("does not mutate ranking input arrays or result records", () => {
    const input = [
      rankable(
        "00000000-0000-4000-8000-000000000050",
        50,
        "2026-08-30T12:01:00.000Z",
      ),
      rankable(
        "00000000-0000-4000-8000-000000000051",
        60,
        "2026-08-30T12:00:00.000Z",
      ),
    ];
    const before = structuredClone(input);

    calculateLiveWallPassLeaderboard(input, "2026-08-30T13:00:00.000Z");

    expect(input).toEqual(before);
  });
});

describe("domain dependency boundary", () => {
  it("recognizes every runtime module form through the TypeScript AST", () => {
    const fixtures = [
      { source: 'import fs from "node:fs";', violations: ["node:fs"] },
      { source: 'import "node:fs";', violations: ["node:fs"] },
      {
        source: 'import {\n  readFileSync,\n} from "node:fs";',
        violations: ["node:fs"],
      },
      {
        source: 'import fs = require("node:fs");',
        violations: ["node:fs"],
      },
      {
        source: 'export { readFileSync } from "node:fs";',
        violations: ["node:fs"],
      },
      { source: 'export * from "undici";', violations: ["undici"] },
      {
        source: 'const client = await import("undici");',
        violations: ["undici"],
      },
      {
        source: 'import type { RuntimeOnly } from "not-emitted";',
        violations: [],
      },
      {
        source: 'export type { RuntimeOnly } from "not-emitted";',
        violations: [],
      },
      {
        source: 'import { sibling } from "./sibling.js";',
        violations: [],
      },
    ];

    for (const fixture of fixtures) {
      expect(forbiddenRuntimeImports(fixture.source)).toEqual(
        fixture.violations,
      );
    }
  });

  it("rejects every runtime dependency manifest section", () => {
    expect(
      runtimeDependencyNames({
        dependencies: { undici: "1.0.0" },
        optionalDependencies: { "node-fetch": "1.0.0" },
        peerDependencies: { react: "1.0.0" },
        bundledDependencies: ["buffer"],
        bundleDependencies: ["stream"],
      }),
    ).toEqual([
      "dependencies:undici",
      "optionalDependencies:node-fetch",
      "peerDependencies:react",
      "bundledDependencies:buffer",
      "bundleDependencies:stream",
    ]);
  });

  it("recursively rejects every non-relative production runtime import and runtime dependency", () => {
    const productionFiles = productionTypeScriptFiles(
      new URL("./", import.meta.url),
    );
    const sourcePaths = productionFiles.map((file) => fileURLToPath(file));

    expect(sourcePaths).toContain(
      fileURLToPath(new URL("./attempt-machine.ts", import.meta.url)),
    );
    expect(sourcePaths).toContain(
      fileURLToPath(new URL("./ranking.ts", import.meta.url)),
    );
    expect(
      productionFiles.flatMap((file) =>
        forbiddenRuntimeImports(
          readFileSync(file, "utf8"),
          fileURLToPath(file),
        ),
      ),
    ).toEqual([]);
    expect(runtimeDependencyNames(readPackageManifest())).toEqual([]);
  });
});

function productionTypeScriptFiles(directory: URL): readonly URL[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const child = new URL(
      entry.isDirectory() ? `${entry.name}/` : entry.name,
      directory,
    );

    if (entry.isDirectory()) {
      return productionTypeScriptFiles(child);
    }

    return entry.isFile() &&
      /\.(?:[cm]?ts|tsx)$/.test(entry.name) &&
      !/\.(?:test|spec)(?:\.d)?\.(?:[cm]?ts|tsx)$/.test(entry.name)
      ? [child]
      : [];
  });
}

function forbiddenRuntimeImports(
  source: string,
  fileName = "fixture.ts",
): readonly string[] {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const specifiers: string[] = [];
  const addSpecifier = (expression: ts.Expression | undefined): void => {
    if (expression && ts.isStringLiteralLike(expression)) {
      specifiers.push(expression.text);
    }
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && hasRuntimeImport(node)) {
      addSpecifier(node.moduleSpecifier);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      hasRuntimeImportEquals(node)
    ) {
      addSpecifier(importEqualsModuleSpecifier(node));
    } else if (ts.isExportDeclaration(node) && hasRuntimeExport(node)) {
      addSpecifier(node.moduleSpecifier);
    } else if (isLiteralDynamicImport(node)) {
      addSpecifier(node.arguments[0]);
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return specifiers.filter((specifier) => !specifier.startsWith("."));
}

function hasRuntimeImport(node: ts.ImportDeclaration): boolean {
  const importClause = node.importClause;
  if (!importClause) {
    return true;
  }
  if (importClause.isTypeOnly || importClause.name) {
    return !importClause.isTypeOnly;
  }
  if (!importClause.namedBindings) {
    return false;
  }
  if (ts.isNamespaceImport(importClause.namedBindings)) {
    return true;
  }
  return (
    importClause.namedBindings.elements.length === 0 ||
    importClause.namedBindings.elements.some((element) => !element.isTypeOnly)
  );
}

function hasRuntimeImportEquals(node: ts.ImportEqualsDeclaration): boolean {
  return !node.isTypeOnly && ts.isExternalModuleReference(node.moduleReference);
}

function importEqualsModuleSpecifier(
  node: ts.ImportEqualsDeclaration,
): ts.Expression | undefined {
  return ts.isExternalModuleReference(node.moduleReference)
    ? node.moduleReference.expression
    : undefined;
}

function hasRuntimeExport(node: ts.ExportDeclaration): boolean {
  if (!node.moduleSpecifier || node.isTypeOnly) {
    return false;
  }
  if (!node.exportClause || ts.isNamespaceExport(node.exportClause)) {
    return true;
  }
  return (
    node.exportClause.elements.length === 0 ||
    node.exportClause.elements.some((element) => !element.isTypeOnly)
  );
}

function isLiteralDynamicImport(node: ts.Node): node is ts.CallExpression {
  return (
    ts.isCallExpression(node) &&
    node.expression.kind === ts.SyntaxKind.ImportKeyword &&
    ts.isStringLiteralLike(node.arguments[0])
  );
}

function readPackageManifest(): unknown {
  return JSON.parse(
    readFileSync(
      fileURLToPath(new URL("../package.json", import.meta.url)),
      "utf8",
    ),
  );
}

function runtimeDependencyNames(packageJson: unknown): readonly string[] {
  if (typeof packageJson !== "object" || packageJson === null) {
    return [];
  }

  const manifest = packageJson as Record<string, unknown>;
  return [
    "dependencies",
    "optionalDependencies",
    "peerDependencies",
    "bundledDependencies",
    "bundleDependencies",
  ].flatMap((section) => dependencyNamesInSection(section, manifest[section]));
}

function dependencyNamesInSection(
  section: string,
  value: unknown,
): readonly string[] {
  if (value === undefined || value === false) {
    return [];
  }
  if (Array.isArray(value)) {
    return value
      .filter((name): name is string => typeof name === "string")
      .map((name) => `${section}:${name}`);
  }
  if (typeof value === "object" && value !== null) {
    return Object.keys(value).map((name) => `${section}:${name}`);
  }
  return [`${section}:<invalid>`];
}
