import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { renderOpenApiDocument } from "../dist/http/openapi.js";

const artifact = resolve(import.meta.dirname, "../openapi.json");
const generated = renderOpenApiDocument();

if (process.argv.includes("--check")) {
  const committed = await readFile(artifact, "utf8").catch(() => undefined);
  if (committed !== generated) {
    process.stderr.write("Generated OpenAPI artifact is out of date.\n");
    process.exitCode = 1;
  }
} else {
  await writeFile(artifact, generated, "utf8");
}
