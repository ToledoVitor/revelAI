export type SetupCameraStatus =
  | "pending"
  | "ready"
  | "denied"
  | "unsupported"
  | "unavailable"
  | "existing-video";

export type SetupGate = Readonly<{
  id: "device" | "space" | "athlete" | "rehearsal" | "record";
  title: string;
  correction: string;
  ready: string;
}>;

export const captureTimingGuidance =
  "A captura completa inclui uma pré-rolagem de calibração de 4 segundos e um intervalo ativo de exatamente 60 segundos.";

export const setupGates: readonly SetupGate[] = [
  {
    id: "device",
    title: "Dispositivo",
    correction: "Simule a disponibilidade da câmera antes de continuar.",
    ready: "Prévia simulada da câmera pronta.",
  },
  {
    id: "space",
    title: "Espaço",
    correction: "Posicione dois marcadores visíveis a três metros da parede.",
    ready: "Os marcadores estão confirmados na prévia. Você pode continuar.",
  },
  {
    id: "athlete",
    title: "Atleta",
    correction:
      "Mantenha o corpo inteiro visível entre os marcadores durante o passe.",
    ready:
      "O enquadramento do atleta está confirmado na prévia. Você pode continuar.",
  },
  {
    id: "rehearsal",
    title: "Ensaio",
    correction: "Ensaie passes na parede alternando os dois pés.",
    ready: "O ensaio está confirmado na prévia. Você pode continuar.",
  },
  {
    id: "record",
    title: "Registro",
    correction:
      "Confira a preparação antes de seguir para a captura completa quando ela estiver disponível.",
    ready:
      "A preparação para o registro está confirmada na prévia. Você pode continuar.",
  },
];

export function setupCameraMessage(status: SetupCameraStatus): string {
  if (status === "ready") return "Prévia simulada da câmera pronta.";
  if (status === "denied")
    return "O acesso à câmera foi negado. Permita o acesso nas configurações do navegador ou use um vídeo existente.";
  if (status === "unsupported")
    return "Este navegador não oferece suporte à prévia da câmera. Use um navegador compatível ou um vídeo existente.";
  if (status === "unavailable")
    return "Nenhuma câmera está disponível. Conecte uma câmera ou use um vídeo existente.";
  if (status === "existing-video")
    return "Vídeo existente escolhido como alternativa de captura. Ele mantém a pré-rolagem de calibração de 4 segundos e o intervalo ativo de exatamente 60 segundos; as próximas orientações continuam necessárias.";
  return "Aguardando simulação da câmera.";
}
