import { expect, test } from "@playwright/test";

test("development browser resolves the lazy review capture module without an error", async ({
  page,
}) => {
  const consoleErrors: string[] = [];
  const reviewModuleFailures: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("response", (response) => {
    if (
      response.status() >= 400 &&
      response.url().includes("/verified/capture")
    ) {
      reviewModuleFailures.push(`${response.status()} ${response.url()}`);
    }
  });

  await page.goto("/_test/verified/capture");

  await expect(
    page.getByRole("heading", {
      name: "Captura para passe na parede",
      level: 1,
    }),
  ).toBeVisible();
  expect(consoleErrors).toEqual([]);
  expect(reviewModuleFailures).toEqual([]);
});

test("development StrictMode keeps a live preview playing and the local fake upload cancellable", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: async () => {
          const canvas = document.createElement("canvas");
          canvas.height = 2;
          canvas.width = 2;
          return canvas.captureStream(1);
        },
      },
    });
  });

  await page.goto("/_test/verified/capture");
  await page.getByRole("button", { name: "Iniciar gravação" }).click();
  await expect(page.getByText("Contagem regressiva: 5 segundos")).toBeVisible();

  const livePreview = page.locator('video[aria-label="Prévia da câmera"]');
  await expect
    .poll(() =>
      livePreview.evaluate((element) => {
        const video = element as HTMLVideoElement;
        return {
          autoplay: video.autoplay,
          hasStream: video.srcObject !== null,
          paused: video.paused,
        };
      }),
    )
    .toEqual({ autoplay: true, hasStream: true, paused: false });

  await page.goto("/_test/verified/capture");
  await page.locator('[data-testid="existing-video-input"]').setInputFiles({
    name: "existing-wall-pass.webm",
    mimeType: "video/webm",
    buffer: Buffer.from("existing-wall-pass"),
  });
  await page
    .getByRole("button", { name: "Enviar para upload de revisão" })
    .click();
  await expect(
    page.getByText("Preparando o vídeo para o envio de revisão."),
  ).toBeVisible();
  await page.getByRole("button", { name: "Cancelar envio" }).click();
  await expect(
    page.getByText(
      "Envio cancelado. Nenhuma resposta do servidor foi simulada.",
    ),
  ).toBeVisible();
});
