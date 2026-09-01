import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("../../../", import.meta.url));
const fixture = await mkdtemp(join(tmpdir(), "revelai-clean-api-demo-"));
const archive = join(fixture, "revelai.tar");

try {
  await run("git", ["archive", "--format=tar", "--output", archive, "HEAD"], {
    cwd: repository,
  });
  await run("tar", ["-xf", archive, "-C", fixture], { cwd: repository });
  await run("pnpm", ["install", "--frozen-lockfile"], { cwd: fixture });
  await run("pnpm", ["--filter", "@revelai/api", "run", "demo:smoke"], {
    cwd: fixture,
  });
  await run(
    "pnpm",
    ["--filter", "@revelai/api", "run", "operator:receipt-smoke"],
    { cwd: fixture },
  );
  await run("pnpm", ["--filter", "@revelai/api", "run", "openapi:check"], {
    cwd: fixture,
  });
  console.log("Clean API executable regression passed.");
} finally {
  await rm(fixture, { recursive: true, force: true });
}

function run(executable, arguments_, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, arguments_, {
      cwd: options.cwd,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("close", (exitCode) => {
      if (exitCode === 0) resolve();
      else reject(new Error("Clean API demo regression command failed."));
    });
  });
}
