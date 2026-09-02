import { createRoot } from "react-dom/client";
import { App } from "../app";
import type { ReviewSetupPort } from "../verified/setup";

type ProductionHarness = Readonly<{
  mountProductionApp(
    element: Element,
    reviewSetupPort?: ReviewSetupPort,
  ): () => void;
}>;

function mountProductionApp(
  element: Element,
  reviewSetupPort?: ReviewSetupPort,
) {
  const root = createRoot(element);
  root.render(<App reviewSetupPort={reviewSetupPort} />);

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
