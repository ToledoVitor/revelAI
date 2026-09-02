export {
  normalizeSelectedMedia,
  selectedMediaMime,
  type AcceptedMediaMime,
} from "../lib/media/selected-media";

export type RecorderCandidate = Readonly<{
  recorderMime: string;
  name: "wall-pass.mp4" | "wall-pass.webm";
  declaredMime: "video/mp4" | "video/webm";
}>;

export const recorderCandidates: readonly RecorderCandidate[] = [
  {
    recorderMime: "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
    name: "wall-pass.mp4",
    declaredMime: "video/mp4",
  },
  {
    recorderMime: "video/mp4",
    name: "wall-pass.mp4",
    declaredMime: "video/mp4",
  },
  {
    recorderMime: "video/webm;codecs=vp9",
    name: "wall-pass.webm",
    declaredMime: "video/webm",
  },
  {
    recorderMime: "video/webm;codecs=vp8",
    name: "wall-pass.webm",
    declaredMime: "video/webm",
  },
  {
    recorderMime: "video/webm",
    name: "wall-pass.webm",
    declaredMime: "video/webm",
  },
];

export const captureRequirementLines = [
  "MP4 (video/mp4), MOV (video/quicktime) e WebM (video/webm).",
  "Vídeo em paisagem, mínimo 1280×720, proporção 1,30–2,00 e ao menos 24 fps.",
  "Um único vídeo contínuo de 64,0–65,0 segundos: pré-rolagem [0,4) e intervalo ativo [4,64).",
  "Duas placas fiduciais quadradas de 0,20 m no chão. Parede/chão é Y=0, Y positivo aponta ao atleta e X negativo fica à esquerda.",
  "Centro A (-1,50, 3,00) m; cantos TL/TR/BR/BL: (-1,60,2,90), (-1,40,2,90), (-1,40,3,10), (-1,60,3,10). Centro B (1,50, 3,00) m; cantos: (1,40,2,90), (1,60,2,90), (1,60,3,10), (1,40,3,10).",
] as const;

export function selectedRecorderCandidate(): RecorderCandidate | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  return recorderCandidates.find((candidate) =>
    MediaRecorder.isTypeSupported(candidate.recorderMime),
  );
}
