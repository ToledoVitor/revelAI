import type {
  AttemptOutcome,
  LeaderboardResponse,
  VerifiedResult,
} from "@revelai/contracts";
import {
  ArrowsLeftRight,
  ArrowLeft,
  ArrowRight,
  Camera,
  CheckCircle,
  Circle,
  Footprints,
  Timer,
  Warning,
} from "@phosphor-icons/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import {
  createRevelApiClient,
  type RevelApiAbort,
  type RevelApiError,
} from "../lib/api/client";
import { ProductionCapture } from "./production-capture";
import { ProductionSetupCamera } from "./production-setup-camera";
import {
  setupGates,
  type SetupCameraStatus,
  type SetupGate,
} from "./setup-model";
import {
  isVerifiedOutcomeForAttempt,
  resolveUploadReconciliation,
} from "./upload-reconciliation";
import { usePendingAttemptPolling } from "../lib/attempt-flow/pending-polling";
import { useAttemptUploadLifecycle } from "../lib/attempt-flow/upload-lifecycle";

type RevelApiClient = ReturnType<typeof createRevelApiClient>;

const requiredGateIds: ["device", "space", "athlete", "rehearsal", "record"] = [
  "device",
  "space",
  "athlete",
  "rehearsal",
  "record",
];

const safeGenericError = "Não foi possível continuar agora. Tente novamente.";
const leaderboardInput = {
  version: 1 as const,
  ruleVersion: "wall-pass-v1-score-1" as const,
  limit: 20,
};

type TracerStage =
  | "challenge"
  | "setup"
  | "creating-session"
  | "readying-session"
  | "capture"
  | "uploading"
  | "pending"
  | "terminal";

function isAbort(error: unknown): error is RevelApiAbort {
  return (
    typeof error === "object" &&
    error !== null &&
    "kind" in error &&
    (error as { kind?: unknown }).kind === "aborted"
  );
}

function safeError(error: unknown): string {
  if (isRouteError(error)) return error.message;
  return safeGenericError;
}

function isRouteError(error: unknown): error is RevelApiError {
  return (
    typeof error === "object" &&
    error !== null &&
    typeof (error as RevelApiError).code === "string" &&
    typeof (error as RevelApiError).message === "string" &&
    typeof (error as RevelApiError).retryable === "boolean" &&
    typeof (error as RevelApiError).status === "number"
  );
}

function hasRouteErrorCode(
  error: unknown,
  code: RevelApiError["code"],
): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

function focusHeading(ref: React.RefObject<HTMLHeadingElement | null>) {
  ref.current?.focus({ preventScroll: true });
}

type VerifiedTracerProps = Readonly<{ client: RevelApiClient }>;

