import { access, readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { captureHomeVisualArtifacts } from "./visual-harness.node";

test("keeps the home layout and controls usable at each approved viewport", async ({
  page,
}, testInfo) => {
  await page.goto("/");

  const heading = page.getByRole("heading", {
    name: "Treine. Grave. Evolua.",
    level: 1,
  });
  const hero = page.getByRole("img", {
    name: "Jogador de futsal treinando em quadra interna",
  });

  await expect(heading).toBeVisible();
  await expect(hero).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Treino livre" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Desafio verificado" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Analisar treino" }),
  ).toBeVisible();

  const headingBox = await heading.boundingBox();
  const heroBox = await hero.boundingBox();
  expect(headingBox).not.toBeNull();
  expect(heroBox).not.toBeNull();

  if (testInfo.project.name === "desktop-home") {
    expect(heroBox!.x).toBeGreaterThan(headingBox!.x);
    await expect(
      page.getByRole("navigation", { name: "Navegação principal" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Abrir navegação" }),
    ).toBeHidden();
  } else {
    await expect(
      page.getByRole("button", { name: "Abrir navegação" }),
    ).toBeVisible();
    await expect(
      page.getByRole("navigation", { name: "Navegação principal" }),
    ).toBeHidden();
  }
});

test("keeps every mobile home decision in the 390 by 844 viewport", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-home");
  await page.goto("/");

  const requiredControls = [
    page.getByRole("link", { name: "RevelAI" }),
    page.getByRole("heading", { name: "Treine. Grave. Evolua.", level: 1 }),
    page.getByText(
      "Análises de visão computacional para jogadores de futsal que querem mais.",
    ),
    page.getByRole("button", { name: "Treino livre" }),
    page.getByRole("button", { name: "Desafio verificado" }),
    page.getByRole("button", { name: "Analisar treino" }),
  ];

  expect(
    await page.evaluate(() => document.documentElement.scrollHeight),
  ).toBeLessThanOrEqual(844);

  for (const control of requiredControls) {
    const box = await control.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.y + box!.height).toBeLessThanOrEqual(844);
  }
});

test("writes normalized capture, metadata, overlay, and diff for each approved reference", async ({
  page,
}, testInfo) => {
  await page.goto("/");

  const artifacts = await captureHomeVisualArtifacts({
    page,
    viewport: testInfo.project.use.viewport as {
      width: number;
      height: number;
    },
    dpr: testInfo.project.use.deviceScaleFactor as number,
  });

  expect(artifacts.metadata.route).toBe("/");
  expect(artifacts.metadata.state).toBe("ready");
  await Promise.all(Object.values(artifacts.files).map((file) => access(file)));
  const persistedMetadata = JSON.parse(
    await readFile(artifacts.files.metadata, "utf8"),
  );
  expect(persistedMetadata).toMatchObject({
    viewport: testInfo.project.use.viewport,
    dpr: testInfo.project.use.deviceScaleFactor,
    route: "/",
    state: "ready",
    fixture: "home-default",
    captureScale: "css",
    normalizedPixelDensity: 1,
  });
  expect(artifacts.comparison.reference).toMatch(
    /(?:desktop|mobile)-home\.png$/,
  );
  expect(artifacts.comparison.mismatchRatio).toBeLessThanOrEqual(
    artifacts.comparison.maxMismatchRatio,
  );
});

test("respects reduced motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");

  const animationDuration = await page
    .getByRole("button", { name: "Analisar treino" })
    .evaluate((element) => getComputedStyle(element).animationDuration);
  const transitionDuration = await page
    .getByRole("button", { name: "Analisar treino" })
    .evaluate((element) => getComputedStyle(element).transitionDuration);

  expect(["0.01ms", "1e-05s"]).toContain(animationDuration);
  expect(["0.01ms", "1e-05s"]).toContain(transitionDuration);
});

test("opens each unavailable destination without an API or follow-up network request", async ({
  page,
}, testInfo) => {
  const requests: string[] = [];
  page.on("request", (request) => {
    requests.push(request.url());
  });

  for (const control of [
    "Meus treinos",
    "Ranking",
    "Treino livre",
    "Desafio verificado",
    "Analisar treino",
  ]) {
    await page.goto("/");
    await expect(
      page.getByRole("img", {
        name: "Jogador de futsal treinando em quadra interna",
      }),
    ).toHaveJSProperty("complete", true);
    await page.evaluate(() => document.fonts.ready);
    const requestCountBeforeInteraction = requests.length;

    if (
      testInfo.project.name === "mobile-home" &&
      (control === "Meus treinos" || control === "Ranking")
    ) {
      await page.getByRole("button", { name: "Abrir navegação" }).click();
    }

    await page.getByRole("button", { name: control }).click();

    await expect(
      page.getByRole("heading", { name: "Indisponível", level: 1 }),
    ).toBeVisible();
    await expect(page.getByRole("status")).toHaveText(
      "Disponível após ativação do fluxo",
    );
    expect(requests.slice(requestCountBeforeInteraction)).toEqual([]);
  }
});

test("keeps keyboard focus visible and activates every unavailable control", async ({
  page,
}, testInfo) => {
  const controls = [
    { name: "Meus treinos", isNavigationControl: true },
    { name: "Ranking", isNavigationControl: true },
    { name: "Treino livre", isNavigationControl: false },
    { name: "Desafio verificado", isNavigationControl: false },
    { name: "Analisar treino", isNavigationControl: false },
  ];

  for (const control of controls) {
    await page.goto("/");

    if (
      testInfo.project.name === "mobile-home" &&
      control.isNavigationControl
    ) {
      const navigationToggle = page.getByRole("button", {
        name: "Abrir navegação",
      });
      await navigationToggle.focus();
      await expect(navigationToggle).toHaveCSS("outline-width", "3px");
      await navigationToggle.press("Enter");
    }

    const target = page.getByRole("button", { name: control.name });
    await target.focus();
    await expect(target).toBeFocused();
    await expect(target).toHaveCSS("outline-width", "3px");
    await target.press("Enter");

    const unavailableHeading = page.getByRole("heading", {
      name: "Indisponível",
      level: 1,
    });
    await expect(unavailableHeading).toBeVisible();
    await expect(unavailableHeading).toBeFocused();
  }
});
