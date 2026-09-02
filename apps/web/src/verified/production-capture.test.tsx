import { MAX_UPLOAD_BYTES } from "@revelai/contracts";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProductionCapture } from "./production-capture";

class RecorderMock {
  static isTypeSupported = vi.fn((mime: string) => mime === "video/webm");
  readonly listeners = new Map<string, Set<(event: Event) => void>>();
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
      data: this.blob ?? new Blob(["capture"], { type: this.options.mimeType }),
    });
    this.emit("stop", new Event("stop"));
  });
  blob: Blob | undefined;
  state = "inactive";

  constructor(
    readonly stream: MediaStream,
    readonly options: Readonly<{ mimeType?: string }>,
  ) {}

  emit(type: string, event: Event | { data: Blob }) {
    for (const listener of this.listeners.get(type) ?? [])
      listener(event as Event);
  }
}

function streamHarness(facingMode?: string) {
  const stop = vi.fn();
  return {
    stop,
    stream: {
      getTracks: () => [{ stop }],
      getVideoTracks: () =>
        facingMode ? [{ getSettings: () => ({ facingMode }) }] : [],
    } as unknown as MediaStream,
  };
}

function installRecorder(
  supported: (mime: string) => boolean = (mime) => mime === "video/webm",
) {
  const instances: RecorderMock[] = [];
  const supportedSpy = vi.fn(supported);
  const Mock = class extends RecorderMock {
    static isTypeSupported = supportedSpy;
    constructor(stream: MediaStream, options: Readonly<{ mimeType?: string }>) {
      super(stream, options);
      instances.push(this);
    }
  };
  vi.stubGlobal("MediaRecorder", Mock);
  return { instances, supportedSpy };
}

function installMedia(getUserMedia: ReturnType<typeof vi.fn>) {
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia },
  });
}

