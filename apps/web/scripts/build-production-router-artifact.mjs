import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  buildProductionRouterArtifact,
  runPnpm,
} from "./production-router-build.mjs";

const webDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export { buildProductionRouterArtifact, runPnpm };

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    await buildProductionRouterArtifact();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
