import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../app";
import { createReviewSetupPort } from "./setup";

const captureTimingGuidance =
  "A captura completa inclui uma pré-rolagem de calibração de 4 segundos e um intervalo ativo de exatamente 60 segundos.";

function setupFixture(cameraStatus: "denied" | "unsupported" | "unavailable") {
  return {
    challenges: [
      {
        id: "wall-pass-v1" as const,
        name: "Passe na parede — futsal",
      },
    ],
    cameraStatus,
  };
}

async function chooseWallPass(user: ReturnType<typeof userEvent.setup>) {
  await user.click(
    screen.getByRole("button", { name: "Selecionar Passe na parede — futsal" }),
  );
  await user.click(
    screen.getByRole("button", { name: "Continuar para orientação" }),
  );
  return screen.findByRole("heading", {
    name: "Preparação para passe na parede",
    level: 1,
  });
}

async function completeRemainingPreparation(
  user: ReturnType<typeof userEvent.setup>,
) {
  for (let index = 0; index < 5; index += 1) {
    await user.click(
      screen.getByRole("button", {
        name: index === 0 ? "Simular câmera pronta" : "Simular etapa pronta",
      }),
    );
    await user.click(screen.getByRole("button", { name: "Continuar" }));
  }
}

async function completePreparation(user: ReturnType<typeof userEvent.setup>) {
  await chooseWallPass(user);
  await completeRemainingPreparation(user);
}

describe("review calibration setup", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/_test/verified/setup");
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("requires the review-only wall-pass fixture to be selected before setup guidance", async () => {
    const user = userEvent.setup();
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    render(<App />);

    expect(
      await screen.findByRole("heading", {
        name: "Escolha o desafio para a orientação",
        level: 1,
      }),
    ).toBeVisible();
    const continueToGuidance = screen.getByRole("button", {
      name: "Continuar para orientação",
    });
    const selectWallPass = screen.getByRole("button", {
      name: "Selecionar Passe na parede — futsal",
    });
    expect(continueToGuidance).toBeDisabled();
    expect(continueToGuidance).toHaveClass(
      "setup-action",
      "setup-action--primary",
    );
    expect(selectWallPass).toBeVisible();
    expect(selectWallPass).toHaveClass("setup-action");
    await chooseWallPass(user);
    expect(screen.getByText("wall-pass-v1")).toBeVisible();
    expect(screen.getByText("Etapa 1 de 5 — Dispositivo")).toBeVisible();
    expect(
      screen.getByRole("region", { name: "Prévia da câmera" }),
    ).toHaveAccessibleDescription(
      "Simule a disponibilidade da câmera antes de continuar.",
    );
    expect(screen.getByRole("button", { name: "Continuar" })).toBeDisabled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("enables the device gate only after a clearly labelled simulation", async () => {
    const user = userEvent.setup();

    render(<App />);
    await chooseWallPass(user);
    await user.click(
      screen.getByRole("button", { name: "Simular câmera pronta" }),
    );

    expect(
      screen.getByText("Prévia simulada da câmera pronta."),
    ).toHaveAttribute("role", "status");
    expect(screen.getByRole("button", { name: "Continuar" })).toBeEnabled();
  });

  it("keeps one actionable live update for every gate before and after its simulation", async () => {
    const user = userEvent.setup();

    render(<App />);
    await chooseWallPass(user);

    expect(screen.getByText(captureTimingGuidance)).toBeVisible();

    for (const [pending, ready, simulation] of [
      [
        "Simule a disponibilidade da câmera antes de continuar.",
        "Prévia simulada da câmera pronta.",
        "Simular câmera pronta",
      ],
      [
        "Posicione dois marcadores visíveis a três metros da parede.",
        "Os marcadores estão confirmados na prévia. Você pode continuar.",
        "Simular etapa pronta",
      ],
      [
        "Mantenha o corpo inteiro visível entre os marcadores durante o passe.",
        "O enquadramento do atleta está confirmado na prévia. Você pode continuar.",
        "Simular etapa pronta",
      ],
      [
        "Ensaie passes na parede alternando os dois pés.",
        "O ensaio está confirmado na prévia. Você pode continuar.",
        "Simular etapa pronta",
      ],
      [
        "Confira a preparação antes de seguir para a captura completa quando ela estiver disponível.",
        "A preparação para o registro está confirmada na prévia. Você pode continuar.",
        "Simular etapa pronta",
      ],
    ] as const) {
      expect(screen.getAllByRole("status")).toHaveLength(1);
      expect(screen.getByRole("status")).toHaveTextContent(pending);

      await user.click(screen.getByRole("button", { name: simulation }));

      expect(screen.getAllByRole("status")).toHaveLength(1);
      expect(screen.getByRole("status")).toHaveTextContent(ready);
      expect(screen.getByRole("status")).not.toHaveTextContent(
        "aguardando simulação",
      );

      await user.click(screen.getByRole("button", { name: "Continuar" }));
    }
  });

  it("enforces the device-to-record sequence before completing preparation guidance", async () => {
    const user = userEvent.setup();

    render(<App />);
    await chooseWallPass(user);

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
      await chooseWallPass(user);

      expect(await screen.findByText(message)).toHaveAttribute(
        "role",
        "status",
      );
      await user.click(
        screen.getByRole("button", { name: "Usar vídeo existente" }),
      );

      expect(screen.getByRole("status")).toHaveTextContent(
        "Vídeo existente escolhido como alternativa de captura. Ele mantém a pré-rolagem de calibração de 4 segundos e o intervalo ativo de exatamente 60 segundos; as próximas orientações continuam necessárias.",
      );
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
    await chooseWallPass(user);

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
    await chooseWallPass(user);
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

  it("moves focus through entry, gate changes, back navigation, and completion", async () => {
    const user = userEvent.setup();

    render(<App />);
    const choiceHeading = await screen.findByRole("heading", {
      name: "Escolha o desafio para a orientação",
      level: 1,
    });
    expect(choiceHeading).toHaveFocus();

    screen
      .getByRole("button", { name: "Selecionar Passe na parede — futsal" })
      .focus();
    await user.keyboard("{Enter}");
    screen.getByRole("button", { name: "Continuar para orientação" }).focus();
    await user.keyboard("{Enter}");

    const setupHeading = await screen.findByRole("heading", {
      name: "Preparação para passe na parede",
      level: 1,
    });
    expect(setupHeading).toHaveFocus();

    screen.getByRole("button", { name: "Simular câmera pronta" }).focus();
    await user.keyboard("{Enter}");
    screen.getByRole("button", { name: "Continuar" }).focus();
    await user.keyboard("{Enter}");
    expect(setupHeading).toHaveFocus();

    screen.getByRole("button", { name: "Voltar" }).focus();
    await user.keyboard("{Enter}");
    expect(setupHeading).toHaveFocus();

    await completeRemainingPreparation(user);
    const completionHeading = await screen.findByRole("heading", {
      name: "Preparação concluída",
      level: 1,
    });
    expect(completionHeading).toHaveFocus();

    const returnHome = screen.getByRole("button", {
      name: "Voltar para Início",
    });
    expect(returnHome).toHaveClass("setup-action", "setup-action--primary");
    await user.click(returnHome);
    expect(window.location.pathname).toBe("/");
  });

  it("completes repeated review guidance without API, session, or attempt mutations", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const firstUser = userEvent.setup();
    const firstRender = render(<App />);
    await completePreparation(firstUser);
    firstRender.unmount();

    window.history.replaceState({}, "", "/_test/verified/setup");
    const secondUser = userEvent.setup();
    render(<App />);
    await completePreparation(secondUser);

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
