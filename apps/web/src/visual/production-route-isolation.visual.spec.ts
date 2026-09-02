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
    ).not.toContainText("Captura para passe na parede");
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
    expect(
      await page.evaluate(
        () =>
          (
            window as typeof window & {
              __revelaiReviewCaptureModuleEvaluations?: number;
            }
          ).__revelaiReviewCaptureModuleEvaluations,
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
    ).not.toContainText("Captura para passe na parede");
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
    expect(
      await page.evaluate(
        () =>
          (
            window as typeof window & {
              __revelaiReviewCaptureModuleEvaluations?: number;
            }
          ).__revelaiReviewCaptureModuleEvaluations,
      ),
    ).toBeUndefined();
    expect(apiRequests).toEqual([]);
  });
}

test("served production verified setup uses real camera controls without review simulation copy", async ({
  page,
}) => {
  const apiRequests: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/v1/"))
      apiRequests.push(request.url());
  });

  await page.goto("/verified");

  const setup = page.getByRole("main", {
    name: "Preparação do desafio verificado",
  });
  await expect(setup).toBeVisible();
  await expect(setup).not.toContainText(/simular|simulação|simulada/i);
  await expect(
    setup.getByRole("button", { name: "Ativar câmera" }),
  ).toBeVisible();
  await expect(
    setup.getByRole("button", { name: "Usar vídeo existente" }),
  ).toBeVisible();
  expect(apiRequests).toEqual([]);
});

test("served production verified setup keeps its real device gate coherent across Back", async ({
  page,
}) => {
  const apiRequests: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/v1/"))
      apiRequests.push(request.url());
  });

  await page.goto("/verified");
  const setup = page.getByRole("main", {
    name: "Preparação do desafio verificado",
  });
  await setup.getByRole("button", { name: "Usar vídeo existente" }).click();
  await expect(setup.getByRole("button", { name: "Continuar" })).toBeEnabled();
  await setup.getByRole("button", { name: "Continuar" }).click();
  await expect(setup).toContainText("Etapa 2 de 5");
  await setup.getByRole("button", { name: "Voltar" }).click();

  await expect(setup).toContainText(
    "Vídeo existente escolhido como alternativa de captura.",
  );
  await expect(setup.getByRole("button", { name: "Continuar" })).toBeEnabled();
  expect(apiRequests).toEqual([]);
});

test("served production Home mounts the sole Free owner before one exact Free creation", async ({
  page,
}) => {
  const requestBodies: unknown[] = [];
  const apiRequests: string[] = [];
  await page.route("**/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    apiRequests.push(`${request.method()} ${url.pathname}`);
    if (request.method() === "POST" && url.pathname === "/v1/attempts") {
      requestBodies.push(request.postDataJSON());
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({
          id: "attempt-free-production-1",
          mode: "free",
          status: "awaiting-upload",
          createdAt: "2026-08-30T12:01:00.000Z",
          outcome: {
            state: "pending",
            attemptId: "attempt-free-production-1",
            mode: "free",
            status: "awaiting-upload",
          },
        }),
      });
      return;
    }
    await route.fulfill({ status: 404, body: "not expected" });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Treino livre" }).click();

  const freeOwner = page.getByRole("main", {
    name: "Treino livre — análise aproximada",
  });
  await expect(freeOwner).toBeVisible();
  await expect(
    freeOwner.getByRole("button", { name: "Selecionar vídeo" }),
  ).toBeEnabled();
  await expect(page.getByRole("navigation")).not.toContainText("Ranking");
  await expect(freeOwner).not.toContainText(
    /score|ranking|rank|percentil|top percent|verified/i,
  );
  expect(requestBodies).toEqual([{ mode: "free" }]);
  expect(apiRequests).toEqual(["POST /v1/attempts"]);
});

