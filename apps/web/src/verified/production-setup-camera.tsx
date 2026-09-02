import { useEffect, useRef, useState } from "react";
import { setupCameraMessage, type SetupCameraStatus } from "./setup-model";

function cameraFailureStatus(error: unknown): SetupCameraStatus {
  const name =
    typeof error === "object" && error !== null && "name" in error
      ? (error as { name?: unknown }).name
      : undefined;
  if (name === "NotAllowedError" || name === "SecurityError") return "denied";
  if (name === "NotFoundError" || name === "OverconstrainedError")
    return "unavailable";
  return "unavailable";
}

function productionCameraMessage(
  status: SetupCameraStatus,
  requesting: boolean,
): string {
  if (requesting) return "Solicitando acesso à câmera.";
  if (status === "ready") return "Prévia da câmera pronta.";
  if (status === "pending")
    return "Ative a câmera ou use um vídeo existente antes de continuar.";
  return setupCameraMessage(status);
}

export function ProductionSetupCamera({
  disabled,
  status,
  onStatus,
}: Readonly<{
  disabled: boolean;
  status: SetupCameraStatus;
  onStatus(status: SetupCameraStatus): void;
}>) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | undefined>(undefined);
  const mountedRef = useRef(true);
  const generationRef = useRef(0);
  const [requesting, setRequesting] = useState(false);

  const stopPreview = () => {
    const stream = streamRef.current;
    stream?.getTracks().forEach((track) => track.stop());
    streamRef.current = undefined;
    if (videoRef.current) videoRef.current.srcObject = null;
    return stream !== undefined;
  };

  const activateCamera = async () => {
    if (disabled || requesting) return;
    const generation = ++generationRef.current;
    stopPreview();
    if (!navigator.mediaDevices?.getUserMedia) {
      onStatus("unsupported");
      return;
    }
    setRequesting(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" } },
        audio: false,
      });
      if (!mountedRef.current || generation !== generationRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        try {
          void videoRef.current.play().catch(() => undefined);
        } catch {
          // A preview still owns the stream when a browser refuses playback.
        }
      }
      onStatus("ready");
    } catch (error) {
      if (!mountedRef.current || generation !== generationRef.current) return;
      onStatus(cameraFailureStatus(error));
    } finally {
      if (mountedRef.current && generation === generationRef.current)
        setRequesting(false);
    }
  };

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
      if (stopPreview()) onStatus("pending");
    };
  }, [onStatus]);

  const canRetry =
    status === "denied" || status === "unsupported" || status === "unavailable";
  return (
    <section aria-label="Prévia da câmera">
      <video
        ref={videoRef}
        autoPlay
        muted
        playsInline
        aria-label="Prévia da câmera"
      />
      <p role="status">{productionCameraMessage(status, requesting)}</p>
      {status !== "ready" && status !== "existing-video" ? (
        <button
          type="button"
          disabled={disabled || requesting || status === "unsupported"}
          onClick={() => void activateCamera()}
        >
          {canRetry ? "Tentar novamente" : "Ativar câmera"}
        </button>
      ) : null}
      {status !== "ready" && status !== "existing-video" ? (
        <button
          type="button"
          disabled={disabled || requesting}
          onClick={() => {
            generationRef.current += 1;
            stopPreview();
            onStatus("existing-video");
          }}
        >
          Usar vídeo existente
        </button>
      ) : null}
    </section>
  );
}
