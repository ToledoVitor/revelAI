import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import type { Page } from "@playwright/test";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import {
  createCaptureMetadata,
  selectFixture,
  type CaptureMetadata,
  type Viewport,
} from "./visual-harness";

type MaskRegion = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type ComparisonResult = {
  reference: string;
  threshold: number;
  mask: {
    rationale: string;
    regions: readonly MaskRegion[];
  };
  changedPixels: number;
  comparedPixels: number;
  mismatchRatio: number;
  maxMismatchRatio: number;
};

type VisualArtifacts = {
  metadata: CaptureMetadata;
  files: {
    capture: string;
    metadata: string;
    normalizedReference: string;
    overlay: string;
    diff: string;
  };
  comparison: ComparisonResult;
};

const webRoot = fileURLToPath(new URL("../../", import.meta.url));
const repositoryRoot = resolve(webRoot, "../..");
const artifactDirectory = resolve(
  webRoot,
  "coverage/playwright/visual-artifacts",
);

function filenameWithoutExtension(filename: string) {
  return filename.replace(/\.png$/, "");
}

function getReference(viewport: Viewport) {
  return viewport.width <= 700 ? "mobile-home.png" : "desktop-home.png";
}

function getMask(viewport: Viewport): ComparisonResult["mask"] {
  if (viewport.width <= 700) {
    return {
      rationale:
        "The upper mobile hero is an independently supplied runtime image, so the comparison evaluates the unmasked decision controls below it.",
      regions: [
        {
          x: 0,
          y: 0,
          width: viewport.width,
          height: Math.round(viewport.height * 0.62),
        },
      ],
    };
  }

  return {
    rationale:
      "The desktop runtime hero uses the approved standalone image instead of the reference screenshot raster, so its photographic region is excluded while the left-side interface remains compared.",
    regions: [
      {
        x: Math.round(viewport.width * 0.45),
        y: 0,
        width: Math.round(viewport.width * 0.55),
        height: viewport.height,
      },
    ],
  };
}

function resizeNearest(source: PNG, width: number, height: number) {
  const normalized = new PNG({ width, height });

  for (let y = 0; y < height; y += 1) {
    const sourceY = Math.min(
      source.height - 1,
      Math.floor((y * source.height) / height),
    );

    for (let x = 0; x < width; x += 1) {
      const sourceX = Math.min(
        source.width - 1,
        Math.floor((x * source.width) / width),
      );
      const sourceOffset = (sourceY * source.width + sourceX) * 4;
      const targetOffset = (y * width + x) * 4;
      normalized.data[targetOffset] = source.data[sourceOffset];
      normalized.data[targetOffset + 1] = source.data[sourceOffset + 1];
      normalized.data[targetOffset + 2] = source.data[sourceOffset + 2];
      normalized.data[targetOffset + 3] = source.data[sourceOffset + 3];
    }
  }

  return normalized;
}

function isMasked(x: number, y: number, regions: readonly MaskRegion[]) {
  return regions.some(
    (region) =>
      x >= region.x &&
      y >= region.y &&
      x < region.x + region.width &&
      y < region.y + region.height,
  );
}

function createOverlay(reference: PNG, capture: PNG) {
  const overlay = new PNG({ width: capture.width, height: capture.height });

  for (let offset = 0; offset < capture.data.length; offset += 4) {
    overlay.data[offset] = Math.round(
      reference.data[offset] * 0.5 + capture.data[offset] * 0.5,
    );
    overlay.data[offset + 1] = Math.round(
      reference.data[offset + 1] * 0.5 + capture.data[offset + 1] * 0.5,
    );
    overlay.data[offset + 2] = Math.round(
      reference.data[offset + 2] * 0.5 + capture.data[offset + 2] * 0.5,
    );
    overlay.data[offset + 3] = 255;
  }

  return overlay;
}

