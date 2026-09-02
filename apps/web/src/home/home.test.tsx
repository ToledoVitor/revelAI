import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../app";

function setViewport(width: number, height: number) {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: width,
  });
  Object.defineProperty(window, "innerHeight", {
    configurable: true,
    value: height,
  });
  window.dispatchEvent(new Event("resize"));
}

describe("the web home", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/");
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("presents the approved desktop home controls at 1440 by 1024", () => {
    setViewport(1440, 1024);

    render(<App />);

    expect(
      screen.getByRole("heading", { name: "Treine. Grave. Evolua.", level: 1 }),
    ).toBeVisible();
    expect(
      screen.getByRole("img", {
        name: "Jogador de futsal treinando em quadra interna",
      }),
    ).toHaveAttribute("src", "/assets/futsal-hero.png");
    expect(
      screen.getByRole("navigation", { name: "Navegação principal" }),
    ).toBeVisible();
    expect(screen.getByRole("link", { name: "Início" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByRole("button", { name: "Treino livre" })).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Desafio verificado" }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Treino livre" }),
    ).toHaveAccessibleDescription(
      "Insights aproximados sobre seu desempenho para você evoluir no seu ritmo.",
    );
    expect(
      screen.getByRole("button", { name: "Desafio verificado" }),
    ).toHaveAccessibleDescription(
      "Competitivo · calibrado Análise calibrada em condições padrão para ranking competitivo confiável.",
    );
    expect(
      screen.getByRole("button", { name: "Analisar treino" }),
    ).toBeVisible();
  });

  it("keeps the home choices and navigation available at 390 by 844", async () => {
    setViewport(390, 844);
    const user = userEvent.setup();

    render(<App />);

    await user.click(screen.getByRole("button", { name: "Abrir navegação" }));

    expect(
      screen.getByRole("navigation", { name: "Navegação principal" }),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Meus treinos" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Ranking" })).toBeVisible();
    expect(screen.getByText("Escolha como você vai começar")).toBeVisible();
  });

  it("keeps Início on the home route when activated with the keyboard", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.tab();
    expect(screen.getByRole("link", { name: "RevelAI" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("link", { name: "Início" })).toHaveFocus();
    await user.keyboard("{Enter}");

    expect(
      screen.getByRole("heading", { name: "Treine. Grave. Evolua.", level: 1 }),
    ).toBeVisible();
    expect(window.location.pathname).toBe("/");
  });

  it.each([
    "Meus treinos",
    "Ranking",
    "Treino livre",
    "Desafio verificado",
    "Analisar treino",
  ])(
    "opens a truthful unavailable shell for %s without making an API call",
    async (control) => {
      const user = userEvent.setup();
      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);

      render(<App />);

      await user.click(screen.getByRole("button", { name: control }));

      expect(
        screen.getByRole("heading", { name: "Indisponível", level: 1 }),
      ).toBeVisible();
      expect(screen.getByRole("status")).toHaveTextContent(
        "Disponível após ativação do fluxo",
      );
      expect(fetchSpy).not.toHaveBeenCalled();
    },
  );
});
