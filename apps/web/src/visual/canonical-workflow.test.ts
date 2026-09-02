// @vitest-environment node

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const workflowPath = fileURLToPath(
  new URL("../../../../.github/workflows/ci.yml", import.meta.url),
);

describe("canonical visual workflow", () => {
  it("keeps each canonical container hermetic without allowing an implicit install", async () => {
    const workflow = await readFile(workflowPath, "utf8");
    const canonicalStep = workflow.slice(
      workflow.indexOf("      - name: Run canonical Linux visual gate"),
      workflow.indexOf(
        "      - run: pnpm --filter @revelai/api run openapi:check",
      ),
    );

    expect(canonicalStep).toContain('revelai_pnpm_store="$(pnpm store path)"');
    expect(canonicalStep).toContain('test -d "$revelai_pnpm_store"');

    const dockerRuns = canonicalStep
      .split("          docker run --rm \\\n")
      .slice(1);

    expect(dockerRuns).toHaveLength(2);

    for (const dockerRun of dockerRuns) {
      expect(dockerRun).toContain("--network none");
      expect(dockerRun).toContain("--platform linux/amd64");
      expect(dockerRun).toContain(
        '--volume "$revelai_pnpm_store:$revelai_pnpm_store:ro"',
      );
      expect(dockerRun).toContain(
        '--volume "$GITHUB_WORKSPACE:$GITHUB_WORKSPACE"',
      );
      expect(dockerRun).toContain('--volume "$revelai_pnpm_root:/pnpm:ro"');
      expect(dockerRun).toContain('--workdir "$GITHUB_WORKSPACE"');
      expect(dockerRun).toContain(
        '--env PNPM_CONFIG_STORE_DIR="$revelai_pnpm_store"',
      );
      expect(dockerRun).toContain(
        "--env pnpm_config_verify_deps_before_run=error",
      );
      expect(dockerRun).toContain("--env PNPM_CONFIG_OFFLINE=true");
      expect(dockerRun).toContain('"$PLAYWRIGHT_IMAGE"');
      expect(dockerRun).toContain("node /pnpm/pnpm/bin/pnpm.cjs");
    }

    expect(canonicalStep).toContain(
      "mcr.microsoft.com/playwright@sha256:dcc5531e97840b9b5e794f2814476b21571c5124a3fca2267d73041f56e7580e",
    );
    expect(dockerRuns[0]).toContain(
      "node /pnpm/pnpm/bin/pnpm.cjs --filter @revelai/design-system run build",
    );
    expect(dockerRuns[1]).toContain(
      "node /pnpm/pnpm/bin/pnpm.cjs --filter @revelai/web run test:visual:canonical",
    );
  });
});
