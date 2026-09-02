import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./app";

function fakeReviewPort() {
  return {
    getFixture: vi.fn(() => ({
      challenge: {
        id: "wall-pass-v1" as const,
        name: "Passe na parede — futsal",
      },
      cameraStatus: "pending" as const,
    })),
    retryCamera: vi.fn(() => "pending" as const),
  };
}

describe("production router review-route isolation", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it.each(["/_test/verified/setup", "/_test/verified/capture"])(
    "uses the normal unavailable boundary for direct production navigation to %s",
    async (path) => {
      const port = fakeReviewPort();
      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);
      window.history.replaceState({}, "", path);

      render(<App reviewModeEnabled={false} reviewSetupPort={port} />);

      expect(
        await screen.findByRole("heading", { name: "Indisponível", level: 1 }),
      ).toBeVisible();
      expect(port.getFixture).not.toHaveBeenCalled();
      expect(port.retryCamera).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    },
  );

  it.each(["/_test/verified/setup", "/_test/verified/capture"])(
    "uses the normal unavailable boundary for in-app production navigation to %s",
    async (path) => {
      const port = fakeReviewPort();
      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);
      window.history.replaceState({}, "", "/");

      render(<App reviewModeEnabled={false} reviewSetupPort={port} />);
      window.history.pushState({}, "", path);
      window.dispatchEvent(new PopStateEvent("popstate"));

      expect(
        await screen.findByRole("heading", { name: "Indisponível", level: 1 }),
      ).toBeVisible();
      expect(port.getFixture).not.toHaveBeenCalled();
      expect(port.retryCamera).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    },
  );
});
