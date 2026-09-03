import { expect, test, type Locator, type Page } from "@playwright/test";

const viewport = { height: 844, width: 390 } as const;

async function activateUnavailableControl(page: Page, control: Locator) {
  await control.scrollIntoViewIfNeeded();
  await expect(control).toBeVisible();
  const bounds = await control.boundingBox();

  expect(bounds).not.toBeNull();
  expect(bounds?.x).toBeGreaterThanOrEqual(0);
  expect(bounds?.x ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(
    viewport.width,
  );
  expect(bounds?.y).toBeGreaterThanOrEqual(0);
  expect(
    (bounds?.y ?? Number.POSITIVE_INFINITY) + (bounds?.height ?? 0),
  ).toBeLessThanOrEqual(viewport.height);

  await control.click();
  await expect(
    page.getByText("Disponível após ativação do fluxo", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Voltar ao início" }).click();
  await expect(
    page.getByRole("heading", { name: "Treine. Grave. Evolua." }),
  ).toBeVisible();
}

test("the served Expo home hydrates at 390 by 844 without a blank root or browser error", async ({
  page,
}) => {
  const browserErrors: string[] = [];

  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));

  const response = await page.goto("/");

  expect(response?.status()).toBe(200);
  await expect(
    page.getByRole("heading", { name: "Treine. Grave. Evolua." }),
  ).toBeVisible();
  await expect(page.locator("#root")).not.toBeEmpty();
  expect(browserErrors).toEqual([]);
});

test("every required home control is reachable and activates inside the 390 by 844 viewport", async ({
  page,
}) => {
  await page.goto("/");
  const scrollableHome = page.getByLabel("Conteúdo inicial rolável");

  await expect(scrollableHome).toBeVisible();
  await scrollableHome.hover();
  await page.mouse.wheel(0, viewport.height);
  await expect
    .poll(() => scrollableHome.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(0);

  await activateUnavailableControl(
    page,
    page.getByRole("button", { name: "Treino livre — análise aproximada" }),
  );
  await activateUnavailableControl(
    page,
    page.getByRole("button", { name: "Desafio verificado" }),
  );
  await activateUnavailableControl(
    page,
    page.getByRole("button", { name: "Analisar treino" }),
  );

  await page.getByRole("button", { name: "Abrir navegação" }).click();
  await activateUnavailableControl(
    page,
    page.getByRole("button", { name: "Meus treinos" }),
  );

  await page.getByRole("button", { name: "Abrir navegação" }).click();
  await activateUnavailableControl(
    page,
    page.getByRole("button", { name: "Ranking" }),
  );
});
