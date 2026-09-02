import {
  MAX_UPLOAD_BYTES,
  mediaUploadFixtures,
  type MediaUploadFormDataRequestDescriptor,
  type RouteError,
} from "@revelai/contracts";
import { useEffect, useRef, useState } from "react";
import {
  captureRequirementLines,
  normalizeSelectedMedia,
  selectedRecorderCandidate,
  type AcceptedMediaMime,
  type RecorderCandidate,
} from "./capture-media";

export type BrowserCaptureState =
  | "idle"
  | "requesting-permission"
  | "countdown"
  | "pre-roll"
  | "active"
  | "stopping"
  | "preview"
  | "error"
  | "unavailable";

export type VerifiedDraft = Readonly<{
  kind: "review-verified-draft";
  challengeId: "wall-pass";
  challengeVersion: 1;
}>;

type LocalMedia = Readonly<{
  file: File;
  name: string;
  declaredMime: string;
  wireMime: AcceptedMediaMime;
  size: number;
  previewUrl?: string;
}>;

export type ReviewUploadProgress =
  | Readonly<{ kind: "preparing" }>
  | Readonly<{ kind: "progress"; loaded: number; total?: number }>;

export type ReviewUploadResult =
  | Readonly<{ kind: "accepted" }>
  | Readonly<{ kind: "connection-error" }>
  | Readonly<{ kind: "route-error"; error: RouteError }>;

export type ReviewCapturePort = Readonly<{
  getDraft(): VerifiedDraft;
  upload(
    input: Readonly<{
      draft: VerifiedDraft;
      media: LocalMedia;
      formData: FormData;
      signal: AbortSignal;
      onProgress(progress: ReviewUploadProgress): void;
    }>,
  ): Promise<ReviewUploadResult>;
}>;

const acceptedMediaFormDataDescriptor: MediaUploadFormDataRequestDescriptor =
  mediaUploadFixtures.accepted.request.adapter === "form-data"
    ? mediaUploadFixtures.accepted.request
    : (() => {
        throw new Error("The shared accepted media fixture must use FormData.");
      })();

const acceptedMediaPart = acceptedMediaFormDataDescriptor.parts.find(
  (part) => part.kind === "file",
);

if (!acceptedMediaPart || acceptedMediaPart.kind !== "file") {
  throw new Error("The shared accepted media fixture must contain one file.");
}

const acceptedMediaFieldName = acceptedMediaPart.fieldName;

const knownMediaErrorCodes = new Set(
  mediaUploadFixtures.rejected.flatMap((fixture) =>
    fixture.expected.kind === "route-error" ? [fixture.expected.body.code] : [],
  ),
);

const fakeUploadPhaseMs = 250;