export function VerifiedTracer({ client }: VerifiedTracerProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const generationRef = useRef(0);
  const createStartedRef = useRef(false);
  const uploadGenerationRef = useRef(0);
  const pollingStopRef = useRef<() => void>(() => undefined);
  const [stage, setStage] = useState<TracerStage>("challenge");
  const [gateIndex, setGateIndex] = useState(0);
  const [passedGates, setPassedGates] = useState<ReadonlySet<SetupGate["id"]>>(
    () => new Set(),
  );
  const [cameraStatus, setCameraStatus] =
    useState<SetupCameraStatus>("pending");
  const [calibrationId, setCalibrationId] = useState<string>();
  const [attemptId, setAttemptId] = useState<string>();
  const [media, setMedia] = useState<File>();
  const [outcome, setOutcome] = useState<AttemptOutcome>();
  const [terminal, setTerminal] = useState<AttemptOutcome>();
  const [message, setMessage] = useState("");
  const [attemptState, setAttemptState] = useState<
    "creating" | "ready" | "error"
  >("creating");
  const [createTick, setCreateTick] = useState(0);
  const [uploadProgress, setUploadProgress] = useState<
    Readonly<{ loaded: number; total?: number }> | undefined
  >();

  const rankingView =
    new URLSearchParams(location.search).get("view") === "ranking";

  const resetToSetup = useCallback(() => {
    generationRef.current += 1;
    createStartedRef.current = false;
    uploadGenerationRef.current += 1;
    pollingStopRef.current();
    setGateIndex(0);
    setPassedGates(new Set());
    setCameraStatus("pending");
    setCalibrationId(undefined);
    setAttemptId(undefined);
    setMedia(undefined);
    setOutcome(undefined);
    setTerminal(undefined);
    setMessage("");
    setAttemptState("creating");
    setCreateTick(0);
    setUploadProgress(undefined);
    setStage("challenge");
  }, []);

  const stopPolling = useCallback(() => {
    pollingStopRef.current();
  }, []);

  const completeOutcome = useCallback(
    (nextOutcome: AttemptOutcome, ownedAttemptId: string) => {
      stopPolling();
      if (
        resolveUploadReconciliation(nextOutcome, ownedAttemptId).kind ===
        "mismatch"
      ) {
        setMessage("Este resultado não está disponível neste fluxo.");
        setTerminal(undefined);
        setStage("terminal");
        return;
      }
      setTerminal(nextOutcome);
      setStage("terminal");
    },
    [stopPolling],
  );

  const applyUploadOutcome = useCallback(
    (nextOutcome: AttemptOutcome, ownedAttemptId: string) => {
      const transition = resolveUploadReconciliation(
        nextOutcome,
        ownedAttemptId,
      );
      if (transition.kind === "mismatch") {
        setMessage("Este resultado não está disponível neste fluxo.");
        setStage("capture");
        return;
      }
      setOutcome(transition.outcome);
      if (!transition.preserveMedia) {
        setMedia(undefined);
        setUploadProgress(undefined);
      }
      if (transition.kind === "capture") {
        setStage("capture");
        return;
      }
      if (transition.kind === "pending") {
        setStage("pending");
        return;
      }
      completeOutcome(transition.outcome, ownedAttemptId);
    },
    [completeOutcome],
  );

  const uploadLifecycle = useAttemptUploadLifecycle({
    enabled: stage === "uploading",
    attemptId,
    media,
    expectedMode: "verified",
    generation: generationRef.current,
    uploadGeneration: uploadGenerationRef.current,
    client,
    isGenerationCurrent: (generation, uploadGeneration) =>
      generation === generationRef.current &&
      uploadGeneration === uploadGenerationRef.current,
    isAbort,
    isRouteError,
    hasRouteErrorCode,
    errorMessage: safeError,
    onProgress: setUploadProgress,
    onOutcome: applyUploadOutcome,
    onMismatch: () => {
      setMessage("Este envio não pertence a esta tentativa verificada.");
      setStage("capture");
    },
    onError: (nextMessage) => {
      setMessage(nextMessage);
      setStage("capture");
    },
  });

  useEffect(() => {
    focusHeading(headingRef);
  }, [gateIndex, stage, terminal, rankingView]);

  useEffect(() => {
    if (stage !== "creating-session") return;
    const generation = generationRef.current;
    const controller = new AbortController();
    void client
      .createCalibrationSession(
        { challengeId: "wall-pass", challengeVersion: 1 },
        { signal: controller.signal },
      )
      .then((session) => {
        if (generation !== generationRef.current) return;
        setCalibrationId(session.id);
        setStage("readying-session");
      })
      .catch((error: unknown) => {
        if (generation !== generationRef.current || isAbort(error)) return;
        setMessage(safeError(error));
        setStage("setup");
      });
    return () => controller.abort();
  }, [client, stage]);

  useEffect(() => {
    if (stage !== "readying-session" || !calibrationId) return;
    const generation = generationRef.current;
    const controller = new AbortController();
    void client
      .readyCalibrationSession(
        calibrationId,
        {
          requiredGates: requiredGateIds,
        },
        { signal: controller.signal },
      )
      .then(() => {
        if (generation !== generationRef.current) return;
        setStage("capture");
      })
      .catch((error: unknown) => {
        if (generation !== generationRef.current || isAbort(error)) return;
        setMessage(safeError(error));
        setStage("setup");
      });
    return () => controller.abort();
  }, [calibrationId, client, stage]);

  useEffect(() => {
    if (stage !== "capture" || !calibrationId || createStartedRef.current)
      return;
    createStartedRef.current = true;
    setAttemptState("creating");
    const generation = generationRef.current;
    const controller = new AbortController();
    void client
      .createAttempt(
        {
          mode: "verified",
          challengeId: "wall-pass",
          challengeVersion: 1,
          calibrationSessionId: calibrationId,
        },
        { signal: controller.signal },
      )
      .then((attempt) => {
        if (generation !== generationRef.current) return;
        setAttemptId(attempt.id);
        setAttemptState("ready");
      })
      .catch((error: unknown) => {
        if (generation !== generationRef.current || isAbort(error)) return;
        createStartedRef.current = false;
        setAttemptState("error");
        setMessage(safeError(error));
      });
    return () => controller.abort();
  }, [calibrationId, client, createTick, stage]);

  const pendingPolling = usePendingAttemptPolling({
    enabled: stage === "pending" && outcome?.state === "pending",
    attemptId,
    generation: generationRef.current,
    request: async (ownedAttemptId, options) => {
      const nextOutcome = await client.getAttemptOutcome(
        ownedAttemptId,
        options,
      );
      return !isVerifiedOutcomeForAttempt(nextOutcome, ownedAttemptId) ||
        nextOutcome.state !== "pending"
        ? { kind: "terminal" as const, value: nextOutcome }
        : { kind: "pending" as const, value: nextOutcome };
    },
    onDecision: (decision) => {
      if (!attemptId) return;
      if (decision.kind === "terminal") {
        completeOutcome(decision.value, attemptId);
        return;
      }
      setMessage("");
      setOutcome(decision.value);
    },
    onError: (error) => setMessage(safeError(error)),
    isAbort,
  });
  pollingStopRef.current = pendingPolling.stop;

  useEffect(() => () => stopPolling(), [stopPolling]);

  if (rankingView) {
    return <LiveLeaderboard client={client} headingRef={headingRef} />;
  }

  if (stage === "challenge") {
    return (
      <ChallengeChoice
        headingRef={headingRef}
        onBack={() => navigate("/")}
        onPrepare={() => {
          setMessage("");
          setStage("setup");
        }}
      />
    );
  }

  if (
    stage === "setup" ||
    stage === "creating-session" ||
    stage === "readying-session"
  ) {
    const activeGate = setupGates[gateIndex];
    const currentGatePassed =
      activeGate?.id === "device"
        ? cameraStatus === "ready" || cameraStatus === "existing-video"
        : activeGate
          ? passedGates.has(activeGate.id)
          : false;
    const currentGateStatus =
      activeGate?.id === "device"
        ? ""
        : currentGatePassed
          ? activeGate?.ready
          : activeGate?.correction;
    const displayedPassedGates = new Set(passedGates);
    if (cameraStatus === "ready" || cameraStatus === "existing-video") {
      displayedPassedGates.add("device");
    }
    return (
      <main
        className="calibration-setup verified-editorial-page"
        aria-labelledby="verified-setup-heading"
      >
        <SetupProgress
          activeIndex={gateIndex}
          passedGates={displayedPassedGates}
          landmark="setup-progress"
        />
        <p className="eyebrow">Passe contra parede</p>
        <h1
          id="verified-setup-heading"
          data-visual-landmark="setup-heading"
          ref={headingRef}
          tabIndex={-1}
          aria-label="Preparação do desafio verificado"
        >
          {activeGate?.id === "space"
            ? "Calibre o espaço."
            : activeGate?.id === "athlete"
              ? "Enquadre o atleta."
              : activeGate?.id === "rehearsal"
                ? "Confirme o ensaio."
                : activeGate?.id === "record"
                  ? "Prepare a gravação."
                  : "Prepare o dispositivo."}
        </h1>
        <p className="sr-only">
          Etapa {gateIndex + 1} de {setupGates.length} — {activeGate?.title}
        </p>
        <p className="setup-challenge-name">Passe contra parede</p>
        {activeGate?.id === "device" ? (
          <ProductionSetupCamera
            disabled={stage !== "setup"}
            status={cameraStatus}
            onStatus={setCameraStatus}
          />
        ) : (
          <CalibrationGuidance
            activeGate={activeGate}
            currentGatePassed={currentGatePassed}
            currentGateStatus={currentGateStatus}
            passedGates={displayedPassedGates}
          />
        )}
        {message ? <p role="alert">{message}</p> : null}
        <div className="setup-actions">
          {activeGate && activeGate.id !== "device" ? (
            <button
              type="button"
              data-visual-landmark="setup-confirm"
              disabled={stage !== "setup"}
              onClick={() =>
                setPassedGates(
                  (current) => new Set([...current, activeGate.id]),
                )
              }
            >
              Confirmar etapa
            </button>
          ) : null}
          <button
            className="setup-continue"
            type="button"
            data-visual-landmark="setup-continue"
            disabled={stage !== "setup" || !currentGatePassed}
            onClick={() => {
              if (gateIndex === setupGates.length - 1) {
                setMessage("");
                setStage("creating-session");
                return;
              }
              setGateIndex((current) => current + 1);
            }}
          >
            Continuar <ArrowRight aria-hidden="true" weight="light" />
          </button>
          <button
            className="setup-back"
            type="button"
            data-visual-landmark="setup-back"
            disabled={stage !== "setup"}
            onClick={() => {
              if (gateIndex === 0) {
                setStage("challenge");
                return;
              }
              setGateIndex((current) => current - 1);
            }}
          >
            <ArrowLeft aria-hidden="true" weight="light" />
            {gateIndex === 0 ? "Voltar à escolha" : "Voltar"}
          </button>
          <button
            className="setup-cancel"
            type="button"
            data-visual-landmark="setup-cancel"
            disabled={stage !== "setup"}
            onClick={() => navigate("/")}
          >
            Cancelar preparação
          </button>
        </div>
      </main>
    );
  }

  if (stage === "capture" || stage === "uploading") {
    const uploading = stage === "uploading";
    return (
      <main
        className="verified-capture verified-editorial-page"
        aria-label="Envie o vídeo verificado"
      >
        <SetupProgress
          activeIndex={4}
          passedGates={new Set(requiredGateIds)}
          landmark="capture-progress"
        />
        <h1
          id="verified-capture-heading"
          data-visual-landmark="capture-heading"
          ref={headingRef}
          tabIndex={-1}
          aria-label="Envie o vídeo verificado"
        >
          Tudo certo. Agora, jogue.
        </h1>
        <p className="capture-intro">
          Pré-rolagem de 4 s e intervalo ativo de 60 s. O servidor confirma a
          elegibilidade.
        </p>
        {!attemptId ? (
          <p role="status">
            {attemptState === "error"
              ? "Não foi possível preparar a tentativa. Tente novamente."
              : "Preparando uma tentativa para este envio."}
          </p>
        ) : null}
        <ProductionCapture
          disabled={uploading || !attemptId}
          media={media}
          onMedia={setMedia}
        />
        {uploading ? (
          <>
            <progress
              aria-label="Envio do vídeo verificado"
              {...(uploadProgress && uploadProgress.total !== undefined
                ? {
                    value: uploadProgress.loaded,
                    max: uploadProgress.total,
                  }
                : {})}
            />
            <p role="status">
              {uploadProgress
                ? `Enviando ${uploadProgress.loaded} de ${uploadProgress.total ?? "tamanho não informado"} bytes.`
                : "Enviando vídeo ao servidor."}
            </p>
          </>
        ) : null}
        {message ? <p role="alert">{message}</p> : null}
        {attemptState === "error" ? (
          <button
            type="button"
            onClick={() => {
              createStartedRef.current = false;
              setAttemptState("creating");
              setMessage("");
              setCreateTick((current) => current + 1);
            }}
          >
            Tentar preparar tentativa
          </button>
        ) : null}
        <button
          className="capture-submit"
          type="button"
          data-visual-landmark="capture-submit"
          disabled={!attemptId || !media || uploading}
          onClick={() => {
            uploadGenerationRef.current += 1;
            setMessage("");
            setUploadProgress(undefined);
            setStage("uploading");
          }}
        >
          Enviar vídeo
        </button>
        {uploading ? (
          <button
            type="button"
            onClick={() => {
              const uploadGeneration = ++uploadGenerationRef.current;
              uploadLifecycle.abort();
              setUploadProgress(undefined);
              setStage("capture");
              setMessage(
                "Envio cancelado. O vídeo continua pronto para tentar novamente.",
              );
              if (attemptId)
                void uploadLifecycle.reconcile({
                  attemptId,
                  generation: generationRef.current,
                  uploadGeneration,
                  fallbackMessage:
                    "Envio cancelado. O vídeo continua pronto para tentar novamente.",
                });
            }}
          >
            Cancelar envio
          </button>
        ) : null}
      </main>
    );
  }

  if (stage === "pending") {
    return (
      <main
        className="verified-pending verified-editorial-page"
        aria-labelledby="processing-heading"
      >
        <p className="eyebrow">Desafio verificado</p>
        <h1
          id="processing-heading"
          data-visual-landmark="processing-heading"
          ref={headingRef}
          tabIndex={-1}
          aria-label="Processando tentativa"
        >
          Vídeo recebido. Análise em curso.
        </h1>
        <span className="heading-rule" aria-hidden="true" />
        <p role="status">
          O processamento continua no servidor. Atualize esta tela quando
          voltar; não prometemos uma notificação com o navegador fechado.
        </p>
        <ol
          className="processing-timeline"
          aria-label="Andamento da análise"
          data-visual-landmark="processing-timeline"
        >
          <li className="is-complete">
            <CheckCircle aria-hidden="true" weight="fill" />
            <span>01</span>
            <strong>Vídeo recebido</strong>
          </li>
          <li className="is-current" aria-current="step">
            <Circle
              aria-hidden="true"
              className="timeline-current-dot"
              weight="fill"
            />
            <span>02</span>
            <strong>Analisando desempenho</strong>
          </li>
          <li>
            <Circle
              aria-hidden="true"
              className="timeline-pending-dot"
              weight="light"
            />
            <span>03</span>
            <strong>Relatório disponível</strong>
          </li>
        </ol>
        {message ? <p role="alert">{message}</p> : null}
        <div className="pending-actions">
          <button
            className="pending-refresh"
            type="button"
            data-visual-landmark="pending-refresh"
            disabled={pendingPolling.refreshing}
            aria-busy={pendingPolling.refreshing}
            onClick={() => void pendingPolling.refresh()}
          >
            Atualizar agora
          </button>
          <button
            type="button"
            data-visual-landmark="pending-reset"
            onClick={() => resetToSetup()}
          >
            Iniciar outro desafio
          </button>
        </div>
        {pendingPolling.refreshing ? (
          <p role="status">Atualizando tentativa.</p>
        ) : null}
      </main>
    );
  }

  return (
    <TerminalReport
      headingRef={headingRef}
      message={message}
      outcome={terminal}
      onRetry={resetToSetup}
    />
  );
}

