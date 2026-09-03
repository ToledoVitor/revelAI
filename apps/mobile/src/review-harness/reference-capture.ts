export type FontLoadState = "loaded" | "fallback";

export type ReferenceCaptureMetadata = Readonly<{
  route: "/";
  fixture: "home-default";
  state: "ready";
  viewport: Readonly<{ width: 390; height: 844 }>;
  dpr: 2;
  fontLoadState: FontLoadState;
  timestamp: string;
}>;

export function createReferenceCaptureMetadata(
  input: Readonly<{
    fontLoadState: FontLoadState;
    timestamp: string;
  }>,
): ReferenceCaptureMetadata {
  return {
    route: "/",
    fixture: "home-default",
    state: "ready",
    viewport: { width: 390, height: 844 },
    dpr: 2,
    fontLoadState: input.fontLoadState,
    timestamp: input.timestamp,
  };
}
