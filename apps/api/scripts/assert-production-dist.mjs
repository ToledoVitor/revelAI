import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../dist/", import.meta.url));
const leaked = [];
const testSupportArtifact = /\.test-support\.|c5-pipeline-test-support\./u;

async function visit(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await visit(path);
    else if (entry.isFile() && testSupportArtifact.test(entry.name))
      leaked.push(path);
  }
}

try {
  await visit(root);
} catch (error) {
  if (error && typeof error === "object" && error.code === "ENOENT") {
    throw new Error(
      "Production API dist directory is missing; run the build first.",
    );
  }
  throw error;
}

if (leaked.length > 0)
  throw new Error(
    `Production API dist must exclude test-support artifacts: ${leaked.join(", ")}`,
  );