describe("production verified capture", () => {
  beforeEach(() => {
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    Reflect.deleteProperty(navigator, "mediaDevices");
  });

  it("shows the approved visual fallback while retaining the real camera and expandable requirements", () => {
    render(<ProductionCapture disabled={false} onMedia={vi.fn()} />);

    expect(
      screen.getByRole("img", {
        name: "Referência visual de uma jogadora treinando futsal",
      }),
    ).toHaveAttribute("src", "/assets/futsal-hero.png");
    expect(
      screen.getByRole("button", { name: "Iniciar gravação" }),
    ).toBeEnabled();
    expect(screen.getByLabelText("Enviar vídeo existente")).toBeEnabled();
    expect(screen.getByText("Requisitos da captura")).toBeVisible();
  });

  it("uses the exact MIME preference and 5 + 4 + 60 second automatic capture timeline", async () => {
    const { stream } = streamHarness();
    const getUserMedia = vi.fn().mockResolvedValue(stream);
    installMedia(getUserMedia);
    const recorder = installRecorder(
      (mime) => mime === "video/webm;codecs=vp8",
    );
    const onMedia = vi.fn();
    render(<ProductionCapture disabled={false} onMedia={onMedia} />);
    vi.useFakeTimers();

    await act(async () => {
      screen.getByRole("button", { name: "Iniciar gravação" }).click();
      await Promise.resolve();
    });
    expect(getUserMedia).toHaveBeenCalledWith({
      video: { facingMode: { ideal: "environment" } },
      audio: false,
    });
    expect(screen.getByText("Contagem regressiva: 5 segundos")).toBeVisible();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(recorder.instances).toHaveLength(1);
    expect(recorder.supportedSpy.mock.calls.map(([mime]) => mime)).toEqual([
      "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
      "video/mp4",
      "video/webm;codecs=vp9",
      "video/webm;codecs=vp8",
    ]);
    expect(screen.getByText("Pré-rolagem: 0 de 4 segundos")).toBeVisible();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000);
    });
    expect(screen.getByText("Duração ativa: 0 de 60 segundos")).toBeVisible();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(recorder.instances[0]?.stop).toHaveBeenCalledOnce();
    expect(onMedia).toHaveBeenCalledWith(
      expect.objectContaining({ name: "wall-pass.webm", type: "video/webm" }),
    );
  });

  it("keeps file selection available after permission and MIME fallback failures", async () => {
    const user = userEvent.setup();
    installMedia(vi.fn().mockRejectedValue(new Error("denied")));
    installRecorder(() => false);
    const onMedia = vi.fn();
    render(<ProductionCapture disabled={false} onMedia={onMedia} />);
    await user.click(screen.getByRole("button", { name: "Iniciar gravação" }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Não foi possível acessar a câmera",
    );
    const file = new File(["video"], "fallback.webm", { type: "video/webm" });
    await user.upload(screen.getByTestId("production-video-input"), file);
    expect(onMedia).toHaveBeenCalledWith(file);
  });

  it("uses the production existing-video and recovery action names", async () => {
    const user = userEvent.setup();
    installMedia(
      vi.fn().mockRejectedValue(new DOMException("denied", "NotAllowedError")),
    );
    installRecorder();
    render(<ProductionCapture disabled={false} onMedia={vi.fn()} />);

    expect(screen.getByLabelText("Enviar vídeo existente")).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Iniciar gravação" }));
    expect(
      await screen.findByRole("button", { name: "Tentar novamente" }),
    ).toBeEnabled();
  });

  it("normalizes an undeclared WebM for the wire while preserving its source metadata and preview lifecycle", async () => {
    const user = userEvent.setup();
    const createObjectUrl = vi.fn(() => "blob:production-webm");
    const revokeObjectUrl = vi.fn();
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: createObjectUrl,
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: revokeObjectUrl,
    });
    const onMedia = vi.fn();
    render(<ProductionCapture disabled={false} onMedia={onMedia} />);

    fireEvent.change(screen.getByTestId("production-video-input"), {
      target: {
        files: [new File(["video"], "source.webm", { type: "" })],
      },
    });

    expect(onMedia).toHaveBeenLastCalledWith(
      expect.objectContaining({ name: "source.webm", type: "video/webm" }),
    );
    expect(
      screen.getByText("Tipo declarado: não declarado pelo arquivo."),
    ).toBeVisible();
    expect(
      screen.getByText("Formato de envio normalizado: video/webm."),
    ).toBeVisible();
    expect(
      screen
        .getAllByLabelText("Prévia do vídeo selecionado")
        .find((element) => element.tagName === "VIDEO"),
    ).toHaveAttribute("src", "blob:production-webm");

    await user.click(screen.getByRole("button", { name: "Descartar" }));
    expect(onMedia).toHaveBeenLastCalledWith(undefined);
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:production-webm");
  });

  it("announces rear-camera fallback and keeps rejected source files out of the verified wire", async () => {
    const user = userEvent.setup();
    const { stream } = streamHarness("user");
    installMedia(vi.fn().mockResolvedValue(stream));
    installRecorder();
    const onMedia = vi.fn();
    render(<ProductionCapture disabled={false} onMedia={onMedia} />);

    await user.click(screen.getByRole("button", { name: "Iniciar gravação" }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(
      screen
        .getAllByRole("status")
        .find((status) =>
          status.textContent?.includes(
            "O navegador selecionou uma câmera diferente da traseira",
          ),
        ),
    ).toBeTruthy();

    const tooLarge = new File(["video"], "large.webm", {
      type: "video/webm",
    });
    Object.defineProperty(tooLarge, "size", {
      configurable: true,
      value: MAX_UPLOAD_BYTES + 1,
    });
    // A busy camera leaves the file input disabled; unmounting/re-mounting
    // models the available existing-video fallback after capture cleanup.
    cleanup();
    render(<ProductionCapture disabled={false} onMedia={onMedia} />);
    await user.upload(screen.getByTestId("production-video-input"), tooLarge);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "excede o limite exibido",
    );
    expect(onMedia).not.toHaveBeenCalled();
  });

  it("discards early, recorder-error, and empty automatic recordings", async () => {
    const first = streamHarness();
    const second = streamHarness();
    const third = streamHarness();
    installMedia(
      vi
        .fn()
        .mockResolvedValueOnce(first.stream)
        .mockResolvedValueOnce(second.stream)
        .mockResolvedValueOnce(third.stream),
    );
    const recorder = installRecorder();
    const onMedia = vi.fn();
    render(<ProductionCapture disabled={false} onMedia={onMedia} />);
    vi.useFakeTimers();

    const start = async () => {
      await act(async () => {
        screen
          .getByRole("button", {
            name: /Iniciar gravação|Tentar novamente/,
          })
          .click();
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(5_000);
      });
    };
    await start();
    await act(async () => {
      recorder.instances[0]?.emit("stop", new Event("stop"));
    });
    expect(screen.getByRole("alert")).toHaveTextContent("terminou antes");
    expect(first.stop).toHaveBeenCalledOnce();

    await start();
    await act(async () => {
      recorder.instances[1]?.emit("error", new Event("error"));
    });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "encontrou um problema",
    );
    expect(second.stop).toHaveBeenCalledOnce();

    await start();
    recorder.instances[2]!.blob = new Blob([], { type: "video/webm" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(64_000);
    });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "não produziu um vídeo utilizável",
    );
    expect(onMedia).not.toHaveBeenCalled();
    expect(third.stop).toHaveBeenCalledOnce();
  });

  it("cleans recorder and tracks when StrictMode unmounts during capture", async () => {
    const { stream, stop } = streamHarness();
    installMedia(vi.fn().mockResolvedValue(stream));
    const recorder = installRecorder();
    const view = render(
      <StrictMode>
        <ProductionCapture disabled={false} onMedia={vi.fn()} />
      </StrictMode>,
    );
    vi.useFakeTimers();
    await act(async () => {
      screen.getByRole("button", { name: "Iniciar gravação" }).click();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(5_000);
    });
    view.unmount();
    expect(recorder.instances[0]?.stop).toHaveBeenCalledOnce();
    expect(
      recorder.instances[0]?.removeEventListener.mock.calls.map(
        ([type]) => type,
      ),
    ).toEqual(["dataavailable", "error", "stop"]);
    expect(stop).toHaveBeenCalledOnce();
  });

  it("stops a stream that resolves after the capture unmounts", async () => {
    const { stream, stop } = streamHarness();
    let resolveCamera: ((value: MediaStream) => void) | undefined;
    installMedia(
      vi.fn(
        () =>
          new Promise<MediaStream>((resolve) => {
            resolveCamera = resolve;
          }),
      ),
    );
    installRecorder();
    const view = render(
      <ProductionCapture disabled={false} onMedia={vi.fn()} />,
    );

    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Iniciar gravação" }));
    view.unmount();
    await act(async () => {
      resolveCamera?.(stream);
      await Promise.resolve();
    });

    expect(stop).toHaveBeenCalledOnce();
  });

  it("falls back before countdown when MediaRecorder is unavailable", async () => {
    const { stream } = streamHarness();
    installMedia(vi.fn().mockResolvedValue(stream));
    Reflect.deleteProperty(globalThis, "MediaRecorder");
    render(<ProductionCapture disabled={false} onMedia={vi.fn()} />);

    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Iniciar gravação" }));
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Este navegador não consegue gravar em um formato aceito",
    );
    expect(screen.queryByText(/Contagem regressiva/)).not.toBeInTheDocument();
  });
});
