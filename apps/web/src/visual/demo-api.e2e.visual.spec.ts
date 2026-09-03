import { expect, test, type Page, type Request } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const webRoot = fileURLToPath(new URL("../../", import.meta.url));
const mediaDirectory = resolve(webRoot, "coverage/demo-media");
const freeMedia = resolve(mediaDirectory, "free-portrait.mp4");
const verifiedMedia = resolve(mediaDirectory, "verified-landscape.mp4");
const demoE2EEnabled = process.env.REVELAI_DEMO_E2E === "true";
// A real verified trace handles 640 durable frames. Keep the finite E2E
// outcome budget derived from the actual stages instead of adding retries or
// replacing the runtime: transport, C5's 30-second process cap, C8's durable
// reconstruction/analysis, one capped pending poll, and CI scheduling margin.
const verifiedUploadBudgetMs = 30_000;
const verifiedExtractionBudgetMs = 30_000;
const verifiedAnalysisBudgetMs = 30_000;
const verifiedPendingPollBudgetMs = 5_000;
const verifiedCiSchedulingMarginMs = 25_000;
const verifiedResultTimeoutMs =
  verifiedUploadBudgetMs +
  verifiedExtractionBudgetMs +
  verifiedAnalysisBudgetMs +
  verifiedPendingPollBudgetMs +
  verifiedCiSchedulingMarginMs;

test.skip(
  !demoE2EEnabled,
  "The real demo API suite runs only through playwright.demo.config.ts.",
);

type ObservedRequest = Readonly<{
  method: string;
  path: string;
  request: Request;
}>;

function observeApiRequests(page: Page) {
  const requests: ObservedRequest[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/v1/")) {
      requests.push({ method: request.method(), path: url.pathname, request });
    }
  });
  return requests;
}

function observeBrowserErrors(page: Page) {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

function requestByPath(
  requests: readonly ObservedRequest[],
  method: string,
  path: string,
) {
  const request = requests.find(
    (candidate) => candidate.method === method && candidate.path === path,
  );
  if (!request) throw new Error(`Missing ${method} ${path}.`);
  return request.request;
}

async function completeVerifiedSetup(page: Page) {
  for (let index = 0; index < 5; index += 1) {
    await page
      .getByRole("button", {
        name: index === 0 ? "Usar vídeo existente" : "Confirmar etapa",
      })
      .click();
    await page.getByRole("button", { name: "Continuar" }).click();
  }
}

test("production build drives Free Training through the real demo API boundary", async ({
  page,
}) => {
  const requests = observeApiRequests(page);
  const browserErrors = observeBrowserErrors(page);

  await page.goto("/");
  await page.getByRole("button", { name: "Treino livre" }).click();
  const owner = page.getByRole("main", {
    name: "Treino livre — análise aproximada",
  });
  await expect(owner).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Selecionar vídeo" }),
  ).toBeEnabled();
  await page.locator("#free-training-video-input").setInputFiles(freeMedia);
  await expect(
    page.getByRole("button", { name: "Enviar vídeo", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Enviar vídeo", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Atualizar agora" }),
  ).toBeVisible();
  await expect(
    page.getByRole("main", { name: "Treino livre — análise aproximada" }),
  ).toContainText("Análise aproximada gerada pelo servidor.", {
    timeout: 45_000,
  });

  const create = requestByPath(requests, "POST", "/v1/attempts");
  expect(create.postDataJSON()).toEqual({ mode: "free" });
  const upload = requests.find(
    (request) =>
      request.method === "POST" &&
      /^\/v1\/attempts\/[^/]+\/media$/.test(request.path),
  );
  expect(upload).toBeDefined();
  await expect(upload?.request.headerValue("content-type")).resolves.toContain(
    "multipart/form-data",
  );

  const body = await owner.innerText();
  expect(body).not.toMatch(
    /score|ranking|rank|percentil|top percent|verified|leaderboard/i,
  );
  await page.getByRole("link", { name: "Meus treinos", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Meus treinos neste dispositivo" }),
  ).toBeVisible();
  await expect(
    page.getByText("Treino livre — análise aproximada"),
  ).toBeVisible();
  expect(browserErrors).toEqual([]);
});

test("production build drives the verified demo trace without a ranking claim", async ({
  page,
}) => {
  const requests = observeApiRequests(page);
  const browserErrors = observeBrowserErrors(page);

  await page.goto("/");
  await page.getByRole("button", { name: "Desafio verificado" }).click();
  await expect(
    page.getByRole("heading", { name: "Escolha. Prepare. Compita." }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Preparar desafio" }).click();
  await completeVerifiedSetup(page);
  await expect(
    page.getByRole("heading", { name: "Envie o vídeo verificado" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Enviar vídeo", exact: true }),
  ).toBeDisabled();
  await page.locator("#production-video-input").setInputFiles(verifiedMedia);
  await expect(
    page.getByRole("button", { name: "Enviar vídeo", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Enviar vídeo", exact: true }).click();
  await expect(
    page.getByRole("progressbar", { name: "Envio do vídeo verificado" }),
  ).toBeVisible();
  const report = page.getByRole("main", {
    name: "Resultado do desafio verificado",
  });
  await expect(report).toBeVisible({ timeout: verifiedResultTimeoutMs });
  await expect(report.getByText("Demo — não vale para ranking")).toBeVisible();
  expect(await report.innerText()).not.toMatch(
    /posição|percentil|top percent|ranking no resultado/i,
  );

  const calibration = requestByPath(
    requests,
    "POST",
    "/v1/calibration-sessions",
  );
  expect(calibration.postDataJSON()).toEqual({
    challengeId: "wall-pass",
    challengeVersion: 1,
  });
  const ready = requests.find(
    (request) =>
      request.method === "POST" &&
      /^\/v1\/calibration-sessions\/[^/]+\/ready$/.test(request.path),
  );
  expect(ready).toBeDefined();
  expect(ready?.request.postDataJSON()).toEqual({
    requiredGates: ["device", "space", "athlete", "rehearsal", "record"],
  });
  const attempt = requestByPath(requests, "POST", "/v1/attempts");
  expect(attempt.postDataJSON()).toMatchObject({
    mode: "verified",
    challengeId: "wall-pass",
    challengeVersion: 1,
  });
  const upload = requests.find(
    (request) =>
      request.method === "POST" &&
      /^\/v1\/attempts\/[^/]+\/media$/.test(request.path),
  );
  expect(upload).toBeDefined();
  await expect(upload?.request.headerValue("content-type")).resolves.toContain(
    "multipart/form-data",
  );

  await report.getByRole("link", { name: "Ver Ranking atual" }).click();
  const leaderboard = page.getByRole("main", { name: "Ranking atual" });
  await expect(leaderboard).toContainText(
    "Ainda não há resultados no ranking atual.",
  );
  expect(requests).toContainEqual(
    expect.objectContaining({
      method: "GET",
      path: "/v1/leaderboards/wall-pass",
    }),
  );
  expect(browserErrors).toEqual([]);
});
