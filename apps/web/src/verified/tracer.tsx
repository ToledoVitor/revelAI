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

type RevelApiClient = ReturnType<typeof createRevelApiClient>;

const requiredGates = [
  ["device", "Dispositivo"],
  ["space", "Espaço"],
  ["athlete", "Atleta"],
  ["rehearsal", "Ensaio"],
  ["record", "Registro"],
] as const;

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

function focusHeading(ref: React.RefObject<HTMLHeadingElement | null>) {
  ref.current?.focus();
}

function isVerifiedOutcome(outcome: AttemptOutcome): boolean {
  if (outcome.state === "pending") return outcome.mode === "verified";
  if (outcome.state === "valid")
    return outcome.result.kind === "verified-result";
  return outcome.mode === "verified";
}

type VerifiedTracerProps = Readonly<{ client: RevelApiClient }>;

export function VerifiedTracer({ client }: VerifiedTracerProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const generationRef = useRef(0);
  const createStartedRef = useRef(false);
  const uploadStartedRef = useRef(false);
  const pendingRequestRef = useRef(false);
  const timeoutRef = useRef<number | undefined>(undefined);
  const pollAbortRef = useRef<AbortController | undefined>(undefined);
  const [stage, setStage] = useState<TracerStage>("setup");
  const [gateIndex, setGateIndex] = useState(0);
  const [calibrationId, setCalibrationId] = useState<string>();
  const [attemptId, setAttemptId] = useState<string>();
  const [media, setMedia] = useState<File>();
  const [outcome, setOutcome] = useState<AttemptOutcome>();
  const [terminal, setTerminal] = useState<AttemptOutcome>();
  const [message, setMessage] = useState("");
  const [backoffSeconds, setBackoffSeconds] = useState(1);
  const [pollTick, setPollTick] = useState(0);

  const rankingView =
    new URLSearchParams(location.search).get("view") === "ranking";

  const resetToSetup = useCallback(() => {
    generationRef.current += 1;
    createStartedRef.current = false;
    uploadStartedRef.current = false;
    pollAbortRef.current?.abort();
    if (timeoutRef.current !== undefined)
      window.clearTimeout(timeoutRef.current);
    timeoutRef.current = undefined;
    setGateIndex(0);
    setCalibrationId(undefined);
    setAttemptId(undefined);
    setMedia(undefined);
    setOutcome(undefined);
    setTerminal(undefined);
    setMessage("");
    setBackoffSeconds(1);
    setPollTick(0);
    setStage("setup");
  }, []);

  useEffect(() => {
    focusHeading(headingRef);
  }, [stage, terminal, rankingView]);

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
          requiredGates: ["device", "space", "athlete", "rehearsal", "record"],
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
      })
      .catch((error: unknown) => {
        if (generation !== generationRef.current || isAbort(error)) return;
        setMessage(safeError(error));
      });
    return () => controller.abort();
  }, [calibrationId, client, stage]);

  useEffect(() => {
    if (
      stage !== "uploading" ||
      !attemptId ||
      !media ||
      uploadStartedRef.current
    )
      return;
    uploadStartedRef.current = true;
    const generation = generationRef.current;
    const controller = new AbortController();
    void client
      .uploadAttemptMedia(attemptId, media, { signal: controller.signal })
      .then((accepted) => {
        if (generation !== generationRef.current) return;
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
        setOutcome(accepted.outcome);
        setBackoffSeconds(1);
        setStage("pending");
      })
      .catch((error: unknown) => {
        if (generation !== generationRef.current || isAbort(error)) {
          if (generation === generationRef.current && isAbort(error)) {
            setMessage(
              "Envio cancelado. O vídeo continua pronto para tentar novamente.",
            );
            setStage("capture");
          }
          return;
        }
        setMessage(safeError(error));
        setStage("capture");
      });
    return () => controller.abort();
  }, [attemptId, client, media, stage]);

  const stopPolling = useCallback(() => {
    if (timeoutRef.current !== undefined)
      window.clearTimeout(timeoutRef.current);
    timeoutRef.current = undefined;
    pollAbortRef.current?.abort();
    pollAbortRef.current = undefined;
  }, []);

  const completeOutcome = useCallback(
    (nextOutcome: AttemptOutcome) => {
      stopPolling();
      if (!isVerifiedOutcome(nextOutcome)) {
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

  const refreshOutcome = useCallback(async () => {
    if (stage !== "pending" || !attemptId || pendingRequestRef.current) return;
    pendingRequestRef.current = true;
    const controller = new AbortController();
    pollAbortRef.current = controller;
    try {
      const nextOutcome = await client.getAttemptOutcome(attemptId, {
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      setMessage("");
      setOutcome(nextOutcome);
      if (nextOutcome.state === "pending") {
        const nextDelay = Math.min(backoffSeconds * 2, 5);
        setBackoffSeconds(nextDelay);
      } else {
        completeOutcome(nextOutcome);
      }
    } catch (error) {
      if (!isAbort(error)) setMessage(safeError(error));
    } finally {
      if (pollAbortRef.current === controller) pollAbortRef.current = undefined;
      pendingRequestRef.current = false;
      if (!controller.signal.aborted && stage === "pending") {
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
    const activeGate = requiredGates[gateIndex];
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
          Etapa {gateIndex + 1} de {requiredGates.length} — {activeGate?.[1]}
        </p>
        <p role="status">
          A orientação ajuda a preparar a captura, mas a verificação é decidida
          no servidor.
        </p>
        {message ? <p role="alert">{message}</p> : null}
        <button
          type="button"
          disabled={stage !== "setup" || !activeGate}
          onClick={() => {
            if (gateIndex === requiredGates.length - 1) {
              setMessage("");
              setStage("creating-session");
              return;
            }
            setGateIndex((current) => current + 1);
          }}
        >
          Confirmar {activeGate?.[1]}
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
          <p role="status">Preparando uma tentativa para este envio.</p>
        ) : null}
        <ProductionCapture
          disabled={uploading || !attemptId}
          media={media}
          onMedia={setMedia}
        />
        {message ? <p role="alert">{message}</p> : null}
        <button
          type="button"
          disabled={!attemptId || !media || uploading}
          onClick={() => {
            uploadStartedRef.current = false;
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
              pollAbortRef.current?.abort();
              uploadStartedRef.current = false;
              setStage("capture");
              setMessage(
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
        <button type="button" onClick={() => void refreshOutcome()}>
          Atualizar agora
        </button>
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
  const load = useCallback(
    async (requestedCursor?: string) => {
      try {
        setError("");
        const next = await client.getLeaderboard({
          ...leaderboardInput,
          ...(requestedCursor ? { cursor: requestedCursor } : {}),
        });
        setResponse((current) =>
          requestedCursor && current
            ? { ...next, entries: [...current.entries, ...next.entries] }
            : next,
        );
        setCursor(next.nextCursor ?? undefined);
      } catch (loadError) {
        setError(safeError(loadError));
      }
    },
    [client],
  );
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
                <li key={entry.entryId}>
                  Posição {entry.rank} — score {entry.score} —{" "}
                  {entry.completedAt}
                </li>
              ))}
            </ol>
          )}
          {cursor ? (
            <button type="button" onClick={() => void load(cursor)}>
              Carregar mais
            </button>
          ) : null}
        </>
      ) : null}
      <button type="button" onClick={() => void load()}>
        Atualizar ranking
      </button>
      <Link to="/verified">Voltar ao desafio</Link>
    </main>
  );
}
