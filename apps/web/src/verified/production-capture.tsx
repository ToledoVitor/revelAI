import { useEffect, useRef, useState } from "react";

type CaptureState =
  | "idle"
  | "requesting-permission"
  | "countdown"
  | "pre-roll"
  | "active"
  | "stopping"
  | "error";

type RecorderCandidate = Readonly<{
  mime: string;
  name: "wall-pass.mp4" | "wall-pass.webm";
  declaredMime: "video/mp4" | "video/webm";
}>;

const candidates: readonly RecorderCandidate[] = [
  {
    mime: "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
    name: "wall-pass.mp4",
    declaredMime: "video/mp4",
  },
  { mime: "video/mp4", name: "wall-pass.mp4", declaredMime: "video/mp4" },
  {
    mime: "video/webm;codecs=vp9",
    name: "wall-pass.webm",
    declaredMime: "video/webm",
  },
  {
    mime: "video/webm;codecs=vp8",
    name: "wall-pass.webm",
    declaredMime: "video/webm",
  },
  { mime: "video/webm", name: "wall-pass.webm", declaredMime: "video/webm" },
];

export function ProductionCapture({
  disabled,
  media,
  onMedia,
}: Readonly<{
  disabled: boolean;
  media?: File;
  onMedia(file: File): void;
}>) {
  const previewRef = useRef<HTMLVideoElement>(null);
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
  const autoStopRef = useRef(false);
  const [state, setState] = useState<CaptureState>("idle");
  const [message, setMessage] = useState(
    "Pronto para gravar ou selecionar um vídeo existente.",
  );
  const [countdown, setCountdown] = useState(5);
  const [preRoll, setPreRoll] = useState(0);
  const [active, setActive] = useState(0);

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
    const candidate = candidates.find((item) =>
      MediaRecorder.isTypeSupported(item.mime),
    );
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
      recorder = new MediaRecorder(stream, { mimeType: candidate.mime });
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
      onMedia(
        new File([blob], candidate.name, { type: candidate.declaredMime }),
      );
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
    clearTimers();
    stopTracks();
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
      streamRef.current = stream;
      if (previewRef.current) {
        previewRef.current.srcObject = stream;
        void previewRef.current.play().catch(() => undefined);
      }
      setState("countdown");
      setMessage("Prévia ativa durante a contagem regressiva.");
      setCountdown(5);
      for (let second = 1; second <= 5; second += 1)
        schedule(() => setCountdown(5 - second), second * 1_000);
      schedule(() => beginRecorder(stream), 5_000);
    } catch {
      fail(
        "Não foi possível acessar a câmera. Permita o acesso ou envie um vídeo existente.",
      );
    }
  };

  useEffect(
    () => () => {
      clearTimers();
      const recorder = recorderRef.current;
      recorderRef.current = undefined;
      detachRecorderListeners();
      if (recorder && recorder.state !== "inactive") recorder.stop();
      stopTracks();
      chunksRef.current = [];
    },
    [],
  );

  const busy = [
    "requesting-permission",
    "countdown",
    "pre-roll",
    "active",
    "stopping",
  ].includes(state);
  return (
    <section aria-label="Captura do vídeo verificado">
      <video
        ref={previewRef}
        autoPlay
        muted
        playsInline
        aria-label="Prévia da câmera"
      />
      <p role={state === "error" ? "alert" : "status"}>
        Estado da captura: {state}. {message}
      </p>
      {state === "countdown" ? (
        <p>Contagem regressiva: {countdown} segundos</p>
      ) : null}
      {state === "pre-roll" ? (
        <p>Pré-rolagem: {preRoll} de 4 segundos</p>
      ) : null}
      {state === "active" ? (
        <p>Duração ativa: {active} de 60 segundos</p>
      ) : null}
      <button
        type="button"
        disabled={disabled || busy}
        onClick={() => void start()}
      >
        Iniciar gravação
      </button>
      <label htmlFor="production-video-input">Selecionar vídeo</label>
      <input
        id="production-video-input"
        data-testid="production-video-input"
        type="file"
        accept="video/mp4,video/quicktime,video/webm,.mp4,.mov,.webm"
        disabled={disabled || busy}
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          if (file) onMedia(file);
        }}
      />
      {media ? <p>{media.name}</p> : null}
    </section>
  );
}
