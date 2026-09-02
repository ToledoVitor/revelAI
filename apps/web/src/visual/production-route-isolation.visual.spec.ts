import { expect, test } from "@playwright/test";

const reviewPaths = ["/_test/verified/setup", "/_test/verified/capture"];

function freeValidAttempt(id: string) {
  return {
    id,
    mode: "free",
    status: "valid",
    createdAt: "2026-08-30T12:01:00.000Z",
    outcome: {
      state: "valid",
      result: {
        kind: "free-insight",
        attemptId: id,
        provenance: {
          kind: "demo",
          fixtureId: "free-limited-ball-v1",
          providerVersion: "demo-observations-v1",
        },
        approximate: true,
        observations: [
          {
            kind: "athlete-visibility",
            unit: "percent",
            value: 64,
            range: "partial",
          },
          {
            kind: "ball-visibility",
            unit: "percent",
            value: 42,
            range: "limited",
          },
          {
            kind: "movement-activity",
            unit: "percent",
            value: 65,
            range: "high",
          },
        ],
        tips: ["Mantenha a bola visível durante a sequência."],
        generatedAt: "2026-08-30T12:02:00.000Z",
      },
    },
  };
}

function freeAwaitingUploadAttempt(id: string) {
  return {
    id,
    mode: "free",
    status: "awaiting-upload",
    createdAt: "2026-08-30T12:01:00.000Z",
    outcome: {
      state: "pending",
      attemptId: id,
      mode: "free",
      status: "awaiting-upload",
    },
  };
}

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

for (const failedFact of ["owner", "intent"] as const) {
  test(`served production completes History cleanup after matched partial ${failedFact} removal`, async ({
    page,
  }) => {
    const attemptId = `attempt-history-partial-${failedFact}`;
    const oldKey = `f${failedFact === "owner" ? "3" : "4"}2222222-2222-4222-8222-222222222222`;
    const failedKey = `revelai.free-training.${failedFact === "owner" ? "owner.v1" : "create-intent.v1"}`;
    const paths: string[] = [];
    const keys: string[] = [];
    await page.addInitScript(
      ({ id, key, blockedKey }) => {
        const originalGet = Storage.prototype.getItem;
        const originalRemove = Storage.prototype.removeItem;
        const rawGet = originalGet.bind(window.sessionStorage);
        window.sessionStorage.setItem(
          "revelai.free-training.owner.v1",
          JSON.stringify({ attemptId: id }),
        );
        window.sessionStorage.setItem(
          "revelai.free-training.create-intent.v1",
          JSON.stringify({ idempotencyKey: key }),
        );
        let blocked = true;
        Storage.prototype.removeItem = function removeItem(storageKey) {
          if (
            this === window.sessionStorage &&
            blocked &&
            storageKey === blockedKey
          ) {
            return;
          }
          return originalRemove.call(this, storageKey);
        };
        (
          window as typeof window & {
            __readRawFreeTrainingOwnership?: () => {
              owner: string | null;
              intent: string | null;
            };
            __restoreFreeTrainingOwnershipRemoval?: () => void;
          }
        ).__readRawFreeTrainingOwnership = () => ({
          owner: rawGet("revelai.free-training.owner.v1"),
          intent: rawGet("revelai.free-training.create-intent.v1"),
        });
        (
          window as typeof window & {
            __restoreFreeTrainingOwnershipRemoval?: () => void;
          }
        ).__restoreFreeTrainingOwnershipRemoval = () => {
          blocked = false;
        };
      },
      { id: attemptId, key: oldKey, blockedKey: failedKey },
    );
    await page.route("**/v1/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      paths.push(`${request.method()} ${url.pathname}`);
      if (request.method() === "GET" && url.pathname === "/v1/attempts") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            items: [freeAwaitingUploadAttempt(attemptId)],
            nextCursor: null,
          }),
        });
        return;
      }
      if (
        request.method() === "DELETE" &&
        url.pathname === `/v1/attempts/${attemptId}`
      ) {
        await route.fulfill({ status: 204 });
        return;
      }
      if (request.method() === "POST" && url.pathname === "/v1/attempts") {
        keys.push(request.headers()["idempotency-key"] ?? "");
        await route.fulfill({
          status: 201,
          contentType: "application/json",
          body: JSON.stringify(
            freeAwaitingUploadAttempt(`attempt-history-fresh-${failedFact}`),
          ),
        });
        return;
      }
      await route.fulfill({ status: 404, body: "not expected" });
    });
    page.on("dialog", (dialog) => void dialog.accept());

    await page.goto("/training/history");
    await page.getByRole("button", { name: "Excluir treino" }).click();
    const cleanupButton = page.getByRole("button", {
      name: "Concluir limpeza",
    });
    await expect(cleanupButton).toBeVisible();
    await expect(
      page.getByRole("heading", {
        name: "Meus treinos neste dispositivo",
        level: 1,
      }),
    ).toBeFocused();
    await cleanupButton.click();
    await expect(cleanupButton).toBeFocused();
    expect(
      await page.evaluate(() =>
        (
          window as typeof window & {
            __readRawFreeTrainingOwnership?: () => {
              owner: string | null;
              intent: string | null;
            };
          }
        ).__readRawFreeTrainingOwnership?.(),
      ),
    ).toEqual({
      owner: failedFact === "owner" ? JSON.stringify({ attemptId }) : null,
      intent:
        failedFact === "intent"
          ? JSON.stringify({ idempotencyKey: oldKey })
          : null,
    });

    await page.evaluate(() => {
      (
        window as typeof window & {
          __restoreFreeTrainingOwnershipRemoval?: () => void;
        }
      ).__restoreFreeTrainingOwnershipRemoval?.();
    });
    await cleanupButton.click();
    await expect(page.getByText("Treino excluído.")).toHaveAttribute(
      "role",
      "status",
    );
    await expect(
      page.getByRole("heading", {
        name: "Meus treinos neste dispositivo",
        level: 1,
      }),
    ).toBeFocused();
    expect(
      await page.evaluate(() =>
        (
          window as typeof window & {
            __readRawFreeTrainingOwnership?: () => {
              owner: string | null;
              intent: string | null;
            };
          }
        ).__readRawFreeTrainingOwnership?.(),
      ),
    ).toEqual({ owner: null, intent: null });

    await page.getByRole("link", { name: "Início" }).click();
    await page.getByRole("button", { name: "Treino livre" }).click();
    await expect(
      page.getByRole("button", { name: "Selecionar vídeo" }),
    ).toBeEnabled();
    expect(keys).toHaveLength(1);
    expect(keys[0]).not.toBe(oldKey);
    expect(paths).toEqual([
      "GET /v1/attempts",
      `DELETE /v1/attempts/${attemptId}`,
      "POST /v1/attempts",
    ]);
  });
}

