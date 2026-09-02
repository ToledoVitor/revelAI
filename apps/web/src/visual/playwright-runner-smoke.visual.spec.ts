import { expect, test } from "@playwright/test";

test("launches Chromium for runner environment checks", async ({ page }) => {
  await page.setContent("<main>Chromium is ready</main>");

  await expect(page.getByRole("main")).toHaveText("Chromium is ready");
});
