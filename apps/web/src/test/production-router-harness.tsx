import { createRoot } from "react-dom/client";
import { App } from "../app";
import type { ReviewCapturePort } from "../verified/capture";
import type { ReviewSetupPort } from "../verified/setup";

type ProductionHarness = Readonly<{
  mountProductionApp(
    element: Element,
    reviewSetupPort?: ReviewSetupPort,
    reviewCapturePort?: ReviewCapturePort,
  ): () => void;
}>;

function mountProductionApp(
  element: Element,
  reviewSetupPort?: ReviewSetupPort,
  reviewCapturePort?: ReviewCapturePort,
) {
  const root = createRoot(element);
  root.render(
    <App
      reviewSetupPort={reviewSetupPort}
      reviewCapturePort={reviewCapturePort}
    />,
  );

  return () => root.unmount();
}

declare global {
  interface Window {
    __revelaiProductionRouterHarness?: ProductionHarness;
  }
}

window.__revelaiProductionRouterHarness = Object.freeze({
  mountProductionApp,
});
