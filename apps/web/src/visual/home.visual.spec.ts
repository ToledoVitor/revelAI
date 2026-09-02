import { expect, test } from "@playwright/test";

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

test("opens each unavailable destination without a v1 API request", async ({
  page,
}, testInfo) => {
  let apiRequests = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/v1/")) {
      apiRequests += 1;
    }
  });

  for (const control of [
    "Meus treinos",
    "Ranking",
    "Treino livre",
    "Desafio verificado",
    "Analisar treino",
  ]) {
    await page.goto("/");

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
  }

  expect(apiRequests).toBe(0);
});
