import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { basename, dirname, extname, resolve } from "node:path";

const webDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = resolve(
  webDirectory,
  "coverage/production-router-dist",
);
const forbiddenReviewArtifacts = [
  "__revelaiReviewSetupModuleEvaluations",
  "__revelaiReviewCaptureModuleEvaluations",
  "Preparação para passe na parede",
  "Captura para passe na parede",
];

async function emittedFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = resolve(directory, entry.name);
      return entry.isDirectory() ? emittedFiles(entryPath) : [entryPath];
    }),
  );

  return files.flat();
}

const files = await emittedFiles(outputDirectory);
const javascriptFiles = files.filter((file) => extname(file) === ".js");

if (javascriptFiles.length === 0) {
  throw new Error("The isolated production router artifact has no JavaScript.");
}

if (
  javascriptFiles.some((file) =>
    /^(setup|capture)-[\w-]+\.js$/.test(basename(file)),
  )
) {
  throw new Error(
    "Review setup or capture chunk leaked into production output.",
  );
}

for (const file of javascriptFiles) {
  const content = await readFile(file, "utf8");
  for (const forbiddenArtifact of forbiddenReviewArtifacts) {
    if (content.includes(forbiddenArtifact)) {
      throw new Error(
        `Review setup or capture artifact leaked into production output: ${forbiddenArtifact}`,
      );
    }
  }
}
