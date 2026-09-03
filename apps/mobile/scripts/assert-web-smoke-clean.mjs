import { execFileSync } from "node:child_process";
import { log } from "node:console";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const appDirectory = resolve(import.meta.dirname, "..");
const repositoryDirectory = resolve(appDirectory, "../..");
const legacyOutputDirectory = resolve(appDirectory, "test-results");
const generatedOutputDirectory = "apps/mobile/dist/playwright-results";

if (existsSync(legacyOutputDirectory)) {
  throw new Error(
    `Playwright left the unignored legacy output directory: ${legacyOutputDirectory}.`,
  );
}

execFileSync(
  "git",
  ["check-ignore", "--no-index", "--quiet", generatedOutputDirectory],
  { cwd: repositoryDirectory },
);

log("Playwright output remains in the ignored generated dist directory.");
