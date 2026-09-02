import {
  CANONICAL_LINUX_RENDERER,
  DARWIN_ARM64_RENDERER,
  type VisualRenderer,
} from "./visual-gate";

export type VisualRouteState = {
  route: string;
  state: string;
};

export type Viewport = {
  width: number;
  height: number;
};

export type CaptureMetadata = {
  viewport: Viewport;
  dpr: number;
  route: string;
  state: string;
  fixture: string;
  screenshot: string;
};

const fixtures = [
  {
    id: "home-default",
    route: "/",
    state: "ready",
  },
  {
    id: "home-mutation",
    route: "/",
    state: "ui-ink-mutation",
  },
] as const;

const uiInkCoverageBaselines = {
  [DARWIN_ARM64_RENDERER]: {
    desktop: [416],
    mobile: [1040, 17232, 2287],
  },
  [CANONICAL_LINUX_RENDERER]: {
    desktop: [165],
    mobile: [865, 15673, 1578],
  },
} as const satisfies Record<
  VisualRenderer,
  Record<"desktop" | "mobile", readonly number[]>
>;

function routeFilePart(route: string) {
  return route === "/"
    ? "root"
    : route.replace(/^\/+|\/+$/g, "").replaceAll("/", "-");
}

export function selectFixture({ route, state }: VisualRouteState) {
  const fixture = fixtures.find(
    (candidate) => candidate.route === route && candidate.state === state,
  );

  if (!fixture) {
    throw new Error(`No visual fixture is registered for ${route} (${state}).`);
  }

  return fixture.id;
}

export function createCaptureMetadata({
  viewport,
  dpr,
  route,
  state,
  fixture,
}: Omit<CaptureMetadata, "screenshot">): CaptureMetadata {
  if (!Number.isFinite(dpr) || dpr <= 0) {
    throw new Error("Screenshot DPR must be a positive finite number.");
  }

  const screenshot = `${fixture}--${viewport.width}x${viewport.height}--dpr-${dpr}--${routeFilePart(route)}--${state}.png`;

  return { viewport, dpr, route, state, fixture, screenshot };
}

export function getUiInkCoverageBaselines({
  viewport,
  renderer,
}: {
  viewport: Viewport;
  renderer: VisualRenderer;
}) {
  return uiInkCoverageBaselines[renderer][
    viewport.width <= 700 ? "mobile" : "desktop"
  ];
}

export function assessUiInkCoverage({
  baselineCaptureInkPixels,
  capturedInkPixels,
}: {
  baselineCaptureInkPixels: readonly number[];
  capturedInkPixels: readonly number[];
}) {
  if (baselineCaptureInkPixels.length !== capturedInkPixels.length) {
    throw new Error("UI ink coverage inputs must have matching regions.");
  }

  return capturedInkPixels.map((capturedInkPixelsForRegion, index) => {
    const baselineInkPixels = baselineCaptureInkPixels[index];
    const minCaptureInkPixels = Math.floor(baselineInkPixels * 0.9);

    return {
      baselineCaptureInkPixels: baselineInkPixels,
      minCaptureInkPixels,
      capturedInkPixels: capturedInkPixelsForRegion,
      passes: capturedInkPixelsForRegion >= minCaptureInkPixels,
    };
  });
}

export function createOverlayPlan({
  reference,
  capture,
  metadata,
}: {
  reference: string;
  capture: string;
  metadata: CaptureMetadata;
}) {
  return {
    reference,
    capture,
    opacity: 0.5,
    metadata,
  } as const;
}

export function blendOverlayPixels({
  reference,
  capture,
  opacity,
}: {
  reference: Uint8ClampedArray;
  capture: Uint8ClampedArray;
  opacity: number;
}) {
  if (
    reference.length !== capture.length ||
    reference.length % 4 !== 0 ||
    !Number.isFinite(opacity) ||
    opacity < 0 ||
    opacity > 1
  ) {
    throw new Error(
      "Overlay inputs must be equal RGBA buffers and an opacity from 0 to 1.",
    );
  }

  const overlay = new Uint8ClampedArray(reference.length);

  for (let offset = 0; offset < reference.length; offset += 1) {
    overlay[offset] = Math.round(
      reference[offset] * (1 - opacity) + capture[offset] * opacity,
    );
  }

  return overlay;
}

export function comparePixels({
  reference,
  capture,
}: {
  reference: Uint8ClampedArray;
  capture: Uint8ClampedArray;
}) {
  if (reference.length !== capture.length || reference.length % 4 !== 0) {
    throw new Error("Pixel buffers must have equal RGBA lengths.");
  }

  const diff = new Uint8ClampedArray(reference.length);
  let changedPixels = 0;

  for (let offset = 0; offset < reference.length; offset += 4) {
    const hasChanged =
      reference[offset] !== capture[offset] ||
      reference[offset + 1] !== capture[offset + 1] ||
      reference[offset + 2] !== capture[offset + 2] ||
      reference[offset + 3] !== capture[offset + 3];

    if (hasChanged) {
      changedPixels += 1;
      diff.set([255, 0, 0, 255], offset);
    }
  }

  return {
    changedPixels,
    totalPixels: reference.length / 4,
    diff,
  } as const;
}