test("served production direct Free route owns its one creation without review modules", async ({
  page,
}) => {
  const apiRequests: string[] = [];
  await page.route("**/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    apiRequests.push(`${request.method()} ${url.pathname}`);
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        id: "attempt-free-production-direct",
        mode: "free",
        status: "awaiting-upload",
        createdAt: "2026-08-30T12:01:00.000Z",
        outcome: {
          state: "pending",
          attemptId: "attempt-free-production-direct",
          mode: "free",
          status: "awaiting-upload",
        },
      }),
    });
  });

  await page.goto("/free-training");

  await expect(
    page.getByRole("heading", {
      name: "Treino livre — análise aproximada",
      level: 1,
    }),
  ).toBeFocused();
  await expect(
    page.getByRole("button", { name: "Selecionar vídeo" }),
  ).toBeEnabled();
  expect(apiRequests).toEqual(["POST /v1/attempts"]);
  expect(
    await page.evaluate(
      () =>
        (
          window as typeof window & {
            __revelaiReviewSetupModuleEvaluations?: number;
            __revelaiReviewCaptureModuleEvaluations?: number;
          }
        ).__revelaiReviewSetupModuleEvaluations,
    ),
  ).toBeUndefined();
  expect(
    await page.evaluate(
      () =>
        (
          window as typeof window & {
            __revelaiReviewSetupModuleEvaluations?: number;
            __revelaiReviewCaptureModuleEvaluations?: number;
          }
        ).__revelaiReviewCaptureModuleEvaluations,
    ),
  ).toBeUndefined();
});

test("served production canonicalizes trailing and repeated Free slashes before the sole owner mounts", async ({
  page,
}) => {
  const requestBodies: unknown[] = [];
  await page.route("**/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "POST" && url.pathname === "/v1/attempts") {
      requestBodies.push(request.postDataJSON());
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({
          id: "attempt-free-canonical",
          mode: "free",
          status: "awaiting-upload",
          createdAt: "2026-08-30T12:01:00.000Z",
          outcome: {
            state: "pending",
            attemptId: "attempt-free-canonical",
            mode: "free",
            status: "awaiting-upload",
          },
        }),
      });
      return;
    }
    await route.fulfill({ status: 404, body: "not expected" });
  });

  await page.goto("/free-training///");

  await expect(page).toHaveURL(/\/free-training$/);
  const freeOwner = page.getByRole("main", {
    name: "Treino livre — análise aproximada",
  });
  await expect(
    freeOwner.getByRole("button", { name: "Selecionar vídeo" }),
  ).toBeEnabled();
  await expect(page.getByRole("navigation")).not.toContainText("Ranking");
  await expect(freeOwner).not.toContainText(
    /score|ranking|rank|percentil|top percent|verified/i,
  );
  expect(requestBodies).toEqual([{ mode: "free" }]);
});

test("served production reload resumes an observed Free owner without another POST", async ({
  page,
}) => {
  let creates = 0;
  let reads = 0;
  const created = {
    id: "attempt-free-reload",
    mode: "free",
    status: "awaiting-upload",
    createdAt: "2026-08-30T12:01:00.000Z",
    outcome: {
      state: "pending",
      attemptId: "attempt-free-reload",
      mode: "free",
      status: "awaiting-upload",
    },
  };
  await page.route("**/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "POST" && url.pathname === "/v1/attempts") {
      creates += 1;
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify(created),
      });
      return;
    }
    if (
      request.method() === "GET" &&
      url.pathname === "/v1/attempts/attempt-free-reload"
    ) {
      reads += 1;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(created),
      });
      return;
    }
    await route.fulfill({ status: 404, body: "not expected" });
  });

  await page.goto("/free-training");
  await expect(
    page.getByRole("button", { name: "Selecionar vídeo" }),
  ).toBeEnabled();
  await page.reload();

  await expect(
    page.getByRole("button", { name: "Selecionar vídeo" }),
  ).toBeEnabled();
  expect(creates).toBe(1);
  expect(reads).toBe(1);
});

test("served production recovers a commit-wins lost Free create after reload without an orphan POST", async ({
  page,
}) => {
  let creates = 0;
  const keys: string[] = [];
  const created = {
    id: "attempt-free-commit-wins",
    mode: "free",
    status: "awaiting-upload",
    createdAt: "2026-08-30T12:01:00.000Z",
    outcome: {
      state: "pending",
      attemptId: "attempt-free-commit-wins",
      mode: "free",
      status: "awaiting-upload",
    },
  };
  await page.route("**/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "POST" && url.pathname === "/v1/attempts") {
      creates += 1;
      keys.push(request.headers()["idempotency-key"] ?? "");
      if (creates === 1) {
        // The server commits this logical request but the response is lost.
        await route.abort("connectionreset");
        return;
      }
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify(created),
      });
      return;
    }
    await route.fulfill({ status: 404, body: "not expected" });
  });

  await page.goto("/free-training");
  await expect(page.getByRole("alert")).toBeVisible();
  await page.reload();

  await expect(
    page.getByRole("button", { name: "Selecionar vídeo" }),
  ).toBeEnabled();
  expect(creates).toBe(2);
  expect(keys[0]).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
  expect(keys[1]).toBe(keys[0]);
});