function ChallengeChoice({
  headingRef,
  onBack,
  onPrepare,
}: Readonly<{
  headingRef: React.RefObject<HTMLHeadingElement | null>;
  onBack(): void;
  onPrepare(): void;
}>) {
  return (
    <main
      className="challenge-choice verified-editorial-page"
      aria-labelledby="challenge-choice-heading"
    >
      <button className="challenge-back" type="button" onClick={onBack}>
        <ArrowLeft aria-hidden="true" weight="light" />
        <span className="sr-only">Voltar para Início</span>
      </button>
      <p className="challenge-step">
        1/5 <span>Desafios</span>
      </p>
      <div className="challenge-choice-hero">
        <div>
          <h1
            id="challenge-choice-heading"
            ref={headingRef}
            tabIndex={-1}
            data-visual-landmark="challenge-heading"
          >
            Escolha. Prepare. Compita.
          </h1>
          <span className="heading-rule" aria-hidden="true" />
          <p>
            Escolha um desafio validado e prepare-se para superar seu melhor.
          </p>
        </div>
        <img
          src="/assets/futsal-hero.png"
          alt="Jogador treinando passe contra parede em uma quadra de futsal"
        />
      </div>
      <section className="challenge-list" aria-label="Desafios disponíveis">
        <article
          className="challenge-card challenge-card--selected"
          data-visual-landmark="challenge-card"
        >
          <span className="challenge-number" aria-hidden="true">
            01
          </span>
          <div>
            <p className="challenge-kicker">Recomendado</p>
            <h2>Passe contra parede</h2>
            <p>Máximo de passes contra a parede em 60 segundos.</p>
            <ul aria-label="Requisitos do desafio passe contra parede">
              <li>
                <Timer aria-hidden="true" weight="light" /> 60 segundos
              </li>
              <li>
                <Footprints aria-hidden="true" weight="light" /> ambos os pés
              </li>
              <li>
                <ArrowsLeftRight aria-hidden="true" weight="light" /> 3 metros
              </li>
              <li>
                <Camera aria-hidden="true" weight="light" /> câmera calibrada
              </li>
            </ul>
          </div>
        </article>
        <article className="challenge-card">
          <span className="challenge-number" aria-hidden="true">
            02
          </span>
          <div>
            <h2>Controle bilateral</h2>
            <p>Toques alternados com ambos os pés por 30 segundos.</p>
          </div>
          <button
            type="button"
            disabled
            aria-describedby="challenge-upcoming-explanation"
          >
            Em breve
          </button>
        </article>
        <article className="challenge-card">
          <span className="challenge-number" aria-hidden="true">
            03
          </span>
          <div>
            <h2>Condução em slalom</h2>
            <p>Conduza entre os cones no menor tempo possível.</p>
          </div>
          <button
            type="button"
            disabled
            aria-describedby="challenge-upcoming-explanation"
          >
            Em breve
          </button>
        </article>
      </section>
      <p id="challenge-upcoming-explanation" className="sr-only">
        Este desafio estará disponível em breve.
      </p>
      <button
        className="challenge-prepare"
        type="button"
        data-visual-landmark="challenge-prepare"
        onClick={onPrepare}
      >
        Preparar desafio <ArrowRight aria-hidden="true" weight="light" />
      </button>
    </main>
  );
}

