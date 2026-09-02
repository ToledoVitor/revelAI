import { access, readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { resolveVisualGate } from "./visual-gate";
import { captureHomeVisualArtifacts } from "./visual-harness.node";

const visualGate = resolveVisualGate({
  mode: process.env.REVELAI_VISUAL_MODE,
  rendererIdentity: process.env.REVELAI_VISUAL_RENDERER,
  runtime: { platform: process.platform, arch: process.arch },
});
const isStructuralVisualRun = visualGate.mode === "structural";

function getPixelRenderer() {
  if (!("renderer" in visualGate)) {
    throw new Error("Pixel visual tests require an explicit renderer.");
  }

  return visualGate.renderer;
}

test("loads the bundled display and body fonts before visual capture", async ({
  page,
}) => {
  await page.goto("/");
  await page.evaluate(() => document.fonts.ready);

  const loadedFamilies = await page.evaluate(() =>
    Array.from(document.fonts)
      .filter((font) => font.status === "loaded")
      .map((font) => font.family.replaceAll('"', "")),
  );

  expect(loadedFamilies).toEqual(
    expect.arrayContaining(["Arimo", "Bebas Neue"]),
  );
});

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

test("renders the exact mobile viewport without browser warnings or errors", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-home");
  const diagnostics: string[] = [];

  page.on("console", (message) => {
    if (message.type() === "warning" || message.type() === "error") {
      diagnostics.push(`${message.type()}: ${message.text()}`);
    }
  });
  page.on("pageerror", (error) =>
    diagnostics.push(`pageerror: ${error.message}`),
  );

  await page.goto("/");
  expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBe(
    844,
  );
  expect(diagnostics).toEqual([]);
});

test("writes normalized capture, metadata, overlay, and diff for each approved reference", async ({
  page,
}, testInfo) => {
  test.skip(
    isStructuralVisualRun,
    "Reference-pixel comparisons run in the pinned Linux visual renderer.",
  );
  await page.goto("/");

  const artifacts = await captureHomeVisualArtifacts({
    page,
    viewport: testInfo.project.use.viewport as {
      width: number;
      height: number;
    },
    dpr: testInfo.project.use.deviceScaleFactor as number,
    renderer: getPixelRenderer(),
  });

  expect(artifacts.metadata.route).toBe("/");
  expect(artifacts.metadata.state).toBe("ready");
  expect(artifacts.comparison.renderer).toBe(getPixelRenderer());
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
  expect(
    artifacts.comparison.exceedsBudget,
    JSON.stringify(
      {
        renderer: artifacts.comparison.renderer,
        image: artifacts.comparison.image,
        uiInk: artifacts.comparison.uiInk,
      },
      null,
      2,
    ),
  ).toBe(false);
  expect(artifacts.comparison.image.mismatchRatio).toBeLessThanOrEqual(
    artifacts.comparison.image.maxMismatchRatio,
  );
  expect(artifacts.comparison.uiInk.mismatchRatio).toBeLessThanOrEqual(
    artifacts.comparison.uiInk.maxMismatchRatio,
  );
  expect(artifacts.comparison.uiInk.coverage).toEqual(
    expect.arrayContaining([expect.objectContaining({ passes: true })]),
  );
});

test("rejects deliberate UI regressions that sit over the masked photo", async ({
  page,
}, testInfo) => {
  test.skip(
    isStructuralVisualRun,
    "Reference-pixel comparisons run in the pinned Linux visual renderer.",
  );
  await page.goto("/");

  await page.evaluate((isMobile) => {
    const selectors = isMobile
      ? [".brand", ".hero-copy h1", ".hero-description"]
      : [".primary-navigation"];

    for (const selector of selectors) {
      const element = document.querySelector<HTMLElement>(selector);
      if (!element) {
        throw new Error(`Missing visual-regression target: ${selector}`);
      }

      element.style.color = "#F7F5F0";
      element.style.opacity = "0";
    }
  }, testInfo.project.name === "mobile-home");

  try {
    const artifacts = await captureHomeVisualArtifacts({
      page,
      viewport: testInfo.project.use.viewport as {
        width: number;
        height: number;
      },
      dpr: testInfo.project.use.deviceScaleFactor as number,
      state: "ui-ink-mutation",
      renderer: getPixelRenderer(),
    });

    expect(artifacts.metadata).toMatchObject({
      route: "/",
      state: "ui-ink-mutation",
      fixture: "home-mutation",
    });
    expect(artifacts.comparison.exceedsBudget).toBe(true);
    expect(artifacts.comparison.uiInk.coverage).toEqual(
      expect.arrayContaining([expect.objectContaining({ passes: false })]),
    );
  } finally {
    await page.goto("/");
  }
});

test("starts the desktop photo at the approved 46 percent composition split", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-home");
  await page.goto("/");

  const heroBox = await page
    .getByRole("img", {
      name: "Jogador de futsal treinando em quadra interna",
    })
    .boundingBox();

  expect(heroBox).not.toBeNull();
  expect(heroBox!.x).toBeGreaterThanOrEqual(655);
  expect(heroBox!.x).toBeLessThanOrEqual(691);
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

test("keeps the remaining unavailable destination free of follow-up network requests", async ({
  page,
}) => {
  const requests: string[] = [];
  page.on("request", (request) => {
    requests.push(request.url());
  });

  for (const control of ["Analisar treino"]) {
    await page.goto("/");
    await expect(
      page.getByRole("img", {
        name: "Jogador de futsal treinando em quadra interna",
      }),
    ).toHaveJSProperty("complete", true);
    await page.evaluate(() => document.fonts.ready);
    const requestCountBeforeInteraction = requests.length;

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
  const controls = [{ name: "Analisar treino", isNavigationControl: false }];

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

test("opens the device-local history link with visible keyboard focus", async ({
  page,
}, testInfo) => {
  await page.route("**/v1/attempts*", (route) =>
    route.fulfill({ json: { items: [], nextCursor: null } }),
  );
  await page.goto("/");

  if (testInfo.project.name === "mobile-home") {
    await page.getByRole("button", { name: "Abrir navegação" }).press("Enter");
  }

  const historyLink = page.getByRole("link", { name: "Meus treinos" });
  await historyLink.focus();
  await expect(historyLink).toBeFocused();
  await expect(historyLink).toHaveCSS("outline-width", "3px");
  await historyLink.press("Enter");

  const heading = page.getByRole("heading", {
    name: "Meus treinos neste dispositivo",
    level: 1,
  });
  await expect(heading).toBeVisible();
  await expect(heading).toBeFocused();
  await expect(page.getByRole("status")).toHaveText(
    "Nenhum treino neste dispositivo ainda.",
  );
});

test("keeps mobile navigation links in the keyboard sequence and restores focus when closed", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-home");
  await page.goto("/");

  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "RevelAI" })).toBeFocused();
  await page.keyboard.press("Tab");

  const navigationToggle = page.getByRole("button", { name: /navegação/ });
  await expect(navigationToggle).toBeFocused();
  await navigationToggle.press("Enter");
  await expect(navigationToggle).toHaveAttribute("aria-expanded", "true");

  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Início" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Meus treinos" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Ranking" })).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(navigationToggle).toHaveAttribute("aria-expanded", "false");
  await expect(navigationToggle).toBeFocused();
});
