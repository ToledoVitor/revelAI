import {
  AttemptOutcomeSchema,
  LeaderboardResponseSchema,
} from "@revelai/contracts";
import { describe, expect, it } from "vitest";
import {
  policyApprovedRankedLeaderboard,
  policyApprovedRankedOutcome,
} from "./ranked-policy-fixture";

describe("policy-approved ranked visual fixture", () => {
  it("uses the existing contract shape without calculating rank or policy in Web", () => {
    const outcome = AttemptOutcomeSchema.parse(policyApprovedRankedOutcome);
    const leaderboard = LeaderboardResponseSchema.parse(
      policyApprovedRankedLeaderboard,
    );

    expect(outcome).toMatchObject({
      state: "valid",
      result: {
        kind: "verified-result",
        competitiveStatus: "ranked",
        rankingSnapshot: { rank: 3, percentile: 87.5, topPercent: 12.5 },
      },
    });
    expect(leaderboard.entries).toHaveLength(1);
  });
});
