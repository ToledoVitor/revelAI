import { expect, test } from "@playwright/test";

const reviewPaths = ["/_test/verified/setup", "/_test/verified/capture"];

for (const path of reviewPaths) {
  test(`served production artifact keeps direct ${path} at the unavailable boundary`, async ({
    page,
  }) => {
    const apiRequests: string[] = [];
    page.on("request", (request) => {
      if (new URL(request.url()).pathname.startsWith("/v1/")) {
        apiRequests.push(request.url());
      }
    });

    await page.goto(path);

    await expect(
      page.getByRole("heading", { name: "Indisponível", level: 1 }),
    ).toBeVisible();
    await expect(
      page.getByRole("main", { name: "Indisponível" }),
    ).not.toContainText("Preparação para passe na parede");
    await expect(
      page.getByRole("main", { name: "Indisponível" }),
    ).toContainText(
      "A orientação de preparação aguarda a ativação completa da captura e do resultado.",
    );
    expect(
      await page.evaluate(
        () =>
          (
            window as typeof window & {
              __revelaiReviewSetupModuleEvaluations?: number;
            }
          ).__revelaiReviewSetupModuleEvaluations,
      ),
    ).toBeUndefined();
    expect(apiRequests).toEqual([]);
  });

  test(`served production artifact keeps in-app ${path} at the unavailable boundary`, async ({
    page,
  }) => {
    const apiRequests: string[] = [];
    page.on("request", (request) => {
      if (new URL(request.url()).pathname.startsWith("/v1/")) {
        apiRequests.push(request.url());
      }
    });

    await page.goto("/");
    await page.evaluate((destination) => {
      window.history.pushState({}, "", destination);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }, path);

    await expect(
      page.getByRole("heading", { name: "Indisponível", level: 1 }),
    ).toBeVisible();
    await expect(
      page.getByRole("main", { name: "Indisponível" }),
    ).not.toContainText("Preparação para passe na parede");
    await expect(
      page.getByRole("main", { name: "Indisponível" }),
    ).toContainText(
      "A orientação de preparação aguarda a ativação completa da captura e do resultado.",
    );
    expect(
      await page.evaluate(
        () =>
          (
            window as typeof window & {
              __revelaiReviewSetupModuleEvaluations?: number;
            }
          ).__revelaiReviewSetupModuleEvaluations,
      ),
    ).toBeUndefined();
    expect(apiRequests).toEqual([]);
  });
}