test("served production keeps same-task History cleanup retries causally matched", async ({
  page,
}) => {
  const attemptId = "attempt-history-same-task-cleanup";
  const oldKey = "f5555555-5555-4555-8555-555555555555";
  const paths: string[] = [];
  const keys: string[] = [];
  await page.addInitScript(
    ({ id, key }) => {
      const originalGet = Storage.prototype.getItem;
      const originalRemove = Storage.prototype.removeItem;
      const rawGet = originalGet.bind(window.sessionStorage);
      window.sessionStorage.setItem(
        "revelai.free-training.owner.v1",
        JSON.stringify({ attemptId: id }),
      );
      window.sessionStorage.setItem(
        "revelai.free-training.create-intent.v1",
        JSON.stringify({ idempotencyKey: key }),
      );
      let readBlocked = false;
      let intentRemovalBlocked = true;
      Storage.prototype.getItem = function getItem(storageKey) {
        if (this === window.sessionStorage && readBlocked) return null;
        return originalGet.call(this, storageKey);
      };
      Storage.prototype.removeItem = function removeItem(storageKey) {
        if (
          this === window.sessionStorage &&
          intentRemovalBlocked &&
          storageKey === "revelai.free-training.create-intent.v1"
        ) {
          return;
        }
        return originalRemove.call(this, storageKey);
      };
      (
        window as typeof window & {
          __blockFreeTrainingStorageRead?: () => void;
          __restoreFreeTrainingStorageRead?: () => void;
          __restoreFreeTrainingIntentRemoval?: () => void;
          __readRawFreeTrainingOwnership?: () => {
            owner: string | null;
            intent: string | null;
          };
        }
      ).__blockFreeTrainingStorageRead = () => {
        readBlocked = true;
      };
      (
        window as typeof window & {
          __restoreFreeTrainingStorageRead?: () => void;
        }
      ).__restoreFreeTrainingStorageRead = () => {
        readBlocked = false;
      };
      (
        window as typeof window & {
          __restoreFreeTrainingIntentRemoval?: () => void;
        }
      ).__restoreFreeTrainingIntentRemoval = () => {
        intentRemovalBlocked = false;
      };
      (
        window as typeof window & {
          __readRawFreeTrainingOwnership?: () => {
            owner: string | null;
            intent: string | null;
          };
        }
      ).__readRawFreeTrainingOwnership = () => ({
        owner: rawGet("revelai.free-training.owner.v1"),
        intent: rawGet("revelai.free-training.create-intent.v1"),
      });
    },
    { id: attemptId, key: oldKey },
  );
  await page.route("**/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    paths.push(`${request.method()} ${url.pathname}`);
    if (request.method() === "GET" && url.pathname === "/v1/attempts") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          items: [freeAwaitingUploadAttempt(attemptId)],
          nextCursor: null,
        }),
      });
      return;
    }
    if (
      request.method() === "DELETE" &&
      url.pathname === `/v1/attempts/${attemptId}`
    ) {
      await route.fulfill({ status: 204 });
      return;
    }
    if (request.method() === "POST" && url.pathname === "/v1/attempts") {
      keys.push(request.headers()["idempotency-key"] ?? "");
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify(
          freeAwaitingUploadAttempt("attempt-history-fresh"),
        ),
      });
      return;
    }
    await route.fulfill({ status: 404, body: "not expected" });
  });
  page.on("dialog", (dialog) => void dialog.accept());

  await page.goto("/training/history");
  await page.evaluate(() => {
    (
      window as typeof window & {
        __blockFreeTrainingStorageRead?: () => void;
      }
    ).__blockFreeTrainingStorageRead?.();
  });
  await page.getByRole("button", { name: "Excluir treino" }).click();
  const cleanupButton = page.getByRole("button", {
    name: "Concluir limpeza",
  });
  await expect(cleanupButton).toBeVisible();
  await page.evaluate(() => {
    (
      window as typeof window & {
        __restoreFreeTrainingStorageRead?: () => void;
      }
    ).__restoreFreeTrainingStorageRead?.();
    const cleanup = [...document.querySelectorAll("button")].find(
      (candidate) => candidate.textContent === "Concluir limpeza",
    );
    if (!(cleanup instanceof HTMLButtonElement))
      throw new Error("Missing cleanup button");
    cleanup.focus();
    cleanup.click();
    cleanup.click();
  });

  await expect(cleanupButton).toBeFocused();
  await expect(page.getByRole("alert")).toContainText(
    "O treino foi excluído, mas a limpeza neste dispositivo precisa ser concluída.",
  );
  expect(
    await page.evaluate(() =>
      (
        window as typeof window & {
          __readRawFreeTrainingOwnership?: () => {
            owner: string | null;
            intent: string | null;
          };
        }
      ).__readRawFreeTrainingOwnership?.(),
    ),
  ).toEqual({
    owner: null,
    intent: JSON.stringify({ idempotencyKey: oldKey }),
  });

  await page.evaluate(() => {
    (
      window as typeof window & {
        __restoreFreeTrainingIntentRemoval?: () => void;
      }
    ).__restoreFreeTrainingIntentRemoval?.();
  });
  await cleanupButton.click();
  await expect(page.getByText("Treino excluído.")).toHaveAttribute(
    "role",
    "status",
  );
  await expect(
    page.getByRole("heading", {
      name: "Meus treinos neste dispositivo",
      level: 1,
    }),
  ).toBeFocused();
  expect(
    await page.evaluate(() =>
      (
        window as typeof window & {
          __readRawFreeTrainingOwnership?: () => {
            owner: string | null;
            intent: string | null;
          };
        }
      ).__readRawFreeTrainingOwnership?.(),
    ),
  ).toEqual({ owner: null, intent: null });

  await page.getByRole("link", { name: "Início" }).click();
  await page.getByRole("button", { name: "Treino livre" }).click();
  await expect(
    page.getByRole("button", { name: "Selecionar vídeo" }),
  ).toBeEnabled();
  expect(keys).toHaveLength(1);
  expect(keys[0]).not.toBe(oldKey);
  expect(paths).toEqual([
    "GET /v1/attempts",
    `DELETE /v1/attempts/${attemptId}`,
    "POST /v1/attempts",
  ]);
});

