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

export type VisualLandmark = Readonly<{
  id: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
}>;

export type ReferenceVisualGate = Readonly<{
  maxMismatchRatio: number;
  requiredLandmarks: readonly string[];
}>;

type VisualFixture = Readonly<{
  id: string;
  route: string;
  state: string;
  reference: Readonly<Partial<Record<"desktop" | "mobile", string>>>;
}>;

const fixtures: readonly VisualFixture[] = [
  {
    id: "home-default",
    route: "/",
    state: "ready",
    reference: { desktop: "desktop-home.png", mobile: "mobile-home.png" },
  },
  {
    id: "home-mutation",
    route: "/",
    state: "ui-ink-mutation",
    reference: { desktop: "desktop-home.png", mobile: "mobile-home.png" },
  },
  {
    id: "verified-challenge-default",
    route: "/verified",
    state: "challenge-choice",
    reference: { mobile: "mobile-challenge.png" },
  },
  {
    id: "verified-calibration-default",
    route: "/verified",
    state: "calibration-guidance",
    reference: { mobile: "mobile-calibration.png" },
  },
  {
    id: "verified-record-default",
    route: "/verified",
    state: "recording-capture",
    reference: { mobile: "mobile-record.png" },
  },
  {
    id: "verified-processing-demo",
    route: "/verified",
    state: "processing-pending",
    reference: { mobile: "mobile-processing.png" },
  },
  {
    id: "verified-ranked-policy-approved",
    route: "/verified",
    state: "ranked-report",
    reference: { mobile: "mobile-report.png" },
  },
];

/**
 * These limits are an acceptance calibration for the selected W6 references,
 * not candidate-derived tolerances. They preserve complete-screen comparison
 * while allowing the documented approved asset/truth differences. Landmarks
 * separately prevent a high-level ratio from accepting missing UI.
 */
const referenceVisualGates = {
  "challenge-choice": {
    maxMismatchRatio: 0.25,
    requiredLandmarks: [
      "site-header",
      "challenge-heading",
      "challenge-card",
      "challenge-prepare",
    ],
  },
  "calibration-guidance": {
    maxMismatchRatio: 0.4,
    requiredLandmarks: [
      "site-header",
      "setup-progress",
      "setup-heading",
      "calibration-truth",
      "setup-confirm",
      "setup-continue",
      "setup-back",
      "setup-cancel",
    ],
  },
  "recording-capture": {
    maxMismatchRatio: 0.36,
    requiredLandmarks: [
      "site-header",
      "capture-progress",
      "capture-heading",
      "capture-preview",
      "capture-start",
      "capture-file-select",
    ],
  },
  "processing-pending": {
    maxMismatchRatio: 0.3,
    requiredLandmarks: [
      "site-header",
      "processing-heading",
      "processing-timeline",
      "pending-refresh",
      "pending-reset",
    ],
  },
  "ranked-report": {
    maxMismatchRatio: 0.2,
    requiredLandmarks: [
      "site-header",
      "report-heading",
      "report-truth",
      "report-scorecard",
      "report-metrics",
    ],
  },
} as const satisfies Record<string, ReferenceVisualGate>;

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

export function getVisualReference({
  route,
  state,
  viewport,
}: VisualRouteState & Readonly<{ viewport: Viewport }>) {
  const fixture = fixtures.find(
    (candidate) => candidate.route === route && candidate.state === state,
  );

  if (!fixture) {
    throw new Error(`No visual fixture is registered for ${route} (${state}).`);
  }

  const density = viewport.width <= 700 ? "mobile" : "desktop";
  const reference = fixture.reference[density];
  if (!reference) {
    throw new Error(
      `No ${density} reference is registered for ${route} (${state}).`,
    );
  }

  return reference;
}

export function getReferenceVisualGate({
  route,
  state,
  viewport,
}: VisualRouteState & Readonly<{ viewport: Viewport }>): ReferenceVisualGate {
  if (route !== "/verified" || viewport.width > 700)
    throw new Error(`No W6 visual gate is registered for ${route} (${state}).`);
  const gate = referenceVisualGates[state as keyof typeof referenceVisualGates];
  if (!gate)
    throw new Error(`No W6 visual gate is registered for ${route} (${state}).`);
  return gate;
}

export function assertReferenceVisualLandmarks({
  viewport,
  requiredLandmarks,
  landmarks,
}: Readonly<{
  viewport: Viewport;
  requiredLandmarks: readonly string[];
  landmarks: readonly VisualLandmark[];
}>): void {
  const byId = new Map(landmarks.map((landmark) => [landmark.id, landmark]));
  for (const id of requiredLandmarks) {
    const landmark = byId.get(id);
    if (!landmark) throw new Error(`Missing visual landmark: ${id}.`);
    if (
      landmark.left < 0 ||
      landmark.top < 0 ||
      landmark.right > viewport.width ||
      landmark.bottom > viewport.height ||
      landmark.right <= landmark.left ||
      landmark.bottom <= landmark.top
    )
      throw new Error(
        `Visual landmark is cropped: ${id} (${landmark.left},${landmark.top},${landmark.right},${landmark.bottom}) outside ${viewport.width}×${viewport.height}.`,
      );
  }
}

export function assertReferenceVisualMismatch({
  state,
  mismatchRatio,
  gate,
}: Readonly<{
  state: string;
  mismatchRatio: number;
  gate: ReferenceVisualGate;
}>): void {
  if (mismatchRatio > gate.maxMismatchRatio)
    throw new Error(
      `Visual mismatch exceeded ${state}: ${mismatchRatio.toFixed(6)} > ${gate.maxMismatchRatio.toFixed(6)}.`,
    );
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
