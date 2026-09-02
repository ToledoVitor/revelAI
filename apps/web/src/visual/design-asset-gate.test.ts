// @vitest-environment node

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const webRoot = fileURLToPath(new URL("../..", import.meta.url));

describe("web design asset gate", () => {
  it("verifies the approved hero before the web runtime starts", () => {
    const output = execFileSync(
      process.execPath,
      ["scripts/verify-design-assets.mjs"],
      {
        cwd: webRoot,
        encoding: "utf8",
      },
    );

    expect(output).toContain("Design assets verified: 10 assets.");
  });
});
