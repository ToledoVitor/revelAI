import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { mediaUploadFixtures } from "@revelai/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../app";

type StreamHarness = Readonly<{
  stream: MediaStream;
  stopTrack: ReturnType<typeof vi.fn>;
}>;

type RecorderHarness = Readonly<{
  instances: RecorderMock[];
  isTypeSupported: ReturnType<typeof vi.fn>;
}>;

class RecorderMock {
  readonly addEventListener = vi.fn(
    (type: string, listener: (event: Event) => void) => {
      const listeners = this.listeners.get(type) ?? new Set();
      listeners.add(listener);
      this.listeners.set(type, listeners);
    },
  );
  readonly removeEventListener = vi.fn(
    (type: string, listener: (event: Event) => void) => {
      this.listeners.get(type)?.delete(listener);
    },
  );
  readonly start = vi.fn(() => {
    this.state = "recording";
  });
  readonly stop = vi.fn(() => {
    this.state = "inactive";
    this.emit("dataavailable", {
      data:
        this.recordedBlob ??
        new Blob(["recorded-wall-pass"], { type: this.options.mimeType }),
    });
    this.emit("stop", new Event("stop"));
  });
  recordedBlob: Blob | undefined;
  state = "inactive";
  private readonly listeners = new Map<string, Set<(event: Event) => void>>();

  constructor(
    readonly stream: MediaStream,
    readonly options: Readonly<{ mimeType?: string }>,
  ) {}

  emit(type: string, event: Event | Readonly<{ data: Blob }>) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event as Event);
    }
  }
}

function createStream(facingMode = "environment"): StreamHarness {
  const stopTrack = vi.fn();
  const track = {
    getSettings: () => ({ facingMode }),
    stop: stopTrack,
  };
  return {
    stream: {
      getTracks: () => [track],
      getVideoTracks: () => [track],
    } as unknown as MediaStream,
    stopTrack,
  };
}

function installRecorder(
  supportedMime: (mime: string) => boolean = (mime) => mime === "video/webm",
): RecorderHarness {
  const instances: RecorderMock[] = [];
  const isTypeSupported = vi.fn(supportedMime);
  const MediaRecorderMock = class extends RecorderMock {
    static isTypeSupported = isTypeSupported;

    constructor(stream: MediaStream, options: Readonly<{ mimeType?: string }>) {
      super(stream, options);
      instances.push(this);
    }
  };
  vi.stubGlobal("MediaRecorder", MediaRecorderMock);
  return { instances, isTypeSupported };
}

function installMediaDevices(getUserMedia: ReturnType<typeof vi.fn>) {
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia },
  });
}

async function settleCaptureRequest() {
  await act(async () => {
    await Promise.resolve();
  });
}

async function selectExistingVideo(
  user: ReturnType<typeof userEvent.setup>,
  file = new File(["existing-wall-pass"], "existing-wall-pass.webm", {
    type: "video/webm",
  }),
) {
  await user.upload(screen.getByTestId("existing-video-input"), file);
  return file;
}

