import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const failure = "API Vitest worker configuration regression failed.";
const config = fileURLToPath(new URL("../vitest.config.mjs", import.meta.url));
const packageJson = fileURLToPath(new URL("../package.json", import.meta.url));

const ci = await loadConfig("true");
if (ci.test?.minWorkers !== 1 || ci.test?.maxWorkers !== 1) {
  throw new Error(failure);
}

const local = await loadConfig(undefined);
if (
  local.test?.minWorkers !== 1 ||
  !Number.isInteger(local.test?.maxWorkers) ||
  local.test.maxWorkers < 1 ||
  local.test.maxWorkers > 4
) {
  throw new Error(failure);
}

const manifest = JSON.parse(await readFile(packageJson, "utf8"));
if (manifest.scripts?.test !== "vitest run --config vitest.config.mjs") {
  throw new Error(failure);
}

console.log("API Vitest worker configuration regression passed.");

async function loadConfig(ciValue) {
  const previousCi = process.env.CI;
  try {
    if (ciValue === undefined) delete process.env.CI;
    else process.env.CI = ciValue;
    const moduleUrl = pathToFileURL(config);
    moduleUrl.searchParams.set("run", `${ciValue ?? "local"}-${Date.now()}`);
    return (await import(moduleUrl.href)).default;
  } finally {
    if (previousCi === undefined) delete process.env.CI;
    else process.env.CI = previousCi;
  }
}
