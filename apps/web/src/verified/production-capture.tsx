import { MAX_UPLOAD_BYTES } from "@revelai/contracts";
import { UploadSimple } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import {
  captureRequirementLines,
  normalizeSelectedMedia,
  selectedRecorderCandidate,
  type AcceptedMediaMime,
} from "./capture-media";

type CaptureState =
  | "idle"
  | "requesting-permission"
  | "countdown"
  | "pre-roll"
  | "active"
  | "stopping"
  | "error";

type LocalProductionMedia = Readonly<{
  sourceFile: File;
  wireFile: File;
  wireMime: AcceptedMediaMime;
  previewUrl?: string;
}>;

export function ProductionCapture({
  disabled,
  media,
  onMedia,
}: Readonly<{
  disabled: boolean;
  media?: File;
  onMedia(file?: File): void;
}>) {
  const previewRef = useRef<HTMLVideoElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const streamRef = useRef<MediaStream | undefined>(undefined);
  const recorderRef = useRef<MediaRecorder | undefined>(undefined);
  const recorderListenersRef = useRef<
    | Readonly<{
        recorder: MediaRecorder;
        data: (event: Event) => void;
        error: (event: Event) => void;
        stop: (event: Event) => void;
      }>
    | undefined
  >(undefined);
  const timerIdsRef = useRef<Set<number>>(new Set());
  const chunksRef = useRef<Blob[]>([]);
  const localMediaRef = useRef<LocalProductionMedia | undefined>(undefined);
  const autoStopRef = useRef(false);
  const mountedRef = useRef(true);
  const captureGenerationRef = useRef(0);
  const [state, setState] = useState<CaptureState>("idle");
  const [message, setMessage] = useState(
    "Pronto para gravar ou selecionar um vídeo existente.",
  );
  const [countdown, setCountdown] = useState(5);
  const [preRoll, setPreRoll] = useState(0);
  const [active, setActive] = useState(0);
  const [cameraNotice, setCameraNotice] = useState("");
  const [localMedia, setLocalMedia] = useState<LocalProductionMedia>();
  const [hasLivePreview, setHasLivePreview] = useState(false);

  const clearTimers = () => {
    for (const timer of timerIdsRef.current) window.clearTimeout(timer);
    timerIdsRef.current.clear();
  };
  const schedule = (callback: () => void, delay: number) => {
    const timer = window.setTimeout(() => {
      timerIdsRef.current.delete(timer);
      callback();
    }, delay);
    timerIdsRef.current.add(timer);
  };
  const stopTracks = () => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = undefined;
    if (previewRef.current) previewRef.current.srcObject = null;
    if (mountedRef.current) setHasLivePreview(false);
  };
  const releaseLocalMedia = (notifyParent = false) => {
    const current = localMediaRef.current;
    if (current?.previewUrl) URL.revokeObjectURL?.(current.previewUrl);
    localMediaRef.current = undefined;
    if (mountedRef.current) setLocalMedia(undefined);
    if (notifyParent && current) onMedia(undefined);
  };
  const keepLocalMedia = (
    sourceFile: File,
    wireFile: File,
    wireMime: AcceptedMediaMime,
  ) => {
    releaseLocalMedia();
    const previewUrl =
      typeof URL.createObjectURL === "function"
        ? URL.createObjectURL(sourceFile)
        : undefined;
    const next = { sourceFile, wireFile, wireMime, previewUrl };
    localMediaRef.current = next;
    setLocalMedia(next);
    onMedia(wireFile);
  };
  const detachRecorderListeners = () => {
    const listeners = recorderListenersRef.current;
    if (!listeners) return;
    listeners.recorder.removeEventListener("dataavailable", listeners.data);
    listeners.recorder.removeEventListener("error", listeners.error);
    listeners.recorder.removeEventListener("stop", listeners.stop);
    recorderListenersRef.current = undefined;
  };
  const fail = (nextMessage: string) => {
    clearTimers();
    const recorder = recorderRef.current;
    recorderRef.current = undefined;
    detachRecorderListeners();
    if (recorder && recorder.state !== "inactive") recorder.stop();
    stopTracks();
    chunksRef.current = [];
    setState("error");
    setMessage(nextMessage);
  };

  const beginRecorder = (stream: MediaStream) => {
    if (typeof MediaRecorder === "undefined") {
      stopTracks();
      if (mountedRef.current) {
        setState("error");
        setMessage(
          "Este navegador não consegue gravar em um formato aceito. Envie um vídeo existente.",
        );
      }
      return;
    }
    const candidate = selectedRecorderCandidate();
    if (!candidate) {
      stopTracks();
      setState("error");
      setMessage(
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
      fail(
        "Não foi possível iniciar a gravação neste navegador. Envie um vídeo existente.",
      );
      return;
    }
    recorderRef.current = recorder;
    chunksRef.current = [];
    autoStopRef.current = false;
    const onData = (event: Event) => {
      const data = (event as BlobEvent).data;
      if (data.size > 0) chunksRef.current.push(data);
    };
    const onError = () =>
      fail(
        "A gravação encontrou um problema. Descarte e tente novamente ou envie um vídeo existente.",
      );
    const onStop = () => {
      clearTimers();
      recorderRef.current = undefined;
      detachRecorderListeners();
      stopTracks();
      if (!autoStopRef.current) {
        setState("error");
        setMessage(
          "A gravação terminou antes de completar a captura necessária. Descarte e tente novamente.",
        );
        chunksRef.current = [];
        return;
      }
      const blob = new Blob(chunksRef.current, {
        type: candidate.declaredMime,
      });
      chunksRef.current = [];
      if (blob.size === 0) {
        setState("error");
        setMessage(
          "A gravação não produziu um vídeo utilizável. Descarte e tente novamente.",
        );
        return;
      }
      const file = new File([blob], candidate.name, {
        type: candidate.declaredMime,
      });
      keepLocalMedia(file, file, candidate.declaredMime);
      setState("idle");
      setMessage("Gravação concluída. Revise o arquivo antes do envio.");
    };
    recorder.addEventListener("dataavailable", onData);
    recorder.addEventListener("error", onError);
    recorder.addEventListener("stop", onStop);
    recorderListenersRef.current = {
      recorder,
      data: onData,
      error: onError,
      stop: onStop,
    };
    try {
      recorder.start();
      setState("pre-roll");
      setMessage("Pré-rolagem de calibração em andamento.");
      setPreRoll(0);
      setActive(0);
      schedule(() => {
        setPreRoll(4);
        setState("active");
        setMessage("Intervalo ativo em andamento.");
      }, 4_000);
      for (let second = 1; second <= 4; second += 1)
        schedule(() => setPreRoll(second), second * 1_000);
      for (let second = 1; second <= 60; second += 1)
        schedule(() => setActive(second), (second + 4) * 1_000);
      schedule(() => {
        autoStopRef.current = true;
        setState("stopping");
        setMessage("Encerrando a gravação após o intervalo ativo.");
        recorder.stop();
      }, 64_000);
    } catch {
      fail(
        "Não foi possível iniciar a gravação neste navegador. Envie um vídeo existente.",
      );
    }
  };

  const start = async () => {
    if (disabled) return;
    const generation = ++captureGenerationRef.current;
    clearTimers();
    stopTracks();
    releaseLocalMedia(true);
    setCameraNotice("");
    if (typeof MediaRecorder === "undefined") {
      setState("error");
      setMessage(
        "Este navegador não consegue gravar em um formato aceito. Envie um vídeo existente.",
      );
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setState("error");
      setMessage(
        "Este navegador não oferece acesso à câmera. Envie um vídeo existente.",
      );
      return;
    }
    setState("requesting-permission");
    setMessage("Solicitando acesso à câmera.");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" } },
        audio: false,
      });
      if (!mountedRef.current || generation !== captureGenerationRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      streamRef.current = stream;
      setHasLivePreview(true);
      if (previewRef.current) {
        previewRef.current.srcObject = stream;
        void previewRef.current.play().catch(() => undefined);
      }
      const facingMode = stream
        .getVideoTracks?.()[0]
        ?.getSettings?.().facingMode;
      if (facingMode && facingMode !== "environment") {
        setCameraNotice(
          "O navegador selecionou uma câmera diferente da traseira. Ajuste o enquadramento antes de gravar.",
        );
      }
      setState("countdown");
      setMessage("Prévia ativa durante a contagem regressiva.");
      setCountdown(5);
      for (let second = 1; second <= 5; second += 1)
        schedule(() => setCountdown(5 - second), second * 1_000);
      schedule(() => beginRecorder(stream), 5_000);
    } catch {
      if (!mountedRef.current || generation !== captureGenerationRef.current)
        return;
      fail(
        "Não foi possível acessar a câmera. Permita o acesso ou envie um vídeo existente.",
      );
    }
  };

  const selectExistingVideo = (file?: File) => {
    if (!file || disabled || busy) return;
    const normalized = normalizeSelectedMedia(file);
    if (!normalized) {
      releaseLocalMedia(true);
      setState("error");
      setMessage(
        "Escolha um arquivo MP4, MOV ou WebM com tipo declarado correspondente.",
      );
      return;
    }
    if (file.size === 0) {
      releaseLocalMedia(true);
      setState("error");
      setMessage(
        "O vídeo selecionado não contém dados. Escolha outro arquivo.",
      );
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      releaseLocalMedia(true);
      setState("error");
      setMessage(
        "O vídeo selecionado excede o limite exibido. O servidor continua sendo a autoridade para a aceitação.",
      );
      return;
    }
    keepLocalMedia(file, normalized.file, normalized.wireMime);
    setState("idle");
    setMessage("Vídeo existente selecionado. Revise o arquivo antes do envio.");
  };

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      captureGenerationRef.current += 1;
      clearTimers();
      const recorder = recorderRef.current;
      recorderRef.current = undefined;
      detachRecorderListeners();
      if (recorder && recorder.state !== "inactive") recorder.stop();
      stopTracks();
      chunksRef.current = [];
      releaseLocalMedia();
    };
  }, []);

  const busy = [
    "requesting-permission",
    "countdown",
    "pre-roll",
    "active",
    "stopping",
  ].includes(state);
  return (
    <section
      className="production-capture"
      aria-label="Captura do vídeo verificado"
    >
      <details className="capture-requirements">
        <summary>Requisitos da captura</summary>
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
      </details>
      <section
        className="capture-preview"
        aria-label="Prévia da câmera"
        data-live={hasLivePreview}
        data-visual-landmark="capture-preview"
      >
        {!hasLivePreview ? (
          <img
            className="capture-fallback-image"
            src="/assets/futsal-hero.png"
            alt="Referência visual de uma jogadora treinando futsal"
          />
        ) : null}
        <video
          ref={previewRef}
          className="capture-live-preview"
          autoPlay
          muted
          playsInline
          aria-label="Prévia da câmera"
        />
        <p role={state === "error" ? "alert" : "status"}>
          Estado da captura: {state}. {message}
        </p>
        {cameraNotice ? <p role="status">{cameraNotice}</p> : null}
        {state === "countdown" ? (
          <p>Contagem regressiva: {countdown} segundos</p>
        ) : null}
        {state === "pre-roll" ? (
          <p>Pré-rolagem: {preRoll} de 4 segundos</p>
        ) : null}
        {state === "active" ? (
          <p>Duração ativa: {active} de 60 segundos</p>
        ) : null}
      </section>
      <div className="capture-actions">
        <button
          type="button"
          data-visual-landmark="capture-start"
          disabled={disabled || busy}
          onClick={() => void start()}
        >
          {state === "error" ? "Tentar novamente" : "Iniciar gravação"}
        </button>
        <button
          className="capture-file-select"
          type="button"
          data-visual-landmark="capture-file-select"
          disabled={disabled || busy}
          onClick={() => fileInputRef.current?.click()}
        >
          <UploadSimple aria-hidden="true" weight="light" />
          Enviar vídeo existente
        </button>
      </div>
      <input
        id="production-video-input"
        ref={fileInputRef}
        data-testid="production-video-input"
        type="file"
        accept="video/mp4,video/quicktime,video/webm,.mp4,.mov,.webm"
        disabled={disabled || busy}
        onChange={(event) => {
          selectExistingVideo(event.currentTarget.files?.[0]);
          event.currentTarget.value = "";
        }}
      />
      {localMedia ? (
        <section aria-label="Prévia do vídeo selecionado">
          {localMedia.previewUrl ? (
            <video
              controls
              src={localMedia.previewUrl}
              aria-label="Prévia do vídeo selecionado"
            />
          ) : null}
          <p>{localMedia.sourceFile.name}</p>
          <p>
            Tipo declarado:{" "}
            {localMedia.sourceFile.type || "não declarado pelo arquivo."}
          </p>
          <p>Formato de envio normalizado: {localMedia.wireMime}.</p>
          <p>{localMedia.sourceFile.size} bytes</p>
          <button
            type="button"
            disabled={disabled || busy}
            onClick={() => {
              releaseLocalMedia(true);
              setState("idle");
              setMessage("Vídeo descartado. Selecione ou grave outro vídeo.");
            }}
          >
            Descartar
          </button>
        </section>
      ) : media ? (
        <p>{media.name}</p>
      ) : null}
    </section>
  );
}
