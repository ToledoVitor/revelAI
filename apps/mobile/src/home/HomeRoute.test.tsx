import { fireEvent, render, screen } from "@testing-library/react-native";
import { router } from "expo-router";
import { HomeRoute } from "./HomeRoute";

jest.mock("expo-router", () => ({
  router: {
    push: jest.fn(),
  },
}));

describe("HomeRoute", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("routes every inactive home entry to the truthful unavailable shell without an API call", () => {
    const fetchSpy = jest.fn();
    global.fetch = fetchSpy;

    render(<HomeRoute />);

    expect(screen.getByRole("header", { name: "RevelAI" })).toBeTruthy();
    expect(
      screen.getByRole("header", { name: "Treine. Grave. Evolua." }),
    ).toBeTruthy();

    for (const control of [
      "Treino livre — análise aproximada",
      "Desafio verificado",
      "Analisar treino",
    ]) {
      fireEvent.press(screen.getByRole("button", { name: control }));
    }

    fireEvent.press(screen.getByRole("button", { name: "Abrir navegação" }));
    fireEvent.press(screen.getByRole("button", { name: "Meus treinos" }));
    fireEvent.press(screen.getByRole("button", { name: "Ranking" }));

    expect(router.push).toHaveBeenNthCalledWith(
      1,
      "/indisponivel/treino-livre",
    );
    expect(router.push).toHaveBeenNthCalledWith(
      2,
      "/indisponivel/desafio-verificado",
    );
    expect(router.push).toHaveBeenNthCalledWith(
      3,
      "/indisponivel/analisar-treino",
    );
    expect(router.push).toHaveBeenNthCalledWith(
      4,
      "/indisponivel/meus-treinos",
    );
    expect(router.push).toHaveBeenNthCalledWith(5, "/indisponivel/ranking");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("keeps a future sport disabled with an accessible Em breve explanation", () => {
    render(<HomeRoute />);

    fireEvent.press(screen.getByRole("button", { name: "Abrir navegação" }));

    expect(screen.getByRole("button", { name: "Novos esportes" })).toHaveProp(
      "accessibilityState",
      { disabled: true },
    );
    expect(screen.getByText("Em breve")).toBeTruthy();
  });

  it("keeps the required free-training truth label visible", () => {
    render(<HomeRoute />);

    expect(
      screen.getByText("Treino livre — análise aproximada", { exact: true }),
    ).toBeTruthy();
  });
});
