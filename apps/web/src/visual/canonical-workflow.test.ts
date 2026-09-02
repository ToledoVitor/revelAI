// @vitest-environment node

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const workflowPath = fileURLToPath(
  new URL("../../../../.github/workflows/ci.yml", import.meta.url),
);

describe("canonical visual workflow", () => {
  it("uses the host's installed pnpm store without allowing an implicit install", async () => {
    const workflow = await readFile(workflowPath, "utf8");
    const canonicalStep = workflow.slice(
      workflow.indexOf("      - name: Run canonical Linux visual gate"),
      workflow.indexOf(
        "      - run: pnpm --filter @revelai/api run openapi:check",
      ),
    );

    expect(canonicalStep).toContain('revelai_pnpm_store="$(pnpm store path)"');
    expect(canonicalStep).toContain(
      '--volume "$revelai_pnpm_store:$revelai_pnpm_store:ro"',
    );
    expect(canonicalStep).toContain(
      '--volume "$GITHUB_WORKSPACE:$GITHUB_WORKSPACE"',
    );
    expect(canonicalStep).toContain('--workdir "$GITHUB_WORKSPACE"');
    expect(canonicalStep).toContain(
      '--env PNPM_CONFIG_STORE_DIR="$revelai_pnpm_store"',
    );
    expect(canonicalStep).toContain(
      "--env pnpm_config_verify_deps_before_run=error",
    );
    expect(canonicalStep).toContain("--env PNPM_CONFIG_OFFLINE=true");
    expect(canonicalStep).toContain("--network none");
    expect(canonicalStep).toContain("--platform linux/amd64");
    expect(canonicalStep).toContain(
      "mcr.microsoft.com/playwright@sha256:dcc5531e97840b9b5e794f2814476b21571c5124a3fca2267d73041f56e7580e",
    );
  });
});
