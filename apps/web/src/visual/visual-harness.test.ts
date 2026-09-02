import { describe, expect, it } from "vitest";
import {
  assessUiInkCoverage,
  blendOverlayPixels,
  comparePixels,
  createCaptureMetadata,
  createOverlayPlan,
  getUiInkCoverageBaselines,
  selectFixture,
} from "./visual-harness";

describe("visual harness", () => {
  it("selects the approved home fixture and names desktop screenshots deterministically", () => {
    const fixture = selectFixture({ route: "/", state: "ready" });
    const metadata = createCaptureMetadata({
      viewport: { width: 1440, height: 1024 },
      dpr: 1,
      route: "/",
      state: "ready",
      fixture,
    });

    expect(metadata).toEqual({
      viewport: { width: 1440, height: 1024 },
      dpr: 1,
      route: "/",
      state: "ready",
      fixture: "home-default",
      screenshot: "home-default--1440x1024--dpr-1--root--ready.png",
    });
  });

  it("records mobile metadata and produces a portable overlay and pixel diff", () => {
    const fixture = selectFixture({ route: "/", state: "ready" });
    const metadata = createCaptureMetadata({
      viewport: { width: 390, height: 844 },
      dpr: 2,
      route: "/",
      state: "ready",
      fixture,
    });
    const overlay = createOverlayPlan({
      reference: "mobile-home.png",
      capture: metadata.screenshot,
      metadata,
    });
    const diff = comparePixels({
      reference: new Uint8ClampedArray([0, 0, 0, 255, 255, 255, 255, 255]),
      capture: new Uint8ClampedArray([0, 0, 0, 255, 254, 255, 255, 255]),
    });
    const overlayPixels = blendOverlayPixels({
      reference: new Uint8ClampedArray([0, 0, 0, 255]),
      capture: new Uint8ClampedArray([200, 100, 50, 255]),
      opacity: 0.5,
    });

    expect(metadata.screenshot).toBe(
      "home-default--390x844--dpr-2--root--ready.png",
    );
    expect(overlay.opacity).toBe(0.5);
    expect(overlay.metadata).toEqual(metadata);
    expect(diff.changedPixels).toBe(1);
    expect(diff.totalPixels).toBe(2);
    expect(overlayPixels).toEqual(new Uint8ClampedArray([100, 50, 25, 255]));
  });

  it("keeps an independent Linux ink floor so a missing normal control fails", () => {
    const desktopBaseline = getUiInkCoverageBaselines({
      viewport: { width: 1440, height: 1024 },
      renderer: "linux",
    });
    const mobileBaseline = getUiInkCoverageBaselines({
      viewport: { width: 390, height: 844 },
      renderer: "linux",
    });

    expect(desktopBaseline).toEqual([165]);
    expect(mobileBaseline).toEqual([865, 15673, 1578]);
    expect(
      assessUiInkCoverage({
        baselineCaptureInkPixels: desktopBaseline,
        capturedInkPixels: [0],
      }),
    ).toEqual([
      {
        baselineCaptureInkPixels: 165,
        minCaptureInkPixels: 148,
        capturedInkPixels: 0,
        passes: false,
      },
    ]);
  });
});
