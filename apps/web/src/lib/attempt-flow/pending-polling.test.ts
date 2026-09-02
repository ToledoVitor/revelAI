import { describe, expect, it } from "vitest";
import { nextPendingPollBackoff } from "./pending-polling";

describe("pending attempt polling", () => {
  it("caps the shared 1/2/4/5 second progression", () => {
    expect([1, 2, 4, 5, 5].map(nextPendingPollBackoff)).toEqual([
      2, 4, 5, 5, 5,
    ]);
  });
});
