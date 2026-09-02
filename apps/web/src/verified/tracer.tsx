import type {
  AttemptOutcome,
  LeaderboardResponse,
  VerifiedResult,
} from "@revelai/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import {
  createRevelApiClient,
  type RevelApiAbort,
  type RevelApiError,
} from "../lib/api/client";
import { ProductionCapture } from "./production-capture";
import {
  captureTimingGuidance,
  setupCameraMessage,
  setupGates,
  type SetupCameraStatus,
  type SetupGate,
} from "./setup-model";

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
  if (
    typeof error === "object" &&
    error !== null &&
    typeof (error as RevelApiError).code === "string" &&
    typeof (error as RevelApiError).message === "string" &&
    typeof (error as RevelApiError).retryable === "boolean" &&
    typeof (error as RevelApiError).status === "number"
  ) {
    return (error as RevelApiError).message;
  }
  return safeGenericError;
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
  ref.current?.focus();
}

function isVerifiedOutcomeForAttempt(
  outcome: AttemptOutcome,
  attemptId: string,
): boolean {
  if (outcome.state === "pending")
    return outcome.mode === "verified" && outcome.attemptId === attemptId;
  if (outcome.state === "valid")
    return (
      outcome.result.kind === "verified-result" &&
      outcome.result.attemptId === attemptId
    );
  return outcome.mode === "verified" && outcome.attemptId === attemptId;
}

type VerifiedTracerProps = Readonly<{ client: RevelApiClient }>;

