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

type VisualMetric = {
  threshold: number;
  changedPixels: number;
  comparedPixels: number;
  mismatchRatio: number;
  maxMismatchRatio: number;
};

type UiInkCoverage = {
  region: MaskRegion;
  baselineCaptureInkPixels: number;
  minCaptureInkPixels: number;
  capturedInkPixels: number;
  passes: boolean;
};

type ComparisonResult = {
  reference: string;
  mask: {
    rationale: string;
    regions: readonly MaskRegion[];
  };
  image: VisualMetric;
  uiInk: VisualMetric & {
    rationale: string;
    regions: readonly MaskRegion[];
    coverage: readonly UiInkCoverage[];
  };
  mismatchRatio: number;
  maxMismatchRatio: number;
  exceedsBudget: boolean;
};

type VisualArtifacts = {
  metadata: CaptureMetadata;
  files: {
    capture: string;
    metadata: string;
    normalizedReference: string;
    overlay: string;
    diff: string;
    uiInkCapture: string;
    uiInkReference: string;
    uiInkOverlay: string;
    uiInkDiff: string;
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

function getMask(viewport: Viewport) {
  if (viewport.width <= 700) {
    return {
      rationale:
        "The mobile photo begins below the header and ends before the decision controls; only those runtime-photography pixels are excluded from the full-view comparison.",
      regions: [
        {
          x: 0,
          y: Math.round(viewport.height * 0.069),
          width: viewport.width,
          height: Math.round(viewport.height * 0.565),
        },
      ],
    };
  }

  return {
    rationale:
      "The desktop runtime photo starts at the approved 46 percent split below the header, so only that photographic rectangle is excluded from the full-view comparison.",
    regions: [
      {
        x: Math.round(viewport.width * 0.464),
        y: 82,
        width: Math.round(viewport.width * 0.536),
        height: viewport.height - 82,
      },
    ],
  };
}

function getUiInkRegions(viewport: Viewport): readonly MaskRegion[] {
  if (viewport.width <= 700) {
    return [
      { x: 20, y: 8, width: 150, height: 45 },
      { x: 20, y: 78, width: 230, height: 312 },
      { x: 20, y: 398, width: 235, height: 135 },
    ];
  }

  return [{ x: 1035, y: 20, width: 375, height: 44 }];
}

function getUiInkCoverageBaselines(viewport: Viewport) {
  // Captured after `document.fonts.ready` at the approved CSS viewports. The
  // gate allows a 10% rasterisation margin below while making a removed control
  // unambiguously fail without depending on the variable hero photograph.
  if (viewport.width <= 700) {
    return [1040, 17232, 2287] as const;
  }

  return [416] as const;
}

function getVisualBudgets(viewport: Viewport) {
  if (viewport.width <= 700) {
    return {
      imageMaxMismatchRatio: 0.145,
      uiInkMaxMismatchRatio: 0.24,
    } as const;
  }

  return {
    imageMaxMismatchRatio: 0.12,
    uiInkMaxMismatchRatio: 0.05,
  } as const;
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
  const threshold = 0.18;
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

const warmWhite = [247, 245, 240] as const;
const nearBlack = [16, 17, 15] as const;
const deepEmerald = [0, 107, 60] as const;

function isWithinRegion(x: number, y: number, regions: readonly MaskRegion[]) {
  return regions.some(
    (region) =>
      x >= region.x &&
      y >= region.y &&
      x < region.x + region.width &&
      y < region.y + region.height,
  );
}

function colorDistance(
  red: number,
  green: number,
  blue: number,
  target: readonly [number, number, number],
) {
  return Math.hypot(red - target[0], green - target[1], blue - target[2]);
}

function getUiInkColor(red: number, green: number, blue: number) {
  if (colorDistance(red, green, blue, nearBlack) <= 58) {
    return nearBlack;
  }

  if (colorDistance(red, green, blue, deepEmerald) <= 68) {
    return deepEmerald;
  }

  return null;
}

function createUiInkLayer(source: PNG, regions: readonly MaskRegion[]) {
  const layer = new PNG({ width: source.width, height: source.height });

  for (let y = 0; y < source.height; y += 1) {
    for (let x = 0; x < source.width; x += 1) {
      const offset = (y * source.width + x) * 4;
      const ink = isWithinRegion(x, y, regions)
        ? getUiInkColor(
            source.data[offset],
            source.data[offset + 1],
            source.data[offset + 2],
          )
        : null;
      const color = ink ?? warmWhite;

      layer.data[offset] = color[0];
      layer.data[offset + 1] = color[1];
      layer.data[offset + 2] = color[2];
      layer.data[offset + 3] = 255;
    }
  }

  return layer;
}

function countInkPixels(layer: PNG, region: MaskRegion) {
  let inkPixels = 0;

  for (let y = region.y; y < region.y + region.height; y += 1) {
    for (let x = region.x; x < region.x + region.width; x += 1) {
      const offset = (y * layer.width + x) * 4;
      const isWarmWhite =
        layer.data[offset] === warmWhite[0] &&
        layer.data[offset + 1] === warmWhite[1] &&
        layer.data[offset + 2] === warmWhite[2];

      if (!isWarmWhite) {
        inkPixels += 1;
      }
    }
  }

  return inkPixels;
}

function createUiInkDiff({
  reference,
  capture,
  regions,
}: {
  reference: PNG;
  capture: PNG;
  regions: readonly MaskRegion[];
}) {
  const referenceInk = createUiInkLayer(reference, regions);
  const captureInk = createUiInkLayer(capture, regions);
  const diff = new PNG({ width: capture.width, height: capture.height });
  const threshold = 0.1;
  const changedPixels = pixelmatch(
    referenceInk.data,
    captureInk.data,
    diff.data,
    capture.width,
    capture.height,
    { threshold, includeAA: false },
  );
  const comparedPixels = regions.reduce(
    (total, region) => total + region.width * region.height,
    0,
  );

  return {
    referenceInk,
    captureInk,
    diff,
    threshold,
    changedPixels,
    comparedPixels,
  };
}

async function captureUiInk(page: Page, path: string) {
  const style = await page.addStyleTag({
    content: ".hero-image { visibility: hidden !important; }",
  });

  try {
    await page.screenshot({ path, scale: "css" });
  } finally {
    await style.evaluate((element) => element.parentNode?.removeChild(element));
  }
}

async function waitForVisualAssets(page: Page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(
      Array.from(document.images).map((image) => {
        if (image.complete) {
          return Promise.resolve();
        }

        return new Promise<void>((resolveImage) => {
          image.addEventListener("load", () => resolveImage(), { once: true });
          image.addEventListener("error", () => resolveImage(), { once: true });
        });
      }),
    );
  });
}

export async function captureHomeVisualArtifacts({
  page,
  viewport,
  dpr,
  state = "ready",
}: {
  page: Page;
  viewport: Viewport;
  dpr: number;
  state?: string;
}): Promise<VisualArtifacts> {
  const route = new URL(page.url()).pathname;
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
    uiInkCapture: resolve(artifactDirectory, `${artifactStem}.ui-ink.png`),
    uiInkReference: resolve(
      artifactDirectory,
      `${artifactStem}.ui-ink-reference.png`,
    ),
    uiInkOverlay: resolve(
      artifactDirectory,
      `${artifactStem}.ui-ink-overlay.png`,
    ),
    uiInkDiff: resolve(artifactDirectory, `${artifactStem}.ui-ink-diff.png`),
  };

  await mkdir(artifactDirectory, { recursive: true });
  await waitForVisualAssets(page);
  await page.screenshot({ path: files.capture, scale: "css" });
  await captureUiInk(page, files.uiInkCapture);

  const [captureFile, referenceFile, uiInkCaptureFile] = await Promise.all([
    readFile(files.capture),
    readFile(resolve(repositoryRoot, "docs/design/references", referenceName)),
    readFile(files.uiInkCapture),
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
  const uiInkRegions = getUiInkRegions(viewport);
  const uiInkCoverageBaselines = getUiInkCoverageBaselines(viewport);
  const budgets = getVisualBudgets(viewport);
  const uiInkCapture = PNG.sync.read(uiInkCaptureFile);
  const {
    referenceInk,
    captureInk,
    diff: uiInkDiff,
    threshold: uiInkThreshold,
    changedPixels: uiInkChangedPixels,
    comparedPixels: uiInkComparedPixels,
  } = createUiInkDiff({
    reference,
    capture: uiInkCapture,
    regions: uiInkRegions,
  });
  const image: VisualMetric = {
    threshold,
    changedPixels,
    comparedPixels,
    mismatchRatio: changedPixels / comparedPixels,
    maxMismatchRatio: budgets.imageMaxMismatchRatio,
  };
  const coverage = uiInkRegions.map((region, index) => {
    const baselineCaptureInkPixels = uiInkCoverageBaselines[index];
    const minCaptureInkPixels = Math.floor(baselineCaptureInkPixels * 0.9);
    const capturedInkPixels = countInkPixels(captureInk, region);

    return {
      region,
      baselineCaptureInkPixels,
      minCaptureInkPixels,
      capturedInkPixels,
      passes: capturedInkPixels >= minCaptureInkPixels,
    };
  });
  const uiInk: ComparisonResult["uiInk"] = {
    rationale:
      "The focused ink layer compares brand, navigation, headline, and description tokens after hiding only the runtime photograph. Its pixel diff and per-region ink-coverage floors keep interface ink over photography regression-tested.",
    regions: uiInkRegions,
    coverage,
    threshold: uiInkThreshold,
    changedPixels: uiInkChangedPixels,
    comparedPixels: uiInkComparedPixels,
    mismatchRatio: uiInkChangedPixels / uiInkComparedPixels,
    maxMismatchRatio: budgets.uiInkMaxMismatchRatio,
  };
  const comparison: ComparisonResult = {
    reference: referenceName,
    mask,
    image,
    uiInk,
    mismatchRatio: uiInk.mismatchRatio,
    maxMismatchRatio: uiInk.maxMismatchRatio,
    exceedsBudget:
      image.mismatchRatio > image.maxMismatchRatio ||
      uiInk.mismatchRatio > uiInk.maxMismatchRatio ||
      uiInk.coverage.some((region) => !region.passes),
  };

  await Promise.all([
    writeFile(files.normalizedReference, PNG.sync.write(reference)),
    writeFile(files.overlay, PNG.sync.write(createOverlay(reference, capture))),
    writeFile(files.diff, PNG.sync.write(diff)),
    writeFile(files.uiInkReference, PNG.sync.write(referenceInk)),
    writeFile(
      files.uiInkOverlay,
      PNG.sync.write(createOverlay(referenceInk, captureInk)),
    ),
    writeFile(files.uiInkDiff, PNG.sync.write(uiInkDiff)),
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
