import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../app";
import { createReviewSetupPort } from "./setup";

function setupFixture(cameraStatus: "denied" | "unsupported" | "unavailable") {
  return {
    challenge: {
      id: "wall-pass-v1" as const,
      name: "Passe na parede — futsal",
    },
    cameraStatus,
  };
}

describe("review calibration setup", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/_test/verified/setup");
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("presents wall-pass setup guidance with a blocked first gate and no API call", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    render(<App />);

    expect(
      await screen.findByRole("heading", {
        name: "Preparação para passe na parede",
        level: 1,
      }),
    ).toBeVisible();
    expect(screen.getByText("wall-pass-v1")).toBeVisible();
    expect(screen.getByText("Etapa 1 de 5 — Dispositivo")).toBeVisible();
    expect(
      screen.getByRole("region", { name: "Prévia da câmera" }),
    ).toHaveAccessibleDescription("Aguardando simulação da câmera.");
    expect(screen.getByRole("button", { name: "Continuar" })).toBeDisabled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("enables the device gate only after a clearly labelled simulation", async () => {
    const user = userEvent.setup();

    render(<App />);

    await screen.findByRole("heading", {
      name: "Preparação para passe na parede",
      level: 1,
    });
    await user.click(
      screen.getByRole("button", { name: "Simular câmera pronta" }),
    );

    expect(
      screen.getByText("Prévia simulada da câmera pronta."),
    ).toHaveAttribute("role", "status");
    expect(screen.getByRole("button", { name: "Continuar" })).toBeEnabled();
  });

  it("enforces the device-to-record sequence before completing preparation guidance", async () => {
    const user = userEvent.setup();

    render(<App />);
    await screen.findByRole("heading", {
      name: "Preparação para passe na parede",
      level: 1,
    });

    await user.click(
      screen.getByRole("button", { name: "Simular câmera pronta" }),
    );
    await user.click(screen.getByRole("button", { name: "Continuar" }));

    for (const [index, gate, correction] of [
      [
        2,
        "Espaço",
        "Posicione dois marcadores visíveis a três metros da parede.",
      ],
      [
        3,
        "Atleta",
        "Mantenha o corpo inteiro visível entre os marcadores durante o passe.",
      ],
      [4, "Ensaio", "Ensaie passes na parede alternando os dois pés."],
      [
        5,
        "Registro",
        "Confira a preparação antes de seguir para a captura completa quando ela estiver disponível.",
      ],
    ] as const) {
      expect(screen.getByText(`Etapa ${index} de 5 — ${gate}`)).toBeVisible();
      expect(
        screen.getByRole("heading", { name: gate, level: 2 }),
      ).toBeVisible();
      expect(screen.getByText(correction)).toHaveAttribute("role", "status");
      expect(screen.getByRole("button", { name: "Continuar" })).toBeDisabled();

      await user.click(
        screen.getByRole("button", { name: "Simular etapa pronta" }),
      );
      await user.click(screen.getByRole("button", { name: "Continuar" }));
    }

    expect(
      screen.getByRole("heading", { name: "Preparação concluída", level: 1 }),
    ).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent(
      "A preparação orienta a captura. A captura completa e o resultado ainda não estão ativos.",
    );
  });

  it.each([
    [
      "denied" as const,
      "O acesso à câmera foi negado. Permita o acesso nas configurações do navegador ou use um vídeo existente.",
    ],
    [
      "unsupported" as const,
      "Este navegador não oferece suporte à prévia da câmera. Use um navegador compatível ou um vídeo existente.",
    ],
    [
      "unavailable" as const,
      "Nenhuma câmera está disponível. Conecte uma câmera ou use um vídeo existente.",
    ],
  ])(
    "offers an announced existing-video fallback when the camera is %s",
    async (cameraStatus, message) => {
      const user = userEvent.setup();

      render(
        <App
          reviewSetupPort={createReviewSetupPort(setupFixture(cameraStatus))}
        />,
      );

      expect(await screen.findByText(message)).toHaveAttribute(
        "role",
        "status",
      );
      await user.click(
        screen.getByRole("button", { name: "Usar vídeo existente" }),
      );

      expect(
        screen.getByText(
          "Vídeo existente escolhido como alternativa de captura. As próximas orientações continuam necessárias.",
        ),
      ).toHaveAttribute("role", "status");
      expect(screen.getByRole("button", { name: "Continuar" })).toBeEnabled();
    },
  );

  it("retries a camera remediation through the injected fake port", async () => {
    const user = userEvent.setup();
    const retryCamera = vi.fn(() => "ready" as const);
    const port = {
      getFixture: () => setupFixture("denied"),
      retryCamera,
    };

    render(<App reviewSetupPort={port} />);

    await screen.findByText("O acesso à câmera foi negado.", { exact: false });
    await user.click(
      screen.getByRole("button", { name: "Tentar acesso à câmera" }),
    );

    expect(retryCamera).toHaveBeenCalledOnce();
    expect(screen.getByText("Prévia simulada da câmera pronta.")).toBeVisible();
  });

  it("returns to the previous gate and cancels deterministically to home", async () => {
    const user = userEvent.setup();

    render(<App />);
    await screen.findByRole("heading", {
      name: "Preparação para passe na parede",
      level: 1,
    });
    await user.click(
      screen.getByRole("button", { name: "Simular câmera pronta" }),
    );
    await user.click(screen.getByRole("button", { name: "Continuar" }));
    expect(screen.getByText("Etapa 2 de 5 — Espaço")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Voltar" }));
    expect(screen.getByText("Etapa 1 de 5 — Dispositivo")).toBeVisible();
    expect(screen.getByRole("button", { name: "Continuar" })).toBeEnabled();

    await user.click(
      screen.getByRole("button", { name: "Cancelar preparação" }),
    );
    expect(
      screen.getByRole("heading", { name: "Treine. Grave. Evolua.", level: 1 }),
    ).toBeVisible();
    expect(window.location.pathname).toBe("/");
  });
});
