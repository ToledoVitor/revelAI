import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const failure = "API Vitest worker configuration regression failed.";
const config = fileURLToPath(new URL("../vitest.config.mjs", import.meta.url));
const packageJson = fileURLToPath(new URL("../package.json", import.meta.url));
const rootPackageJson = fileURLToPath(
  new URL("../../../package.json", import.meta.url),
);
let configLoadCount = 0;

for (const ciValue of ["true", "TRUE", " TrUe ", "1", " 1 "]) {
  assertWorkers(await loadConfig(ciValue), 1);
}
for (const ciValue of [undefined, "", " ", "false", "FALSE", "0", " 0 "]) {
  assertWorkers(await loadConfig(ciValue), 4);
}

const manifest = JSON.parse(await readFile(packageJson, "utf8"));
if (
  manifest.scripts?.test !==
  "node scripts/assert-vitest-worker-config.mjs && vitest run --config vitest.config.mjs"
) {
  throw new Error(failure);
}
const rootManifest = JSON.parse(await readFile(rootPackageJson, "utf8"));
if (
  rootManifest.scripts?.test !==
  "node apps/api/scripts/assert-vitest-worker-config.mjs && turbo run test --concurrency=1"
) {
  throw new Error(failure);
}

console.log("API Vitest worker configuration regression passed.");

async function loadConfig(ciValue) {
  const previousCi = process.env.CI;
  try {
    if (ciValue === undefined) delete process.env.CI;
    else process.env.CI = ciValue;
    const moduleUrl = pathToFileURL(config);
    configLoadCount += 1;
    moduleUrl.searchParams.set(
      "run",
      `${ciValue ?? "local"}-${configLoadCount}`,
    );
    return (await import(moduleUrl.href)).default;
  } finally {
    if (previousCi === undefined) delete process.env.CI;
    else process.env.CI = previousCi;
  }
}

function assertWorkers(config, maxWorkers) {
  if (config.test?.minWorkers !== 1 || config.test.maxWorkers !== maxWorkers) {
    throw new Error(failure);
  }
}
