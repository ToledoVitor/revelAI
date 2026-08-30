import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  dimensionsOfPng,
  equalDimensions,
  formatDimensions,
  parseOptions,
  parseReferenceAssets,
  readManifest,
  repositoryPath,
  sha256,
} from "./design-asset-manifest.mjs";

async function readApprovedSource(asset) {
  let contents;
  try {
    contents = await readFile(asset.source);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      throw new Error(`Missing approved source: ${asset.source}`);
    }
    throw error;
  }

  const actualHash = sha256(contents);
  if (actualHash !== asset.sourceHash) {
    throw new Error(
      `Source hash mismatch for ${asset.label}: expected ${asset.sourceHash}, received ${actualHash}`,
    );
  }

  const actualDimensions = dimensionsOfPng(contents, asset.label);
  if (!equalDimensions(actualDimensions, asset.sourceDimensions)) {
    throw new Error(
      `Source dimension mismatch for ${asset.label}: expected ${formatDimensions(asset.sourceDimensions)}, received ${formatDimensions(actualDimensions)}`,
    );
  }

  if (
    actualHash !== asset.repositoryHash ||
    !equalDimensions(actualDimensions, asset.repositoryDimensions)
  ) {
    throw new Error(`Repository expectation mismatch for ${asset.label}`);
  }

  return { asset, contents };
}

export async function importApprovedDesignAssets({ repoRoot, manifestPath }) {
  const assets = parseReferenceAssets(await readManifest(manifestPath));
  const verifiedSources = await Promise.all(assets.map(readApprovedSource));

  for (const { asset, contents } of verifiedSources) {
    const destination = repositoryPath(repoRoot, asset.destination);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, contents);
  }

  return verifiedSources.length;
}

async function main() {
  const count = await importApprovedDesignAssets(
    parseOptions(process.argv.slice(2)),
  );
  process.stdout.write(`Imported ${count} approved design assets.\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
