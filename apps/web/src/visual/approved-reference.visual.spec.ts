import {
  assertReferenceVisualLandmarks,
  getReferenceVisualGate,
} from "./visual-harness";
import {
  AttemptOutcomeSchema,
  CalibrationSessionSchema,
  CreateAttemptResponseSchema,
  MediaUploadAcceptedSchema,
} from "@revelai/contracts";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { captureReferenceVisualArtifacts } from "./visual-harness.node";
import {
  policyApprovedRankedLeaderboard,
  policyApprovedRankedOutcome,
} from "./ranked-policy-fixture";

const viewport = { width: 390, height: 844 } as const;
const captureBytes = Buffer.from([
  0, 0, 0, 16, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 1, 2, 3, 4,
]);

const calibration = CalibrationSessionSchema.parse({
  id: "calibration-visual-w6",
  challengeId: "wall-pass",
  challengeVersion: 1,
  state: "issued",
  nonce: "1234567890123456789012345678901234567890123",
  issuedAt: "2026-08-30T12:00:00.000Z",
  expiresAt: "2026-08-30T12:15:00.000Z",
  requiredGates: ["device", "space", "athlete", "rehearsal", "record"],
});

const pendingOutcome = AttemptOutcomeSchema.parse({
  state: "pending",
  attemptId: "attempt-ranked-policy-approved-w6",
  mode: "verified",
  status: "processing",
});

const uploadedOutcome = AttemptOutcomeSchema.parse({
  state: "pending",
  attemptId: "attempt-ranked-policy-approved-w6",
  mode: "verified",
  status: "uploaded",
});

const createdAttempt = CreateAttemptResponseSchema.parse({
  id: "attempt-ranked-policy-approved-w6",
  mode: "verified",
  status: "awaiting-upload",
  createdAt: "2026-08-30T12:01:00.000Z",
  challenge: { id: "wall-pass", version: 1 },
  outcome: {
    state: "pending",
    attemptId: "attempt-ranked-policy-approved-w6",
    mode: "verified",
    status: "awaiting-upload",
  },
});

const acceptedUpload = MediaUploadAcceptedSchema.parse({
  kind: "media-upload-accepted",
  attemptId: "attempt-ranked-policy-approved-w6",
  mode: "verified",
  acceptedStatus: "uploaded",
  outcome: uploadedOutcome,
});

async function expectVisibleFocus(locator: Locator) {
  await locator.focus();
  await expect(locator).toBeFocused();
  expect(
    await locator.evaluate((element) => getComputedStyle(element).outlineStyle),
  ).not.toBe("none");
}

async function tabTo(page: Page, locator: Locator) {
  for (let index = 0; index < 24; index += 1) {
    await page.keyboard.press("Tab");
    if (await locator.evaluate((element) => element === document.activeElement))
      return;
  }
  throw new Error("Required control was not reachable by Tab.");
}

async function assertApprovedViewport(
  page: Page,
  state:
    | "challenge-choice"
    | "calibration-guidance"
    | "recording-capture"
    | "processing-pending"
    | "ranked-report",
) {
  await page.evaluate(async () => {
    window.scrollTo({ top: 0, left: 0, behavior: "instant" });
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve()),
    );
  });
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  const gate = getReferenceVisualGate({ route: "/verified", state, viewport });
  const landmarks = await page
    .locator("[data-visual-landmark]")
    .evaluateAll((elements) =>
      elements.map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          id: element.getAttribute("data-visual-landmark") ?? "",
          left: rect.left,
          top: rect.top,
          right: rect.right,
          bottom: rect.bottom,
        };
      }),
    );
  assertReferenceVisualLandmarks({
    viewport,
    requiredLandmarks: gate.requiredLandmarks,
    landmarks,
  });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(viewport.width);
  return { gate, landmarks };
}

