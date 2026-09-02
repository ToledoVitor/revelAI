import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProductionSetupCamera } from "./production-setup-camera";
import type { SetupCameraStatus } from "./setup-model";

function installMedia(getUserMedia: ReturnType<typeof vi.fn>) {
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia },
  });
}

function CameraHarness() {
  const [status, setStatus] = useState<SetupCameraStatus>("pending");
  return (
    <ProductionSetupCamera
      disabled={false}
      status={status}
      onStatus={setStatus}
    />
  );
}

describe("production setup camera", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    Reflect.deleteProperty(navigator, "mediaDevices");
  });

  it("recovers a denied real-camera request through a named retry and keeps the fallback available", async () => {
    const user = userEvent.setup();
    const stop = vi.fn();
    const getUserMedia = vi
      .fn()
      .mockRejectedValueOnce(new DOMException("denied", "NotAllowedError"))
      .mockResolvedValueOnce({
        getTracks: () => [{ stop }],
      } as unknown as MediaStream);
    installMedia(getUserMedia);
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
    render(<CameraHarness />);

    await user.click(screen.getByRole("button", { name: "Ativar câmera" }));
    expect(
      await screen.findByRole("button", { name: "Tentar novamente" }),
    ).toBeEnabled();
    expect(
      screen.getByRole("button", { name: "Usar vídeo existente" }),
    ).toBeEnabled();

    await user.click(screen.getByRole("button", { name: "Tentar novamente" }));
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("status")).toHaveTextContent(
      "Prévia da câmera pronta.",
    );
    cleanup();
    expect(stop).toHaveBeenCalledOnce();
  });

  it("stops a late permission stream after unmount", async () => {
    const stop = vi.fn();
    let resolveCamera: ((stream: MediaStream) => void) | undefined;
    installMedia(
      vi.fn(
        () =>
          new Promise<MediaStream>((resolve) => {
            resolveCamera = resolve;
          }),
      ),
    );
    const view = render(
      <ProductionSetupCamera
        disabled={false}
        status="pending"
        onStatus={vi.fn()}
      />,
    );

    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Ativar câmera" }));
    view.unmount();
    await act(async () => {
      resolveCamera?.({
        getTracks: () => [{ stop }],
      } as unknown as MediaStream);
      await Promise.resolve();
    });

    expect(stop).toHaveBeenCalledOnce();
  });
});