function waitForFakeUploadPhase(signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timeoutId = window.setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, fakeUploadPhaseMs);
    const abort = () => {
      window.clearTimeout(timeoutId);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

function defaultReviewCapturePort(): ReviewCapturePort {
  return Object.freeze({
    getDraft: () =>
      Object.freeze({
        kind: "review-verified-draft" as const,
        challengeId: "wall-pass" as const,
        challengeVersion: 1 as const,
      }),
    async upload({ media, onProgress, signal }) {
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      onProgress({ kind: "preparing" });
      await waitForFakeUploadPhase(signal);
      onProgress({
        kind: "progress",
        loaded: Math.floor(media.size / 2),
        total: media.size,
      });
      await waitForFakeUploadPhase(signal);
      onProgress({ kind: "progress", loaded: media.size, total: media.size });
      await waitForFakeUploadPhase(signal);
      return { kind: "accepted" };
    },
  });
}

function formatBytes(size: number) {
  return `${size} bytes`;
}

function buildMediaFormData(media: LocalMedia) {
  const formData = new FormData();
  formData.append(acceptedMediaFieldName, media.file, media.name);
  return formData;
}

function uploadErrorMessage(error: RouteError) {
  if (!knownMediaErrorCodes.has(error.code)) {
    return "Não foi possível preparar este vídeo para o envio de revisão.";
  }
  if (
    error.code === "media_too_large" ||
    error.code === "multipart_body_too_large"
  ) {
    return "O vídeo ultrapassa o limite de tamanho. Selecione um arquivo menor.";
  }
  if (error.code === "media_empty") {
    return "O vídeo não contém dados. Escolha outro arquivo.";
  }
  return "Este vídeo não pode ser preparado para revisão. Confira o formato e os requisitos antes de tentar novamente.";
}

declare global {
  interface Window {
    __revelaiReviewCaptureModuleEvaluations?: number;
  }
}

if (typeof window !== "undefined") {
  window.__revelaiReviewCaptureModuleEvaluations =
    (window.__revelaiReviewCaptureModuleEvaluations ?? 0) + 1;
}

type ReviewCaptureRouteProps = Readonly<{ port?: ReviewCapturePort }>;

export function ReviewCaptureRoute({ port }: ReviewCaptureRouteProps) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const previewRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | undefined>(undefined);
  const recorderRef = useRef<MediaRecorder | undefined>(undefined);
  const recorderListenersRef = useRef<
    | Readonly<{
        recorder: MediaRecorder;
        data: EventListener;
        error: EventListener;
        stop: EventListener;
      }>
    | undefined
  >(undefined);
  const chunksRef = useRef<Blob[]>([]);
  const assetRef = useRef<LocalMedia | undefined>(undefined);
  const activeUploadRef = useRef<AbortController | undefined>(undefined);
  const uploadGenerationRef = useRef(0);
  const automaticStopRef = useRef(false);
  const mountedRef = useRef(true);
  const timeoutIdsRef = useRef<Set<number>>(new Set());
  const intervalIdsRef = useRef<Set<number>>(new Set());
  const [defaultPort] = useState(defaultReviewCapturePort);
  const activePort = port ?? defaultPort;
  const [captureState, setCaptureState] = useState<BrowserCaptureState>("idle");
  const [countdown, setCountdown] = useState(5);
  const [preRollSeconds, setPreRollSeconds] = useState(0);
  const [activeSeconds, setActiveSeconds] = useState(0);
  const [captureMessage, setCaptureMessage] = useState(
    "Pronto para gravar ou selecionar um vídeo existente.",
  );
  const [cameraNotice, setCameraNotice] = useState("");
  const [asset, setAsset] = useState<LocalMedia>();
  const [uploadState, setUploadState] = useState<
    | "idle"
    | "preparing"
    | "progress"
    | "retryable-error"
    | "cancelled"
    | "accepted"
    | "route-error"
  >("idle");
  const [uploadMessage, setUploadMessage] = useState("");
  const [uploadProgress, setUploadProgress] = useState<
    Readonly<{ loaded: number; total?: number }> | undefined
  >();

  const clearTimers = () => {
    for (const timeoutId of timeoutIdsRef.current)
      window.clearTimeout(timeoutId);
    timeoutIdsRef.current.clear();
    for (const intervalId of intervalIdsRef.current)
      window.clearInterval(intervalId);
    intervalIdsRef.current.clear();
  };

  const clearCaptureChunks = () => {
    chunksRef.current = [];
  };

  const scheduleTimeout = (callback: () => void, delay: number) => {
    const timeoutId = window.setTimeout(() => {
      timeoutIdsRef.current.delete(timeoutId);
      callback();
    }, delay);
    timeoutIdsRef.current.add(timeoutId);
  };

  const scheduleInterval = (callback: () => void, delay: number) => {
    const intervalId = window.setInterval(callback, delay);
    intervalIdsRef.current.add(intervalId);
  };

  const detachRecorderListeners = () => {
    const listeners = recorderListenersRef.current;
    if (!listeners) return;
    listeners.recorder.removeEventListener("dataavailable", listeners.data);
    listeners.recorder.removeEventListener("error", listeners.error);
    listeners.recorder.removeEventListener("stop", listeners.stop);
    recorderListenersRef.current = undefined;
  };

  const stopTracks = () => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = undefined;
    if (previewRef.current) previewRef.current.srcObject = null;
  };

  const releaseLocalMedia = (updateState = true) => {
    const current = assetRef.current;
    if (current?.previewUrl) URL.revokeObjectURL?.(current.previewUrl);
    assetRef.current = undefined;
    if (updateState && mountedRef.current) setAsset(undefined);
  };

  const isCurrentUpload = (generation: number, controller: AbortController) =>
    mountedRef.current &&
    uploadGenerationRef.current === generation &&
    activeUploadRef.current === controller;

  const finishCaptureError = (
    message: string,
    state: BrowserCaptureState = "error",
  ) => {
    clearTimers();
    detachRecorderListeners();
    const recorder = recorderRef.current;
    recorderRef.current = undefined;
    if (recorder && recorder.state !== "inactive") recorder.stop();
    stopTracks();
    clearCaptureChunks();
    releaseLocalMedia();
    if (!mountedRef.current) return;
    setCaptureState(state);
    setCaptureMessage(message);
  };

  const makeLocalMedia = (
    sourceFile: File,
    file: File,
    wireMime: AcceptedMediaMime,
  ): LocalMedia => {
    const previewUrl =
      typeof URL.createObjectURL === "function"
        ? URL.createObjectURL(sourceFile)
        : undefined;
    return {
      file,
      name: sourceFile.name,
      declaredMime: sourceFile.type,
      wireMime,
      size: sourceFile.size,
      previewUrl,
    };
  };

  const completeRecording = (candidate: RecorderCandidate) => {
    clearTimers();
    detachRecorderListeners();
    recorderRef.current = undefined;
    stopTracks();
    if (!automaticStopRef.current) {
      finishCaptureError(
        "A gravação terminou antes de completar a captura necessária. Descarte e tente novamente.",
      );
      return;
    }
    const chunks = chunksRef.current;
    clearCaptureChunks();
    const blob = new Blob(chunks, { type: candidate.declaredMime });
    if (blob.size === 0) {
      finishCaptureError(
        "A gravação não produziu um vídeo utilizável. Descarte e tente novamente.",
      );
      return;
    }
    const file = new File([blob], candidate.name, {
      type: candidate.declaredMime,
    });
    const recordedMedia = makeLocalMedia(file, file, candidate.declaredMime);
    assetRef.current = recordedMedia;
    setAsset(recordedMedia);
    setCaptureState("preview");
    setCaptureMessage("Gravação concluída. Revise o arquivo antes do envio.");
  };

  const beginRecorder = (stream: MediaStream) => {
    const candidate = selectedRecorderCandidate();
    if (!candidate) {
      stopTracks();
      clearCaptureChunks();
      setCaptureState("unavailable");
      setCaptureMessage(
        "Este navegador não consegue gravar em um formato aceito. Envie um vídeo existente.",
      );
      return;
    }
    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(stream, {
        mimeType: candidate.recorderMime,
      });
    } catch {
      finishCaptureError(
        "Não foi possível iniciar a gravação neste navegador. Envie um vídeo existente.",
        "unavailable",
      );
      return;
    }
    recorderRef.current = recorder;
    chunksRef.current = [];
    automaticStopRef.current = false;
    const data: EventListener = (event) => {
      const blob = (event as BlobEvent).data;
      if (blob?.size > 0) chunksRef.current.push(blob);
    };
    const error: EventListener = () => {
      finishCaptureError(
        "A gravação encontrou um problema. Descarte e tente novamente ou envie um vídeo existente.",
      );
    };
    const stop: EventListener = () => completeRecording(candidate);
    recorderListenersRef.current = { recorder, data, error, stop };
    recorder.addEventListener("dataavailable", data);
    recorder.addEventListener("error", error);
    recorder.addEventListener("stop", stop);
    try {
      recorder.start();
    } catch {
      finishCaptureError(
        "Não foi possível iniciar a gravação neste navegador. Envie um vídeo existente.",
        "unavailable",
      );
      return;
    }
    const startedAt = Date.now();
    setCaptureState("pre-roll");
    setCaptureMessage("Pré-rolagem de calibração em andamento.");
    setPreRollSeconds(0);
    setActiveSeconds(0);
    scheduleInterval(() => {
      const elapsed = Math.floor((Date.now() - startedAt) / 1_000);
      if (elapsed < 4) setPreRollSeconds(elapsed);
      else setActiveSeconds(Math.min(elapsed - 4, 60));
    }, 1_000);
    scheduleTimeout(() => {
      setPreRollSeconds(4);
      setActiveSeconds(0);
      setCaptureState("active");
      setCaptureMessage("Intervalo ativo em andamento.");
    }, 4_000);
    scheduleTimeout(() => {
      automaticStopRef.current = true;
      setCaptureState("stopping");
      setCaptureMessage("Encerrando a gravação após o intervalo ativo.");
      recorder.stop();
    }, 64_000);
  };

  const startCapture = async () => {
    if (activeUploadRef.current) return;
    releaseLocalMedia();
    clearCaptureChunks();
    clearTimers();
    detachRecorderListeners();
    stopTracks();
    setCameraNotice("");
    setUploadState("idle");
    setUploadMessage("");
    setUploadProgress(undefined);
    if (!navigator.mediaDevices?.getUserMedia) {
      setCaptureState("unavailable");
      setCaptureMessage(
        "Este navegador não oferece acesso à câmera. Envie um vídeo existente.",
      );
      return;
    }
    setCaptureState("requesting-permission");
    setCaptureMessage("Solicitando acesso à câmera.");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" } },
        audio: false,
      });
      if (!mountedRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      streamRef.current = stream;
      if (previewRef.current) {
        previewRef.current.srcObject = stream;
        const playback = previewRef.current.play();
        if (playback) void playback.catch(() => undefined);
      }
      const facingMode = stream.getVideoTracks()[0]?.getSettings?.().facingMode;
      if (facingMode && facingMode !== "environment") {
        setCameraNotice(
          "O navegador selecionou uma câmera diferente da traseira. Ajuste o enquadramento antes de gravar.",
        );
      }
      const countdownStartedAt = Date.now();
      setCountdown(5);
      setCaptureState("countdown");
      setCaptureMessage("Prévia ativa durante a contagem regressiva.");
      scheduleInterval(() => {
        const elapsed = Math.floor((Date.now() - countdownStartedAt) / 1_000);
        setCountdown(Math.max(0, 5 - elapsed));
      }, 1_000);
      scheduleTimeout(() => beginRecorder(stream), 5_000);
    } catch {
      finishCaptureError(
        "Não foi possível acessar a câmera. Permita o acesso ou envie um vídeo existente.",
      );
    }
  };

  const selectExistingVideo = (file?: File) => {
    if (!file || activeUploadRef.current) return;
    releaseLocalMedia();
    clearCaptureChunks();
    const normalized = normalizeSelectedMedia(file);
    if (!normalized) {
      finishCaptureError(
        "Escolha um arquivo MP4, MOV ou WebM com tipo declarado correspondente.",
      );
      return;
    }
    if (file.size === 0) {
      finishCaptureError(
        "O vídeo selecionado não contém dados. Escolha outro arquivo.",
      );
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      finishCaptureError(
        "O vídeo selecionado excede o limite exibido. O servidor continua sendo a autoridade para a aceitação.",
      );
      return;
    }
    const localMedia = makeLocalMedia(
      file,
      normalized.file,
      normalized.wireMime,
    );
    assetRef.current = localMedia;
    setAsset(localMedia);
    setCaptureState("preview");
    setCaptureMessage("Vídeo existente selecionado para a revisão de envio.");
    setUploadState("idle");
    setUploadMessage("");
    setUploadProgress(undefined);
  };

  const startUpload = async () => {
    const localMedia = assetRef.current;
    if (!localMedia || activeUploadRef.current) return;
    const controller = new AbortController();
    const generation = uploadGenerationRef.current + 1;
    uploadGenerationRef.current = generation;
    activeUploadRef.current = controller;
    setUploadState("preparing");
    setUploadMessage("Preparando o vídeo para o envio de revisão.");
    setUploadProgress(undefined);
    try {
      const result = await activePort.upload({
        draft: activePort.getDraft(),
        media: localMedia,
        formData: buildMediaFormData(localMedia),
        signal: controller.signal,
        onProgress: (progress) => {
          if (!isCurrentUpload(generation, controller)) return;
          if (progress.kind === "preparing") {
            setUploadState("preparing");
            setUploadMessage("Preparando o vídeo para o envio de revisão.");
            return;
          }
          setUploadState("progress");
          setUploadProgress({ loaded: progress.loaded, total: progress.total });
          setUploadMessage("Enviando o vídeo para a revisão local.");
        },
      });
      if (!isCurrentUpload(generation, controller)) return;
      activeUploadRef.current = undefined;
      if (result.kind === "accepted") {
        releaseLocalMedia();
        clearCaptureChunks();
        setCaptureState("idle");
        setCaptureMessage("Pronto para gravar ou selecionar outro vídeo.");
        setUploadState("accepted");
        setUploadProgress(undefined);
        setUploadMessage(
          "Envio de revisão concluído localmente. Nenhuma tentativa foi criada no servidor.",
        );
      } else if (result.kind === "connection-error") {
        setUploadState("retryable-error");
        setUploadMessage(
          "A conexão foi interrompida antes do envio de revisão. Tente novamente com o mesmo vídeo.",
        );
      } else {
        setUploadState("route-error");
        setUploadMessage(uploadErrorMessage(result.error));
      }
    } catch {
      if (!isCurrentUpload(generation, controller)) return;
      activeUploadRef.current = undefined;
      if (controller.signal.aborted) {
        setUploadState("cancelled");
        setUploadProgress(undefined);
        setUploadMessage(
          "Envio cancelado. Nenhuma resposta do servidor foi simulada.",
        );
      } else {
        setUploadState("retryable-error");
        setUploadMessage(
          "A conexão foi interrompida antes do envio de revisão. Tente novamente com o mesmo vídeo.",
        );
      }
    }
  };

  const cancelUpload = () => {
    const controller = activeUploadRef.current;
    if (!controller) return;
    uploadGenerationRef.current += 1;
    activeUploadRef.current = undefined;
    controller.abort();
    if (!mountedRef.current) return;
    setUploadState("cancelled");
    setUploadProgress(undefined);
    setUploadMessage(
      "Envio cancelado. Nenhuma resposta do servidor foi simulada.",
    );
  };

  useEffect(() => {
    mountedRef.current = true;
    headingRef.current?.focus();
    return () => {
      mountedRef.current = false;
      activeUploadRef.current?.abort();
      activeUploadRef.current = undefined;
      uploadGenerationRef.current += 1;
      clearTimers();
      detachRecorderListeners();
      const recorder = recorderRef.current;
      recorderRef.current = undefined;
      if (recorder && recorder.state !== "inactive") recorder.stop();
      stopTracks();
      clearCaptureChunks();
      releaseLocalMedia(false);
    };
  }, []);

  const isRecording = [
    "requesting-permission",
    "countdown",
    "pre-roll",
    "active",
    "stopping",
  ].includes(captureState);
  const isUploading = uploadState === "preparing" || uploadState === "progress";

  return (
    <main className="verified-capture" aria-labelledby="capture-heading">
      <p className="eyebrow">Captura de revisão</p>
      <h1 id="capture-heading" ref={headingRef} tabIndex={-1}>
        Captura para passe na parede
      </h1>
      <section aria-label="Requisitos da captura">
        <h2>Antes de gravar ou selecionar</h2>
        <ul>
          <li>{captureRequirementLines[0]}</li>
          <li>
            Tamanho máximo de {MAX_UPLOAD_BYTES / 1024 / 1024} MiB. Esta
            conferência no navegador é apenas orientação; o servidor decide a
            aceitação.
          </li>
          {captureRequirementLines.slice(1).map((requirement) => (
            <li key={requirement}>{requirement}</li>
          ))}
        </ul>
      </section>
      <section aria-label="Prévia da câmera" className="capture-preview">
        <video
          ref={previewRef}
          autoPlay
          muted
          playsInline
          aria-label="Prévia da câmera"
        />
        <p role="status">
          Estado da captura: {captureState}. {captureMessage}
        </p>
        {cameraNotice ? <p role="status">{cameraNotice}</p> : null}
        {captureState === "countdown" ? (
          <p>Contagem regressiva: {countdown} segundos</p>
        ) : null}
        {captureState === "pre-roll" ? (
          <p>Pré-rolagem: {preRollSeconds} de 4 segundos</p>
        ) : null}
        {captureState === "active" ? (
          <p>Duração ativa: {activeSeconds} de 60 segundos</p>
        ) : null}
      </section>
      {captureState === "error" || captureState === "unavailable" ? (
        <p role="alert">{captureMessage}</p>
      ) : null}
      <div className="capture-actions">
        <button
          type="button"
          disabled={isRecording || isUploading}
          onClick={() => void startCapture()}
        >
          Iniciar gravação
        </button>
        <button
          type="button"
          disabled={isRecording || isUploading}
          onClick={() => fileInputRef.current?.click()}
        >
          Enviar vídeo existente
        </button>
        <input
          ref={fileInputRef}
          data-testid="existing-video-input"
          type="file"
          accept="video/mp4,video/quicktime,video/webm,.mp4,.mov,.webm"
          tabIndex={-1}
          aria-hidden="true"
          disabled={isUploading}
          onChange={(event) => {
            selectExistingVideo(event.currentTarget.files?.[0]);
            event.currentTarget.value = "";
          }}
        />
        {captureState === "error" || captureState === "unavailable" ? (
          <button type="button" onClick={() => void startCapture()}>
            Tentar novamente
          </button>
        ) : null}
      </div>
      {asset ? (
        <section
          aria-label="Prévia do vídeo selecionado"
          className="capture-file-preview"
        >
          {asset.previewUrl ? (
            <video
              controls
              src={asset.previewUrl}
              aria-label="Prévia do vídeo selecionado"
            />
          ) : null}
          <p>{asset.name}</p>
          <p>
            Tipo declarado:{" "}
            {asset.declaredMime || "não declarado pelo arquivo."}
          </p>
          <p>Formato de envio normalizado: {asset.wireMime}.</p>
          <p>{formatBytes(asset.size)}</p>
          <button
            type="button"
            disabled={isUploading}
            onClick={() => {
              if (activeUploadRef.current) return;
              clearCaptureChunks();
              releaseLocalMedia();
              setCaptureState("idle");
              setCaptureMessage(
                "Vídeo descartado. Selecione ou grave outro vídeo.",
              );
              setUploadState("idle");
              setUploadMessage("");
            }}
          >
            Descartar
          </button>
          <button
            type="button"
            disabled={isUploading}
            onClick={() => void startUpload()}
          >
            Enviar para upload de revisão
          </button>
        </section>
      ) : null}
      {isUploading ? (
        <button type="button" onClick={cancelUpload}>
          Cancelar envio
        </button>
      ) : null}
      {uploadState === "retryable-error" ? (
        <button type="button" onClick={() => void startUpload()}>
          Tentar novamente
        </button>
      ) : null}
      {uploadMessage ? (
        <p
          role={
            uploadState === "retryable-error" || uploadState === "route-error"
              ? "alert"
              : "status"
          }
        >
          {uploadMessage}
          {uploadProgress?.total
            ? ` ${uploadProgress.loaded} de ${uploadProgress.total} bytes.`
            : ""}
        </p>
      ) : null}
    </main>
  );
}