function createMaskedDiff({
  reference,
  capture,
  regions,
}: {
  reference: PNG;
  capture: PNG;
  regions: readonly MaskRegion[];
}) {
  const referenceForDiff = PNG.sync.read(PNG.sync.write(reference));
  const captureForDiff = PNG.sync.read(PNG.sync.write(capture));
  let comparedPixels = 0;

  for (let y = 0; y < capture.height; y += 1) {
    for (let x = 0; x < capture.width; x += 1) {
      const offset = (y * capture.width + x) * 4;

      if (isMasked(x, y, regions)) {
        captureForDiff.data[offset] = referenceForDiff.data[offset];
        captureForDiff.data[offset + 1] = referenceForDiff.data[offset + 1];
        captureForDiff.data[offset + 2] = referenceForDiff.data[offset + 2];
        captureForDiff.data[offset + 3] = referenceForDiff.data[offset + 3];
      } else {
        comparedPixels += 1;
      }
    }
  }

  const diff = new PNG({ width: capture.width, height: capture.height });
  const threshold = 0.32;
  const changedPixels = pixelmatch(
    referenceForDiff.data,
    captureForDiff.data,
    diff.data,
    capture.width,
    capture.height,
    { threshold, includeAA: false },
  );

  return {
    diff,
    threshold,
    changedPixels,
    comparedPixels,
  };
}

export async function captureHomeVisualArtifacts({
  page,
  viewport,
  dpr,
}: {
  page: Page;
  viewport: Viewport;
  dpr: number;
}): Promise<VisualArtifacts> {
  const route = new URL(page.url()).pathname;
  const state = "ready";
  const fixture = selectFixture({ route, state });
  const metadata = createCaptureMetadata({
    viewport,
    dpr,
    route,
    state,
    fixture,
  });
  const referenceName = getReference(viewport);
  const artifactStem = filenameWithoutExtension(metadata.screenshot);
  const files = {
    capture: resolve(artifactDirectory, metadata.screenshot),
    metadata: resolve(artifactDirectory, `${artifactStem}.metadata.json`),
    normalizedReference: resolve(
      artifactDirectory,
      `${artifactStem}.reference-normalized.png`,
    ),
    overlay: resolve(artifactDirectory, `${artifactStem}.overlay.png`),
    diff: resolve(artifactDirectory, `${artifactStem}.diff.png`),
  };

  await mkdir(artifactDirectory, { recursive: true });
  await page.screenshot({ path: files.capture, scale: "css" });

  const [captureFile, referenceFile] = await Promise.all([
    readFile(files.capture),
    readFile(resolve(repositoryRoot, "docs/design/references", referenceName)),
  ]);
  const capture = PNG.sync.read(captureFile);
  const reference = resizeNearest(
    PNG.sync.read(referenceFile),
    capture.width,
    capture.height,
  );
  const mask = getMask(viewport);
  const { diff, threshold, changedPixels, comparedPixels } = createMaskedDiff({
    reference,
    capture,
    regions: mask.regions,
  });
  const comparison: ComparisonResult = {
    reference: referenceName,
    threshold,
    mask,
    changedPixels,
    comparedPixels,
    mismatchRatio: changedPixels / comparedPixels,
    maxMismatchRatio: viewport.width <= 700 ? 0.24 : 0.33,
  };

  await Promise.all([
    writeFile(files.normalizedReference, PNG.sync.write(reference)),
    writeFile(files.overlay, PNG.sync.write(createOverlay(reference, capture))),
    writeFile(files.diff, PNG.sync.write(diff)),
    writeFile(
      files.metadata,
      `${JSON.stringify(
        {
          ...metadata,
          captureScale: "css",
          normalizedPixelDensity: 1,
          captureDimensions: { width: capture.width, height: capture.height },
          reference: referenceName,
          comparison,
        },
        null,
        2,
      )}\n`,
    ),
  ]);

  return { metadata, files, comparison };
}