export function VerifiedTracer({ client }: VerifiedTracerProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const generationRef = useRef(0);
  const createStartedRef = useRef(false);
  const activeUploadRef = useRef<AbortController | undefined>(undefined);
  const uploadGenerationRef = useRef(0);
  const pendingRequestRef = useRef<
    | Readonly<{
        attemptId: string;
        generation: number;
        controller: AbortController;
      }>
    | undefined
  >(undefined);
  const timeoutRef = useRef<number | undefined>(undefined);
  const pollAbortRef = useRef<AbortController | undefined>(undefined);
  const [stage, setStage] = useState<TracerStage>("setup");
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
  const [backoffSeconds, setBackoffSeconds] = useState(1);
  const [pollTick, setPollTick] = useState(0);
  const [refreshing, setRefreshing] = useState(false);

  const rankingView =
    new URLSearchParams(location.search).get("view") === "ranking";

  const resetToSetup = useCallback(() => {
    generationRef.current += 1;
    createStartedRef.current = false;
    uploadGenerationRef.current += 1;
    const upload = activeUploadRef.current;
    activeUploadRef.current = undefined;
    upload?.abort();
    const pending = pendingRequestRef.current;
    pendingRequestRef.current = undefined;
    pending?.controller.abort();
    pollAbortRef.current?.abort();
    if (timeoutRef.current !== undefined)
      window.clearTimeout(timeoutRef.current);
    timeoutRef.current = undefined;
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
    setBackoffSeconds(1);
    setPollTick(0);
    setRefreshing(false);
    setStage("setup");
  }, []);

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

  useEffect(() => {
    if (stage !== "uploading" || !attemptId || !media) return;
    const generation = generationRef.current;
    const uploadGeneration = uploadGenerationRef.current;
    const controller = new AbortController();
    activeUploadRef.current = controller;
    void client
      .uploadAttemptMedia(attemptId, media, { signal: controller.signal })
      .then((accepted) => {
        if (
          generation !== generationRef.current ||
          uploadGeneration !== uploadGenerationRef.current ||
          activeUploadRef.current !== controller
        )
          return;
        if (
          accepted.attemptId !== attemptId ||
          accepted.mode !== "verified" ||
          accepted.outcome.attemptId !== attemptId ||
          accepted.outcome.mode !== "verified"
        ) {
          setMessage("Este envio não pertence a esta tentativa verificada.");
          setStage("capture");
          return;
        }
        activeUploadRef.current = undefined;
        setOutcome(accepted.outcome);
        setMedia(undefined);
        setBackoffSeconds(1);
        setStage("pending");
      })
      .catch((error: unknown) => {
        if (
          generation !== generationRef.current ||
          uploadGeneration !== uploadGenerationRef.current ||
          activeUploadRef.current !== controller
        )
          return;
        activeUploadRef.current = undefined;
        if (hasRouteErrorCode(error, "duplicate_media_upload")) {
          void client
            .getAttempt(attemptId)
            .then((attempt) => {
              if (
                generation !== generationRef.current ||
                uploadGeneration !== uploadGenerationRef.current
              )
                return;
              const nextOutcome = attempt.outcome;
              if (!isVerifiedOutcomeForAttempt(nextOutcome, attemptId)) {
                setMessage("Este resultado não está disponível neste fluxo.");
                setStage("capture");
                return;
              }
              setOutcome(nextOutcome);
              setMedia(undefined);
              setBackoffSeconds(1);
              if (nextOutcome.state === "pending") {
                setStage("pending");
                return;
              }
              setTerminal(nextOutcome);
              setStage("terminal");
            })
            .catch((reconciliationError: unknown) => {
              if (
                generation !== generationRef.current ||
                uploadGeneration !== uploadGenerationRef.current ||
                isAbort(reconciliationError)
              )
                return;
              setMessage(safeError(reconciliationError));
              setStage("capture");
            });
          return;
        }
        setMessage(safeError(error));
        setStage("capture");
      });
    return () => {
      if (activeUploadRef.current === controller) {
        activeUploadRef.current = undefined;
        controller.abort();
      }
    };
  }, [attemptId, client, media, stage]);

  const stopPolling = useCallback(() => {
    if (timeoutRef.current !== undefined)
      window.clearTimeout(timeoutRef.current);
    timeoutRef.current = undefined;
    const pending = pendingRequestRef.current;
    pendingRequestRef.current = undefined;
    pending?.controller.abort();
    pollAbortRef.current = undefined;
  }, []);

  const completeOutcome = useCallback(
    (nextOutcome: AttemptOutcome, ownedAttemptId: string) => {
      stopPolling();
      if (!isVerifiedOutcomeForAttempt(nextOutcome, ownedAttemptId)) {
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

  const reconcileUploadAttempt = useCallback(
    async (
      ownedAttemptId: string,
      generation: number,
      fallbackMessage = safeGenericError,
    ) => {
      try {
        const attempt = await client.getAttempt(ownedAttemptId);
        if (generation !== generationRef.current) return;
        const nextOutcome = attempt.outcome;
        if (!isVerifiedOutcomeForAttempt(nextOutcome, ownedAttemptId)) {
          setMessage("Este resultado não está disponível neste fluxo.");
          setStage("capture");
          return;
        }
        setOutcome(nextOutcome);
        setMedia(undefined);
        setBackoffSeconds(1);
        if (nextOutcome.state === "pending") {
          setStage("pending");
          return;
        }
        completeOutcome(nextOutcome, ownedAttemptId);
      } catch (error) {
        if (generation !== generationRef.current || isAbort(error)) return;
        setMessage(fallbackMessage);
        setStage("capture");
      }
    },
    [client, completeOutcome],
  );

  const refreshOutcome = useCallback(async () => {
    if (stage !== "pending" || !attemptId) return;
    const generation = generationRef.current;
    const activeRequest = pendingRequestRef.current;
    if (
      activeRequest &&
      activeRequest.generation === generation &&
      activeRequest.attemptId === attemptId
    )
      return;
    const controller = new AbortController();
    const request = { attemptId, generation, controller };
    pendingRequestRef.current = request;
    setRefreshing(true);
    pollAbortRef.current = controller;
    try {
      const nextOutcome = await client.getAttemptOutcome(attemptId, {
        signal: controller.signal,
      });
      if (
        controller.signal.aborted ||
        pendingRequestRef.current !== request ||
        generation !== generationRef.current
      )
        return;
      if (!isVerifiedOutcomeForAttempt(nextOutcome, attemptId)) {
        completeOutcome(nextOutcome, attemptId);
        return;
      }
      setMessage("");
      setOutcome(nextOutcome);
      if (nextOutcome.state === "pending") {
        const nextDelay = Math.min(backoffSeconds * 2, 5);
        setBackoffSeconds(nextDelay);
      } else {
        completeOutcome(nextOutcome, attemptId);
      }
    } catch (error) {
      if (!isAbort(error)) setMessage(safeError(error));
    } finally {
      if (pollAbortRef.current === controller) pollAbortRef.current = undefined;
      if (pendingRequestRef.current === request)
        pendingRequestRef.current = undefined;
      if (generation === generationRef.current) setRefreshing(false);
      if (
        !controller.signal.aborted &&
        generation === generationRef.current &&
        stage === "pending"
      ) {
        setPollTick((current) => current + 1);
      }
    }
  }, [attemptId, backoffSeconds, client, completeOutcome, stage]);

  useEffect(() => {
    if (stage !== "pending" || outcome?.state !== "pending") return;
    const delay = Math.min(backoffSeconds, 5) * 1_000;
    timeoutRef.current = window.setTimeout(() => void refreshOutcome(), delay);
    const onFocus = () => void refreshOutcome();
    const onVisibility = () => {
      if (document.visibilityState === "visible") void refreshOutcome();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      if (timeoutRef.current !== undefined)
        window.clearTimeout(timeoutRef.current);
      timeoutRef.current = undefined;
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
      pollAbortRef.current?.abort();
    };
  }, [backoffSeconds, outcome, pollTick, refreshOutcome, stage]);

  useEffect(() => () => stopPolling(), [stopPolling]);

  if (rankingView) {
    return <LiveLeaderboard client={client} headingRef={headingRef} />;
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
        ? currentGatePassed
          ? setupCameraMessage(cameraStatus)
          : cameraStatus === "pending"
            ? activeGate.correction
            : setupCameraMessage(cameraStatus)
        : currentGatePassed
          ? activeGate?.ready
          : activeGate?.correction;
    return (
      <main
        className="calibration-setup"
        aria-labelledby="verified-setup-heading"
      >
        <p className="eyebrow">Desafio verificado</p>
        <h1 id="verified-setup-heading" ref={headingRef} tabIndex={-1}>
          Preparação do desafio verificado
        </h1>
        <p>
          Etapa {gateIndex + 1} de {setupGates.length} — {activeGate?.title}
        </p>
        <p>{captureTimingGuidance}</p>
        <h2>{activeGate?.title}</h2>
        <section aria-label="Prévia da câmera">
          <p role="status">{currentGateStatus}</p>
        </section>
        {message ? <p role="alert">{message}</p> : null}
        <button
          type="button"
          disabled={stage !== "setup" || !activeGate}
          onClick={() => {
            if (activeGate?.id === "device") {
              setCameraStatus("ready");
              return;
            }
            if (activeGate) {
              setPassedGates((current) => new Set([...current, activeGate.id]));
            }
          }}
        >
          {activeGate?.id === "device"
            ? "Simular câmera pronta"
            : "Simular etapa pronta"}
        </button>
        {activeGate?.id === "device" && !currentGatePassed ? (
          <button
            type="button"
            disabled={stage !== "setup"}
            onClick={() => setCameraStatus("ready")}
          >
            Tentar acesso à câmera
          </button>
        ) : null}
        {activeGate?.id === "device" && !currentGatePassed ? (
          <button
            type="button"
            disabled={stage !== "setup"}
            onClick={() => setCameraStatus("existing-video")}
          >
            Usar vídeo existente
          </button>
        ) : null}
        <button
          type="button"
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
          Continuar
        </button>
        <button
          type="button"
          disabled={stage !== "setup"}
          onClick={() => {
            if (gateIndex === 0) {
              navigate("/");
              return;
            }
            setGateIndex((current) => current - 1);
          }}
        >
          {gateIndex === 0 ? "Voltar para Início" : "Voltar"}
        </button>
        <button
          type="button"
          disabled={stage !== "setup"}
          onClick={() => navigate("/")}
        >
          Cancelar preparação
        </button>
      </main>
    );
  }

  if (stage === "capture" || stage === "uploading") {
    const uploading = stage === "uploading";
    return (
      <main
        className="verified-capture"
        aria-labelledby="verified-capture-heading"
      >
        <p className="eyebrow">Desafio verificado</p>
        <h1 id="verified-capture-heading" ref={headingRef} tabIndex={-1}>
          Envie o vídeo verificado
        </h1>
        <p>
          Inclua pré-rolagem de calibração de 4 segundos e um intervalo ativo de
          60 segundos. O servidor confirma a elegibilidade.
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
            <progress aria-label="Envio do vídeo verificado" />
            <p role="status">Enviando vídeo ao servidor.</p>
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
          type="button"
          disabled={!attemptId || !media || uploading}
          onClick={() => {
            uploadGenerationRef.current += 1;
            setMessage("");
            setStage("uploading");
          }}
        >
          Enviar vídeo
        </button>
        {uploading ? (
          <button
            type="button"
            onClick={() => {
              uploadGenerationRef.current += 1;
              const upload = activeUploadRef.current;
              activeUploadRef.current = undefined;
              upload?.abort();
              setStage("capture");
              setMessage(
                "Envio cancelado. O vídeo continua pronto para tentar novamente.",
              );
              if (attemptId)
                void reconcileUploadAttempt(
                  attemptId,
                  generationRef.current,
                  "Envio cancelado. O vídeo continua pronto para tentar novamente.",
                );
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
      <main aria-labelledby="processing-heading">
        <p className="eyebrow">Desafio verificado</p>
        <h1 id="processing-heading" ref={headingRef} tabIndex={-1}>
          Processando tentativa
        </h1>
        <p role="status">
          O processamento continua no servidor. Atualize esta tela quando
          voltar; não prometemos uma notificação com o navegador fechado.
        </p>
        {message ? <p role="alert">{message}</p> : null}
        <button
          type="button"
          disabled={refreshing}
          aria-busy={refreshing}
          onClick={() => void refreshOutcome()}
        >
          Atualizar agora
        </button>
        {refreshing ? <p role="status">Atualizando tentativa.</p> : null}
        <button type="button" onClick={() => resetToSetup()}>
          Iniciar outro desafio
        </button>
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
  return (
    <main aria-labelledby="verified-report-heading">
      <p className="eyebrow">{truth}</p>
      <h1 id="verified-report-heading" ref={headingRef} tabIndex={-1}>
        Resultado do desafio verificado
      </h1>
      <p>Score: {result.score}</p>
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
      <dl>
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
      {result.competitiveStatus === "ranked" ? (
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
            Top percent: {result.rankingSnapshot.topPercent}% — distância até o
            topo, não um sinônimo de percentil.
          </p>
          <p>
            Pontuações no cálculo:{" "}
            {result.rankingSnapshot.scoreCountAtFinalization}
          </p>
          <p>Calculado em: {result.rankingSnapshot.calculatedAt}</p>
          <p>Tentativa do snapshot: {result.rankingSnapshot.asOfAttemptId}</p>
        </section>
      ) : null}
      <Link to="/verified?view=ranking">Ver Ranking atual</Link>
      <button type="button" onClick={onRetry}>
        Novo desafio
      </button>
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
