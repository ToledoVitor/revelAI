import { ArrowLeft, VideoCamera } from "@phosphor-icons/react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";

type CameraStatus =
  | "pending"
  | "ready"
  | "denied"
  | "unsupported"
  | "unavailable"
  | "existing-video";

export type ReviewSetupFixture = Readonly<{
  challenge: Readonly<{
    id: "wall-pass-v1";
    name: string;
  }>;
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
}>;

const gates: readonly Gate[] = [
  {
    id: "device",
    title: "Dispositivo",
    correction: "Simule a disponibilidade da câmera antes de continuar.",
  },
  {
    id: "space",
    title: "Espaço",
    correction: "Posicione dois marcadores visíveis a três metros da parede.",
  },
  {
    id: "athlete",
    title: "Atleta",
    correction:
      "Mantenha o corpo inteiro visível entre os marcadores durante o passe.",
  },
  {
    id: "rehearsal",
    title: "Ensaio",
    correction: "Ensaie passes na parede alternando os dois pés.",
  },
  {
    id: "record",
    title: "Registro",
    correction:
      "Confira a preparação antes de seguir para a captura completa quando ela estiver disponível.",
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
    challenge: Object.freeze({
      id: "wall-pass-v1",
      name: "Passe na parede — futsal",
    }),
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
    return "Vídeo existente escolhido como alternativa de captura. As próximas orientações continuam necessárias.";
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
  const [defaultPort] = useState(() => createReviewSetupPort());
  const [fixture] = useState(() => (port ?? defaultPort).getFixture());
  const [cameraStatus, setCameraStatus] = useState(fixture.cameraStatus);
  const [activeGateIndex, setActiveGateIndex] = useState(0);
  const [passedGates, setPassedGates] = useState<ReadonlySet<Gate["id"]>>(
    () => new Set(),
  );
  const [complete, setComplete] = useState(false);
  const activeGate = gates[activeGateIndex];
  const deviceReady =
    cameraStatus === "ready" || cameraStatus === "existing-video";
  const currentGatePassed =
    activeGate.id === "device" ? deviceReady : passedGates.has(activeGate.id);

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

  if (complete) {
    return (
      <main className="calibration-setup" aria-labelledby="setup-heading">
        <p className="eyebrow">Orientação de preparação</p>
        <h1 id="setup-heading" tabIndex={-1}>
          Preparação concluída
        </h1>
        <p role="status">
          A preparação orienta a captura. A captura completa e o resultado ainda
          não estão ativos.
        </p>
      </main>
    );
  }

  return (
    <main className="calibration-setup" aria-labelledby="setup-heading">
      <p className="eyebrow">Orientação de preparação</p>
      <h1 id="setup-heading" tabIndex={-1}>
        Preparação para passe na parede
      </h1>
      <p className="setup-challenge-id">{fixture.challenge.id}</p>
      <p>{fixture.challenge.name}</p>
      <p>
        Etapa {activeGateIndex + 1} de {gates.length} — {activeGate.title}
      </p>
      <h2>{activeGate.title}</h2>
      <p role="status">{activeGate.correction}</p>
      <section
        aria-describedby="camera-preview-status"
        aria-label="Prévia da câmera"
        className="camera-preview"
      >
        <VideoCamera aria-hidden="true" weight="light" />
        <p id="camera-preview-status" role="status">
          {activeGate.id === "device"
            ? cameraMessage(cameraStatus)
            : `Prévia de ${activeGate.title.toLocaleLowerCase("pt-BR")} aguardando simulação.`}
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
