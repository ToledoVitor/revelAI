import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  dimensionsOfPng,
  equalDimensions,
  ensureSha256,
  formatDimensions,
  parseHeroAssets,
  parseOptions,
  parseReferenceAssets,
  readManifest,
  readRepositoryAsset,
  sha256,
} from "./design-asset-manifest.mjs";

function exactKeys(value, keys, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new Error(`${field} has an invalid shape`);
  }
}

function assertDimensions(value, field) {
  if (
    !Number.isInteger(value.width) ||
    !Number.isInteger(value.height) ||
    value.width <= 0 ||
    value.height <= 0
  ) {
    throw new Error(`${field} must have positive integer width and height`);
  }
}

function validateReceipt(receipt) {
  exactKeys(receipt, ["master", "webCrop", "mobileCrop"], "Asset receipt");
  exactKeys(
    receipt.master,
    [
      "generatorRunId",
      "sha256",
      "width",
      "height",
      "licensedOrGenerated",
      "accepted",
      "checklist",
    ],
    "Asset receipt master",
  );
  exactKeys(
    receipt.webCrop,
    ["sha256", "width", "height"],
    "Asset receipt webCrop",
  );
  exactKeys(
    receipt.mobileCrop,
    ["sha256", "width", "height"],
    "Asset receipt mobileCrop",
  );
  exactKeys(
    receipt.master.checklist,
    [
      "noText",
      "noLogoOrSponsor",
      "noUiOrDeviceChrome",
      "athleteVisible",
      "ballVisible",
    ],
    "Asset receipt checklist",
  );

  if (
    typeof receipt.master.generatorRunId !== "string" ||
    receipt.master.generatorRunId.trim() === ""
  ) {
    throw new Error("Asset receipt generatorRunId must be a non-empty string");
  }
  if (receipt.master.licensedOrGenerated !== "generated") {
    throw new Error("Asset receipt licensedOrGenerated must be generated");
  }
  if (receipt.master.accepted !== true) {
    throw new Error("Asset receipt accepted must be true");
  }
  for (const [item, field] of [
    [receipt.master, "master"],
    [receipt.webCrop, "webCrop"],
    [receipt.mobileCrop, "mobileCrop"],
  ]) {
    ensureSha256(item.sha256, `Asset receipt ${field} sha256`);
    assertDimensions(item, `Asset receipt ${field}`);
  }
  for (const [key, value] of Object.entries(receipt.master.checklist)) {
    if (value !== true) {
      throw new Error(`Asset receipt checklist ${key} must be true`);
    }
  }

  return receipt;
}

async function readReceipt(repoRoot) {
  const receiptPath = join(
    repoRoot,
    "docs/design/assets/a1-asset-receipt.json",
  );
  let contents;
  try {
    contents = await readFile(receiptPath, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") {
      throw new Error("Missing asset receipt");
    }
    throw error;
  }

  try {
    return validateReceipt(JSON.parse(contents));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error("Malformed asset receipt");
    }
    throw error;
  }
}

async function verifyAsset(repoRoot, asset, receiptAsset) {
  const { contents } = await readRepositoryAsset(
    repoRoot,
    asset.destination,
    "Missing repository asset",
  );
  const actualHash = sha256(contents);
  if (actualHash !== asset.repositoryHash) {
    throw new Error(
      `Repository hash mismatch for ${asset.destination}: expected ${asset.repositoryHash}, received ${actualHash}`,
    );
  }

  const actualDimensions = dimensionsOfPng(contents, asset.destination);
  const expectedDimensions = asset.repositoryDimensions ?? asset.dimensions;
  if (!equalDimensions(actualDimensions, expectedDimensions)) {
    throw new Error(
      `Repository dimension mismatch for ${asset.destination}: expected ${formatDimensions(expectedDimensions)}, received ${formatDimensions(actualDimensions)}`,
    );
  }

  if (receiptAsset) {
    if (receiptAsset.sha256 !== actualHash) {
      throw new Error(`Asset receipt hash mismatch for ${asset.destination}`);
    }
    if (!equalDimensions(receiptAsset, actualDimensions)) {
      throw new Error(
        `Asset receipt dimensions mismatch for ${asset.destination}`,
      );
    }
  }
}

export async function verifyDesignAssets({ repoRoot, manifestPath }) {
  const markdown = await readManifest(manifestPath);
  const references = parseReferenceAssets(markdown);
  const hero = parseHeroAssets(markdown);
  const receipt = await readReceipt(repoRoot);

  await Promise.all(references.map((asset) => verifyAsset(repoRoot, asset)));
  await verifyAsset(repoRoot, hero.master, receipt.master);
  await verifyAsset(repoRoot, hero.webCrop, receipt.webCrop);
  await verifyAsset(repoRoot, hero.mobileCrop, receipt.mobileCrop);

  return references.length + 3;
}

async function main() {
  const count = await verifyDesignAssets(parseOptions(process.argv.slice(2)));
  process.stdout.write(`Design assets verified: ${count} assets.\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
