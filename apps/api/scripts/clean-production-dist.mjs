import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// This is deliberately an exact, package-owned build output—not a caller
// supplied path—so a normal build cannot retain excluded test artifacts.
const productionDist = fileURLToPath(new URL("../dist/", import.meta.url));

await rm(productionDist, { recursive: true, force: true });
