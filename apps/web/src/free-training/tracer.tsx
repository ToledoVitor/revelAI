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
} from "../lib/attempt-flow/upload-reconciliation";
import { usePendingAttemptPolling } from "../lib/attempt-flow/pending-polling";
import { useAttemptUploadLifecycle } from "../lib/attempt-flow/upload-lifecycle";
import { FreeTrainingMedia } from "./media";
import {
  beginFreeTrainingCreateIntent,
  clearFreeTrainingCreateIntent,
  clearFreeTrainingOwner,
  clearFreeTrainingOwnershipForAttempt,
  persistFreeTrainingOwner,
  readFreeTrainingOwner,
} from "./owner";

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
  const ownerRecoveryStartedRef = useRef(false);
  const uploadGenerationRef = useRef(0);
  const activeCreateRef = useRef<AbortController | undefined>(undefined);
  const activeDeleteRef = useRef<AbortController | undefined>(undefined);
  const pollingStopRef = useRef<() => void>(() => undefined);
  const [stage, setStage] = useState<FreeStage>("creating");
  const [attemptId, setAttemptId] = useState<string>();
  const [media, setMedia] = useState<File>();
  const [outcome, setOutcome] = useState<AttemptOutcome>();
  const [terminal, setTerminal] = useState<AttemptOutcome>();
  const [message, setMessage] = useState("");
  const [createTick, setCreateTick] = useState(0);
  const [uploadProgress, setUploadProgress] = useState<
    Readonly<{ loaded: number; total?: number }> | undefined
  >();

  const stopPolling = useCallback(() => {
    pollingStopRef.current();
  }, []);

  const resetForNewTraining = useCallback(() => {
    flowGenerationRef.current += 1;
    createStartedRef.current = false;
    ownerRecoveryStartedRef.current = false;
    clearFreeTrainingOwner();
    clearFreeTrainingCreateIntent();
    uploadGenerationRef.current += 1;
    const creation = activeCreateRef.current;
    activeCreateRef.current = undefined;
    creation?.abort();
    const deletion = activeDeleteRef.current;
    activeDeleteRef.current = undefined;
    deletion?.abort();
    stopPolling();
    setAttemptId(undefined);
    setMedia(undefined);
    setOutcome(undefined);
    setTerminal(undefined);
    setMessage("");
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
    expectedMode: "free",
    generation: flowGenerationRef.current,
    uploadGeneration: uploadGenerationRef.current,
    client,
    isGenerationCurrent: (generation, uploadGeneration) =>
      generation === flowGenerationRef.current &&
      uploadGeneration === uploadGenerationRef.current,
    isAbort,
    isRouteError,
    hasRouteErrorCode,
    errorMessage: safeError,
    onProgress: setUploadProgress,
    onOutcome: applyUploadOutcome,
    onMismatch: () => {
      setMessage("Este envio não pertence a este treino livre.");
      setTerminal(undefined);
      setStage("terminal");
    },
    onError: (nextMessage) => {
      setMessage(nextMessage);
      setStage("capture");
    },
  });

  useEffect(() => {
    focusHeading(headingRef);
  }, [stage, terminal]);

  useEffect(() => {
    if (
      stage !== "creating" ||
      createStartedRef.current ||
      ownerRecoveryStartedRef.current
    )
      return;
    createStartedRef.current = true;
    ownerRecoveryStartedRef.current = true;
    const generation = flowGenerationRef.current;
    const controller = new AbortController();
    activeCreateRef.current = controller;

    const isCurrent = () =>
      !controller.signal.aborted &&
      generation === flowGenerationRef.current &&
      activeCreateRef.current === controller;
    const rejectOwner = (ownedAttemptId?: string) => {
      if (!isCurrent()) return;
      activeCreateRef.current = undefined;
      if (ownedAttemptId) clearFreeTrainingOwnershipForAttempt(ownedAttemptId);
      setMessage("Esta tentativa não está disponível neste fluxo.");
      setStage("terminal");
    };
    const adopt = (attempt: {
      id: string;
      mode: string;
      outcome: AttemptOutcome;
    }) => {
      if (!isCurrent()) return;
      if (!isOutcomeForAttempt(attempt.outcome, attempt.id, "free")) {
        rejectOwner(attempt.id);
        return;
      }
      activeCreateRef.current = undefined;
      persistFreeTrainingOwner(attempt.id);
      setAttemptId(attempt.id);
      applyUploadOutcome(attempt.outcome, attempt.id);
    };
    const create = async () => {
      const intent = beginFreeTrainingCreateIntent();
      try {
        const attempt = await client.createAttempt(
          { mode: "free" },
          { signal: controller.signal, idempotencyKey: intent.idempotencyKey },
        );
        if (attempt.mode !== "free") {
          rejectOwner(attempt.id);
          return;
        }
        adopt(attempt);
      } catch (error) {
        if (!isCurrent() || isAbort(error)) return;
        activeCreateRef.current = undefined;
        createStartedRef.current = false;
        ownerRecoveryStartedRef.current = false;
        setMessage(safeError(error));
      }
    };
    const recoverOrCreate = async () => {
      const owner = readFreeTrainingOwner();
      if (owner) {
        try {
          const attempt = await client.getAttempt(owner.attemptId, {
            signal: controller.signal,
          });
          if (attempt.mode !== "free" || attempt.id !== owner.attemptId) {
            rejectOwner(owner.attemptId);
            return;
          }
          adopt(attempt);
        } catch (error) {
          if (!isCurrent() || isAbort(error)) return;
          if (hasRouteErrorCode(error, "attempt_not_found")) {
            clearFreeTrainingOwnershipForAttempt(owner.attemptId);
            if (isCurrent()) void create();
            return;
          }
          activeCreateRef.current = undefined;
          createStartedRef.current = false;
          ownerRecoveryStartedRef.current = false;
          setMessage(safeError(error));
        }
        return;
      }

      if (isCurrent()) void create();
    };
    void recoverOrCreate();
    return undefined;
  }, [applyUploadOutcome, client, createTick, stage]);

  const pendingPolling = usePendingAttemptPolling({
    enabled: stage === "pending" && outcome?.state === "pending",
    attemptId,
    generation: flowGenerationRef.current,
    request: async (ownedAttemptId, options) => {
      const nextOutcome = await client.getAttemptOutcome(
        ownedAttemptId,
        options,
      );
      return !isOutcomeForAttempt(nextOutcome, ownedAttemptId, "free") ||
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

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      queueMicrotask(() => {
        if (mountedRef.current) return;
        flowGenerationRef.current += 1;
        uploadGenerationRef.current += 1;
        activeCreateRef.current?.abort();
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
        clearFreeTrainingOwnershipForAttempt(attemptId);
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
              uploadLifecycle.abort();
              setUploadProgress(undefined);
              setStage("capture");
              setMessage(
                "Envio cancelado. O vídeo continua pronto para tentar novamente.",
              );
              if (attemptId)
                void uploadLifecycle.reconcile({
                  attemptId,
                  generation: flowGenerationRef.current,
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
      <main className="free-training" aria-labelledby="free-training-heading">
        {heading}
        <p role="status">
          O processamento continua no servidor. Atualize esta tela quando
          voltar; não prometemos uma notificação com o navegador fechado.
        </p>
        {message ? <p role="alert">{message}</p> : null}
        <button
          type="button"
          disabled={pendingPolling.refreshing}
          aria-busy={pendingPolling.refreshing}
          onClick={() => void pendingPolling.refresh()}
        >
          Atualizar agora
        </button>
        {pendingPolling.refreshing ? (
          <p role="status">Atualizando treino.</p>
        ) : null}
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
