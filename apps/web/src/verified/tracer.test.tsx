import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../app";

const calibration = {
  id: "calibration-w4-1",
  challengeId: "wall-pass",
  challengeVersion: 1,
  state: "issued",
  nonce: "1234567890123456789012345678901234567890123",
  issuedAt: "2026-08-30T12:00:00.000Z",
  expiresAt: "2026-08-30T12:15:00.000Z",
  requiredGates: ["device", "space", "athlete", "rehearsal", "record"],
} as const;

const createdAttempt = {
  id: "attempt-w4-1",
  mode: "verified",
  status: "awaiting-upload",
  createdAt: "2026-08-30T12:01:00.000Z",
  challenge: { id: "wall-pass", version: 1 },
  outcome: {
    state: "pending",
    attemptId: "attempt-w4-1",
    mode: "verified",
    status: "awaiting-upload",
  },
} as const;

const acceptedUpload = {
  kind: "media-upload-accepted",
  attemptId: "attempt-w4-1",
  mode: "verified",
  acceptedStatus: "uploaded",
  outcome: {
    state: "pending",
    attemptId: "attempt-w4-1",
    mode: "verified",
    status: "uploaded",
  },
} as const;

const demoOutcome = {
  state: "valid",
  result: {
    kind: "verified-result",
    attemptId: "attempt-w4-1",
    challengeId: "wall-pass",
    challengeVersion: 1,
    ruleVersion: "wall-pass-v1-score-1",
    provenance: {
      kind: "demo",
      fixtureId: "wall-pass-balanced-v1",
      providerVersion: "demo-observations-v1",
    },
    metrics: {
      validPasses: 22,
      accuracyPercent: 88.5,
      meanCadenceSeconds: 1.7,
      leftFootPercent: 50,
      rightFootPercent: 50,
    },
    score: 86,
    completedAt: "2026-08-30T12:02:00.000Z",
    competitiveStatus: "demo",
    competitiveEligible: false,
  },
} as const;

const rankedOutcome = {
  state: "valid",
  result: {
    kind: "verified-result",
    attemptId: "attempt-w4-1",
    challengeId: "wall-pass",
    challengeVersion: 1,
    ruleVersion: "wall-pass-v1-score-1",
    provenance: {
      kind: "roboflow",
      workspaceId: "workspace-w4",
      workflowId: "revelai-wall-pass-geometry-v1",
      workflowVersion: "1.0.0",
      modelBundleId: "bundle-w4",
      providerVersion: "roboflow-w4",
    },
    metrics: {
      validPasses: 31,
      accuracyPercent: 93.5,
      meanCadenceSeconds: 1.32,
      leftFootPercent: 48,
      rightFootPercent: 52,
    },
    score: 94,
    completedAt: "2026-08-30T12:02:00.000Z",
    competitiveStatus: "ranked",
    competitiveEligible: true,
    rankingSnapshot: {
      kind: "frozen",
      challengeId: "wall-pass",
      challengeVersion: 1,
      ruleVersion: "wall-pass-v1-score-1",
      rank: 3,
      cohortSize: 24,
      percentile: 87.5,
      topPercent: 12.5,
      scoreCountAtFinalization: 24,
      asOfAttemptId: "attempt-w4-1",
      calculatedAt: "2026-08-30T12:02:00.000Z",
    },
  },
} as const;

const experimentalOutcome = {
  ...demoOutcome,
  result: {
    ...demoOutcome.result,
    provenance: {
      kind: "roboflow",
      workspaceId: "workspace-w4",
      workflowId: "revelai-wall-pass-geometry-v1",
      workflowVersion: "1.0.0",
      modelBundleId: "bundle-w4",
      providerVersion: "roboflow-w4",
    },
    competitiveStatus: "experimental",
  },
} as const;

const pendingOutcome = {
  state: "pending",
  attemptId: "attempt-w4-1",
  mode: "verified",
  status: "processing",
} as const;

function response(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function enterPending(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Desafio verificado" }));
  await completeVerifiedSetup(user);
  await screen.findByRole("heading", { name: "Envie o vídeo verificado" });
  await waitForAttemptReady();
  fireEvent.change(screen.getByTestId("production-video-input"), {
    target: {
      files: [new File(["video"], "wall-pass.webm", { type: "video/webm" })],
    },
  });
  await user.click(screen.getByRole("button", { name: "Enviar vídeo" }));
  await screen.findByRole("heading", { name: "Processando tentativa" });
}

async function waitForAttemptReady() {
  await waitFor(() =>
    expect(screen.getByTestId("production-video-input")).toBeEnabled(),
  );
}

async function completeVerifiedSetup(user: ReturnType<typeof userEvent.setup>) {
  for (let index = 0; index < 5; index += 1) {
    await user.click(
      screen.getByRole("button", {
        name: index === 0 ? "Usar vídeo existente" : "Confirmar etapa",
      }),
    );
    await user.click(screen.getByRole("button", { name: "Continuar" }));
  }
}

function workflowFetch(result: unknown | (() => unknown)) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const pathname = new URL(input.toString()).pathname;
    if (pathname === "/v1/calibration-sessions")
      return response(calibration, 201);
    if (pathname === "/v1/calibration-sessions/calibration-w4-1/ready")
      return new Response(null, { status: 204 });
    if (pathname === "/v1/attempts") return response(createdAttempt, 201);
    if (pathname === "/v1/attempts/attempt-w4-1/media")
      return response(acceptedUpload, 202);
    if (pathname === "/v1/attempts/attempt-w4-1/result")
      return response(typeof result === "function" ? result() : result, 200);
    throw new Error(`Unexpected request: ${pathname}`);
  });
}

