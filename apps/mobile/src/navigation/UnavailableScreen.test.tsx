import { render, screen } from "@testing-library/react-native";
import { UnavailableScreen } from "./UnavailableScreen";

describe("UnavailableScreen", () => {
  it("explains that an inactive flow is unavailable without implying pending work", () => {
    render(<UnavailableScreen destination="ranking" />);

    expect(screen.getByRole("header", { name: "Indisponível" })).toBeTruthy();
    expect(
      screen.getByRole("alert", {
        name: "Disponível após ativação do fluxo",
      }),
    ).toBeTruthy();
    expect(
      screen.getByText("Ranking será disponibilizado em breve."),
    ).toBeTruthy();
  });
});
