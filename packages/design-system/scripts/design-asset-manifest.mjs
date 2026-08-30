import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export function parseOptions(argv) {
  const options = {};

  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];

    if (
      (flag !== "--repo-root" && flag !== "--manifest") ||
      value === undefined
    ) {
      throw new Error(
        "Usage: node <script> [--repo-root <path>] [--manifest <path>]",
      );
    }

    options[flag.slice(2)] = value;
  }

  const repoRoot = resolve(options["repo-root"] ?? process.cwd());
  return {
    repoRoot,
    manifestPath: resolve(
      options.manifest ?? join(repoRoot, "docs/design/asset-manifest.md"),
    ),
  };
}

export function sha256(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

export function dimensionsOfPng(contents, assetLabel) {
  if (
    contents.length < 24 ||
    !contents.subarray(0, 8).equals(PNG_SIGNATURE) ||
    contents.toString("ascii", 12, 16) !== "IHDR"
  ) {
    throw new Error(`${assetLabel} is not a readable PNG`);
  }

  return {
    width: contents.readUInt32BE(16),
    height: contents.readUInt32BE(20),
  };
}

export function parseDimensions(value, field) {
  const match = /^(\d+)×(\d+)$/.exec(value.trim());
  if (!match) {
    throw new Error(`${field} must use WIDTH×HEIGHT`);
  }

  return { width: Number(match[1]), height: Number(match[2]) };
}

export function equalDimensions(actual, expected) {
  return actual.width === expected.width && actual.height === expected.height;
}

export function formatDimensions(dimensions) {
  return `${dimensions.width}×${dimensions.height}`;
}

export function ensureSha256(value, field) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new Error(`${field} must be 64 lowercase hexadecimal characters`);
  }
  return value;
}

export function repositoryPath(repoRoot, destination) {
  if (typeof destination !== "string" || isAbsolute(destination)) {
    throw new Error("Repository destination must be a relative path");
  }

  const absolutePath = resolve(repoRoot, destination);
  if (relative(repoRoot, absolutePath).startsWith("..")) {
    throw new Error("Repository destination must remain inside the repository");
  }
  return absolutePath;
}

function removeCodeTicks(value) {
  return value.trim().replace(/^`(.*)`$/, "$1");
}

function findSection(markdown, heading) {
  const title = `## ${heading}`;
  const start = markdown.indexOf(title);
  if (start === -1) {
    throw new Error(`Missing manifest section: ${heading}`);
  }

  const nextHeading = markdown.indexOf("\n## ", start + title.length);
  return markdown.slice(
    start + title.length,
    nextHeading === -1 ? markdown.length : nextHeading,
  );
}

function parseTable(markdown, heading) {
  const lines = findSection(markdown, heading)
    .split("\n")
    .filter((line) => line.trim().startsWith("|"));
  if (lines.length < 3) {
    throw new Error(`Missing table rows in manifest section: ${heading}`);
  }

  const cells = (line) =>
    line.trim().split("|").slice(1, -1).map(removeCodeTicks);
  const headers = cells(lines[0]);
  const divider = cells(lines[1]);
  if (
    divider.length !== headers.length ||
    divider.some((cell) => !/^:?-{3,}:?$/.test(cell))
  ) {
    throw new Error(`Malformed table divider in manifest section: ${heading}`);
  }

  return lines.slice(2).map((line) => {
    const values = cells(line);
    if (values.length !== headers.length) {
      throw new Error(`Malformed table row in manifest section: ${heading}`);
    }
    return Object.fromEntries(
      headers.map((header, index) => [header, values[index]]),
    );
  });
}

function required(row, field, section) {
  const value = row[field];
  if (!value) {
    throw new Error(`Missing ${field} in manifest ${section} row`);
  }
  return value;
}

export async function readManifest(manifestPath) {
  return readFile(manifestPath, "utf8");
}

export function parseReferenceAssets(markdown) {
  return parseTable(markdown, "Approved reference screenshots").map((row) => ({
    label: required(row, "Reference", "reference"),
    source: required(row, "Immutable source", "reference"),
    destination: required(row, "Repository destination", "reference"),
    sourceHash: ensureSha256(
      required(row, "Source SHA-256", "reference"),
      "Source SHA-256",
    ),
    sourceDimensions: parseDimensions(
      required(row, "Source dimensions", "reference"),
      "Source dimensions",
    ),
    repositoryHash: ensureSha256(
      required(row, "Repository SHA-256", "reference"),
      "Repository SHA-256",
    ),
    repositoryDimensions: parseDimensions(
      required(row, "Repository dimensions", "reference"),
      "Repository dimensions",
    ),
  }));
}

export function parseHeroAssets(markdown) {
  const assets = parseTable(markdown, "Canonical standalone hero gate").map(
    (row) => ({
      label: required(row, "Asset", "hero"),
      destination: required(row, "Required destination", "hero"),
      dimensions: parseDimensions(
        required(row, "Required dimensions", "hero"),
        "Required dimensions",
      ),
      repositoryHash: ensureSha256(
        required(row, "Repository SHA-256", "hero"),
        "Repository SHA-256",
      ),
    }),
  );

  const byLabel = new Map(assets.map((asset) => [asset.label, asset]));
  const requiredLabels = ["Hero master", "Web hero crop", "Mobile hero crop"];
  if (
    assets.length !== requiredLabels.length ||
    requiredLabels.some((label) => !byLabel.has(label))
  ) {
    throw new Error(
      "Hero manifest must name the master, web crop, and mobile crop exactly once",
    );
  }

  return {
    master: byLabel.get("Hero master"),
    webCrop: byLabel.get("Web hero crop"),
    mobileCrop: byLabel.get("Mobile hero crop"),
  };
}

export async function readRepositoryAsset(
  repoRoot,
  destination,
  missingMessage,
) {
  const path = repositoryPath(repoRoot, destination);
  try {
    return { path, contents: await readFile(path) };
  } catch (error) {
    if (error && error.code === "ENOENT") {
      throw new Error(`${missingMessage}: ${destination}`);
    }
    throw error;
  }
}
