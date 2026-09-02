import { expect, test } from "@playwright/test";

test("development browser resolves the lazy review setup module without an error", async ({
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
      response.url().includes("/verified/setup")
    ) {
      reviewModuleFailures.push(`${response.status()} ${response.url()}`);
    }
  });

  await page.goto("/_test/verified/setup");

  await expect(
    page.getByRole("heading", {
      name: "Escolha o desafio para a orientação",
      level: 1,
    }),
  ).toBeVisible();
  expect(consoleErrors).toEqual([]);
  expect(reviewModuleFailures).toEqual([]);
});
