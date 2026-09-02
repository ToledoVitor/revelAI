import type {
  AttemptListResponse,
  AttemptOutcome,
  FreeInsight,
} from "@revelai/contracts";
import { useQueryClient, type InfiniteData } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  createRevelApiClient,
  type RevelApiAbort,
  type RevelApiError,
} from "../lib/api/client";
import { trainingHistoryQueryKey } from "../history/query";
import {
  isOutcomeForAttempt,
  resolveUploadReconciliation,
} from "../verified/upload-reconciliation";
import { FreeTrainingMedia } from "./media";

type FreeTrainingTracerProps = Readonly<{
  client: ReturnType<typeof createRevelApiClient>;
}>;

type FreeStage =
  | "creating"
  | "capture"
  | "uploading"
  | "pending"
  | "terminal"
  | "deleting";

const safeGenericError = "Não foi possível continuar agora. Tente novamente.";

function isAbort(error: unknown): error is RevelApiAbort {
  return (
    typeof error === "object" &&
    error !== null &&
    "kind" in error &&
    (error as { kind?: unknown }).kind === "aborted"
  );
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

function safeError(error: unknown): string {
  return isRouteError(error) ? error.message : safeGenericError;
}

function focusHeading(ref: React.RefObject<HTMLHeadingElement | null>) {
  ref.current?.focus();
}

export function FreeTrainingTracer({ client }: FreeTrainingTracerProps) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const flowGenerationRef = useRef(0);
  const mountedRef = useRef(false);
  const createStartedRef = useRef(false);
  const uploadGenerationRef = useRef(0);
  const activeCreateRef = useRef<AbortController | undefined>(undefined);
  const activeUploadRef = useRef<AbortController | undefined>(undefined);
  const activeDeleteRef = useRef<AbortController | undefined>(undefined);
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
  const [stage, setStage] = useState<FreeStage>("creating");
  const [attemptId, setAttemptId] = useState<string>();
  const [media, setMedia] = useState<File>();
  const [outcome, setOutcome] = useState<AttemptOutcome>();
  const [terminal, setTerminal] = useState<AttemptOutcome>();
  const [message, setMessage] = useState("");
  const [createTick, setCreateTick] = useState(0);
  const [backoffSeconds, setBackoffSeconds] = useState(1);
  const [pollTick, setPollTick] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<
    Readonly<{ loaded: number; total?: number }> | undefined
  >();

  const stopPolling = useCallback(() => {
    if (timeoutRef.current !== undefined)
      window.clearTimeout(timeoutRef.current);
    timeoutRef.current = undefined;
    const pending = pendingRequestRef.current;
    pendingRequestRef.current = undefined;
    pending?.controller.abort();
    pollAbortRef.current = undefined;
  }, []);

  const resetForNewTraining = useCallback(() => {
    flowGenerationRef.current += 1;
    createStartedRef.current = false;
    uploadGenerationRef.current += 1;
    const creation = activeCreateRef.current;
    activeCreateRef.current = undefined;
    creation?.abort();
    const upload = activeUploadRef.current;
    activeUploadRef.current = undefined;
    upload?.abort();
    const deletion = activeDeleteRef.current;
    activeDeleteRef.current = undefined;
    deletion?.abort();
    stopPolling();
    setAttemptId(undefined);
    setMedia(undefined);
    setOutcome(undefined);
    setTerminal(undefined);
    setMessage("");
    setBackoffSeconds(1);
    setPollTick(0);
    setRefreshing(false);
    setUploadProgress(undefined);
    setStage("creating");
    setCreateTick((current) => current + 1);
  }, [stopPolling]);

  const completeOutcome = useCallback(
    (nextOutcome: AttemptOutcome, ownedAttemptId: string) => {
      stopPolling();
      if (!isOutcomeForAttempt(nextOutcome, ownedAttemptId, "free")) {
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
        "free",
      );
      if (transition.kind === "mismatch") {
        setMessage("Este resultado não está disponível neste fluxo.");
        setTerminal(undefined);
        setStage("terminal");
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
      setBackoffSeconds(1);
      if (transition.kind === "pending") {
        setStage("pending");
        return;
      }
      completeOutcome(transition.outcome, ownedAttemptId);
    },
    [completeOutcome],
  );

  const reconcileUploadAttempt = useCallback(
    async (
      ownedAttemptId: string,
      generation: number,
      uploadGeneration: number,
      fallbackMessage = safeGenericError,
    ) => {
      try {
        const attempt = await client.getAttempt(ownedAttemptId);
        if (
          generation !== flowGenerationRef.current ||
          uploadGeneration !== uploadGenerationRef.current
        )
          return;
        applyUploadOutcome(attempt.outcome, ownedAttemptId);
      } catch (error) {
        if (
          generation !== flowGenerationRef.current ||
          uploadGeneration !== uploadGenerationRef.current ||
          isAbort(error)
        )
          return;
        setMessage(fallbackMessage);
        setStage("capture");
      }
    },
    [applyUploadOutcome, client],
  );

  useEffect(() => {
    focusHeading(headingRef);
  }, [stage, terminal]);

  useEffect(() => {
    if (stage !== "creating" || createStartedRef.current) return;
    createStartedRef.current = true;
    const generation = flowGenerationRef.current;
    const controller = new AbortController();
    activeCreateRef.current = controller;
    void client
      .createAttempt({ mode: "free" }, { signal: controller.signal })
      .then((attempt) => {
        if (
          controller.signal.aborted ||
          generation !== flowGenerationRef.current
        )
          return;
        activeCreateRef.current = undefined;
        if (
          attempt.mode !== "free" ||
          attempt.outcome.mode !== "free" ||
          attempt.outcome.attemptId !== attempt.id ||
          attempt.outcome.status !== "awaiting-upload"
        ) {
          setMessage("Esta tentativa não está disponível neste fluxo.");
          setStage("terminal");
          return;
        }
        setAttemptId(attempt.id);
        setOutcome(attempt.outcome);
        setStage("capture");
      })
      .catch((error: unknown) => {
        if (
          controller.signal.aborted ||
          generation !== flowGenerationRef.current
        )
          return;
        activeCreateRef.current = undefined;
        createStartedRef.current = false;
        setMessage(safeError(error));
      });
    return undefined;
  }, [client, createTick, stage]);

  useEffect(() => {
    if (stage !== "uploading" || !attemptId || !media) return;
    const generation = flowGenerationRef.current;
    const uploadGeneration = uploadGenerationRef.current;
    const controller = new AbortController();
    activeUploadRef.current = controller;
    void client
      .uploadAttemptMedia(attemptId, media, {
        signal: controller.signal,
        onProgress: (nextProgress) => {
          if (
            generation === flowGenerationRef.current &&
            uploadGeneration === uploadGenerationRef.current &&
            activeUploadRef.current === controller
          )
            setUploadProgress(nextProgress);
        },
      })
      .then((accepted) => {
        if (
          generation !== flowGenerationRef.current ||
          uploadGeneration !== uploadGenerationRef.current ||
          activeUploadRef.current !== controller
        )
          return;
        activeUploadRef.current = undefined;
        setUploadProgress(undefined);
        if (accepted.attemptId !== attemptId || accepted.mode !== "free") {
          setMessage("Este envio não pertence a este treino livre.");
          setTerminal(undefined);
          setStage("terminal");
          return;
        }
        applyUploadOutcome(accepted.outcome, attemptId);
      })
      .catch((error: unknown) => {
        if (
          generation !== flowGenerationRef.current ||
          uploadGeneration !== uploadGenerationRef.current ||
          activeUploadRef.current !== controller
        )
          return;
        activeUploadRef.current = undefined;
        setUploadProgress(undefined);
        if (
          hasRouteErrorCode(error, "duplicate_media_upload") ||
          isAbort(error) ||
          !isRouteError(error)
        ) {
          void reconcileUploadAttempt(
            attemptId,
            generation,
            uploadGeneration,
            safeError(error),
          );
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
  }, [
    applyUploadOutcome,
    attemptId,
    client,
    media,
    reconcileUploadAttempt,
    stage,
  ]);

  const refreshOutcome = useCallback(async () => {
    if (stage !== "pending" || !attemptId) return;
    const generation = flowGenerationRef.current;
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
    pollAbortRef.current = controller;
    setRefreshing(true);
    try {
      const nextOutcome = await client.getAttemptOutcome(attemptId, {
        signal: controller.signal,
      });
      if (
        controller.signal.aborted ||
        pendingRequestRef.current !== request ||
        generation !== flowGenerationRef.current
      )
        return;
      if (!isOutcomeForAttempt(nextOutcome, attemptId, "free")) {
        completeOutcome(nextOutcome, attemptId);
        return;
      }
      setMessage("");
      setOutcome(nextOutcome);
      if (nextOutcome.state === "pending") {
        setBackoffSeconds((current) => Math.min(current * 2, 5));
      } else {
        completeOutcome(nextOutcome, attemptId);
      }
    } catch (error) {
      if (!isAbort(error)) setMessage(safeError(error));
    } finally {
      if (pollAbortRef.current === controller) pollAbortRef.current = undefined;
      if (pendingRequestRef.current === request)
        pendingRequestRef.current = undefined;
      if (generation === flowGenerationRef.current) setRefreshing(false);
      if (
        !controller.signal.aborted &&
        generation === flowGenerationRef.current &&
        stage === "pending"
      )
        setPollTick((current) => current + 1);
    }
  }, [attemptId, client, completeOutcome, stage]);

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

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      queueMicrotask(() => {
        if (mountedRef.current) return;
        flowGenerationRef.current += 1;
        uploadGenerationRef.current += 1;
        activeCreateRef.current?.abort();
        activeUploadRef.current?.abort();
        activeDeleteRef.current?.abort();
        stopPolling();
      });
    };
  }, [stopPolling]);

  const deleteTraining = useCallback(() => {
    if (!attemptId || stage === "deleting" || activeDeleteRef.current) return;
    if (
      !window.confirm(
        "Excluir este treino? A mídia e a análise aproximada serão removidas.",
      )
    )
      return;
    const generation = flowGenerationRef.current;
    const controller = new AbortController();
    activeDeleteRef.current = controller;
    setMessage("");
    setStage("deleting");
    void client
      .deleteAttempt(attemptId, { signal: controller.signal })
      .then(() => {
        if (
          controller.signal.aborted ||
          generation !== flowGenerationRef.current ||
          activeDeleteRef.current !== controller
        )
          return;
        activeDeleteRef.current = undefined;
        setMedia(undefined);
        queryClient.setQueryData<
          InfiniteData<AttemptListResponse, string | undefined>
        >(trainingHistoryQueryKey, (current) => {
          if (!current) return current;
          return {
            ...current,
            pages: current.pages.map((page) => ({
              ...page,
              items: page.items.filter((attempt) => attempt.id !== attemptId),
            })),
          };
        });
        navigate("/training/history", {
          state: { deletedFreeTraining: true },
          replace: true,
        });
      })
      .catch((error: unknown) => {
        if (
          controller.signal.aborted ||
          generation !== flowGenerationRef.current ||
          activeDeleteRef.current !== controller
        )
          return;
        activeDeleteRef.current = undefined;
        setMessage(safeError(error));
        setStage("terminal");
      });
  }, [attemptId, client, navigate, queryClient, stage]);

  const heading = (
    <>
      <p className="eyebrow">Treino livre — análise aproximada</p>
      <h1 id="free-training-heading" ref={headingRef} tabIndex={-1}>
        Treino livre — análise aproximada
      </h1>
    </>
  );

  if (stage === "creating") {
    return (
      <main className="free-training" aria-labelledby="free-training-heading">
        {heading}
        <p role="status">Preparando um treino livre para este envio.</p>
        {message ? <p role="alert">{message}</p> : null}
        {message ? (
          <button
            type="button"
            onClick={() => {
              createStartedRef.current = false;
              setMessage("");
              setCreateTick((current) => current + 1);
            }}
          >
            Tentar novamente
          </button>
        ) : null}
      </main>
    );
  }

  if (stage === "capture" || stage === "uploading") {
    const uploading = stage === "uploading";
    return (
      <main className="free-training" aria-labelledby="free-training-heading">
        {heading}
        <p>O servidor confirma o arquivo e a análise aproximada.</p>
        <FreeTrainingMedia
          disabled={uploading || !attemptId}
          media={media}
          onMedia={setMedia}
        />
        {uploading ? (
          <>
            <progress
              aria-label="Envio do vídeo do treino livre"
              {...(uploadProgress?.total !== undefined
                ? { value: uploadProgress.loaded, max: uploadProgress.total }
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
        <button
          type="button"
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
              const upload = activeUploadRef.current;
              activeUploadRef.current = undefined;
              upload?.abort();
              setUploadProgress(undefined);
              setStage("capture");
              setMessage(
                "Envio cancelado. O vídeo continua pronto para tentar novamente.",
              );
              if (attemptId)
                void reconcileUploadAttempt(
                  attemptId,
                  flowGenerationRef.current,
                  uploadGeneration,
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
      <main className="free-training" aria-labelledby="free-training-heading">
        {heading}
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
        {refreshing ? <p role="status">Atualizando treino.</p> : null}
        <button type="button" onClick={resetForNewTraining}>
          Começar outro treino livre
        </button>
      </main>
    );
  }

  if (stage === "deleting") {
    return (
      <main className="free-training" aria-labelledby="free-training-heading">
        {heading}
        <p role="status" aria-busy="true">
          Excluindo mídia e análise aproximada.
        </p>
      </main>
    );
  }

  return (
    <FreeTerminal
      heading={heading}
      message={message}
      outcome={terminal}
      onDelete={deleteTraining}
      onStartAnother={resetForNewTraining}
    />
  );
}

function FreeTerminal({
  heading,
  message,
  outcome,
  onDelete,
  onStartAnother,
}: Readonly<{
  heading: React.ReactNode;
  message: string;
  outcome?: AttemptOutcome;
  onDelete(): void;
  onStartAnother(): void;
}>) {
  if (outcome?.state === "valid" && outcome.result.kind === "free-insight") {
    return (
      <main className="free-training" aria-labelledby="free-training-heading">
        {heading}
        <FreeInsightReport insight={outcome.result} />
        {message ? <p role="alert">{message}</p> : null}
        <FreeTerminalControls
          onDelete={onDelete}
          onStartAnother={onStartAnother}
        />
      </main>
    );
  }

  if (outcome?.state === "failed" && outcome.mode === "free") {
    return (
      <main className="free-training" aria-labelledby="free-training-heading">
        {heading}
        <h2>Não foi possível concluir a análise aproximada</h2>
        <p role="alert">{outcome.message}</p>
        {message ? <p role="alert">{message}</p> : null}
        <FreeTerminalControls
          onDelete={onDelete}
          onStartAnother={onStartAnother}
        />
      </main>
    );
  }

  return (
    <main className="free-training" aria-labelledby="free-training-heading">
      {heading}
      <h2>Resultado indisponível</h2>
      <p role="alert">{message || safeGenericError}</p>
      <button type="button" onClick={onStartAnother}>
        Começar outro treino livre
      </button>
      <Link to="/training/history">Voltar para Meus treinos</Link>
    </main>
  );
}

function FreeInsightReport({ insight }: Readonly<{ insight: FreeInsight }>) {
  return (
    <section aria-label="Análise aproximada">
      <p role="status">Análise aproximada gerada pelo servidor.</p>
      <p>Análise aproximada: {String(insight.approximate)}.</p>
      <p>Gerado em: {insight.generatedAt}</p>
      {insight.provenance.kind === "demo" ? (
        <dl aria-label="Proveniência demo">
          <dt>Fixture</dt>
          <dd>{insight.provenance.fixtureId}</dd>
          <dt>Versão do provider</dt>
          <dd>{insight.provenance.providerVersion}</dd>
        </dl>
      ) : (
        <dl aria-label="Proveniência Roboflow">
          <dt>Workspace</dt>
          <dd>{insight.provenance.workspaceId}</dd>
          <dt>Workflow</dt>
          <dd>{insight.provenance.workflowId}</dd>
          <dt>Versão do workflow</dt>
          <dd>{insight.provenance.workflowVersion}</dd>
          <dt>Bundle do modelo</dt>
          <dd>{insight.provenance.modelBundleId}</dd>
          <dt>Versão do provider</dt>
          <dd>{insight.provenance.providerVersion}</dd>
        </dl>
      )}
      <dl aria-label="Observações">
        {insight.observations.map((observation) => (
          <div key={observation.kind}>
            <dt>{observation.kind}</dt>
            <dd>
              {observation.value}% — {observation.range}
            </dd>
          </div>
        ))}
      </dl>
      <section aria-label="Sugestões recebidas">
        <h2>Sugestões recebidas</h2>
        <ul>
          {insight.tips.map((tip) => (
            <li key={tip}>{tip}</li>
          ))}
        </ul>
      </section>
    </section>
  );
}

function FreeTerminalControls({
  onDelete,
  onStartAnother,
}: Readonly<{
  onDelete(): void;
  onStartAnother(): void;
}>) {
  return (
    <section aria-label="Ações do treino livre">
      <button type="button" onClick={onStartAnother}>
        Começar outro treino livre
      </button>
      <button type="button" onClick={onDelete}>
        Excluir treino
      </button>
      <Link to="/training/history">Voltar para Meus treinos</Link>
    </section>
  );
}
