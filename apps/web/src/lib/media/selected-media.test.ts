import { describe, expect, it } from "vitest";
import { normalizeSelectedMedia, selectedMediaMime } from "./selected-media";

describe("neutral selected media normalization", () => {
  it("normalizes an undeclared supported source without adding capture policy", () => {
    const source = new File(["video"], "free.webm");

    expect(selectedMediaMime(source)).toBe("video/webm");
    expect(normalizeSelectedMedia(source)).toMatchObject({
      wireMime: "video/webm",
      file: { name: "free.webm", type: "video/webm" },
    });
  });

  it("rejects a source whose extension and declared MIME disagree", () => {
    expect(
      normalizeSelectedMedia(
        new File(["video"], "wrong.mp4", { type: "video/webm" }),
      ),
    ).toBeUndefined();
  });
});
