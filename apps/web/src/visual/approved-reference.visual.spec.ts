import {
  AttemptOutcomeSchema,
  CalibrationSessionSchema,
  CreateAttemptResponseSchema,
  MediaUploadAcceptedSchema,
} from "@revelai/contracts";
import { expect, test } from "@playwright/test";
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

test("captures the approved mobile reference matrix through stable public states", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "mobile-home",
    "The approved W6 state matrix is defined at 390×844 DPR 2 only.",
  );
  let terminal = false;
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
  captures.push(
    await captureReferenceVisualArtifacts({
      page,
      viewport,
      dpr: 2,
      state: "challenge-choice",
    }),
  );

  await page.getByRole("button", { name: "Preparar desafio" }).click();
  await page.getByRole("button", { name: "Usar vídeo existente" }).click();
  await page.getByRole("button", { name: "Continuar" }).click();
  await expect(page.getByText("Calibre o espaço.")).toBeVisible();
  captures.push(
    await captureReferenceVisualArtifacts({
      page,
      viewport,
      dpr: 2,
      state: "calibration-guidance",
    }),
  );

  for (let index = 0; index < 4; index += 1) {
    await page.getByRole("button", { name: "Confirmar etapa" }).click();
    await page.getByRole("button", { name: "Continuar" }).click();
  }
  await expect(
    page.getByRole("heading", { name: "Envie o vídeo verificado" }),
  ).toBeVisible();
  captures.push(
    await captureReferenceVisualArtifacts({
      page,
      viewport,
      dpr: 2,
      state: "recording-capture",
    }),
  );

  await page.locator("#production-video-input").setInputFiles({
    name: "visual-verified.mp4",
    mimeType: "video/mp4",
    buffer: captureBytes,
  });
  await page.getByRole("button", { name: "Enviar vídeo", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Processando tentativa" }),
  ).toBeVisible();
  captures.push(
    await captureReferenceVisualArtifacts({
      page,
      viewport,
      dpr: 2,
      state: "processing-pending",
    }),
  );

  terminal = true;
  await page.getByRole("button", { name: "Atualizar agora" }).click();
  await expect(
    page.getByRole("heading", { name: "Resultado do desafio verificado" }),
  ).toBeVisible();
  await expect(
    page.getByText("Resultado validado — vale para ranking"),
  ).toBeVisible();
  captures.push(
    await captureReferenceVisualArtifacts({
      page,
      viewport,
      dpr: 2,
      state: "ranked-report",
    }),
  );

  expect(captures).toHaveLength(6);
  for (const capture of captures) {
    expect(capture.metadata.viewport).toEqual(viewport);
    expect(capture.metadata.dpr).toBe(2);
    expect(capture.comparison.mask.regions).toEqual([]);
    expect(capture.comparison.image.comparedPixels).toBeGreaterThan(0);
  }
});