async function captureApprovedState({
  page,
  state,
}: Readonly<{
  page: Page;
  state:
    | "challenge-choice"
    | "calibration-guidance"
    | "recording-capture"
    | "processing-pending"
    | "ranked-report";
}>) {
  const { gate, landmarks } = await assertApprovedViewport(page, state);
  const capture = await captureReferenceVisualArtifacts({
    page,
    viewport,
    dpr: 2,
    state,
    landmarks,
  });
  expect(capture.comparison.image.mismatchRatio).toBeLessThanOrEqual(
    gate.maxMismatchRatio,
  );
  expect(capture.comparison.exceedsBudget).toBe(false);
  return capture;
}

test("captures the approved mobile reference matrix through stable public states", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "mobile-home",
    "The approved W6 state matrix is defined at 390×844 DPR 2 only.",
  );
  let terminal = false;
  let holdPendingResult = false;
  let releasePendingResult: (() => void) | undefined;
  const browserErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));
  await page.route("**/v1/**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (
      request.method() === "POST" &&
      pathname === "/v1/calibration-sessions"
    ) {
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify(calibration),
      });
      return;
    }
    if (
      request.method() === "POST" &&
      pathname === "/v1/calibration-sessions/calibration-visual-w6/ready"
    ) {
      await route.fulfill({ status: 204 });
      return;
    }
    if (request.method() === "POST" && pathname === "/v1/attempts") {
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify(createdAttempt),
      });
      return;
    }
    if (
      request.method() === "POST" &&
      pathname === "/v1/attempts/attempt-ranked-policy-approved-w6/media"
    ) {
      await route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify(acceptedUpload),
      });
      return;
    }
    if (
      request.method() === "GET" &&
      pathname === "/v1/attempts/attempt-ranked-policy-approved-w6/result"
    ) {
      if (!terminal && holdPendingResult) {
        await new Promise<void>((resolve) => {
          releasePendingResult = resolve;
        });
        holdPendingResult = false;
      }
      const outcome = terminal ? policyApprovedRankedOutcome : pendingOutcome;
      await route.fulfill({
        status: outcome.state === "pending" ? 202 : 200,
        contentType: "application/json",
        body: JSON.stringify(outcome),
      });
      return;
    }
    if (
      request.method() === "GET" &&
      pathname === "/v1/leaderboards/wall-pass"
    ) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(policyApprovedRankedLeaderboard),
      });
      return;
    }
    await route.fulfill({
      status: 404,
      body: "Unexpected visual fixture request",
    });
  });

  await page.goto("/");
  await page.emulateMedia({ reducedMotion: "reduce" });
  const captures = [];
  captures.push(
    await captureReferenceVisualArtifacts({
      page,
      viewport,
      dpr: 2,
      state: "ready",
    }),
  );

  await page.getByRole("button", { name: "Desafio verificado" }).click();
  await expect(
    page.getByRole("heading", { name: "Escolha. Prepare. Compita." }),
  ).toBeVisible();
  const prepare = page.getByRole("button", { name: "Preparar desafio" });
  await tabTo(page, prepare);
  await expectVisibleFocus(prepare);
  await expect(
    page.getByRole("button", { name: "Em breve" }).first(),
  ).toBeDisabled();
  captures.push(
    await captureApprovedState({ page, state: "challenge-choice" }),
  );

  await prepare.press("Enter");
  await page.getByRole("button", { name: "Usar vídeo existente" }).click();
  await page.getByRole("button", { name: "Continuar" }).click();
  await expect(page.getByText("Calibre o espaço.")).toBeVisible();
  const confirm = page.getByRole("button", { name: "Confirmar etapa" });
  const continueButton = page.getByRole("button", { name: "Continuar" });
  await expect(continueButton).toBeDisabled();
  await expect(page.getByRole("button", { name: "Voltar" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Cancelar preparação" }),
  ).toBeVisible();
  await tabTo(page, confirm);
  await expectVisibleFocus(confirm);
  captures.push(
    await captureApprovedState({ page, state: "calibration-guidance" }),
  );

  await confirm.press("Space");
  await expect(continueButton).toBeEnabled();
  await continueButton.press("Enter");
  for (let index = 0; index < 3; index += 1) {
    await page.getByRole("button", { name: "Confirmar etapa" }).click();
    await page.getByRole("button", { name: "Continuar" }).click();
  }
  await expect(
    page.getByRole("heading", { name: "Envie o vídeo verificado" }),
  ).toBeVisible();
  const existingVideo = page.getByRole("button", {
    name: "Enviar vídeo existente",
  });
  await tabTo(page, existingVideo);
  await expectVisibleFocus(existingVideo);
  await expect(
    page.getByRole("button", { name: "Iniciar gravação" }),
  ).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "Enviar vídeo", exact: true }),
  ).toBeDisabled();
  captures.push(
    await captureApprovedState({ page, state: "recording-capture" }),
  );

  const picker = page.waitForEvent("filechooser");
  await existingVideo.press("Space");
  await (
    await picker
  ).setFiles({
    name: "visual-verified.mp4",
    mimeType: "video/mp4",
    buffer: captureBytes,
  });
  await page.getByRole("button", { name: "Enviar vídeo", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Processando tentativa" }),
  ).toBeVisible();
  const refresh = page.getByRole("button", { name: "Atualizar agora" });
  await expect(refresh).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "Iniciar outro desafio" }),
  ).toBeVisible();
  captures.push(
    await captureApprovedState({ page, state: "processing-pending" }),
  );

  holdPendingResult = true;
  await refresh.click();
  await expect(refresh).toBeDisabled();
  await expect(refresh).toHaveAttribute("aria-busy", "true");
  releasePendingResult?.();
  await expect(refresh).toBeEnabled();

  terminal = true;
  await refresh.click();
  await expect(
    page.getByRole("heading", { name: "Resultado do desafio verificado" }),
  ).toBeVisible();
  await expect(
    page.getByText("Resultado validado — vale para ranking"),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Ver Ranking atual" }),
  ).toBeVisible();
  captures.push(await captureApprovedState({ page, state: "ranked-report" }));

  expect(captures).toHaveLength(6);
  for (const capture of captures) {
    expect(capture.metadata.viewport).toEqual(viewport);
    expect(capture.metadata.dpr).toBe(2);
    expect(capture.comparison.mask.regions).toEqual([]);
    expect(capture.comparison.image.comparedPixels).toBeGreaterThan(0);
  }
  expect(browserErrors).toEqual([]);
});