test("served production verified choice exposes wall-pass before any calibration owner mounts", async ({
  page,
}) => {
  const apiRequests: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/v1/"))
      apiRequests.push(request.url());
  });

  await page.goto("/verified");

  const choice = page.getByRole("main", {
    name: "Escolha. Prepare. Compita.",
  });
  await expect(choice).toBeVisible();
  await expect(choice).not.toContainText(/simular|simulação|simulada/i);
  await expect(
    choice.getByRole("button", { name: "Preparar desafio" }),
  ).toBeVisible();
  await expect(choice.getByText("Passe contra parede")).toBeVisible();
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
  const choice = page.getByRole("main", {
    name: "Escolha. Prepare. Compita.",
  });
  await choice.getByRole("button", { name: "Preparar desafio" }).click();
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

test("served production turns a tombstoned persisted key into one user-started fresh Free Attempt", async ({
  page,
}) => {
  const oldKey = "e3333333-3333-4333-8333-333333333333";
  const keys: string[] = [];
  await page.addInitScript((key) => {
    window.sessionStorage.setItem(
      "revelai.free-training.create-intent.v1",
      JSON.stringify({ idempotencyKey: key }),
    );
  }, oldKey);
  await page.route("**/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "POST" && url.pathname === "/v1/attempts") {
      keys.push(request.headers()["idempotency-key"] ?? "");
      if (keys.length === 1) {
        await route.fulfill({
          status: 404,
          contentType: "application/json",
          body: JSON.stringify({
            code: "attempt_not_found",
            message: "Esta tentativa não está disponível.",
            retryable: false,
          }),
        });
        return;
      }
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({
          id: "attempt-free-fresh-after-tombstone",
          mode: "free",
          status: "awaiting-upload",
          createdAt: "2026-08-30T12:01:00.000Z",
          outcome: {
            state: "pending",
            attemptId: "attempt-free-fresh-after-tombstone",
            mode: "free",
            status: "awaiting-upload",
          },
        }),
      });
      return;
    }
    await route.fulfill({ status: 404, body: "not expected" });
  });

  await page.goto("/free-training");
  await expect(page.getByRole("alert")).toContainText(
    "Esta tentativa já foi excluída.",
  );
  expect(keys).toEqual([oldKey]);

  await page.getByRole("button", { name: "Tentar novamente" }).click();
  await expect(
    page.getByRole("button", { name: "Selecionar vídeo" }),
  ).toBeEnabled();
  expect(keys).toHaveLength(2);
  expect(keys[1]).not.toBe(oldKey);
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.sessionStorage.getItem("revelai.free-training.owner.v1"),
      ),
    )
    .toBe(JSON.stringify({ attemptId: "attempt-free-fresh-after-tombstone" }));
});

