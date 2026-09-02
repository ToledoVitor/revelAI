import { describe, expect, it } from "vitest";
import {
  assessUiInkCoverage,
  blendOverlayPixels,
  comparePixels,
  createCaptureMetadata,
  createOverlayPlan,
  assertReferenceVisualMismatch,
  assertReferenceVisualLandmarkGeometry,
  getReferenceVisualGate,
  getVisualReference,
  getUiInkCoverageBaselines,
  selectFixture,
  assertReferenceVisualLandmarks,
} from "./visual-harness";
import { CANONICAL_LINUX_RENDERER } from "./visual-gate";

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

  it("registers every approved mobile acceptance state with its own reference", () => {
    const states = [
      ["/", "ready", "home-default", "mobile-home.png"],
      [
        "/verified",
        "challenge-choice",
        "verified-challenge-default",
        "mobile-challenge.png",
      ],
      [
        "/verified",
        "calibration-guidance",
        "verified-calibration-default",
        "mobile-calibration.png",
      ],
      [
        "/verified",
        "recording-capture",
        "verified-record-default",
        "mobile-record.png",
      ],
      [
        "/verified",
        "processing-pending",
        "verified-processing-demo",
        "mobile-processing.png",
      ],
      [
        "/verified",
        "ranked-report",
        "verified-ranked-policy-approved",
        "mobile-report.png",
      ],
    ] as const;

    for (const [route, state, fixture, reference] of states) {
      expect(selectFixture({ route, state })).toBe(fixture);
      expect(
        getVisualReference({
          route,
          state,
          viewport: { width: 390, height: 844 },
        }),
      ).toBe(reference);
    }
  });

  it("keeps independently approved non-home pixel limits and rejects missing or cropped landmarks", () => {
    const gate = getReferenceVisualGate({
      route: "/verified",
      state: "calibration-guidance",
      viewport: { width: 390, height: 844 },
    });

    expect(gate.maxMismatchRatio).toBeLessThan(1);
    expect(gate.requiredLandmarks).toContain("setup-confirm");
    expect(() =>
      assertReferenceVisualMismatch({
        state: "calibration-guidance",
        mismatchRatio: gate.maxMismatchRatio + 0.001,
        gate,
      }),
    ).toThrow("exceeded");
    expect(() =>
      assertReferenceVisualLandmarks({
        viewport: { width: 390, height: 844 },
        requiredLandmarks: gate.requiredLandmarks,
        landmarks: gate.requiredLandmarks
          .filter((id) => id !== "setup-confirm")
          .map((id) => ({
            id,
            left: 12,
            top: 12,
            right: 378,
            bottom: 48,
          })),
      }),
    ).toThrow("setup-confirm");
    expect(() =>
      assertReferenceVisualLandmarks({
        viewport: { width: 390, height: 844 },
        requiredLandmarks: gate.requiredLandmarks,
        landmarks: gate.requiredLandmarks.map((id) => ({
          id,
          left: 12,
          top: 12,
          right: 378,
          bottom: id === "setup-cancel" ? 845 : 48,
        })),
      }),
    ).toThrow("setup-cancel");
  });

  it("rejects W6 landmark position and size drift from reference geometry", () => {
    const gate = getReferenceVisualGate({
      route: "/verified",
      state: "challenge-choice",
      viewport: { width: 390, height: 844 },
    });

    expect(gate.referenceGeometry).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "challenge-heading" }),
        expect.objectContaining({ id: "challenge-card" }),
        expect.objectContaining({ id: "challenge-prepare" }),
      ]),
    );
    expect(() =>
      assertReferenceVisualLandmarkGeometry({
        geometry: gate.referenceGeometry,
        landmarks: gate.referenceGeometry.map((reference) => ({
          id: reference.id,
          left: reference.left.min,
          top: reference.top.min,
          right: reference.right.min,
          bottom: reference.bottom.min,
        })),
      }),
    ).not.toThrow();
    expect(() =>
      assertReferenceVisualLandmarkGeometry({
        geometry: gate.referenceGeometry,
        landmarks: gate.referenceGeometry.map((reference) => ({
          id: reference.id,
          left: reference.left.min,
          top:
            reference.id === "challenge-heading"
              ? reference.top.max + 1
              : reference.top.min,
          right: reference.right.min,
          bottom: reference.bottom.min,
        })),
      }),
    ).toThrow("reference geometry");
    expect(() =>
      assertReferenceVisualLandmarkGeometry({
        geometry: gate.referenceGeometry,
        landmarks: gate.referenceGeometry.map((reference) => ({
          id: reference.id,
          left: reference.left.min,
          top: reference.top.min,
          right:
            reference.id === "challenge-card"
              ? reference.right.min - 1
              : reference.right.min,
          bottom: reference.bottom.min,
        })),
      }),
    ).toThrow("reference geometry");
  });

  it("keeps an independent Linux ink floor so a missing normal control fails", () => {
    const canonicalDesktop = {
      viewport: { width: 1440, height: 1024 },
      renderer: CANONICAL_LINUX_RENDERER as never,
    };
    const canonicalMobile = {
      viewport: { width: 390, height: 844 },
      renderer: CANONICAL_LINUX_RENDERER as never,
    };
    expect(() => getUiInkCoverageBaselines(canonicalDesktop)).not.toThrow();
    const desktopBaseline = getUiInkCoverageBaselines({
      ...canonicalDesktop,
    });
    const mobileBaseline = getUiInkCoverageBaselines({
      ...canonicalMobile,
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