function SetupProgress({
  activeIndex,
  passedGates,
  landmark,
}: Readonly<{
  activeIndex: number;
  passedGates: ReadonlySet<SetupGate["id"]>;
  landmark?: string;
}>) {
  return (
    <ol
      className="verified-progress"
      aria-label={`Etapa ${activeIndex + 1} de ${setupGates.length}`}
      data-visual-landmark={landmark}
    >
      {setupGates.map((gate, index) => {
        const passed = passedGates.has(gate.id);
        const active = index === activeIndex;
        return (
          <li key={gate.id} data-active={active} data-passed={passed}>
            {passed ? (
              <CheckCircle aria-hidden="true" weight="fill" />
            ) : (
              <span>{index + 1}</span>
            )}
            <small>{gate.title}</small>
          </li>
        );
      })}
    </ol>
  );
}

function CalibrationGuidance({
  activeGate,
  currentGatePassed,
  currentGateStatus,
  passedGates,
}: Readonly<{
  activeGate: SetupGate;
  currentGatePassed: boolean;
  currentGateStatus: string;
  passedGates: ReadonlySet<SetupGate["id"]>;
}>) {
  return (
    <section
      className="calibration-guidance"
      aria-label="Orientação da calibração"
    >
      <figure className="calibration-visual">
        <img
          src="/assets/futsal-hero.png"
          alt="Referência visual de atleta diante de uma parede de futsal"
        />
        <figcaption>Área de registro para passe contra parede</figcaption>
      </figure>
      <p role="status" className="calibration-status">
        {currentGateStatus}
      </p>
      <ul
        className="calibration-checklist"
        aria-label="Correções da calibração"
      >
        {setupGates.slice(0, 4).map((gate) => {
          const passed =
            passedGates.has(gate.id) ||
            (gate.id === activeGate.id && currentGatePassed);
          return (
            <li
              key={gate.id}
              data-passed={passed}
              data-active={gate.id === activeGate.id}
            >
              {passed ? (
                <CheckCircle aria-hidden="true" weight="fill" />
              ) : (
                <Warning aria-hidden="true" weight="light" />
              )}
              <span>
                <strong>{gate.title}</strong>
                <small>{passed ? gate.ready : gate.correction}</small>
              </span>
            </li>
          );
        })}
      </ul>
      <p className="calibration-truth" data-visual-landmark="calibration-truth">
        <Warning aria-hidden="true" weight="light" /> A ativação só será
        liberada após a calibração confirmada pelo fluxo.
      </p>
    </section>
  );
}

