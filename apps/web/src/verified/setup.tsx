import { ArrowLeft, VideoCamera } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

type CameraStatus =
  | "pending"
  | "ready"
  | "denied"
  | "unsupported"
  | "unavailable"
  | "existing-video";

export type ReviewSetupFixture = Readonly<{
  challenges: readonly Readonly<{
    id: "wall-pass-v1";
    name: string;
  }>[];
  cameraStatus: CameraStatus;
}>;

export type ReviewSetupPort = Readonly<{
  getFixture(): ReviewSetupFixture;
  retryCamera(): CameraStatus;
}>;

type Gate = Readonly<{
  id: "device" | "space" | "athlete" | "rehearsal" | "record";
  title: string;
  correction: string;
  ready: string;
}>;

const captureTimingGuidance =
  "A captura completa inclui uma pré-rolagem de calibração de 4 segundos e um intervalo ativo de exatamente 60 segundos.";

const gates: readonly Gate[] = [
  {
    id: "device",
    title: "Dispositivo",
    correction: "Simule a disponibilidade da câmera antes de continuar.",
    ready: "Prévia simulada da câmera pronta.",
  },
  {
    id: "space",
    title: "Espaço",
    correction: "Posicione dois marcadores visíveis a três metros da parede.",
    ready: "Os marcadores estão confirmados na prévia. Você pode continuar.",
  },
  {
    id: "athlete",
    title: "Atleta",
    correction:
      "Mantenha o corpo inteiro visível entre os marcadores durante o passe.",
    ready:
      "O enquadramento do atleta está confirmado na prévia. Você pode continuar.",
  },
  {
    id: "rehearsal",
    title: "Ensaio",
    correction: "Ensaie passes na parede alternando os dois pés.",
    ready: "O ensaio está confirmado na prévia. Você pode continuar.",
  },
  {
    id: "record",
    title: "Registro",
    correction:
      "Confira a preparação antes de seguir para a captura completa quando ela estiver disponível.",
    ready:
      "A preparação para o registro está confirmada na prévia. Você pode continuar.",
  },
];

declare global {
  interface Window {
    __revelaiReviewSetupModuleEvaluations?: number;
  }
}

if (typeof window !== "undefined") {
  window.__revelaiReviewSetupModuleEvaluations =
    (window.__revelaiReviewSetupModuleEvaluations ?? 0) + 1;
}

function reviewFixture(): ReviewSetupFixture {
  return Object.freeze({
    challenges: Object.freeze([
      Object.freeze({
        id: "wall-pass-v1",
        name: "Passe na parede — futsal",
      }),
    ]),
    cameraStatus: "pending",
  });
}

function cameraMessage(status: CameraStatus): string {
  if (status === "ready") return "Prévia simulada da câmera pronta.";
  if (status === "denied") {
    return "O acesso à câmera foi negado. Permita o acesso nas configurações do navegador ou use um vídeo existente.";
  }
  if (status === "unsupported") {
    return "Este navegador não oferece suporte à prévia da câmera. Use um navegador compatível ou um vídeo existente.";
  }
  if (status === "unavailable") {
    return "Nenhuma câmera está disponível. Conecte uma câmera ou use um vídeo existente.";
  }
  if (status === "existing-video") {
    return "Vídeo existente escolhido como alternativa de captura. Ele mantém a pré-rolagem de calibração de 4 segundos e o intervalo ativo de exatamente 60 segundos; as próximas orientações continuam necessárias.";
  }
  return "Aguardando simulação da câmera.";
}

export function createReviewSetupPort(
  fixture: ReviewSetupFixture = reviewFixture(),
): ReviewSetupPort {
  return Object.freeze({
    getFixture: () => fixture,
    retryCamera: () => fixture.cameraStatus,
  });
}

type ReviewSetupRouteProps = Readonly<{ port?: ReviewSetupPort }>;