test("served production makes no Free POST until session storage confirms its causal key", async ({
  page,
}) => {
  const keys: string[] = [];
  await page.addInitScript(() => {
    const original = Storage.prototype.setItem;
    let blocked = true;
    Storage.prototype.setItem = function (key, value) {
      if (blocked && key === "revelai.free-training.create-intent.v1")
        throw new DOMException("full", "QuotaExceededError");
      return original.call(this, key, value);
    };
    (
      window as typeof window & {
        __allowFreeTrainingSessionStorage?: () => void;
      }
    ).__allowFreeTrainingSessionStorage = () => {
      blocked = false;
    };
  });
  await page.route("**/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "POST" && url.pathname === "/v1/attempts") {
      keys.push(request.headers()["idempotency-key"] ?? "");
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({
          id: "attempt-free-storage-recovered",
          mode: "free",
          status: "awaiting-upload",
          createdAt: "2026-08-30T12:01:00.000Z",
          outcome: {
            state: "pending",
            attemptId: "attempt-free-storage-recovered",
            mode: "free",
            status: "awaiting-upload",
          },
        }),
      });
      return;
    }
    await route.fulfill({ status: 404, body: "not expected" });
  });

  await page.goto("/free-training");
  await expect(page.getByRole("alert")).toContainText(
    "Não foi possível guardar este treino livre neste dispositivo.",
  );
  expect(keys).toEqual([]);

  await page.evaluate(() => {
    (
      window as typeof window & {
        __allowFreeTrainingSessionStorage?: () => void;
      }
    ).__allowFreeTrainingSessionStorage?.();
  });
  await page.getByRole("button", { name: "Tentar novamente" }).click();
  await expect(
    page.getByRole("button", { name: "Selecionar vídeo" }),
  ).toBeEnabled();
  expect(keys).toHaveLength(1);
  expect(keys[0]).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
});