function TerminalReport({
  headingRef,
  message,
  outcome,
  onRetry,
}: Readonly<{
  headingRef: React.RefObject<HTMLHeadingElement | null>;
  message: string;
  outcome?: AttemptOutcome;
  onRetry(): void;
}>) {
  if (!outcome) {
    return (
      <main aria-labelledby="verified-unavailable-heading">
        <h1 id="verified-unavailable-heading" ref={headingRef} tabIndex={-1}>
          Resultado indisponível
        </h1>
        <p role="alert">{message || safeGenericError}</p>
        <button type="button" onClick={onRetry}>
          Iniciar outro desafio
        </button>
      </main>
    );
  }

  if (outcome.state === "valid" && outcome.result.kind === "verified-result") {
    return (
      <VerifiedReport
        headingRef={headingRef}
        result={outcome.result}
        onRetry={onRetry}
      />
    );
  }

  if (outcome.state === "invalid") {
    return (
      <main aria-labelledby="invalid-heading">
        <h1 id="invalid-heading" ref={headingRef} tabIndex={-1}>
          Tentativa inválida
        </h1>
        <p role="alert">{outcome.message}</p>
        <button type="button" onClick={onRetry}>
          Tentar novo desafio
        </button>
      </main>
    );
  }

  if (outcome.state === "failed") {
    return (
      <main aria-labelledby="failed-heading">
        <h1 id="failed-heading" ref={headingRef} tabIndex={-1}>
          Não foi possível concluir a análise
        </h1>
        <p role="alert">{outcome.message}</p>
        {outcome.retryable ? (
          <button type="button" onClick={onRetry}>
            Tentar novo desafio
          </button>
        ) : null}
        <Link to="/">Voltar para Início</Link>
      </main>
    );
  }

  return (
    <TerminalReport
      headingRef={headingRef}
      message={safeGenericError}
      onRetry={onRetry}
    />
  );
}