test("covers the 390px verified leaderboard loading, failure, empty, keyboard, and reduced-motion states", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "mobile-home",
    "The W6 browser accessibility audit is defined at 390×844 DPR 2 only.",
  );
  let phase: "loading" | "failure" | "empty" = "loading";
  let releaseLoading: (() => void) | undefined;
  const browserErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));
  await page.route("**/v1/leaderboards/wall-pass**", async (route) => {
    if (phase === "loading") {
      await new Promise<void>((resolve) => {
        releaseLoading = resolve;
      });
      phase = "failure";
    }
    if (phase === "failure") {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          code: "service_not_ready",
          message: "O ranking não está disponível agora.",
          retryable: true,
        }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ...policyApprovedRankedLeaderboard,
        cohortSize: 0,
        entries: [],
        nextCursor: null,
      }),
    });
  });

  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/verified?view=ranking");
  await expect(
    page.getByRole("heading", { name: "Ranking atual" }),
  ).toBeVisible();
  await expect(page.getByRole("status")).toContainText(
    "Carregando ranking atual.",
  );
  const refresh = page.getByRole("button", { name: "Atualizar ranking" });
  await expect(refresh).toBeDisabled();
  releaseLoading?.();
  await expect(page.getByRole("alert")).toContainText(
    "Não foi possível continuar agora. Tente novamente.",
  );
  await expect(refresh).toBeEnabled();
  await tabTo(page, refresh);
  await expectVisibleFocus(refresh);
  phase = "empty";
  await refresh.press("Enter");
  await expect(page.getByRole("status")).toContainText(
    "Ainda não há resultados no ranking atual.",
  );
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(viewport.width);
  expect(
    browserErrors.filter(
      (error) =>
        error !==
        "Failed to load resource: the server responded with a status of 503 (Service Unavailable)",
    ),
  ).toEqual([]);
});