for (const unavailableRead of ["throws", "silently reads null"] as const) {
  test(`served production preserves a response-lost key while session storage get ${unavailableRead}`, async ({
    page,
  }) => {
    const oldKey = "a3333333-3333-4333-8333-333333333333";
    const keys: string[] = [];
    await page.addInitScript(
      ({ key, unavailable }) => {
        const originalGet = Storage.prototype.getItem;
        const rawGet = originalGet.bind(window.sessionStorage);
        window.sessionStorage.setItem(
          "revelai.free-training.create-intent.v1",
          JSON.stringify({ idempotencyKey: key }),
        );
        let blocked = true;
        Storage.prototype.getItem = function getItem(storageKey) {
          if (this === window.sessionStorage && blocked) {
            if (unavailable === "throws")
              throw new DOMException("blocked", "SecurityError");
            return null;
          }
          return originalGet.call(this, storageKey);
        };
        (
          window as typeof window & {
            __readRawFreeTrainingIntent?: () => string | null;
            __restoreFreeTrainingStorageRead?: () => void;
          }
        ).__readRawFreeTrainingIntent = () =>
          rawGet("revelai.free-training.create-intent.v1");
        (
          window as typeof window & {
            __restoreFreeTrainingStorageRead?: () => void;
          }
        ).__restoreFreeTrainingStorageRead = () => {
          blocked = false;
        };
      },
      { key: oldKey, unavailable: unavailableRead },
    );
    await page.route("**/v1/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (request.method() === "POST" && url.pathname === "/v1/attempts") {
        keys.push(request.headers()["idempotency-key"] ?? "");
        await route.fulfill({
          status: 201,
          contentType: "application/json",
          body: JSON.stringify({
            id: "attempt-free-replayed-after-storage-recovery",
            mode: "free",
            status: "awaiting-upload",
            createdAt: "2026-08-30T12:01:00.000Z",
            outcome: {
              state: "pending",
              attemptId: "attempt-free-replayed-after-storage-recovery",
              mode: "free",
              status: "awaiting-upload",
            },
          }),
        });
        return;
      }
      await route.fulfill({ status: 404, body: "not expected" });
    });

    await page.goto("/free-training");
    await expect(page.getByRole("alert")).toContainText(
      "Não foi possível guardar este treino livre neste dispositivo.",
    );
    expect(keys).toEqual([]);
    expect(
      await page.evaluate(() =>
        (
          window as typeof window & {
            __readRawFreeTrainingIntent?: () => string | null;
          }
        ).__readRawFreeTrainingIntent?.(),
      ),
    ).toBe(JSON.stringify({ idempotencyKey: oldKey }));

    await page.evaluate(() => {
      (
        window as typeof window & {
          __restoreFreeTrainingStorageRead?: () => void;
        }
      ).__restoreFreeTrainingStorageRead?.();
    });
    await page.getByRole("button", { name: "Tentar novamente" }).click();
    await expect(
      page.getByRole("button", { name: "Selecionar vídeo" }),
    ).toBeEnabled();
    expect(keys).toEqual([oldKey]);
  });
}