export function ReviewSetupRoute({ port }: ReviewSetupRouteProps) {
  const navigate = useNavigate();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [defaultPort] = useState(() => createReviewSetupPort());
  const [fixture] = useState(() => (port ?? defaultPort).getFixture());
  const [selectedChallengeId, setSelectedChallengeId] = useState<string>();
  const [hasStartedSetup, setHasStartedSetup] = useState(false);
  const [cameraStatus, setCameraStatus] = useState(fixture.cameraStatus);
  const [activeGateIndex, setActiveGateIndex] = useState(0);
  const [passedGates, setPassedGates] = useState<ReadonlySet<Gate["id"]>>(
    () => new Set(),
  );
  const [complete, setComplete] = useState(false);
  const activeGate = gates[activeGateIndex];
  const selectedChallenge = fixture.challenges.find(
    (challenge) => challenge.id === selectedChallengeId,
  );
  const deviceReady =
    cameraStatus === "ready" || cameraStatus === "existing-video";
  const currentGatePassed =
    activeGate.id === "device" ? deviceReady : passedGates.has(activeGate.id);
  const currentGateStatus =
    activeGate.id === "device"
      ? currentGatePassed
        ? cameraMessage(cameraStatus)
        : cameraStatus === "pending"
          ? activeGate.correction
          : cameraMessage(cameraStatus)
      : currentGatePassed
        ? activeGate.ready
        : activeGate.correction;

  useEffect(() => {
    headingRef.current?.focus();
  }, [activeGateIndex, complete, hasStartedSetup]);

  const markCurrentGateReady = () => {
    if (activeGate.id === "device") {
      setCameraStatus("ready");
      return;
    }
    setPassedGates((current) => new Set([...current, activeGate.id]));
  };

  const continueSetup = () => {
    if (!currentGatePassed) return;
    if (activeGateIndex === gates.length - 1) {
      setComplete(true);
      return;
    }
    setActiveGateIndex((current) => current + 1);
  };

  const goBack = () => {
    if (activeGateIndex === 0) {
      navigate("/");
      return;
    }
    setActiveGateIndex((current) => current - 1);
  };

  if (!hasStartedSetup || !selectedChallenge) {
    return (
      <main className="calibration-setup" aria-labelledby="challenge-heading">
        <p className="eyebrow">Orientação de preparação</p>
        <h1 id="challenge-heading" ref={headingRef} tabIndex={-1}>
          Escolha o desafio para a orientação
        </h1>
        <section
          aria-label="Desafios disponíveis para orientação"
          className="challenge-selection"
        >
          {fixture.challenges.map((challenge) => (
            <button
              aria-pressed={selectedChallengeId === challenge.id}
              className="setup-action"
              key={challenge.id}
              type="button"
              onClick={() => setSelectedChallengeId(challenge.id)}
            >
              Selecionar {challenge.name}
            </button>
          ))}
        </section>
        <button
          className="setup-action setup-action--primary"
          type="button"
          disabled={!selectedChallengeId}
          onClick={() => setHasStartedSetup(true)}
        >
          Continuar para orientação
        </button>
      </main>
    );
  }

  if (complete) {
    return (
      <main className="calibration-setup" aria-labelledby="setup-heading">
        <p className="eyebrow">Orientação de preparação</p>
        <h1 id="setup-heading" ref={headingRef} tabIndex={-1}>
          Preparação concluída
        </h1>
        <p role="status">
          A preparação orienta a captura. A captura completa e o resultado ainda
          não estão ativos.
        </p>
        <button
          className="setup-action setup-action--primary"
          type="button"
          onClick={() => navigate("/")}
        >
          Voltar para Início
        </button>
      </main>
    );
  }

  return (
    <main className="calibration-setup" aria-labelledby="setup-heading">
      <p className="eyebrow">Orientação de preparação</p>
      <h1 id="setup-heading" ref={headingRef} tabIndex={-1}>
        Preparação para passe na parede
      </h1>
      <p className="setup-challenge-id">{selectedChallenge.id}</p>
      <p>{selectedChallenge.name}</p>
      <p>{captureTimingGuidance}</p>
      <p>
        Etapa {activeGateIndex + 1} de {gates.length} — {activeGate.title}
      </p>
      <h2>{activeGate.title}</h2>
      <section
        aria-describedby="camera-preview-status"
        aria-label="Prévia da câmera"
        className="camera-preview"
      >
        <VideoCamera aria-hidden="true" weight="light" />
        <p id="camera-preview-status" role="status">
          {currentGateStatus}
        </p>
      </section>
      <fieldset>
        <legend>Simulação desta etapa</legend>
        <button type="button" onClick={markCurrentGateReady}>
          {activeGate.id === "device"
            ? "Simular câmera pronta"
            : "Simular etapa pronta"}
        </button>
        {activeGate.id === "device" && !deviceReady ? (
          <button
            type="button"
            onClick={() =>
              setCameraStatus(port?.retryCamera() ?? defaultPort.retryCamera())
            }
          >
            Tentar acesso à câmera
          </button>
        ) : null}
        {activeGate.id === "device" &&
        (cameraStatus === "denied" ||
          cameraStatus === "unsupported" ||
          cameraStatus === "unavailable") ? (
          <button
            type="button"
            onClick={() => setCameraStatus("existing-video")}
          >
            Usar vídeo existente
          </button>
        ) : null}
      </fieldset>
      <div className="setup-actions">
        <button type="button" onClick={goBack}>
          <ArrowLeft aria-hidden="true" weight="bold" />
          {activeGateIndex === 0 ? "Voltar para Início" : "Voltar"}
        </button>
        <button type="button" onClick={() => navigate("/")}>
          Cancelar preparação
        </button>
        <button
          type="button"
          disabled={!currentGatePassed}
          onClick={continueSetup}
        >
          Continuar
        </button>
      </div>
    </main>
  );
}