describe("review verified capture", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/_test/verified/capture");
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    Reflect.deleteProperty(navigator, "mediaDevices");
  });

  it("shows the capture requirements before recording or selecting a file", async () => {
    render(<App />);

    expect(
      await screen.findByRole("heading", {
        name: "Captura para passe na parede",
        level: 1,
      }),
    ).toBeVisible();
    expect(
      screen.getByText(
        "MP4 (video/mp4), MOV (video/quicktime) e WebM (video/webm).",
      ),
    ).toBeVisible();
    expect(screen.getByText(/250 MiB/)).toBeVisible();
    expect(screen.getByText(/1280×720/)).toBeVisible();
    expect(screen.getByText(/64,0–65,0 segundos/)).toBeVisible();
    expect(screen.getByText(/\(-1,50, 3,00\)/)).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Iniciar gravação" }),
    ).toBeEnabled();
    expect(
      screen.getByRole("button", { name: "Enviar vídeo existente" }),
    ).toBeEnabled();
  });

  it("waits five seconds before recording, then uses four-second pre-roll and sixty-second active timing", async () => {
    const { stream } = createStream();
    const getUserMedia = vi.fn().mockResolvedValue(stream);
    installMediaDevices(getUserMedia);
    const recorder = installRecorder();

    render(<App />);
    await screen.findByRole("heading", {
      name: "Captura para passe na parede",
    });
    vi.useFakeTimers();
    await act(async () => {
      screen.getByRole("button", { name: "Iniciar gravação" }).click();
    });
    await settleCaptureRequest();

    expect(getUserMedia).toHaveBeenCalledWith({
      video: { facingMode: { ideal: "environment" } },
      audio: false,
    });
    expect(screen.getByText("Contagem regressiva: 5 segundos")).toBeVisible();
    expect(recorder.instances).toHaveLength(0);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(recorder.instances).toHaveLength(1);
    expect(recorder.instances[0]?.start).toHaveBeenCalledOnce();
    expect(screen.getByText("Pré-rolagem: 0 de 4 segundos")).toBeVisible();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000);
    });
    expect(screen.getByText("Duração ativa: 0 de 60 segundos")).toBeVisible();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(recorder.instances[0]?.stop).toHaveBeenCalledOnce();
    expect(screen.getByText("wall-pass.webm")).toBeVisible();
  });

  it("probes recording MIME candidates in order and announces a non-rear camera fallback", async () => {
    const { stream } = createStream("user");
    installMediaDevices(vi.fn().mockResolvedValue(stream));
    const recorder = installRecorder(
      (mime) => mime === "video/webm;codecs=vp8",
    );

    render(<App />);
    await screen.findByRole("heading", {
      name: "Captura para passe na parede",
    });
    vi.useFakeTimers();
    await act(async () => {
      screen.getByRole("button", { name: "Iniciar gravação" }).click();
    });
    await settleCaptureRequest();

    expect(
      screen.getByText(
        "O navegador selecionou uma câmera diferente da traseira. Ajuste o enquadramento antes de gravar.",
      ),
    ).toHaveAttribute("role", "status");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });

    expect(recorder.isTypeSupported.mock.calls.map(([mime]) => mime)).toEqual([
      "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
      "video/mp4",
      "video/webm;codecs=vp9",
      "video/webm;codecs=vp8",
    ]);
    expect(recorder.instances[0]?.options).toEqual({
      mimeType: "video/webm;codecs=vp8",
    });
  });

  it("keeps existing-video selection available when permission or recorder support fails", async () => {
    const user = userEvent.setup();
    installMediaDevices(vi.fn().mockRejectedValue(new Error("denied")));
    installRecorder(() => false);

    render(<App />);
    await screen.findByRole("heading", {
      name: "Captura para passe na parede",
    });
    await user.click(screen.getByRole("button", { name: "Iniciar gravação" }));
    await settleCaptureRequest();

    expect(
      screen.getByText(
        "Não foi possível acessar a câmera. Permita o acesso ou envie um vídeo existente.",
      ),
    ).toHaveAttribute("role", "alert");
    await selectExistingVideo(user);
    expect(screen.getByText("existing-wall-pass.webm")).toBeVisible();
    expect(screen.getByText("video/webm")).toBeVisible();
  });

  it("falls back truthfully without constructing a recorder when no MIME candidate is supported", async () => {
    const { stream } = createStream();
    installMediaDevices(vi.fn().mockResolvedValue(stream));
    const recorder = installRecorder(() => false);

    render(<App />);
    await screen.findByRole("heading", {
      name: "Captura para passe na parede",
    });
    vi.useFakeTimers();
    await act(async () => {
      screen.getByRole("button", { name: "Iniciar gravação" }).click();
    });
    await settleCaptureRequest();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Este navegador não consegue gravar em um formato aceito. Envie um vídeo existente.",
    );
    expect(recorder.instances).toHaveLength(0);
  });

  it("discards an early system stop instead of offering it to upload", async () => {
    const { stream, stopTrack } = createStream();
    installMediaDevices(vi.fn().mockResolvedValue(stream));
    const recorder = installRecorder();

    render(<App />);
    await screen.findByRole("heading", {
      name: "Captura para passe na parede",
    });
    vi.useFakeTimers();
    await act(async () => {
      screen.getByRole("button", { name: "Iniciar gravação" }).click();
    });
    await settleCaptureRequest();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });

    await act(async () => {
      recorder.instances[0]?.emit("stop", new Event("stop"));
    });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "A gravação terminou antes de completar a captura necessária. Descarte e tente novamente.",
    );
    expect(stopTrack).toHaveBeenCalledOnce();
    expect(
      screen.queryByRole("button", { name: "Enviar para upload de revisão" }),
    ).not.toBeInTheDocument();
  });

  it("cleans up a recorder error and discards an automatically stopped empty Blob", async () => {
    const { stream: errorStream, stopTrack } = createStream();
    const { stream: emptyStream, stopTrack: stopEmptyTrack } = createStream();
    installMediaDevices(
      vi
        .fn()
        .mockResolvedValueOnce(errorStream)
        .mockResolvedValueOnce(emptyStream),
    );
    const recorder = installRecorder();

    render(<App />);
    await screen.findByRole("heading", {
      name: "Captura para passe na parede",
    });
    vi.useFakeTimers();
    await act(async () => {
      screen.getByRole("button", { name: "Iniciar gravação" }).click();
    });
    await settleCaptureRequest();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });

    await act(async () => {
      recorder.instances[0]?.emit("error", new Event("error"));
    });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "A gravação encontrou um problema. Descarte e tente novamente ou envie um vídeo existente.",
    );
    expect(stopTrack).toHaveBeenCalledOnce();
    expect(recorder.instances[0]?.removeEventListener).toHaveBeenCalledTimes(3);
    await act(async () => {
      screen.getByRole("button", { name: "Tentar novamente" }).click();
    });
    await settleCaptureRequest();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    recorder.instances[1]!.recordedBlob = new Blob([], { type: "video/webm" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(64_000);
    });

    expect(screen.getByRole("alert")).toHaveTextContent(
      "A gravação não produziu um vídeo utilizável. Descarte e tente novamente.",
    );
    expect(
      screen.queryByRole("button", { name: "Enviar para upload de revisão" }),
    ).not.toBeInTheDocument();
    expect(stopEmptyTrack).toHaveBeenCalledOnce();
  });

  it("builds exactly the shared C2 media FormData part and preserves metadata across a retryable connection failure", async () => {
    const user = userEvent.setup();
    const upload = vi.fn(
      async (input: {
        onProgress(progress: unknown): void;
        formData: FormData;
      }) => {
        input.onProgress({ kind: "preparing" });
        input.onProgress({ kind: "progress", loaded: 18, total: 18 });
        return { kind: "connection-error" as const };
      },
    );
    const port = {
      getDraft: () => ({
        kind: "review-verified-draft" as const,
        challengeId: "wall-pass" as const,
        challengeVersion: 1 as const,
      }),
      upload,
    };

    render(<App reviewCapturePort={port} />);
    await screen.findByRole("heading", {
      name: "Captura para passe na parede",
    });
    const file = await selectExistingVideo(user);
    await user.click(
      screen.getByRole("button", { name: "Enviar para upload de revisão" }),
    );

    expect(upload).toHaveBeenCalledOnce();
    const formData = upload.mock.calls[0]?.[0].formData;
    const parts = Array.from(formData.entries());
    const fixturePart = mediaUploadFixtures.accepted.request.parts[0];
    expect(parts).toHaveLength(1);
    expect(parts[0]?.[0]).toBe(fixturePart?.fieldName);
    expect(parts[0]?.[1]).toMatchObject({
      name: file.name,
      type: file.type,
      size: file.size,
    });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "A conexão foi interrompida antes do envio de revisão. Tente novamente com o mesmo vídeo.",
    );
    expect(screen.getByText(file.name)).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Tentar novamente" }));
    expect(upload).toHaveBeenCalledTimes(2);
  });

  it("allows cancellation without inventing a server response and maps safe C2 media errors", async () => {
    const user = userEvent.setup();
    const pendingUpload = vi.fn(
      ({ signal }: { signal: AbortSignal }) =>
        new Promise<never>((_, reject) => {
          signal.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        }),
    );
    const port = {
      getDraft: () => ({
        kind: "review-verified-draft" as const,
        challengeId: "wall-pass" as const,
        challengeVersion: 1 as const,
      }),
      upload: pendingUpload,
    };

    render(<App reviewCapturePort={port} />);
    await screen.findByRole("heading", {
      name: "Captura para passe na parede",
    });
    await selectExistingVideo(user);
    await user.click(
      screen.getByRole("button", { name: "Enviar para upload de revisão" }),
    );
    await user.click(screen.getByRole("button", { name: "Cancelar envio" }));

    expect(
      await screen.findByText(
        "Envio cancelado. Nenhuma resposta do servidor foi simulada.",
      ),
    ).toHaveAttribute("role", "status");
    expect(pendingUpload).toHaveBeenCalledOnce();
  });

  it("maps only the safe C2 route-error message while preserving the selected asset", async () => {
    const user = userEvent.setup();
    const byteLimitFixture = mediaUploadFixtures.rejected.find(
      (fixture) => fixture.name === "media-byte-limit-exceeded",
    );
    if (!byteLimitFixture || byteLimitFixture.expected.kind !== "route-error") {
      throw new Error(
        "The shared byte-limit media fixture must be a route error.",
      );
    }
    const port = {
      getDraft: () => ({
        kind: "review-verified-draft" as const,
        challengeId: "wall-pass" as const,
        challengeVersion: 1 as const,
      }),
      upload: vi.fn().mockResolvedValue({
        kind: "route-error" as const,
        error: byteLimitFixture.expected.body,
      }),
    };

    render(<App reviewCapturePort={port} />);
    await screen.findByRole("heading", {
      name: "Captura para passe na parede",
    });
    const file = await selectExistingVideo(user);
    await user.click(
      screen.getByRole("button", { name: "Enviar para upload de revisão" }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "O vídeo ultrapassa o limite de tamanho. Selecione um arquivo menor.",
    );
    expect(
      screen.queryByText(byteLimitFixture.expected.body.message),
    ).not.toBeInTheDocument();
    expect(screen.getByText(file.name)).toBeVisible();
  });

  it("renders preparation and byte progress from the fake upload port", async () => {
    const user = userEvent.setup();
    let resolveUpload: ((result: { kind: "accepted" }) => void) | undefined;
    let publishProgress:
      | ((progress: {
          kind: "progress";
          loaded: number;
          total: number;
        }) => void)
      | undefined;
    const port = {
      getDraft: () => ({
        kind: "review-verified-draft" as const,
        challengeId: "wall-pass" as const,
        challengeVersion: 1 as const,
      }),
      upload: vi.fn(
        ({ onProgress }: { onProgress(progress: unknown): void }) =>
          new Promise<{ kind: "accepted" }>((resolve) => {
            resolveUpload = resolve;
            publishProgress = onProgress as typeof publishProgress;
            onProgress({ kind: "preparing" });
          }),
      ),
    };

    render(<App reviewCapturePort={port} />);
    await screen.findByRole("heading", {
      name: "Captura para passe na parede",
    });
    await selectExistingVideo(user);
    await user.click(
      screen.getByRole("button", { name: "Enviar para upload de revisão" }),
    );

    expect(
      screen.getByText("Preparando o vídeo para o envio de revisão."),
    ).toHaveAttribute("role", "status");
    await act(async () => {
      publishProgress?.({ kind: "progress", loaded: 12, total: 24 });
    });
    expect(
      screen.getByText(
        /Enviando o vídeo para a revisão local\. 12 de 24 bytes\./,
      ),
    ).toHaveAttribute("role", "status");
    expect(
      screen.getByRole("button", { name: "Cancelar envio" }),
    ).toBeVisible();
    await act(async () => {
      resolveUpload?.({ kind: "accepted" });
    });
    expect(
      await screen.findByText(/Envio de revisão concluído localmente/),
    ).toBeVisible();
  });

  it("releases local preview URLs on discard, unmount, and accepted fake handoff", async () => {
    const createObjectUrl = vi.fn(() => "blob:review-preview");
    const revokeObjectUrl = vi.fn();
    const originalCreateObjectUrl = URL.createObjectURL;
    const originalRevokeObjectUrl = URL.revokeObjectURL;
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: createObjectUrl,
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: revokeObjectUrl,
    });
    const user = userEvent.setup();

    try {
      const firstRender = render(<App />);
      await screen.findByRole("heading", {
        name: "Captura para passe na parede",
      });
      await selectExistingVideo(user);
      await user.click(screen.getByRole("button", { name: "Descartar" }));
      expect(revokeObjectUrl).toHaveBeenCalledWith("blob:review-preview");

      await selectExistingVideo(user);
      firstRender.unmount();
      expect(revokeObjectUrl).toHaveBeenCalledTimes(2);

      const secondRender = render(<App />);
      await screen.findByRole("heading", {
        name: "Captura para passe na parede",
      });
      await selectExistingVideo(user);
      await user.click(
        screen.getByRole("button", { name: "Enviar para upload de revisão" }),
      );
      expect(
        await screen.findByText(/Envio de revisão concluído localmente/),
      ).toHaveAttribute("role", "status");
      expect(revokeObjectUrl).toHaveBeenCalledTimes(3);
      secondRender.unmount();
    } finally {
      Object.defineProperty(URL, "createObjectURL", {
        configurable: true,
        value: originalCreateObjectUrl,
      });
      Object.defineProperty(URL, "revokeObjectURL", {
        configurable: true,
        value: originalRevokeObjectUrl,
      });
    }
  });
});