test("served production retries both ownership removals before a fresh Free create", async ({
  page,
}) => {
  const staleAttemptId = "attempt-free-stale-owner";
  const staleKey = "b3333333-3333-4333-8333-333333333333";
  const paths: string[] = [];
  const keys: string[] = [];
  await page.addInitScript(
    ({ attemptId, key }) => {
      const originalGet = Storage.prototype.getItem;
      const originalRemove = Storage.prototype.removeItem;
      const rawGet = originalGet.bind(window.sessionStorage);
      window.sessionStorage.setItem(
        "revelai.free-training.owner.v1",
        JSON.stringify({ attemptId }),
      );
      window.sessionStorage.setItem(
        "revelai.free-training.create-intent.v1",
        JSON.stringify({ idempotencyKey: key }),
      );
      let blocked = true;
      Storage.prototype.removeItem = function removeItem(storageKey) {
        if (
          this === window.sessionStorage &&
          blocked &&
          storageKey === "revelai.free-training.owner.v1"
        )
          throw new DOMException("blocked", "SecurityError");
        return originalRemove.call(this, storageKey);
      };
      (
        window as typeof window & {
          __readRawFreeTrainingOwnership?: () => {
            owner: string | null;
            intent: string | null;
          };
          __restoreFreeTrainingOwnershipRemoval?: () => void;
        }
      ).__readRawFreeTrainingOwnership = () => ({
        owner: rawGet("revelai.free-training.owner.v1"),
        intent: rawGet("revelai.free-training.create-intent.v1"),
      });
      (
        window as typeof window & {
          __restoreFreeTrainingOwnershipRemoval?: () => void;
        }
      ).__restoreFreeTrainingOwnershipRemoval = () => {
        blocked = false;
      };
    },
    { attemptId: staleAttemptId, key: staleKey },
  );
  await page.route("**/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    paths.push(`${request.method()} ${url.pathname}`);
    if (
      request.method() === "GET" &&
      url.pathname === `/v1/attempts/${staleAttemptId}`
    ) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          id: staleAttemptId,
          mode: "free",
          status: "valid",
          createdAt: "2026-08-30T12:01:00.000Z",
          outcome: {
            state: "valid",
            result: {
              kind: "free-insight",
              attemptId: staleAttemptId,
              provenance: {
                kind: "demo",
                fixtureId: "free-limited-ball-v1",
                providerVersion: "demo-observations-v1",
              },
              approximate: true,
              observations: [
                {
                  kind: "athlete-visibility",
                  unit: "percent",
                  value: 64,
                  range: "partial",
                },
                {
                  kind: "ball-visibility",
                  unit: "percent",
                  value: 42,
                  range: "limited",
                },
                {
                  kind: "movement-activity",
                  unit: "percent",
                  value: 65,
                  range: "high",
                },
              ],
              tips: ["Mantenha a bola visível durante a sequência."],
              generatedAt: "2026-08-30T12:02:00.000Z",
            },
          },
        }),
      });
      return;
    }
    if (request.method() === "POST" && url.pathname === "/v1/attempts") {
      keys.push(request.headers()["idempotency-key"] ?? "");
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({
          id: "attempt-free-fresh-after-cleanup",
          mode: "free",
          status: "awaiting-upload",
          createdAt: "2026-08-30T12:01:00.000Z",
          outcome: {
            state: "pending",
            attemptId: "attempt-free-fresh-after-cleanup",
            mode: "free",
            status: "awaiting-upload",
          },
        }),
      });
      return;
    }
    await route.fulfill({ status: 404, body: "not expected" });
  });

  await page.goto("/free-training");
  await page
    .getByRole("button", { name: "Começar outro treino livre" })
    .click();
  await expect(page.getByRole("alert")).toContainText(
    "Não foi possível guardar este treino livre neste dispositivo.",
  );
  expect(paths).toEqual([`GET /v1/attempts/${staleAttemptId}`]);
  expect(keys).toEqual([]);
  expect(
    await page.evaluate(() =>
      (
        window as typeof window & {
          __readRawFreeTrainingOwnership?: () => {
            owner: string | null;
            intent: string | null;
          };
        }
      ).__readRawFreeTrainingOwnership?.(),
    ),
  ).toEqual({
    owner: JSON.stringify({ attemptId: staleAttemptId }),
    intent: null,
  });

  await page.evaluate(() => {
    (
      window as typeof window & {
        __restoreFreeTrainingOwnershipRemoval?: () => void;
      }
    ).__restoreFreeTrainingOwnershipRemoval?.();
  });
  await page.getByRole("button", { name: "Tentar novamente" }).click();
  await expect(
    page.getByRole("button", { name: "Selecionar vídeo" }),
  ).toBeEnabled();
  expect(paths).toEqual([
    `GET /v1/attempts/${staleAttemptId}`,
    "POST /v1/attempts",
  ]);
  expect(keys).toHaveLength(1);
  expect(keys[0]).not.toBe(staleKey);
});

