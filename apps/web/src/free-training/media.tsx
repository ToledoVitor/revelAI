import { MAX_UPLOAD_BYTES } from "@revelai/contracts";
import { useEffect, useRef, useState } from "react";
import {
  normalizeSelectedMedia,
  type AcceptedMediaMime,
} from "../verified/capture-media";

type FreeTrainingMediaProps = Readonly<{
  disabled: boolean;
  media?: File;
  onMedia(file?: File): void;
}>;

type LocalFreeMedia = Readonly<{
  sourceFile: File;
  wireFile: File;
  wireMime: AcceptedMediaMime;
  previewUrl?: string;
}>;

const requirements = [
  "MP4, MOV ou WebM.",
  "Duração: 3–180 segundos.",
  "Menor lado: mínimo 480 px.",
  "Vídeo em retrato ou paisagem.",
  "Ao menos 12 fps é a referência nominal do servidor.",
  "Não exigimos fiducial, pré-rolagem, calibração, duração exata, continuidade, câmera traseira, parede, atleta visível nem bola visível.",
] as const;

export function FreeTrainingMedia({
  disabled,
  media,
  onMedia,
}: FreeTrainingMediaProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const localMediaRef = useRef<LocalFreeMedia | undefined>(undefined);
  const [localMedia, setLocalMedia] = useState<LocalFreeMedia>();
  const [message, setMessage] = useState("");

  const releaseLocalMedia = (notifyParent: boolean) => {
    const current = localMediaRef.current;
    if (current?.previewUrl) URL.revokeObjectURL?.(current.previewUrl);
    localMediaRef.current = undefined;
    setLocalMedia(undefined);
    if (notifyParent && current) onMedia(undefined);
  };

  const keepLocalMedia = (
    sourceFile: File,
    wireFile: File,
    wireMime: AcceptedMediaMime,
  ) => {
    releaseLocalMedia(false);
    const previewUrl =
      typeof URL.createObjectURL === "function"
        ? URL.createObjectURL(sourceFile)
        : undefined;
    const next = { sourceFile, wireFile, wireMime, previewUrl };
    localMediaRef.current = next;
    setLocalMedia(next);
    onMedia(wireFile);
  };

  const selectFile = (file?: File) => {
    if (!file || disabled) return;
    const normalized = normalizeSelectedMedia(file);
    if (!normalized) {
      releaseLocalMedia(true);
      setMessage(
        "Escolha um arquivo MP4, MOV ou WebM com tipo declarado correspondente.",
      );
      return;
    }
    if (file.size === 0) {
      releaseLocalMedia(true);
      setMessage(
        "O vídeo selecionado não contém dados. Escolha outro arquivo.",
      );
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      releaseLocalMedia(true);
      setMessage(
        "O vídeo selecionado excede o limite exibido. O servidor continua sendo a autoridade para a aceitação.",
      );
      return;
    }
    setMessage("");
    keepLocalMedia(file, normalized.file, normalized.wireMime);
  };

  useEffect(() => {
    if (!media && localMediaRef.current) releaseLocalMedia(false);
  }, [media]);

  useEffect(
    () => () => {
      const current = localMediaRef.current;
      if (current?.previewUrl) URL.revokeObjectURL?.(current.previewUrl);
      localMediaRef.current = undefined;
    },
    [],
  );

  return (
    <section aria-label="Vídeo do treino livre">
      <section aria-label="Requisitos do treino livre">
        <h2>Antes de selecionar</h2>
        <ul>
          {requirements.map((requirement) => (
            <li key={requirement}>{requirement}</li>
          ))}
          <li>
            Tamanho máximo de {MAX_UPLOAD_BYTES / 1024 / 1024} MiB. O servidor
            confirma o arquivo e a análise.
          </li>
        </ul>
      </section>
      {message ? <p role="alert">{message}</p> : null}
      <input
        ref={inputRef}
        id="free-training-video-input"
        data-testid="free-training-video-input"
        type="file"
        accept="video/mp4,video/quicktime,video/webm,.mp4,.mov,.webm"
        hidden
        disabled={disabled}
        onChange={(event) => {
          selectFile(event.currentTarget.files?.[0]);
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
          <p>Tipo declarado: {localMedia.sourceFile.type || "não declarado"}</p>
          <p>Formato de envio normalizado: {localMedia.wireMime}.</p>
          <p>Tamanho de origem: {localMedia.sourceFile.size} bytes</p>
          <p>Tamanho de envio: {localMedia.wireFile.size} bytes</p>
          <button
            type="button"
            disabled={disabled}
            onClick={() => inputRef.current?.click()}
          >
            Substituir vídeo
          </button>
          <button
            type="button"
            disabled={disabled}
            onClick={() => {
              releaseLocalMedia(true);
              setMessage("Vídeo cancelado. Selecione outro quando quiser.");
            }}
          >
            Cancelar vídeo
          </button>
        </section>
      ) : (
        <button
          type="button"
          disabled={disabled}
          onClick={() => inputRef.current?.click()}
        >
          Selecionar vídeo
        </button>
      )}
    </section>
  );
}