function VerifiedReport({
  headingRef,
  result,
  onRetry,
}: Readonly<{
  headingRef: React.RefObject<HTMLHeadingElement | null>;
  result: VerifiedResult;
  onRetry(): void;
}>) {
  const truth =
    result.competitiveStatus === "ranked"
      ? "Resultado validado — vale para ranking"
      : result.competitiveStatus === "demo"
        ? "Demo — não vale para ranking"
        : "Experimental — não vale para ranking";
  const isRanked = result.competitiveStatus === "ranked";
  return (
    <main
      className="verified-report"
      aria-label="Resultado do desafio verificado"
    >
      <p className="report-truth" data-visual-landmark="report-truth">
        {truth}
      </p>
      <h1
        id="verified-report-heading"
        data-visual-landmark="report-heading"
        ref={headingRef}
        tabIndex={-1}
        aria-label="Resultado do desafio verificado"
      >
        {isRanked ? "Resultado validado." : "Resultado do desafio verificado"}
      </h1>
      <p className="report-challenge">Passe contra parede · 60 s</p>
      <p className="sr-only">Score: {result.score}</p>
      <section
        className="report-scorecard"
        aria-label="Resumo da validação"
        data-visual-landmark="report-scorecard"
      >
        <div>
          <span>Score</span>
          <strong>{result.score}</strong>
          <small>/ 100</small>
        </div>
        {isRanked ? (
          <div>
            <span>Posição no ranking</span>
            <strong>Top {result.rankingSnapshot.topPercent}%</strong>
          </div>
        ) : null}
      </section>
      <dl className="report-metrics" data-visual-landmark="report-metrics">
        <dt>Passes válidos</dt>
        <dd>{result.metrics.validPasses} passes</dd>
        <dt>Precisão</dt>
        <dd>{result.metrics.accuracyPercent}%</dd>
        <dt>Cadência média</dt>
        <dd>{result.metrics.meanCadenceSeconds} s</dd>
        <dt>Pé esquerdo</dt>
        <dd>{result.metrics.leftFootPercent}%</dd>
        <dt>Pé direito</dt>
        <dd>{result.metrics.rightFootPercent}%</dd>
      </dl>
      {isRanked ? (
        <section className="report-insight">
          <h2>Insight principal</h2>
          <p>Continue alternando os dois pés para sustentar o ritmo.</p>
        </section>
      ) : null}
      <details className="report-details">
        <summary>Detalhes da validação</summary>
        <p>Regra: {result.ruleVersion}</p>
        <p>Concluído em: {result.completedAt}</p>
        <p>Proveniência: {result.provenance.kind}.</p>
        {result.provenance.kind === "demo" ? (
          <dl aria-label="Proveniência demo">
            <dt>Fixture</dt>
            <dd>{result.provenance.fixtureId}</dd>
            <dt>Versão do provider</dt>
            <dd>{result.provenance.providerVersion}</dd>
          </dl>
        ) : (
          <dl aria-label="Proveniência Roboflow">
            <dt>Workspace</dt>
            <dd>{result.provenance.workspaceId}</dd>
            <dt>Workflow</dt>
            <dd>{result.provenance.workflowId}</dd>
            <dt>Versão do workflow</dt>
            <dd>{result.provenance.workflowVersion}</dd>
            <dt>Bundle do modelo</dt>
            <dd>{result.provenance.modelBundleId}</dd>
            <dt>Versão do provider</dt>
            <dd>{result.provenance.providerVersion}</dd>
          </dl>
        )}
        {isRanked ? (
          <section aria-label="Snapshot de ranking congelado">
            <h2>Ranking no resultado</h2>
            <p>Snapshot: {result.rankingSnapshot.kind}</p>
            <p>
              Desafio do snapshot: {result.rankingSnapshot.challengeId} v
              {result.rankingSnapshot.challengeVersion}
            </p>
            <p>Regra do snapshot: {result.rankingSnapshot.ruleVersion}</p>
            <p>Posição: {result.rankingSnapshot.rank}</p>
            <p>Coorte: {result.rankingSnapshot.cohortSize}</p>
            <p>
              Percentil: {result.rankingSnapshot.percentile}% — percentual da
              coorte com pontuação igual ou menor.
            </p>
            <p>
              Top percent: {result.rankingSnapshot.topPercent}% — distância até
              o topo, não um sinônimo de percentil.
            </p>
            <p>
              Pontuações no cálculo:{" "}
              {result.rankingSnapshot.scoreCountAtFinalization}
            </p>
            <p>Calculado em: {result.rankingSnapshot.calculatedAt}</p>
            <p>Tentativa do snapshot: {result.rankingSnapshot.asOfAttemptId}</p>
          </section>
        ) : null}
      </details>
      <div className="report-actions">
        <Link to="/verified?view=ranking">Ver Ranking atual</Link>
        <button type="button" onClick={onRetry}>
          Novo desafio
        </button>
      </div>
    </main>
  );
}

