import { createReferenceCaptureMetadata } from "./reference-capture";

describe("the mobile reference capture metadata", () => {
  it("records deterministic 390 by 844 home capture inputs", () => {
    expect(
      createReferenceCaptureMetadata({
        fontLoadState: "loaded",
        timestamp: "2026-08-30T12:00:00.000Z",
      }),
    ).toEqual({
      route: "/",
      fixture: "home-default",
      state: "ready",
      viewport: { width: 390, height: 844 },
      dpr: 2,
      fontLoadState: "loaded",
      timestamp: "2026-08-30T12:00:00.000Z",
    });
  });
});
