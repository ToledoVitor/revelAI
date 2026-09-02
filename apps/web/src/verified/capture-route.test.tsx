import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../app";

describe("review verified capture route", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/_test/verified/capture");
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("renders the review-only capture guidance without a server mutation", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    render(<App />);

    expect(
      await screen.findByRole("heading", {
        name: "Captura para passe na parede",
        level: 1,
      }),
    ).toBeVisible();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
