import { ArrowRight } from "@phosphor-icons/react";

type HomeProps = {
  onFreeTraining(): void;
  onUnavailable(destination: string): void;
  onVerified(): void;
};

type TrainingChoice = {
  id: string;
  number: string;
  title: string;
  kicker?: string;
  detail: string;
  destination: string;
};

const choices: readonly TrainingChoice[] = [
  {
    id: "free-training",
    number: "01",
    title: "Treino livre",
    detail:
      "Insights aproximados sobre seu desempenho para você evoluir no seu ritmo.",
    destination: "treino-livre",
  },
  {
    id: "verified-challenge",
    number: "02",
    title: "Desafio verificado",
    kicker: "Competitivo · calibrado",
    detail:
      "Análise calibrada em condições padrão para ranking competitivo confiável.",
    destination: "desafio-verificado",
  },
];

export function Home({ onFreeTraining, onUnavailable, onVerified }: HomeProps) {
  return (
    <main className="home-page">
      <img
        className="hero-image"
        src="/assets/futsal-hero.png"
        alt="Jogador de futsal treinando em quadra interna"
      />
      <section className="hero-copy" aria-labelledby="home-heading">
        <h1 id="home-heading">Treine. Grave. Evolua.</h1>
        <span className="heading-rule" aria-hidden="true" />
        <p className="hero-description">
          Análises de visão computacional para jogadores de futsal que querem
          mais.
        </p>
      </section>
      <section className="training-choices" aria-labelledby="choices-heading">
        <h2 id="choices-heading">Escolha como você vai começar</h2>
        <div className="choice-list">
          {choices.map((choice) => (
            <button
              className="training-choice"
              key={choice.destination}
              type="button"
              aria-labelledby={`${choice.id}-title`}
              aria-describedby={
                choice.kicker
                  ? `${choice.id}-kicker ${choice.id}-description`
                  : `${choice.id}-description`
              }
              onClick={() =>
                choice.id === "verified-challenge"
                  ? onVerified()
                  : onFreeTraining()
              }
            >
              <span className="choice-number" aria-hidden="true">
                {choice.number}
              </span>
              <span className="choice-content">
                <span className="choice-title" id={`${choice.id}-title`}>
                  {choice.title}
                </span>
                {choice.kicker ? (
                  <span className="choice-kicker" id={`${choice.id}-kicker`}>
                    {choice.kicker}
                  </span>
                ) : null}
                <span className="choice-detail" id={`${choice.id}-description`}>
                  {choice.detail}
                </span>
              </span>
              <ArrowRight
                className="choice-icon"
                aria-hidden="true"
                weight="light"
              />
            </button>
          ))}
        </div>
        <button
          className="analyse-button"
          type="button"
          onClick={() => onUnavailable("analisar-treino")}
        >
          Analisar treino
          <ArrowRight aria-hidden="true" weight="light" />
        </button>
      </section>
    </main>
  );
}