describe("production verified tracer", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/");
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("mounts the verified owner before running the exact session-ready-attempt-media sequence", async () => {
    const user = userEvent.setup();
    const fetchSpy = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const pathname = new URL(input.toString()).pathname;
        if (pathname === "/v1/calibration-sessions")
          return response(calibration, 201);
        if (pathname === "/v1/calibration-sessions/calibration-w4-1/ready") {
          return new Response(null, { status: 204 });
        }
        if (pathname === "/v1/attempts") return response(createdAttempt, 201);
        if (pathname === "/v1/attempts/attempt-w4-1/media") {
          return response(acceptedUpload, 202);
        }
        throw new Error(
          `Unexpected request: ${pathname} ${init?.method ?? "GET"}`,
        );
      },
    );
    vi.stubGlobal("fetch", fetchSpy);

    render(<App />);

    await user.click(
      screen.getByRole("button", { name: "Desafio verificado" }),
    );
    expect(
      await screen.findByRole("heading", {
        name: "Preparação do desafio verificado",
        level: 1,
      }),
    ).toHaveFocus();
    expect(fetchSpy).not.toHaveBeenCalled();

    await completeVerifiedSetup(user);

    expect(
      await screen.findByRole("heading", {
        name: "Envie o vídeo verificado",
        level: 1,
      }),
    ).toHaveFocus();
    expect(
      fetchSpy.mock.calls.map(([input]) => new URL(input.toString()).pathname),
    ).toEqual([
      "/v1/calibration-sessions",
      "/v1/calibration-sessions/calibration-w4-1/ready",
      "/v1/attempts",
    ]);
    expect(JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body))).toEqual({
      challengeId: "wall-pass",
      challengeVersion: 1,
    });
    expect(JSON.parse(String(fetchSpy.mock.calls[1]?.[1]?.body))).toEqual({
      requiredGates: ["device", "space", "athlete", "rehearsal", "record"],
    });
    expect(JSON.parse(String(fetchSpy.mock.calls[2]?.[1]?.body))).toEqual({
      mode: "verified",
      challengeId: "wall-pass",
      challengeVersion: 1,
      calibrationSessionId: "calibration-w4-1",
    });

    const file = new File(["video"], "wall-pass.webm", { type: "video/webm" });
    await waitForAttemptReady();
    fireEvent.change(screen.getByTestId("production-video-input"), {
      target: { files: [file] },
    });
    expect(await screen.findByText(file.name)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Enviar vídeo" }));

    expect(
      await screen.findByRole("heading", {
        name: "Processando tentativa",
        level: 1,
      }),
    ).toHaveFocus();
    const upload = fetchSpy.mock.calls[3];
    expect(new URL(upload?.[0].toString()).pathname).toBe(
      "/v1/attempts/attempt-w4-1/media",
    );
    const uploadParts = Array.from((upload?.[1]?.body as FormData).entries());
    expect(uploadParts).toHaveLength(1);
    expect(uploadParts[0]?.[0]).toBe("media");
    expect(uploadParts[0]?.[1]).toMatchObject({
      name: file.name,
      type: file.type,
    });
  });

  it("preserves the gated setup correction, recovery, back navigation, and focus before any mutation", async () => {
    const user = userEvent.setup();
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    render(<App />);

    await user.click(
      screen.getByRole("button", { name: "Desafio verificado" }),
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "Ative a câmera ou use um vídeo existente antes de continuar.",
    );
    expect(screen.getByRole("button", { name: "Continuar" })).toBeDisabled();
    expect(fetchSpy).not.toHaveBeenCalled();

    await user.click(
      screen.getByRole("button", { name: "Usar vídeo existente" }),
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "Vídeo existente escolhido como alternativa de captura.",
    );
    expect(screen.getByRole("button", { name: "Continuar" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Continuar" }));

    expect(
      screen.getByRole("heading", { name: "Preparação do desafio verificado" }),
    ).toHaveFocus();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Posicione dois marcadores visíveis a três metros da parede.",
    );
    await user.click(screen.getByRole("button", { name: "Voltar" }));
    expect(screen.getByRole("status")).toHaveTextContent(
      "Vídeo existente escolhido como alternativa de captura.",
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("uses a real camera activation instead of exposing simulated controls on the public verified route", async () => {
    const user = userEvent.setup();
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
    const stop = vi.fn();
    const getUserMedia = vi.fn().mockResolvedValue({
      getTracks: () => [{ stop }],
    } as unknown as MediaStream);
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia },
    });
    render(<App />);

    await user.click(
      screen.getByRole("button", { name: "Desafio verificado" }),
    );

    expect(
      screen.queryByRole("button", { name: /simular/i }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Ativar câmera" }));
    await waitFor(() => expect(getUserMedia).toHaveBeenCalledOnce());
    expect(screen.getByRole("status")).toHaveTextContent(
      "Prévia da câmera pronta.",
    );
    expect(screen.getByRole("button", { name: "Continuar" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Continuar" }));
    expect(stop).toHaveBeenCalledOnce();
  });

  it("requires a new real preview when Back returns to a device gate whose stream was released", async () => {
    const user = userEvent.setup();
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
    const stop = vi.fn();
    const getUserMedia = vi.fn().mockResolvedValue({
      getTracks: () => [{ stop }],
    } as unknown as MediaStream);
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia },
    });
    render(<App />);

    await user.click(
      screen.getByRole("button", { name: "Desafio verificado" }),
    );
    await user.click(screen.getByRole("button", { name: "Ativar câmera" }));
    await screen.findByText("Prévia da câmera pronta.");
    await user.click(screen.getByRole("button", { name: "Continuar" }));
    expect(stop).toHaveBeenCalledOnce();

    await user.click(screen.getByRole("button", { name: "Voltar" }));

    expect(
      screen.getByRole("heading", { name: "Preparação do desafio verificado" }),
    ).toHaveFocus();
    expect(screen.getByRole("button", { name: "Continuar" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Ativar câmera" })).toBeEnabled();
    expect(
      screen.getByRole("button", { name: "Usar vídeo existente" }),
    ).toBeEnabled();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Ative a câmera ou use um vídeo existente antes de continuar.",
    );
  });

  it("allows the W2 existing-video fallback to satisfy only the device gate before mutations", async () => {
    const user = userEvent.setup();
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    render(<App />);

    await user.click(
      screen.getByRole("button", { name: "Desafio verificado" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Usar vídeo existente" }),
    );

    expect(screen.getByRole("status")).toHaveTextContent(
      "Vídeo existente escolhido como alternativa de captura.",
    );
    expect(screen.getByRole("button", { name: "Continuar" })).toBeEnabled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("recovers a failed attempt creation without enabling capture until the same prepared session gets a new attempt", async () => {
    const user = userEvent.setup();
    let createCalls = 0;
    const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
      const pathname = new URL(input.toString()).pathname;
      if (pathname === "/v1/calibration-sessions")
        return response(calibration, 201);
      if (pathname === "/v1/calibration-sessions/calibration-w4-1/ready")
        return new Response(null, { status: 204 });
      if (pathname === "/v1/attempts") {
        createCalls += 1;
        return createCalls === 1
          ? response(
              {
                code: "service_not_ready",
                message: "O serviço está temporariamente indisponível.",
                retryable: true,
              },
              503,
            )
          : response(createdAttempt, 201);
      }
      throw new Error(`Unexpected request: ${pathname}`);
    });
    vi.stubGlobal("fetch", fetchSpy);
    render(<App />);

    await user.click(
      screen.getByRole("button", { name: "Desafio verificado" }),
    );
    await completeVerifiedSetup(user);
    expect(
      await screen.findByRole("button", { name: "Tentar preparar tentativa" }),
    ).toBeVisible();
    expect(screen.getByTestId("production-video-input")).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "O serviço está temporariamente indisponível.",
    );

    await user.click(
      screen.getByRole("button", { name: "Tentar preparar tentativa" }),
    );
    await waitForAttemptReady();
    expect(createCalls).toBe(2);
    expect(
      fetchSpy.mock.calls.filter(
        ([input]) =>
          new URL(input.toString()).pathname === "/v1/calibration-sessions",
      ),
    ).toHaveLength(1);
  });

  it("renders a demo result without competitive fields after a manual pending refresh", async () => {
    const user = userEvent.setup();
    const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
      const pathname = new URL(input.toString()).pathname;
      if (pathname === "/v1/calibration-sessions")
        return response(calibration, 201);
      if (pathname === "/v1/calibration-sessions/calibration-w4-1/ready")
        return new Response(null, { status: 204 });
      if (pathname === "/v1/attempts") return response(createdAttempt, 201);
      if (pathname === "/v1/attempts/attempt-w4-1/media")
        return response(acceptedUpload, 202);
      if (pathname === "/v1/attempts/attempt-w4-1/result")
        return response(demoOutcome, 200);
      throw new Error(`Unexpected request: ${pathname}`);
    });
    vi.stubGlobal("fetch", fetchSpy);
    render(<App />);

    await enterPending(user);
    await user.click(screen.getByRole("button", { name: "Atualizar agora" }));

    expect(
      await screen.findByRole("heading", {
        name: "Resultado do desafio verificado",
        level: 1,
      }),
    ).toHaveFocus();
    expect(screen.getByText("Demo — não vale para ranking")).toBeVisible();
    expect(screen.getByText("Score: 86")).toBeVisible();
    expect(screen.getByText("Passes válidos")).toBeVisible();
    expect(screen.getByLabelText("Proveniência demo")).toHaveTextContent(
      "wall-pass-balanced-v1",
    );
    expect(screen.getByLabelText("Proveniência demo")).toHaveTextContent(
      "demo-observations-v1",
    );
    expect(screen.queryByText(/Posição:/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Percentil:/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Top percent:/)).not.toBeInTheDocument();
  });

  it("renders a frozen ranked snapshot with distinct percentile and top-percent meanings", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", workflowFetch(rankedOutcome));
    render(<App />);

    await enterPending(user);
    await user.click(screen.getByRole("button", { name: "Atualizar agora" }));

    expect(
      await screen.findByText("Resultado validado — vale para ranking"),
    ).toBeVisible();
    expect(screen.getByText("Passes válidos")).toBeVisible();
    expect(screen.getByText("31 passes")).toBeVisible();
    expect(screen.getByText("93.5%")).toBeVisible();
    expect(screen.getByText("1.32 s")).toBeVisible();
    expect(screen.getByText("Proveniência: roboflow.")).toBeVisible();
    for (const value of [
      "workspace-w4",
      "revelai-wall-pass-geometry-v1",
      "1.0.0",
      "bundle-w4",
      "roboflow-w4",
    ])
      expect(screen.getByLabelText("Proveniência Roboflow")).toHaveTextContent(
        value,
      );
    const snapshot = screen.getByRole("region", {
      name: "Snapshot de ranking congelado",
    });
    expect(snapshot).toHaveTextContent(
      "Snapshot: frozenDesafio do snapshot: wall-pass v1Regra do snapshot: wall-pass-v1-score-1Posição: 3Coorte: 24",
    );
    expect(
      screen.getByText(/percentual da coorte com pontuação igual ou menor/),
    ).toBeVisible();
    expect(
      screen.getByText(/distância até o topo, não um sinônimo de percentil/),
    ).toBeVisible();
    expect(screen.getByText("Pontuações no cálculo: 24")).toBeVisible();
    expect(snapshot).toHaveTextContent(
      "Calculado em: 2026-08-30T12:02:00.000ZTentativa do snapshot: attempt-w4-1",
    );
    expect(
      screen.getByRole("link", { name: "Ver Ranking atual" }),
    ).toHaveAttribute("href", "/verified?view=ranking");
  });

  it("keeps experimental results noncompetitive without inventing a ranking reason", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", workflowFetch(experimentalOutcome));
    render(<App />);

    await enterPending(user);
    await user.click(screen.getByRole("button", { name: "Atualizar agora" }));

    expect(
      await screen.findByText("Experimental — não vale para ranking"),
    ).toBeVisible();
    expect(screen.queryByText(/Posição:/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Percentil:/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Top percent:/)).not.toBeInTheDocument();
    expect(
      screen.queryByText(/por quê|motivo|reason/i),
    ).not.toBeInTheDocument();
  });

  it("fails closed when a cross-mode Free result reaches the verified polling route", async () => {
    const user = userEvent.setup();
    const freeResult = {
      state: "valid",
      result: {
        kind: "free-insight",
        attemptId: "free-attempt",
        provenance: {
          kind: "demo",
          fixtureId: "free-well-framed-active-v1",
          providerVersion: "demo-observations-v1",
        },
        approximate: true,
        observations: [
          {
            kind: "athlete-visibility",
            unit: "percent",
            value: 90,
            range: "consistent",
          },
          {
            kind: "ball-visibility",
            unit: "percent",
            value: 90,
            range: "consistent",
          },
          {
            kind: "movement-activity",
            unit: "percent",
            value: 80,
            range: "high",
          },
        ],
        tips: ["Boa cobertura para uma análise aproximada."],
        generatedAt: "2026-08-30T12:02:00.000Z",
      },
    };
    vi.stubGlobal("fetch", workflowFetch(freeResult));
    render(<App />);

    await enterPending(user);
    await user.click(screen.getByRole("button", { name: "Atualizar agora" }));

    expect(
      await screen.findByRole("heading", { name: "Resultado indisponível" }),
    ).toBeVisible();
    expect(
      screen.queryByText(/Boa cobertura para uma análise/),
    ).not.toBeInTheDocument();
  });

  it.each([
    ["pending", { ...pendingOutcome, attemptId: "attempt-other" }],
    [
      "valid",
      {
        ...rankedOutcome,
        result: {
          ...rankedOutcome.result,
          attemptId: "attempt-other",
          rankingSnapshot: {
            ...rankedOutcome.result.rankingSnapshot,
            asOfAttemptId: "attempt-other",
          },
        },
      },
    ],
    [
      "invalid",
      {
        state: "invalid",
        attemptId: "attempt-other",
        mode: "verified",
        code: "tracking_insufficient",
        message: "Não foi possível acompanhar a atividade no vídeo.",
        retryable: true,
      },
    ],
    [
      "failed",
      {
        state: "failed",
        attemptId: "attempt-other",
        mode: "verified",
        code: "analysis_internal_error",
        message: "A análise não pôde ser concluída.",
        retryable: false,
      },
    ],
  ] as const)(
    "fails closed when a mismatched %s outcome arrives for the active attempt",
    async (_state, mismatchedOutcome) => {
      const user = userEvent.setup();
      vi.stubGlobal("fetch", workflowFetch(mismatchedOutcome));
      render(<App />);

      await enterPending(user);
      await user.click(screen.getByRole("button", { name: "Atualizar agora" }));

      expect(
        await screen.findByRole("heading", { name: "Resultado indisponível" }),
      ).toBeVisible();
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Este resultado não está disponível neste fluxo.",
      );
    },
  );

  it("polls only while pending with capped 1, 2, 4, 5 second backoff and stops at terminal", async () => {
    const user = userEvent.setup();
    let resultCalls = 0;
    const fetchSpy = workflowFetch(() => {
      resultCalls += 1;
      return resultCalls < 5 ? pendingOutcome : demoOutcome;
    });
    vi.stubGlobal("fetch", fetchSpy);
    render(<App />);

    await enterPending(user);
    expect(resultCalls).toBe(0);
    vi.useFakeTimers();
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await Promise.resolve();
    });
    expect(resultCalls).toBe(1);
    for (const delay of [1_999, 1, 3_999, 1, 4_999, 1]) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(delay);
      });
    }
    expect(resultCalls).toBe(4);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(screen.getByText("Demo — não vale para ranking")).toBeVisible();
    expect(resultCalls).toBe(5);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(resultCalls).toBe(5);
  });

  it("keeps server ordering and ties while appending the next live leaderboard page", async () => {
    const user = userEvent.setup();
    window.history.replaceState({}, "", "/verified?view=ranking");
    let page = 0;
    const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(input.toString());
      expect(url.pathname).toBe("/v1/leaderboards/wall-pass");
      expect(url.searchParams.get("version")).toBe("1");
      expect(url.searchParams.get("ruleVersion")).toBe("wall-pass-v1-score-1");
      expect(url.searchParams.get("limit")).toBe("20");
      page += 1;
      return response({
        view: "live",
        challengeId: "wall-pass",
        challengeVersion: 1,
        ruleVersion: "wall-pass-v1-score-1",
        calculatedAt: "2026-08-30T12:03:00.000Z",
        cohortSize: 4,
        entries:
          page === 1
            ? [
                {
                  entryId: "rank-1",
                  rank: 1,
                  score: 94,
                  completedAt: "2026-08-30T12:00:00.000Z",
                },
                {
                  entryId: "rank-2",
                  rank: 2,
                  score: 90,
                  completedAt: "2026-08-30T12:01:00.000Z",
                },
              ]
            : [
                {
                  entryId: "rank-3",
                  rank: 2,
                  score: 90,
                  completedAt: "2026-08-30T12:02:00.000Z",
                },
                {
                  entryId: "rank-4",
                  rank: 4,
                  score: 72,
                  completedAt: "2026-08-30T12:03:00.000Z",
                },
              ],
        nextCursor: page === 1 ? "next-page" : null,
      });
    });
    vi.stubGlobal("fetch", fetchSpy);
    render(<App />);

    expect(
      await screen.findByRole("heading", { name: "Ranking atual" }),
    ).toHaveFocus();
    expect(await screen.findByText(/Posição 1 — score 94/)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Carregar mais" }));

    const rows = await screen.findAllByRole("listitem");
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining("Posição 1 — score 94"),
      expect.stringContaining("Posição 2 — score 90"),
      expect.stringContaining("Posição 2 — score 90"),
      expect.stringContaining("Posição 4 — score 72"),
    ]);
    expect(fetchSpy.mock.calls[1]?.[0].toString()).toContain(
      "cursor=next-page",
    );
  });

  it("coalesces leaderboard loads, disables competing controls, and ignores a stale unmounted page", async () => {
    const user = userEvent.setup();
    window.history.replaceState({}, "", "/verified?view=ranking");
    let calls = 0;
    let resolveInitial: ((value: Response) => void) | undefined;
    let resolvePage: ((value: Response) => void) | undefined;
    const ranking = (entries: readonly unknown[], nextCursor: string | null) =>
      response({
        view: "live",
        challengeId: "wall-pass",
        challengeVersion: 1,
        ruleVersion: "wall-pass-v1-score-1",
        calculatedAt: "2026-08-30T12:03:00.000Z",
        cohortSize: entries.length,
        entries,
        nextCursor,
      });
    const firstEntry = {
      entryId: "entry-live-1",
      rank: 1,
      score: 94,
      completedAt: "2026-08-30T12:00:00.000Z",
    };
    const fetchSpy = vi.fn((input: RequestInfo | URL) => {
      const url = new URL(input.toString());
      expect(url.pathname).toBe("/v1/leaderboards/wall-pass");
      calls += 1;
      if (calls === 1)
        return new Promise<Response>((resolve) => {
          resolveInitial = resolve;
        });
      if (calls === 2)
        return new Promise<Response>((resolve) => {
          resolvePage = resolve;
        });
      return Promise.resolve(ranking([], null));
    });
    vi.stubGlobal("fetch", fetchSpy);
    const view = render(<App />);

    expect(
      screen.getByRole("button", { name: "Atualizar ranking" }),
    ).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Atualizar ranking" }));
    expect(calls).toBe(1);
    await act(async () => {
      resolveInitial?.(ranking([firstEntry], "cursor-2"));
      await Promise.resolve();
    });
    expect(
      await screen.findByRole("listitem", { name: /Entrada entry-live-1/ }),
    ).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Carregar mais" }));
    expect(
      screen.getByRole("button", { name: "Carregar mais" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Atualizar ranking" }),
    ).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Atualizar ranking" }));
    expect(calls).toBe(2);
    view.unmount();
    render(<App />);
    await act(async () => {
      resolvePage?.(
        ranking(
          [
            {
              entryId: "stale-page-entry",
              rank: 2,
              score: 90,
              completedAt: "2026-08-30T12:01:00.000Z",
            },
          ],
          null,
        ),
      );
      await Promise.resolve();
    });
    expect(screen.queryByText(/stale-page-entry/)).not.toBeInTheDocument();
  });

  it("announces a safe leaderboard fetch error and recovers with the empty live state", async () => {
    const user = userEvent.setup();
    window.history.replaceState({}, "", "/verified?view=ranking");
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        return calls === 1
          ? response(
              {
                code: "service_not_ready",
                message: "O serviço está temporariamente indisponível.",
                retryable: true,
              },
              503,
            )
          : response({
              view: "live",
              challengeId: "wall-pass",
              challengeVersion: 1,
              ruleVersion: "wall-pass-v1-score-1",
              calculatedAt: "2026-08-30T12:03:00.000Z",
              cohortSize: 0,
              entries: [],
              nextCursor: null,
            });
      }),
    );
    render(<App />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "O serviço está temporariamente indisponível.",
    );
    await user.click(screen.getByRole("button", { name: "Atualizar ranking" }));
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Ainda não há resultados no ranking atual.",
    );
    expect(screen.queryByText(/Error|503/)).not.toBeInTheDocument();
  });

  it("coalesces focus, visibility, and manual refreshes and ignores an aborted stale response", async () => {
    const user = userEvent.setup();
    let resolveResult: ((value: Response) => void) | undefined;
    let resultCalls = 0;
    const fetchSpy = vi.fn((input: RequestInfo | URL) => {
      const pathname = new URL(input.toString()).pathname;
      if (pathname === "/v1/calibration-sessions")
        return Promise.resolve(response(calibration, 201));
      if (pathname === "/v1/calibration-sessions/calibration-w4-1/ready")
        return Promise.resolve(new Response(null, { status: 204 }));
      if (pathname === "/v1/attempts")
        return Promise.resolve(response(createdAttempt, 201));
      if (pathname === "/v1/attempts/attempt-w4-1/media")
        return Promise.resolve(response(acceptedUpload, 202));
      if (pathname === "/v1/attempts/attempt-w4-1/result") {
        resultCalls += 1;
        return new Promise<Response>((resolve) => {
          resolveResult = resolve;
        });
      }
      throw new Error(`Unexpected request: ${pathname}`);
    });
    vi.stubGlobal("fetch", fetchSpy);
    render(<App />);

    await enterPending(user);
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      document.dispatchEvent(new Event("visibilitychange"));
      await Promise.resolve();
    });
    await user.click(screen.getByRole("button", { name: "Atualizar agora" }));
    expect(resultCalls).toBe(1);

    await user.click(
      screen.getByRole("button", { name: "Iniciar outro desafio" }),
    );
    expect(
      screen.getByRole("heading", { name: "Preparação do desafio verificado" }),
    ).toBeVisible();
    await act(async () => {
      resolveResult?.(response(demoOutcome));
      await Promise.resolve();
    });
    expect(
      screen.queryByText("Demo — não vale para ranking"),
    ).not.toBeInTheDocument();
  });

  it("does not let an ignored aborted poll from an old generation block the next attempt", async () => {
    const user = userEvent.setup();
    let cycle = 0;
    let resolveOldPoll: ((value: Response) => void) | undefined;
    const fetchSpy = vi.fn((input: RequestInfo | URL) => {
      const pathname = new URL(input.toString()).pathname;
      if (pathname === "/v1/calibration-sessions") {
        cycle += 1;
        return Promise.resolve(
          response({ ...calibration, id: `calibration-${cycle}` }, 201),
        );
      }
      if (pathname.startsWith("/v1/calibration-sessions/calibration-"))
        return Promise.resolve(new Response(null, { status: 204 }));
      if (pathname === "/v1/attempts") {
        const attemptId = `attempt-${cycle}`;
        return Promise.resolve(
          response(
            {
              ...createdAttempt,
              id: attemptId,
              outcome: { ...createdAttempt.outcome, attemptId },
            },
            201,
          ),
        );
      }
      if (pathname === "/v1/attempts/attempt-1/media")
        return Promise.resolve(
          response(
            {
              ...acceptedUpload,
              attemptId: "attempt-1",
              outcome: { ...acceptedUpload.outcome, attemptId: "attempt-1" },
            },
            202,
          ),
        );
      if (pathname === "/v1/attempts/attempt-2/media")
        return Promise.resolve(
          response(
            {
              ...acceptedUpload,
              attemptId: "attempt-2",
              outcome: { ...acceptedUpload.outcome, attemptId: "attempt-2" },
            },
            202,
          ),
        );
      if (pathname === "/v1/attempts/attempt-1/result")
        return new Promise<Response>((resolve) => {
          resolveOldPoll = resolve;
        });
      if (pathname === "/v1/attempts/attempt-2/result")
        return Promise.resolve(
          response({
            ...demoOutcome,
            result: { ...demoOutcome.result, attemptId: "attempt-2" },
          }),
        );
      throw new Error(`Unexpected request: ${pathname}`);
    });
    vi.stubGlobal("fetch", fetchSpy);
    render(<App />);

    await enterPending(user);
    await user.click(screen.getByRole("button", { name: "Atualizar agora" }));
    await waitFor(() =>
      expect(
        fetchSpy.mock.calls.some(
          ([input]) =>
            new URL(input.toString()).pathname ===
            "/v1/attempts/attempt-1/result",
        ),
      ).toBe(true),
    );
    await user.click(
      screen.getByRole("button", { name: "Iniciar outro desafio" }),
    );
    await completeVerifiedSetup(user);
    await screen.findByRole("heading", { name: "Envie o vídeo verificado" });
    await waitForAttemptReady();
    fireEvent.change(screen.getByTestId("production-video-input"), {
      target: {
        files: [new File(["second"], "second.webm", { type: "video/webm" })],
      },
    });
    await user.click(screen.getByRole("button", { name: "Enviar vídeo" }));
    await screen.findByRole("heading", { name: "Processando tentativa" });
    await user.click(screen.getByRole("button", { name: "Atualizar agora" }));
    expect(
      await screen.findByText("Demo — não vale para ranking"),
    ).toBeVisible();

    await act(async () => {
      resolveOldPoll?.(response({ ...pendingOutcome, attemptId: "attempt-1" }));
      await Promise.resolve();
    });
    expect(screen.getByText("Demo — não vale para ranking")).toBeVisible();
  });

  it.each([
    ["capture_requirements_not_met", "A captura não atende aos requisitos."],
    ["video_not_continuous", "Grave um vídeo contínuo para tentar novamente."],
    [
      "calibration_not_verified",
      "Refaça a calibração antes de tentar novamente.",
    ],
    [
      "tracking_insufficient",
      "Não foi possível acompanhar a atividade no vídeo.",
    ],
  ] as const)(
    "renders the safe invalid outcome for %s and starts a fresh session",
    async (code, message) => {
      const user = userEvent.setup();
      const fetchSpy = workflowFetch({
        state: "invalid",
        attemptId: "attempt-w4-1",
        mode: "verified",
        code,
        message,
        retryable: true,
      });
      vi.stubGlobal("fetch", fetchSpy);
      render(<App />);

      await enterPending(user);
      await user.click(screen.getByRole("button", { name: "Atualizar agora" }));
      expect(
        await screen.findByRole("heading", { name: "Tentativa inválida" }),
      ).toHaveFocus();
      expect(screen.getByRole("alert")).toHaveTextContent(message);
      await user.click(
        screen.getByRole("button", { name: "Tentar novo desafio" }),
      );
      expect(
        screen.getByRole("heading", {
          name: "Preparação do desafio verificado",
        }),
      ).toBeVisible();
      expect(
        fetchSpy.mock.calls.filter(
          ([input]) =>
            new URL(input.toString()).pathname === "/v1/calibration-sessions",
        ),
      ).toHaveLength(1);
    },
  );

  it("creates a new calibration and attempt identity after an invalid-result retry", async () => {
    const user = userEvent.setup();
    let cycle = 0;
    const fetchSpy = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        void init;
        const pathname = new URL(input.toString()).pathname;
        if (pathname === "/v1/calibration-sessions") {
          cycle += 1;
          return response(
            { ...calibration, id: `calibration-w4-${cycle}` },
            201,
          );
        }
        if (pathname.startsWith("/v1/calibration-sessions/calibration-w4-"))
          return new Response(null, { status: 204 });
        if (pathname === "/v1/attempts")
          return response(
            {
              ...createdAttempt,
              id: `attempt-w4-${cycle}`,
              outcome: {
                ...createdAttempt.outcome,
                attemptId: `attempt-w4-${cycle}`,
              },
            },
            201,
          );
        if (pathname === "/v1/attempts/attempt-w4-1/media")
          return response(
            {
              ...acceptedUpload,
              outcome: { ...acceptedUpload.outcome, attemptId: "attempt-w4-1" },
            },
            202,
          );
        if (pathname === "/v1/attempts/attempt-w4-1/result")
          return response({
            state: "invalid",
            attemptId: "attempt-w4-1",
            mode: "verified",
            code: "tracking_insufficient",
            message: "Não foi possível acompanhar a atividade no vídeo.",
            retryable: true,
          });
        throw new Error(`Unexpected request: ${pathname}`);
      },
    );
    vi.stubGlobal("fetch", fetchSpy);
    render(<App />);

    await enterPending(user);
    await user.click(screen.getByRole("button", { name: "Atualizar agora" }));
    await user.click(
      await screen.findByRole("button", { name: "Tentar novo desafio" }),
    );
    await completeVerifiedSetup(user);
    await screen.findByRole("heading", { name: "Envie o vídeo verificado" });
    expect(
      fetchSpy.mock.calls.filter(
        ([input]) =>
          new URL(input.toString()).pathname === "/v1/calibration-sessions",
      ),
    ).toHaveLength(2);
    expect(
      fetchSpy.mock.calls
        .filter(
          ([input]) => new URL(input.toString()).pathname === "/v1/attempts",
        )
        .map(([, init]) => JSON.parse(String(init?.body)).calibrationSessionId),
    ).toEqual(["calibration-w4-1", "calibration-w4-2"]);
  });

  it.each([
    [
      "analysis_temporary_unavailable",
      "A análise está indisponível temporariamente.",
      true,
    ],
    [
      "analysis_configuration_invalid",
      "A análise não está disponível agora.",
      false,
    ],
    ["analysis_internal_error", "A análise não pôde ser concluída.", false],
  ] as const)(
    "renders failure retryability faithfully for %s",
    async (code, message, retryable) => {
      const user = userEvent.setup();
      vi.stubGlobal(
        "fetch",
        workflowFetch({
          state: "failed",
          attemptId: "attempt-w4-1",
          mode: "verified",
          code,
          message,
          retryable,
        }),
      );
      render(<App />);

      await enterPending(user);
      await user.click(screen.getByRole("button", { name: "Atualizar agora" }));
      expect(
        await screen.findByRole("heading", {
          name: "Não foi possível concluir a análise",
        }),
      ).toHaveFocus();
      expect(screen.getByRole("alert")).toHaveTextContent(message);
      expect(
        screen.queryByRole("button", { name: "Tentar novo desafio" }),
      ).toBe(
        retryable
          ? screen.getByRole("button", { name: "Tentar novo desafio" })
          : null,
      );
      expect(
        screen.getByRole("link", { name: "Voltar para Início" }),
      ).toHaveAttribute("href", "/");
    },
  );

  it("keeps the same attempt and selected media available after a safe upload-route error", async () => {
    const user = userEvent.setup();
    let uploadCalls = 0;
    const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
      const pathname = new URL(input.toString()).pathname;
      if (pathname === "/v1/calibration-sessions")
        return response(calibration, 201);
      if (pathname === "/v1/calibration-sessions/calibration-w4-1/ready")
        return new Response(null, { status: 204 });
      if (pathname === "/v1/attempts") return response(createdAttempt, 201);
      if (pathname === "/v1/attempts/attempt-w4-1/media") {
        uploadCalls += 1;
        return uploadCalls === 1
          ? response(
              {
                code: "media_empty",
                message: "O arquivo de vídeo está vazio.",
                retryable: false,
              },
              422,
            )
          : response(acceptedUpload, 202);
      }
      throw new Error(`Unexpected request: ${pathname}`);
    });
    vi.stubGlobal("fetch", fetchSpy);
    render(<App />);

    await enterPending(user).catch(() => undefined);
    // The first upload intentionally remains in capture after its safe route error.
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "O arquivo de vídeo está vazio.",
    );
    expect(screen.getByText("wall-pass.webm")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Enviar vídeo" }));
    expect(
      await screen.findByRole("heading", { name: "Processando tentativa" }),
    ).toBeVisible();
    expect(uploadCalls).toBe(2);
    expect(
      fetchSpy.mock.calls.filter(
        ([input]) => new URL(input.toString()).pathname === "/v1/attempts",
      ),
    ).toHaveLength(1);
    expect(
      fetchSpy.mock.calls.map(([input]) => new URL(input.toString()).pathname),
    ).not.toContain("/v1/attempts/attempt-w4-1");
  });

  it("announces indeterminate production upload progress and clears selected media immediately after a parsed 202", async () => {
    const user = userEvent.setup();
    let resolveUpload: ((value: Response) => void) | undefined;
    const fetchSpy = vi.fn((input: RequestInfo | URL) => {
      const pathname = new URL(input.toString()).pathname;
      if (pathname === "/v1/calibration-sessions")
        return Promise.resolve(response(calibration, 201));
      if (pathname === "/v1/calibration-sessions/calibration-w4-1/ready")
        return Promise.resolve(new Response(null, { status: 204 }));
      if (pathname === "/v1/attempts")
        return Promise.resolve(response(createdAttempt, 201));
      if (pathname === "/v1/attempts/attempt-w4-1/media")
        return new Promise<Response>((resolve) => {
          resolveUpload = resolve;
        });
      throw new Error(`Unexpected request: ${pathname}`);
    });
    vi.stubGlobal("fetch", fetchSpy);
    render(<App />);

    await user.click(
      screen.getByRole("button", { name: "Desafio verificado" }),
    );
    await completeVerifiedSetup(user);
    await screen.findByRole("heading", { name: "Envie o vídeo verificado" });
    await waitForAttemptReady();
    fireEvent.change(screen.getByTestId("production-video-input"), {
      target: {
        files: [new File(["video"], "accepted.webm", { type: "video/webm" })],
      },
    });
    await user.click(screen.getByRole("button", { name: "Enviar vídeo" }));
    expect(
      screen.getByRole("progressbar", { name: "Envio do vídeo verificado" }),
    ).toBeVisible();

    await act(async () => {
      resolveUpload?.(response(acceptedUpload, 202));
      await Promise.resolve();
    });
    expect(
      await screen.findByRole("heading", { name: "Processando tentativa" }),
    ).toBeVisible();
    expect(screen.queryByText("accepted.webm")).not.toBeInTheDocument();
  });

  it("rejects the shared accepted-upload fixture when it does not belong to the verified attempt", async () => {
    const user = userEvent.setup();
    const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
      const pathname = new URL(input.toString()).pathname;
      if (pathname === "/v1/calibration-sessions")
        return response(calibration, 201);
      if (pathname === "/v1/calibration-sessions/calibration-w4-1/ready")
        return new Response(null, { status: 204 });
      if (pathname === "/v1/attempts") return response(createdAttempt, 201);
      if (pathname === "/v1/attempts/attempt-w4-1/media")
        return response(
          {
            ...acceptedUpload,
            attemptId: "attempt-upload-1",
            mode: "free",
            outcome: {
              ...acceptedUpload.outcome,
              attemptId: "attempt-upload-1",
              mode: "free",
            },
          },
          202,
        );
      throw new Error(`Unexpected request: ${pathname}`);
    });
    vi.stubGlobal("fetch", fetchSpy);
    render(<App />);

    await enterPending(user).catch(() => undefined);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Este envio não pertence a esta tentativa verificada.",
    );
    expect(
      screen.getByRole("heading", { name: "Envie o vídeo verificado" }),
    ).toBeVisible();
    expect(
      fetchSpy.mock.calls.map(([input]) => new URL(input.toString()).pathname),
    ).not.toContain("/v1/attempts/attempt-w4-1/result");
  });

  it("cancels an upload with an abort-without-response while retaining its media and attempt", async () => {
    const user = userEvent.setup();
    let createCalls = 0;
    const fetchSpy = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const pathname = new URL(input.toString()).pathname;
      if (pathname === "/v1/calibration-sessions")
        return Promise.resolve(response(calibration, 201));
      if (pathname === "/v1/calibration-sessions/calibration-w4-1/ready")
        return Promise.resolve(new Response(null, { status: 204 }));
      if (pathname === "/v1/attempts") {
        createCalls += 1;
        return Promise.resolve(response(createdAttempt, 201));
      }
      if (pathname === "/v1/attempts/attempt-w4-1/media") {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        });
      }
      throw new Error(`Unexpected request: ${pathname}`);
    });
    vi.stubGlobal("fetch", fetchSpy);
    render(<App />);

    await user.click(
      screen.getByRole("button", { name: "Desafio verificado" }),
    );
    await completeVerifiedSetup(user);
    await screen.findByRole("heading", { name: "Envie o vídeo verificado" });
    await waitForAttemptReady();
    fireEvent.change(screen.getByTestId("production-video-input"), {
      target: {
        files: [new File(["video"], "retained.webm", { type: "video/webm" })],
      },
    });
    await user.click(screen.getByRole("button", { name: "Enviar vídeo" }));
    await user.click(
      await screen.findByRole("button", { name: "Cancelar envio" }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Envio cancelado. O vídeo continua pronto para tentar novamente.",
    );
    expect(screen.getByText("retained.webm")).toBeVisible();
    expect(createCalls).toBe(1);
    expect(screen.queryByText(/AbortError|Aborted/)).not.toBeInTheDocument();
  });

  it("returns an authoritative awaiting-upload cancellation to capture with its same file and attempt", async () => {
    const user = userEvent.setup();
    let createCalls = 0;
    let uploadCalls = 0;
    const fetchSpy = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const pathname = new URL(input.toString()).pathname;
      if (pathname === "/v1/calibration-sessions")
        return Promise.resolve(response(calibration, 201));
      if (pathname === "/v1/calibration-sessions/calibration-w4-1/ready")
        return Promise.resolve(new Response(null, { status: 204 }));
      if (pathname === "/v1/attempts") {
        createCalls += 1;
        return Promise.resolve(response(createdAttempt, 201));
      }
      if (pathname === "/v1/attempts/attempt-w4-1/media") {
        uploadCalls += 1;
        if (uploadCalls === 1)
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(new DOMException("Aborted", "AbortError")),
            );
          });
        return Promise.resolve(response(acceptedUpload, 202));
      }
      if (pathname === "/v1/attempts/attempt-w4-1")
        return Promise.resolve(response(createdAttempt));
      throw new Error(`Unexpected request: ${pathname}`);
    });
    vi.stubGlobal("fetch", fetchSpy);
    render(<App />);

    await user.click(
      screen.getByRole("button", { name: "Desafio verificado" }),
    );
    await completeVerifiedSetup(user);
    await screen.findByRole("heading", { name: "Envie o vídeo verificado" });
    await waitForAttemptReady();
    fireEvent.change(screen.getByTestId("production-video-input"), {
      target: {
        files: [
          new File(["video"], "before-commit.webm", { type: "video/webm" }),
        ],
      },
    });
    await user.click(screen.getByRole("button", { name: "Enviar vídeo" }));
    await user.click(
      await screen.findByRole("button", { name: "Cancelar envio" }),
    );

    expect(
      await screen.findByRole("heading", { name: "Envie o vídeo verificado" }),
    ).toBeVisible();
    expect(screen.getByText("before-commit.webm")).toBeVisible();
    expect(screen.getByRole("button", { name: "Enviar vídeo" })).toBeEnabled();
    expect(createCalls).toBe(1);

    await user.click(screen.getByRole("button", { name: "Enviar vídeo" }));
    expect(
      await screen.findByRole("heading", { name: "Processando tentativa" }),
    ).toBeVisible();
    expect(uploadCalls).toBe(2);
    expect(createCalls).toBe(1);
  });

  it("ignores a stale first upload failure after a cancelled retry is accepted", async () => {
    const user = userEvent.setup();
    let rejectFirst: ((reason: unknown) => void) | undefined;
    let uploadCalls = 0;
    const fetchSpy = vi.fn((input: RequestInfo | URL) => {
      const pathname = new URL(input.toString()).pathname;
      if (pathname === "/v1/calibration-sessions")
        return Promise.resolve(response(calibration, 201));
      if (pathname === "/v1/calibration-sessions/calibration-w4-1/ready")
        return Promise.resolve(new Response(null, { status: 204 }));
      if (pathname === "/v1/attempts")
        return Promise.resolve(response(createdAttempt, 201));
      if (pathname === "/v1/attempts/attempt-w4-1/media") {
        uploadCalls += 1;
        if (uploadCalls === 1)
          return new Promise<Response>((_resolve, reject) => {
            rejectFirst = reject;
          });
        return Promise.resolve(response(acceptedUpload, 202));
      }
      throw new Error(`Unexpected request: ${pathname}`);
    });
    vi.stubGlobal("fetch", fetchSpy);
    render(<App />);

    await user.click(
      screen.getByRole("button", { name: "Desafio verificado" }),
    );
    await completeVerifiedSetup(user);
    await screen.findByRole("heading", { name: "Envie o vídeo verificado" });
    await waitForAttemptReady();
    fireEvent.change(screen.getByTestId("production-video-input"), {
      target: {
        files: [new File(["video"], "race.webm", { type: "video/webm" })],
      },
    });
    await user.click(screen.getByRole("button", { name: "Enviar vídeo" }));
    await user.click(
      await screen.findByRole("button", { name: "Cancelar envio" }),
    );
    await user.click(screen.getByRole("button", { name: "Enviar vídeo" }));
    expect(
      await screen.findByRole("heading", { name: "Processando tentativa" }),
    ).toBeVisible();
    await act(async () => {
      rejectFirst?.({
        code: "service_not_ready",
        message: "O serviço está temporariamente indisponível.",
        retryable: true,
        status: 503,
      });
      await Promise.resolve();
    });
    expect(
      screen.getByRole("heading", { name: "Processando tentativa" }),
    ).toBeVisible();
    expect(
      screen.queryByText("O serviço está temporariamente indisponível."),
    ).not.toBeInTheDocument();
  });

  it("does not let a stale cancellation reconciliation replace a newer accepted upload", async () => {
    const user = userEvent.setup();
    let uploadCalls = 0;
    let resolveOldAttempt: ((value: Response) => void) | undefined;
    const fetchSpy = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const pathname = new URL(input.toString()).pathname;
      if (pathname === "/v1/calibration-sessions")
        return Promise.resolve(response(calibration, 201));
      if (pathname === "/v1/calibration-sessions/calibration-w4-1/ready")
        return Promise.resolve(new Response(null, { status: 204 }));
      if (pathname === "/v1/attempts")
        return Promise.resolve(response(createdAttempt, 201));
      if (pathname === "/v1/attempts/attempt-w4-1/media") {
        uploadCalls += 1;
        if (uploadCalls === 1)
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(new DOMException("Aborted", "AbortError")),
            );
          });
        return Promise.resolve(response(acceptedUpload, 202));
      }
      if (pathname === "/v1/attempts/attempt-w4-1")
        return new Promise<Response>((resolve) => {
          resolveOldAttempt = resolve;
        });
      throw new Error(`Unexpected request: ${pathname}`);
    });
    vi.stubGlobal("fetch", fetchSpy);
    render(<App />);

    await user.click(
      screen.getByRole("button", { name: "Desafio verificado" }),
    );
    await completeVerifiedSetup(user);
    await screen.findByRole("heading", { name: "Envie o vídeo verificado" });
    await waitForAttemptReady();
    fireEvent.change(screen.getByTestId("production-video-input"), {
      target: {
        files: [new File(["video"], "stale-get.webm", { type: "video/webm" })],
      },
    });
    await user.click(screen.getByRole("button", { name: "Enviar vídeo" }));
    await user.click(
      await screen.findByRole("button", { name: "Cancelar envio" }),
    );
    await user.click(screen.getByRole("button", { name: "Enviar vídeo" }));
    expect(
      await screen.findByRole("heading", { name: "Processando tentativa" }),
    ).toBeVisible();

    await act(async () => {
      resolveOldAttempt?.(response(createdAttempt));
      await Promise.resolve();
    });

    expect(
      screen.getByRole("heading", { name: "Processando tentativa" }),
    ).toBeVisible();
    expect(screen.queryByText("stale-get.webm")).not.toBeInTheDocument();
  });

  it("reconciles an abort-after-commit from the authoritative accepted attempt", async () => {
    const user = userEvent.setup();
    const fetchSpy = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const pathname = new URL(input.toString()).pathname;
      if (pathname === "/v1/calibration-sessions")
        return Promise.resolve(response(calibration, 201));
      if (pathname === "/v1/calibration-sessions/calibration-w4-1/ready")
        return Promise.resolve(new Response(null, { status: 204 }));
      if (pathname === "/v1/attempts")
        return Promise.resolve(response(createdAttempt, 201));
      if (pathname === "/v1/attempts/attempt-w4-1/media") {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        });
      }
      if (pathname === "/v1/attempts/attempt-w4-1")
        return Promise.resolve(
          response({
            ...createdAttempt,
            status: "uploaded",
            outcome: acceptedUpload.outcome,
          }),
        );
      throw new Error(`Unexpected request: ${pathname}`);
    });
    vi.stubGlobal("fetch", fetchSpy);
    render(<App />);

    await user.click(
      screen.getByRole("button", { name: "Desafio verificado" }),
    );
    await completeVerifiedSetup(user);
    await screen.findByRole("heading", { name: "Envie o vídeo verificado" });
    await waitForAttemptReady();
    fireEvent.change(screen.getByTestId("production-video-input"), {
      target: {
        files: [new File(["video"], "committed.webm", { type: "video/webm" })],
      },
    });
    await user.click(screen.getByRole("button", { name: "Enviar vídeo" }));
    await user.click(
      await screen.findByRole("button", { name: "Cancelar envio" }),
    );

    expect(
      await screen.findByRole("heading", { name: "Processando tentativa" }),
    ).toBeVisible();
    expect(
      fetchSpy.mock.calls.map(([input]) => new URL(input.toString()).pathname),
    ).toContain("/v1/attempts/attempt-w4-1");
  });

  it("reconciles a duplicate upload against the authoritative attempt instead of stranding its media", async () => {
    const user = userEvent.setup();
    const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
      const pathname = new URL(input.toString()).pathname;
      if (pathname === "/v1/calibration-sessions")
        return response(calibration, 201);
      if (pathname === "/v1/calibration-sessions/calibration-w4-1/ready")
        return new Response(null, { status: 204 });
      if (pathname === "/v1/attempts") return response(createdAttempt, 201);
      if (pathname === "/v1/attempts/attempt-w4-1/media")
        return response(
          {
            code: "duplicate_media_upload",
            message: "Esta tentativa já possui um vídeo.",
            retryable: false,
          },
          409,
        );
      if (pathname === "/v1/attempts/attempt-w4-1")
        return response({
          ...createdAttempt,
          status: "processing",
          outcome: pendingOutcome,
        });
      throw new Error(`Unexpected request: ${pathname}`);
    });
    vi.stubGlobal("fetch", fetchSpy);
    render(<App />);

    await enterPending(user);

    expect(
      await screen.findByRole("heading", { name: "Processando tentativa" }),
    ).toBeVisible();
    expect(
      fetchSpy.mock.calls.some(
        ([input]) =>
          new URL(input.toString()).pathname === "/v1/attempts/attempt-w4-1",
      ),
    ).toBe(true);
    expect(screen.queryByText("wall-pass.webm")).not.toBeInTheDocument();
  });

  it("reconciles a lost upload response from the authoritative post-commit attempt", async () => {
    const user = userEvent.setup();
    let attemptReads = 0;
    const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
      const pathname = new URL(input.toString()).pathname;
      if (pathname === "/v1/calibration-sessions")
        return response(calibration, 201);
      if (pathname === "/v1/calibration-sessions/calibration-w4-1/ready")
        return new Response(null, { status: 204 });
      if (pathname === "/v1/attempts") return response(createdAttempt, 201);
      if (pathname === "/v1/attempts/attempt-w4-1/media")
        throw new TypeError("The upload connection closed without a response.");
      if (pathname === "/v1/attempts/attempt-w4-1") {
        attemptReads += 1;
        return response({
          ...createdAttempt,
          status: "processing",
          outcome: pendingOutcome,
        });
      }
      throw new Error(`Unexpected request: ${pathname}`);
    });
    vi.stubGlobal("fetch", fetchSpy);
    render(<App />);

    await enterPending(user);

    expect(attemptReads).toBe(1);
    expect(screen.queryByText("wall-pass.webm")).not.toBeInTheDocument();
  });

  it("keeps media and the same attempt retryable when a lost upload response cannot be reconciled", async () => {
    const user = userEvent.setup();
    let creates = 0;
    let uploads = 0;
    let attemptReads = 0;
    const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
      const pathname = new URL(input.toString()).pathname;
      if (pathname === "/v1/calibration-sessions")
        return response(calibration, 201);
      if (pathname === "/v1/calibration-sessions/calibration-w4-1/ready")
        return new Response(null, { status: 204 });
      if (pathname === "/v1/attempts") {
        creates += 1;
        return response(createdAttempt, 201);
      }
      if (pathname === "/v1/attempts/attempt-w4-1/media") {
        uploads += 1;
        if (uploads === 1)
          throw new TypeError(
            "The upload connection closed without a response.",
          );
        return response(acceptedUpload, 202);
      }
      if (pathname === "/v1/attempts/attempt-w4-1") {
        attemptReads += 1;
        throw new TypeError(
          "The attempt read connection closed without a response.",
        );
      }
      throw new Error(`Unexpected request: ${pathname}`);
    });
    vi.stubGlobal("fetch", fetchSpy);
    render(<App />);

    await enterPending(user).catch(() => undefined);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Não foi possível continuar agora. Tente novamente.",
    );
    expect(screen.getByText("wall-pass.webm")).toBeVisible();
    expect(attemptReads).toBe(1);
    expect(creates).toBe(1);
    await user.click(screen.getByRole("button", { name: "Enviar vídeo" }));
    expect(
      await screen.findByRole("heading", { name: "Processando tentativa" }),
    ).toBeVisible();
    expect(uploads).toBe(2);
    expect(creates).toBe(1);
  });

  it("keeps media and the same attempt retryable when reconciliation reports awaiting-upload", async () => {
    const user = userEvent.setup();
    let creates = 0;
    let uploads = 0;
    let attemptReads = 0;
    const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
      const pathname = new URL(input.toString()).pathname;
      if (pathname === "/v1/calibration-sessions")
        return response(calibration, 201);
      if (pathname === "/v1/calibration-sessions/calibration-w4-1/ready")
        return new Response(null, { status: 204 });
      if (pathname === "/v1/attempts") {
        creates += 1;
        return response(createdAttempt, 201);
      }
      if (pathname === "/v1/attempts/attempt-w4-1/media") {
        uploads += 1;
        if (uploads === 1)
          throw new TypeError(
            "The upload connection closed without a response.",
          );
        return response(acceptedUpload, 202);
      }
      if (pathname === "/v1/attempts/attempt-w4-1") {
        attemptReads += 1;
        return response(createdAttempt);
      }
      throw new Error(`Unexpected request: ${pathname}`);
    });
    vi.stubGlobal("fetch", fetchSpy);
    render(<App />);

    await enterPending(user).catch(() => undefined);

    expect(screen.getByText("wall-pass.webm")).toBeVisible();
    expect(attemptReads).toBe(1);
    await user.click(screen.getByRole("button", { name: "Enviar vídeo" }));
    expect(
      await screen.findByRole("heading", { name: "Processando tentativa" }),
    ).toBeVisible();
    expect(uploads).toBe(2);
    expect(creates).toBe(1);
  });

  it("ignores a stale lost-response reconciliation after a newer upload is accepted", async () => {
    const user = userEvent.setup();
    let uploads = 0;
    const resolveAttemptReads: Array<(value: Response) => void> = [];
    const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
      const pathname = new URL(input.toString()).pathname;
      if (pathname === "/v1/calibration-sessions")
        return response(calibration, 201);
      if (pathname === "/v1/calibration-sessions/calibration-w4-1/ready")
        return new Response(null, { status: 204 });
      if (pathname === "/v1/attempts") return response(createdAttempt, 201);
      if (pathname === "/v1/attempts/attempt-w4-1/media") {
        uploads += 1;
        if (uploads === 1)
          throw new TypeError(
            "The upload connection closed without a response.",
          );
        return response(acceptedUpload, 202);
      }
      if (pathname === "/v1/attempts/attempt-w4-1")
        return new Promise<Response>((resolve) => {
          resolveAttemptReads.push(resolve);
        });
      throw new Error(`Unexpected request: ${pathname}`);
    });
    vi.stubGlobal("fetch", fetchSpy);
    render(<App />);

    await user.click(
      screen.getByRole("button", { name: "Desafio verificado" }),
    );
    await completeVerifiedSetup(user);
    await screen.findByRole("heading", { name: "Envie o vídeo verificado" });
    await waitForAttemptReady();
    fireEvent.change(screen.getByTestId("production-video-input"), {
      target: {
        files: [
          new File(["video"], "lost-response.webm", { type: "video/webm" }),
        ],
      },
    });
    await user.click(screen.getByRole("button", { name: "Enviar vídeo" }));
    await waitFor(() => expect(resolveAttemptReads).toHaveLength(1));
    await user.click(
      await screen.findByRole("button", { name: "Cancelar envio" }),
    );
    await waitFor(() => expect(resolveAttemptReads).toHaveLength(2));
    await user.click(screen.getByRole("button", { name: "Enviar vídeo" }));
    expect(
      await screen.findByRole("heading", { name: "Processando tentativa" }),
    ).toBeVisible();

    await act(async () => {
      resolveAttemptReads[0]?.(response(createdAttempt));
      resolveAttemptReads[1]?.(response(createdAttempt));
      await Promise.resolve();
    });

    expect(
      screen.getByRole("heading", { name: "Processando tentativa" }),
    ).toBeVisible();
    expect(screen.queryByText("lost-response.webm")).not.toBeInTheDocument();
  });
});