for (const unavailableRead of ["throws", "silently reads null"] as const) {
  test(`served production keeps direct Free DELETE cleanup blocked when storage get ${unavailableRead}`, async ({
    page,
  }) => {
    const attemptId = "attempt-free-direct-delete-outage";
    const oldKey = "f1111111-1111-4111-8111-111111111111";
    const paths: string[] = [];
    await page.addInitScript(
      ({ id, key, unavailable }) => {
        const originalGet = Storage.prototype.getItem;
        const rawGet = originalGet.bind(window.sessionStorage);
        window.sessionStorage.setItem(
          "revelai.free-training.owner.v1",
          JSON.stringify({ attemptId: id }),
        );
        window.sessionStorage.setItem(
          "revelai.free-training.create-intent.v1",
          JSON.stringify({ idempotencyKey: key }),
        );
        let blocked = false;
        Storage.prototype.getItem = function getItem(storageKey) {
          if (this === window.sessionStorage && blocked) {
            if (unavailable === "throws")
              throw new DOMException("blocked", "SecurityError");
            return null;
          }
          return originalGet.call(this, storageKey);
        };
        (
          window as typeof window & {
            __blockFreeTrainingStorageRead?: () => void;
            __restoreFreeTrainingStorageRead?: () => void;
            __readRawFreeTrainingOwnership?: () => {
              owner: string | null;
              intent: string | null;
            };
          }
        ).__blockFreeTrainingStorageRead = () => {
          blocked = true;
        };
        (
          window as typeof window & {
            __restoreFreeTrainingStorageRead?: () => void;
          }
        ).__restoreFreeTrainingStorageRead = () => {
          blocked = false;
        };
        (
          window as typeof window & {
            __readRawFreeTrainingOwnership?: () => {
              owner: string | null;
              intent: string | null;
            };
          }
        ).__readRawFreeTrainingOwnership = () => ({
          owner: rawGet("revelai.free-training.owner.v1"),
          intent: rawGet("revelai.free-training.create-intent.v1"),
        });
      },
      { id: attemptId, key: oldKey, unavailable: unavailableRead },
    );
    await page.route("**/v1/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      paths.push(`${request.method()} ${url.pathname}`);
      if (
        request.method() === "GET" &&
        url.pathname === `/v1/attempts/${attemptId}`
      ) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(freeValidAttempt(attemptId)),
        });
        return;
      }
      if (
        request.method() === "DELETE" &&
        url.pathname === `/v1/attempts/${attemptId}`
      ) {
        await route.fulfill({ status: 204 });
        return;
      }
      if (request.method() === "POST" && url.pathname === "/v1/attempts") {
        await route.fulfill({
          status: 201,
          contentType: "application/json",
          body: JSON.stringify(
            freeAwaitingUploadAttempt("attempt-free-direct-fresh"),
          ),
        });
        return;
      }
      await route.fulfill({ status: 404, body: "not expected" });
    });
    page.on("dialog", (dialog) => void dialog.accept());

    await page.goto("/free-training");
    await expect(
      page.getByText("Mantenha a bola visível durante a sequência."),
    ).toBeVisible();
    const before = await page.evaluate(() =>
      (
        window as typeof window & {
          __readRawFreeTrainingOwnership?: () => {
            owner: string | null;
            intent: string | null;
          };
        }
      ).__readRawFreeTrainingOwnership?.(),
    );
    await page.evaluate(() => {
      (
        window as typeof window & {
          __blockFreeTrainingStorageRead?: () => void;
        }
      ).__blockFreeTrainingStorageRead?.();
    });
    await page.getByRole("button", { name: "Excluir treino" }).click();

    await expect(page.getByRole("alert")).toContainText(
      "Não foi possível guardar este treino livre neste dispositivo.",
    );
    await expect(page).toHaveURL(/\/free-training$/);
    expect(paths).toEqual([
      `GET /v1/attempts/${attemptId}`,
      `DELETE /v1/attempts/${attemptId}`,
    ]);
    expect(
      await page.evaluate(() =>
        (
          window as typeof window & {
            __readRawFreeTrainingOwnership?: () => {
              owner: string | null;
              intent: string | null;
            };
          }
        ).__readRawFreeTrainingOwnership?.(),
      ),
    ).toEqual(before);

    await page.evaluate(() => {
      (
        window as typeof window & {
          __restoreFreeTrainingStorageRead?: () => void;
        }
      ).__restoreFreeTrainingStorageRead?.();
    });
    await page.getByRole("button", { name: "Tentar novamente" }).click();
    await expect(
      page.getByRole("button", { name: "Selecionar vídeo" }),
    ).toBeEnabled();
    expect(paths).toEqual([
      `GET /v1/attempts/${attemptId}`,
      `DELETE /v1/attempts/${attemptId}`,
      "POST /v1/attempts",
    ]);
  });

  test(`served production keeps History DELETE cleanup blocked when storage get ${unavailableRead}`, async ({
    page,
  }) => {
    const attemptId = "attempt-history-delete-outage";
    const oldKey = "f2222222-2222-4222-8222-222222222222";
    const paths: string[] = [];
    await page.addInitScript(
      ({ id, key, unavailable }) => {
        const originalGet = Storage.prototype.getItem;
        const rawGet = originalGet.bind(window.sessionStorage);
        window.sessionStorage.setItem(
          "revelai.free-training.owner.v1",
          JSON.stringify({ attemptId: id }),
        );
        window.sessionStorage.setItem(
          "revelai.free-training.create-intent.v1",
          JSON.stringify({ idempotencyKey: key }),
        );
        let blocked = false;
        Storage.prototype.getItem = function getItem(storageKey) {
          if (this === window.sessionStorage && blocked) {
            if (unavailable === "throws")
              throw new DOMException("blocked", "SecurityError");
            return null;
          }
          return originalGet.call(this, storageKey);
        };
        (
          window as typeof window & {
            __blockFreeTrainingStorageRead?: () => void;
            __restoreFreeTrainingStorageRead?: () => void;
            __readRawFreeTrainingOwnership?: () => {
              owner: string | null;
              intent: string | null;
            };
          }
        ).__blockFreeTrainingStorageRead = () => {
          blocked = true;
        };
        (
          window as typeof window & {
            __restoreFreeTrainingStorageRead?: () => void;
          }
        ).__restoreFreeTrainingStorageRead = () => {
          blocked = false;
        };
        (
          window as typeof window & {
            __readRawFreeTrainingOwnership?: () => {
              owner: string | null;
              intent: string | null;
            };
          }
        ).__readRawFreeTrainingOwnership = () => ({
          owner: rawGet("revelai.free-training.owner.v1"),
          intent: rawGet("revelai.free-training.create-intent.v1"),
        });
      },
      { id: attemptId, key: oldKey, unavailable: unavailableRead },
    );
    await page.route("**/v1/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      paths.push(`${request.method()} ${url.pathname}`);
      if (request.method() === "GET" && url.pathname === "/v1/attempts") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            items: [freeAwaitingUploadAttempt(attemptId)],
            nextCursor: null,
          }),
        });
        return;
      }
      if (
        request.method() === "DELETE" &&
        url.pathname === `/v1/attempts/${attemptId}`
      ) {
        await route.fulfill({ status: 204 });
        return;
      }
      if (request.method() === "POST" && url.pathname === "/v1/attempts") {
        await route.fulfill({
          status: 201,
          contentType: "application/json",
          body: JSON.stringify(
            freeAwaitingUploadAttempt("attempt-history-fresh"),
          ),
        });
        return;
      }
      await route.fulfill({ status: 404, body: "not expected" });
    });
    page.on("dialog", (dialog) => void dialog.accept());

    await page.goto("/training/history");
    await expect(page.getByRole("article")).toBeVisible();
    const before = await page.evaluate(() =>
      (
        window as typeof window & {
          __readRawFreeTrainingOwnership?: () => {
            owner: string | null;
            intent: string | null;
          };
        }
      ).__readRawFreeTrainingOwnership?.(),
    );
    await page.evaluate(() => {
      (
        window as typeof window & {
          __blockFreeTrainingStorageRead?: () => void;
        }
      ).__blockFreeTrainingStorageRead?.();
    });
    await page.getByRole("button", { name: "Excluir treino" }).click();

    await expect(page.getByRole("alert")).toContainText(
      "O treino foi excluído, mas a limpeza neste dispositivo precisa ser concluída.",
    );
    await expect(
      page.getByRole("button", { name: "Concluir limpeza" }),
    ).toBeEnabled();
    expect(paths).toEqual([
      "GET /v1/attempts",
      `DELETE /v1/attempts/${attemptId}`,
    ]);
    expect(
      await page.evaluate(() =>
        (
          window as typeof window & {
            __readRawFreeTrainingOwnership?: () => {
              owner: string | null;
              intent: string | null;
            };
          }
        ).__readRawFreeTrainingOwnership?.(),
      ),
    ).toEqual(before);

    await page.evaluate(() => {
      (
        window as typeof window & {
          __restoreFreeTrainingStorageRead?: () => void;
        }
      ).__restoreFreeTrainingStorageRead?.();
    });
    await page.getByRole("button", { name: "Concluir limpeza" }).click();
    await expect(page.getByText("Treino excluído.")).toHaveAttribute(
      "role",
      "status",
    );
    await expect(
      page.getByRole("heading", {
        name: "Meus treinos neste dispositivo",
        level: 1,
      }),
    ).toBeFocused();
    await page.getByRole("link", { name: "Início" }).click();
    await page.getByRole("button", { name: "Treino livre" }).click();
    await expect(
      page.getByRole("button", { name: "Selecionar vídeo" }),
    ).toBeEnabled();
    expect(paths).toEqual([
      "GET /v1/attempts",
      `DELETE /v1/attempts/${attemptId}`,
      "POST /v1/attempts",
    ]);
  });
}