function LiveLeaderboard({
  client,
  headingRef,
}: Readonly<{
  client: RevelApiClient;
  headingRef: React.RefObject<HTMLHeadingElement | null>;
}>) {
  const [response, setResponse] = useState<LeaderboardResponse>();
  const [error, setError] = useState("");
  const [cursor, setCursor] = useState<string>();
  const [loading, setLoading] = useState(false);
  const mountedRef = useRef(true);
  const generationRef = useRef(0);
  const activeRequestRef = useRef<AbortController | undefined>(undefined);
  const load = useCallback(
    async (requestedCursor?: string) => {
      if (activeRequestRef.current) return;
      const generation = generationRef.current;
      const controller = new AbortController();
      activeRequestRef.current = controller;
      setLoading(true);
      try {
        setError("");
        const next = await client.getLeaderboard(
          {
            ...leaderboardInput,
            ...(requestedCursor ? { cursor: requestedCursor } : {}),
          },
          { signal: controller.signal },
        );
        if (
          !mountedRef.current ||
          generation !== generationRef.current ||
          activeRequestRef.current !== controller
        )
          return;
        setResponse((current) =>
          requestedCursor && current
            ? { ...next, entries: [...current.entries, ...next.entries] }
            : next,
        );
        setCursor(next.nextCursor ?? undefined);
      } catch (loadError) {
        if (
          controller.signal.aborted ||
          !mountedRef.current ||
          generation !== generationRef.current ||
          activeRequestRef.current !== controller
        )
          return;
        setError(safeError(loadError));
      } finally {
        if (activeRequestRef.current === controller) {
          activeRequestRef.current = undefined;
          if (mountedRef.current && generation === generationRef.current)
            setLoading(false);
        }
      }
    },
    [client],
  );
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
      activeRequestRef.current?.abort();
      activeRequestRef.current = undefined;
    };
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <main aria-labelledby="live-leaderboard-heading">
      <p className="eyebrow">Desafio verificado</p>
      <h1 id="live-leaderboard-heading" ref={headingRef} tabIndex={-1}>
        Ranking atual
      </h1>
      {error ? <p role="alert">{error}</p> : null}
      {!response && !error ? (
        <p role="status">Carregando ranking atual.</p>
      ) : null}
      {response ? (
        <>
          <p>
            Desafio: {response.challengeId} v{response.challengeVersion}
          </p>
          <p>Regra: {response.ruleVersion}</p>
          <p>Calculado em: {response.calculatedAt}</p>
          <p>Coorte: {response.cohortSize}</p>
          {response.entries.length === 0 ? (
            <p role="status">Ainda não há resultados no ranking atual.</p>
          ) : (
            <ol>
              {response.entries.map((entry) => (
                <li
                  key={entry.entryId}
                  aria-label={`Entrada ${entry.entryId}: posição ${entry.rank}, score ${entry.score}`}
                >
                  <span className="sr-only">Entrada {entry.entryId}. </span>
                  Posição {entry.rank} — score {entry.score} —{" "}
                  {entry.completedAt}
                </li>
              ))}
            </ol>
          )}
          {cursor ? (
            <button
              type="button"
              disabled={loading}
              onClick={() => void load(cursor)}
            >
              Carregar mais
            </button>
          ) : null}
        </>
      ) : null}
      <button type="button" disabled={loading} onClick={() => void load()}>
        Atualizar ranking
      </button>
      <Link to="/verified">Voltar ao desafio</Link>
    </main>
  );
}
