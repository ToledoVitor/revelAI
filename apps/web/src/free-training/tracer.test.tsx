import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AttemptOutcome } from "@revelai/contracts";
import { App } from "../app";
import { createRevelApiClient } from "../lib/api/client";
import { resolveUploadReconciliation } from "../lib/attempt-flow/upload-reconciliation";

const createdFreeAttempt = {
  id: "attempt-free-w5-1",
  mode: "free",
  status: "awaiting-upload",
  createdAt: "2026-08-30T12:01:00.000Z",
  outcome: {
    state: "pending",
    attemptId: "attempt-free-w5-1",
    mode: "free",
    status: "awaiting-upload",
  },
} as const;

const acceptedFreeUpload = {
  kind: "media-upload-accepted",
  attemptId: "attempt-free-w5-1",
  mode: "free",
  acceptedStatus: "uploaded",
  outcome: {
    state: "pending",
    attemptId: "attempt-free-w5-1",
    mode: "free",
    status: "uploaded",
  },
} as const;

const freeInsight: AttemptOutcome = {
  state: "valid",
  result: {
    kind: "free-insight",
    attemptId: "attempt-free-w5-1",
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
};

const roboflowFreeInsight: AttemptOutcome = {
  state: "valid",
  result: {
    kind: "free-insight",
    attemptId: "attempt-free-w5-1",
    provenance: {
      kind: "roboflow",
      workspaceId: "workspace-free-w5",
      workflowId: "revelai-free-training-v1",
      workflowVersion: "1.0.0",
      modelBundleId: "free-bundle-w5",
      providerVersion: "roboflow-free-w5",
    },
    approximate: true,
    observations: [
      {
        kind: "athlete-visibility",
        unit: "percent",
        value: 42,
        range: "limited",
      },
      {
        kind: "ball-visibility",
        unit: "percent",
        value: 30,
        range: "limited",
      },
      {
        kind: "movement-activity",
        unit: "percent",
        value: 80,
        range: "high",
      },
    ],
    tips: [
      "Mantenha o corpo inteiro visível.",
      "Mantenha a bola visível durante a sequência.",
    ],
    generatedAt: "2026-08-30T12:03:00.000Z",
  },
};

const freeFailure: AttemptOutcome = {
  state: "failed",
  attemptId: "attempt-free-w5-1",
  mode: "free",
  code: "analysis_temporary_unavailable",
  message: "A análise está indisponível temporariamente.",
  retryable: true,
};

const verifiedOutcome: AttemptOutcome = {
  state: "valid",
  result: {
    kind: "verified-result",
    attemptId: "attempt-free-w5-1",
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
};

function response(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function enterFreePending(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Treino livre" }));
  fireEvent.change(await screen.findByTestId("free-training-video-input"), {
    target: {
      files: [new File(["video"], "free.webm", { type: "video/webm" })],
    },
  });
  await user.click(screen.getByRole("button", { name: "Enviar vídeo" }));
  await screen.findByRole("button", { name: "Atualizar agora" });
}

function freeWorkflowFetch(outcome: AttemptOutcome) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const pathname = new URL(input.toString()).pathname;
    if (pathname === "/v1/attempts") return response(createdFreeAttempt, 201);
    if (pathname === "/v1/attempts/attempt-free-w5-1/media")
      return response(acceptedFreeUpload, 202);
    if (pathname === "/v1/attempts/attempt-free-w5-1/result")
      return response(outcome, outcome.state === "pending" ? 202 : 200);
    throw new Error(`Unexpected request: ${pathname}`);
  });
}

describe("production Free Training tracer", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/");
    window.sessionStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    window.sessionStorage.clear();
    Reflect.deleteProperty(URL, "createObjectURL");
    Reflect.deleteProperty(URL, "revokeObjectURL");
  });

  it("mounts the sole Free owner before creating one exact free Attempt", async () => {
    const user = userEvent.setup();
    const fetchSpy = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        void init;
        const pathname = new URL(input.toString()).pathname;
        if (pathname === "/v1/attempts")
          return response(createdFreeAttempt, 201);
        throw new Error(`Unexpected request: ${pathname}`);
      },
    );
    vi.stubGlobal("fetch", fetchSpy);

    render(<App />);
    await user.click(screen.getByRole("button", { name: "Treino livre" }));

    expect(
      await screen.findByRole("heading", {
        name: "Treino livre — análise aproximada",
        level: 1,
      }),
    ).toHaveFocus();
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledOnce());
    expect(new URL(fetchSpy.mock.calls[0]?.[0].toString()).pathname).toBe(
      "/v1/attempts",
    );
    expect(JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body))).toEqual({
      mode: "free",
    });
  });

  it("creates exactly once for a direct Free route under StrictMode", async () => {
    window.history.replaceState({}, "", "/free-training");
    const fetchSpy = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) => {
        void _input;
        void _init;
        return response(createdFreeAttempt, 201);
      },
    );
    vi.stubGlobal("fetch", fetchSpy);

    render(
      <StrictMode>
        <App />
      </StrictMode>,
    );

    expect(
      await screen.findByRole("button", { name: "Selecionar vídeo" }),
    ).toBeEnabled();
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("aborts a late direct-route Free creation on unmount without leaving an owner behind", async () => {
    window.history.replaceState({}, "", "/free-training");
    const creation = deferred<Response>();
    let createSignal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
        createSignal = init?.signal ?? undefined;
        return creation.promise;
      }),
    );

    const view = render(<App />);
    await waitFor(() => expect(createSignal).toBeDefined());
    view.unmount();
    await act(async () => {
      await Promise.resolve();
    });
    expect(createSignal).toBeDefined();
    expect(createSignal?.aborted).toBe(true);

    await act(async () => {
      creation.resolve(response(createdFreeAttempt, 201));
      await Promise.resolve();
    });
    expect(screen.queryByRole("main")).not.toBeInTheDocument();
  });

  it("replays one causal Free create after an unmount loses its committed response", async () => {
    window.history.replaceState({}, "", "/free-training");
    const serverCommittedCreate = deferred<Response>();
    const createHeaders: string[] = [];
    let creates = 0;
    const fetchSpy = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input.toString());
      if (url.pathname !== "/v1/attempts")
        throw new Error(`Unexpected request: ${url.pathname}`);
      creates += 1;
      createHeaders.push(
        new Headers(init?.headers).get("idempotency-key") ?? "",
      );
      return creates === 1
        ? serverCommittedCreate.promise
        : Promise.resolve(response(createdFreeAttempt, 201));
    });
    vi.stubGlobal("fetch", fetchSpy);

    const first = render(<App />);
    await waitFor(() => expect(creates).toBe(1));
    first.unmount();

    render(<App />);

    expect(
      await screen.findByRole("button", { name: "Selecionar vídeo" }),
    ).toBeEnabled();
    expect(creates).toBe(2);
    expect(createHeaders[0]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(createHeaders[1]).toBe(createHeaders[0]);

    await act(async () => {
      serverCommittedCreate.resolve(response(createdFreeAttempt, 201));
      await Promise.resolve();
    });
  });

  it.each([
    ["awaiting upload", createdFreeAttempt, "Selecionar vídeo", undefined],
    [
      "processing",
      {
        ...createdFreeAttempt,
        status: "processing",
        outcome: {
          state: "pending",
          attemptId: "attempt-free-w5-1",
          mode: "free",
          status: "processing",
        },
      },
      "Atualizar agora",
      undefined,
    ],
    [
      "valid terminal",
      { ...createdFreeAttempt, status: "valid", outcome: freeInsight },
      "Excluir treino",
      "Mantenha a bola visível durante a sequência.",
    ],
    [
      "failed terminal",
      { ...createdFreeAttempt, status: "failed", outcome: freeFailure },
      "Excluir treino",
      "A análise está indisponível temporariamente.",
    ],
  ] as const)(
    "resumes a persisted Free owner at %s without another create",
    async (_name, restoredAttempt, expectedControl, expectedText) => {
      window.history.replaceState({}, "", "/free-training");
      window.sessionStorage.setItem(
        "revelai.free-training.owner.v1",
        JSON.stringify({ attemptId: "attempt-free-w5-1" }),
      );
      const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
        const pathname = new URL(input.toString()).pathname;
        if (pathname === "/v1/attempts/attempt-free-w5-1")
          return response(restoredAttempt);
        throw new Error(`Unexpected request: ${pathname}`);
      });
      vi.stubGlobal("fetch", fetchSpy);

      render(<App />);

      expect(
        await screen.findByRole("button", { name: expectedControl }),
      ).toBeEnabled();
      if (expectedText) expect(screen.getByText(expectedText)).toBeVisible();
      expect(fetchSpy).toHaveBeenCalledOnce();
    },
  );

  it("recovers a persisted owner that the server no longer has by clearing it before one fresh create", async () => {
    window.history.replaceState({}, "", "/free-training");
    window.sessionStorage.setItem(
      "revelai.free-training.owner.v1",
      JSON.stringify({ attemptId: "attempt-deleted-remotely" }),
    );
    window.sessionStorage.setItem(
      "revelai.free-training.create-intent.v1",
      JSON.stringify({
        idempotencyKey: "e1111111-1111-4111-8111-111111111111",
      }),
    );
    const paths: string[] = [];
    const keys: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const pathname = new URL(input.toString()).pathname;
        paths.push(pathname);
        if (pathname === "/v1/attempts/attempt-deleted-remotely")
          return response(
            {
              code: "attempt_not_found",
              message: "Esta tentativa não está disponível.",
              retryable: false,
            },
            404,
          );
        if (pathname === "/v1/attempts") {
          keys.push(new Headers(init?.headers).get("idempotency-key") ?? "");
          return response(createdFreeAttempt, 201);
        }
        throw new Error(`Unexpected request: ${pathname}`);
      }),
    );

    render(<App />);

    expect(
      await screen.findByRole("button", { name: "Selecionar vídeo" }),
    ).toBeEnabled();
    expect(paths).toEqual([
      "/v1/attempts/attempt-deleted-remotely",
      "/v1/attempts",
    ]);
    expect(keys[0]).not.toBe("e1111111-1111-4111-8111-111111111111");
    expect(
      window.sessionStorage.getItem("revelai.free-training.owner.v1"),
    ).toBe(JSON.stringify({ attemptId: "attempt-free-w5-1" }));
  });

  it("fails closed instead of adopting a different Free record for a persisted owner", async () => {
    window.history.replaceState({}, "", "/free-training");
    window.sessionStorage.setItem(
      "revelai.free-training.owner.v1",
      JSON.stringify({ attemptId: "attempt-owned" }),
    );
    const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
      const pathname = new URL(input.toString()).pathname;
      if (pathname === "/v1/attempts/attempt-owned")
        return response({
          ...createdFreeAttempt,
          id: "attempt-unrelated",
          outcome: {
            ...createdFreeAttempt.outcome,
            attemptId: "attempt-unrelated",
          },
        });
      throw new Error(`Unexpected request: ${pathname}`);
    });
    vi.stubGlobal("fetch", fetchSpy);

    render(<App />);

    expect(await screen.findByText("Resultado indisponível")).toBeVisible();
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("shows only the Free video requirements before opening its picker", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response(createdFreeAttempt, 201)),
    );

    render(<App />);
    await user.click(screen.getByRole("button", { name: "Treino livre" }));

    await screen.findByRole("button", { name: "Selecionar vídeo" });
    expect(screen.getByText("MP4, MOV ou WebM.")).toBeVisible();
    expect(screen.getByText("Duração: 3–180 segundos.")).toBeVisible();
    expect(screen.getByText("Menor lado: mínimo 480 px.")).toBeVisible();
    expect(screen.getByText("Vídeo em retrato ou paisagem.")).toBeVisible();
    expect(
      screen.getByText(
        "Não exigimos fiducial, pré-rolagem, calibração, duração exata, continuidade, câmera traseira, parede, atleta visível nem bola visível.",
      ),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Selecionar vídeo" }),
    ).toBeEnabled();
    expect(
      screen.queryByRole("button", { name: /gravação|câmera/i }),
    ).not.toBeInTheDocument();
  });

  it("keeps capture unavailable after Free creation fails, then retries the same mounted owner", async () => {
    const user = userEvent.setup();
    let creates = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const pathname = new URL(input.toString()).pathname;
        if (pathname !== "/v1/attempts")
          throw new Error(`Unexpected request: ${pathname}`);
        creates += 1;
        return creates === 1
          ? response(
              {
                code: "service_not_ready",
                message: "O serviço está temporariamente indisponível.",
                retryable: true,
              },
              503,
            )
          : response(createdFreeAttempt, 201);
      }),
    );

    render(<App />);
    await user.click(screen.getByRole("button", { name: "Treino livre" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "O serviço está temporariamente indisponível.",
    );
    expect(
      screen.queryByRole("button", { name: "Selecionar vídeo" }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Tentar novamente" }));

    expect(
      await screen.findByRole("button", { name: "Selecionar vídeo" }),
    ).toBeEnabled();
    expect(creates).toBe(2);
  });

  it("does not POST until session storage confirms the causal key, then retries once storage recovers", async () => {
    window.history.replaceState({}, "", "/free-training");
    const user = userEvent.setup();
    const storage = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new DOMException("full", "QuotaExceededError");
      });
    const fetchSpy = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) => {
        void _input;
        void _init;
        return response(createdFreeAttempt, 201);
      },
    );
    vi.stubGlobal("fetch", fetchSpy);

    render(<App />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Não foi possível guardar este treino livre neste dispositivo.",
    );
    expect(fetchSpy).not.toHaveBeenCalled();

    storage.mockRestore();
    await user.click(screen.getByRole("button", { name: "Tentar novamente" }));

    expect(
      await screen.findByRole("button", { name: "Selecionar vídeo" }),
    ).toBeEnabled();
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(
      new Headers(fetchSpy.mock.calls[0]?.[1]?.headers).get("idempotency-key"),
    ).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it("turns a tombstoned causal replay into a user-started fresh key without an automatic loop", async () => {
    window.history.replaceState({}, "", "/free-training");
    const oldKey = "f3333333-3333-4333-8333-333333333333";
    window.sessionStorage.setItem(
      "revelai.free-training.create-intent.v1",
      JSON.stringify({ idempotencyKey: oldKey }),
    );
    const user = userEvent.setup();
    const keys: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        keys.push(new Headers(init?.headers).get("idempotency-key") ?? "");
        return keys.length === 1
          ? response(
              {
                code: "attempt_not_found",
                message: "Esta tentativa não está disponível.",
                retryable: false,
              },
              404,
            )
          : response(createdFreeAttempt, 201);
      }),
    );

    render(<App />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Esta tentativa já foi excluída. Comece outro treino livre.",
    );
    expect(keys).toEqual([oldKey]);

    await user.click(screen.getByRole("button", { name: "Tentar novamente" }));
    expect(
      await screen.findByRole("button", { name: "Selecionar vídeo" }),
    ).toBeEnabled();
    expect(keys).toHaveLength(2);
    expect(keys[1]).not.toBe(oldKey);
    expect(
      window.sessionStorage.getItem("revelai.free-training.owner.v1"),
    ).toBe(JSON.stringify({ attemptId: "attempt-free-w5-1" }));
  });

  it("keeps local validation narrow and preserves source versus normalized wire metadata", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response(createdFreeAttempt, 201)),
    );
    const unsupported = new File(["video"], "unsupported.avi", {
      type: "video/x-msvideo",
    });
    const empty = new File([], "empty.webm", { type: "video/webm" });
    const oversized = new File(["video"], "oversized.webm", {
      type: "video/webm",
    });
    Object.defineProperty(oversized, "size", {
      configurable: true,
      value: 250 * 1024 * 1024 + 1,
    });
    const undeclared = new File(["video"], "undeclared.webm");

    render(<App />);
    await user.click(screen.getByRole("button", { name: "Treino livre" }));
    const input = await screen.findByTestId("free-training-video-input");

    fireEvent.change(input, { target: { files: [unsupported] } });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Escolha um arquivo MP4, MOV ou WebM com tipo declarado correspondente.",
    );
    expect(screen.getByRole("button", { name: "Enviar vídeo" })).toBeDisabled();

    fireEvent.change(input, { target: { files: [empty] } });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "O vídeo selecionado não contém dados. Escolha outro arquivo.",
    );

    fireEvent.change(input, { target: { files: [oversized] } });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "O vídeo selecionado excede o limite exibido. O servidor continua sendo a autoridade para a aceitação.",
    );

    fireEvent.change(input, { target: { files: [undeclared] } });
    expect(screen.getByText("undeclared.webm")).toBeVisible();
    expect(screen.getByText("Tipo declarado: não declarado")).toBeVisible();
    expect(
      screen.getByText("Formato de envio normalizado: video/webm."),
    ).toBeVisible();
    expect(screen.getByText("Tamanho de envio: 5 bytes")).toBeVisible();
    expect(screen.getByRole("button", { name: "Enviar vídeo" })).toBeEnabled();
  });

  it("uploads one selected Free video and renders only parsed approximate insight", async () => {
    const user = userEvent.setup();
    const fetchSpy = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        void init;
        const pathname = new URL(input.toString()).pathname;
        if (pathname === "/v1/attempts")
          return response(createdFreeAttempt, 201);
        if (pathname === "/v1/attempts/attempt-free-w5-1/media")
          return response(acceptedFreeUpload, 202);
        if (pathname === "/v1/attempts/attempt-free-w5-1/result")
          return response(freeInsight);
        throw new Error(`Unexpected request: ${pathname}`);
      },
    );
    vi.stubGlobal("fetch", fetchSpy);
    const file = new File(["video"], "free.webm", { type: "video/webm" });

    render(<App />);
    await user.click(screen.getByRole("button", { name: "Treino livre" }));
    await screen.findByRole("button", { name: "Selecionar vídeo" });
    fireEvent.change(screen.getByTestId("free-training-video-input"), {
      target: { files: [file] },
    });

    await user.click(screen.getByRole("button", { name: "Enviar vídeo" }));
    expect(
      await screen.findByRole("button", { name: "Atualizar agora" }),
    ).toBeEnabled();
    const upload = fetchSpy.mock.calls[1];
    const parts = Array.from((upload?.[1]?.body as FormData).entries());
    expect(parts).toHaveLength(1);
    expect(parts[0]?.[0]).toBe("media");
    expect(parts[0]?.[1]).toMatchObject({ name: file.name, type: file.type });

    await user.click(screen.getByRole("button", { name: "Atualizar agora" }));
    expect(
      await screen.findByText("Mantenha a bola visível durante a sequência."),
    ).toBeVisible();
    expect(screen.getByText("64% — partial")).toBeVisible();
    expect(screen.getByText("42% — limited")).toBeVisible();
    expect(screen.getByText("65% — high")).toBeVisible();
    expect(screen.getByText("Análise aproximada: true.")).toBeVisible();
    expect(screen.getByText("free-limited-ball-v1")).toBeVisible();
    expect(screen.getByText("demo-observations-v1")).toBeVisible();
    expect(screen.getByRole("main")).not.toHaveTextContent(
      /score|ranking|rank|percentil|top percent|verified/i,
    );
  });

  it("renders owner upload progress from the injected production XHR path", async () => {
    const user = userEvent.setup();
    const uploadListeners = new Map<string, (event: ProgressEvent) => void>();
    const requestListeners = new Map<string, () => void>();
    const fetchSpy = vi.fn(async () => response(createdFreeAttempt, 201));
    const xhr = {
      upload: {
        addEventListener: (
          type: string,
          listener: (event: ProgressEvent) => void,
        ) => uploadListeners.set(type, listener),
        removeEventListener: (type: string) => uploadListeners.delete(type),
      },
      status: 202,
      responseText: JSON.stringify(acceptedFreeUpload),
      open: () => undefined,
      setRequestHeader: () => undefined,
      addEventListener: (type: string, listener: () => void) =>
        requestListeners.set(type, listener),
      removeEventListener: (type: string) => requestListeners.delete(type),
      send: () =>
        uploadListeners.get("progress")?.({
          lengthComputable: true,
          loaded: 3,
          total: 5,
        } as ProgressEvent),
      abort: () => requestListeners.get("abort")?.(),
    };
    const client = createRevelApiClient({
      baseUrl: window.location.origin,
      athleteId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
      fetch: fetchSpy,
      xhrFactory: () => xhr as unknown as XMLHttpRequest,
    });

    render(<App apiClient={client} />);
    await user.click(screen.getByRole("button", { name: "Treino livre" }));
    fireEvent.change(await screen.findByTestId("free-training-video-input"), {
      target: {
        files: [new File(["video"], "xhr.webm", { type: "video/webm" })],
      },
    });
    await user.click(screen.getByRole("button", { name: "Enviar vídeo" }));

    expect(
      await screen.findByRole("progressbar", {
        name: "Envio do vídeo do treino livre",
      }),
    ).toHaveAttribute("value", "3");
    expect(screen.getByText("Enviando 3 de 5 bytes.")).toBeVisible();
    requestListeners.get("load")?.();
    expect(
      await screen.findByRole("button", { name: "Atualizar agora" }),
    ).toBeEnabled();
  });

  it("polls the owned Free Attempt with the capped 1, 2, 4, 5 second backoff and stops at insight", async () => {
    const user = userEvent.setup();
    let resultCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const pathname = new URL(input.toString()).pathname;
        if (pathname === "/v1/attempts")
          return response(createdFreeAttempt, 201);
        if (pathname === "/v1/attempts/attempt-free-w5-1/media")
          return response(acceptedFreeUpload, 202);
        if (pathname === "/v1/attempts/attempt-free-w5-1/result") {
          resultCalls += 1;
          return response(
            resultCalls < 5
              ? {
                  state: "pending",
                  attemptId: "attempt-free-w5-1",
                  mode: "free",
                  status: "processing",
                }
              : freeInsight,
            resultCalls < 5 ? 202 : 200,
          );
        }
        throw new Error(`Unexpected request: ${pathname}`);
      }),
    );
    render(<App />);

    await enterFreePending(user);
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
    expect(screen.getByText("64% — partial")).toBeVisible();
    expect(resultCalls).toBe(5);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(resultCalls).toBe(5);
  });

  it("coalesces visible, focus, and manual refresh while ignoring an old Free poll after starting another", async () => {
    const user = userEvent.setup();
    let cycle = 0;
    let resolveOldPoll: ((value: Response) => void) | undefined;
    let resultCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const pathname = new URL(input.toString()).pathname;
        if (pathname === "/v1/attempts") {
          cycle += 1;
          const id = `attempt-free-w5-${cycle}`;
          return Promise.resolve(
            response(
              {
                ...createdFreeAttempt,
                id,
                outcome: { ...createdFreeAttempt.outcome, attemptId: id },
              },
              201,
            ),
          );
        }
        if (pathname === "/v1/attempts/attempt-free-w5-1/media")
          return Promise.resolve(response(acceptedFreeUpload, 202));
        if (pathname === "/v1/attempts/attempt-free-w5-1/result") {
          resultCalls += 1;
          return new Promise<Response>((resolve) => {
            resolveOldPoll = resolve;
          });
        }
        throw new Error(`Unexpected request: ${pathname}`);
      }),
    );
    render(<App />);

    await enterFreePending(user);
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      document.dispatchEvent(new Event("visibilitychange"));
      await Promise.resolve();
    });
    await user.click(screen.getByRole("button", { name: "Atualizar agora" }));
    expect(resultCalls).toBe(1);

    await user.click(
      screen.getByRole("button", { name: "Começar outro treino livre" }),
    );
    expect(
      await screen.findByRole("heading", {
        name: "Treino livre — análise aproximada",
        level: 1,
      }),
    ).toHaveFocus();
    await act(async () => {
      resolveOldPoll?.(response(freeInsight));
      await Promise.resolve();
    });
    expect(
      screen.queryByText("Mantenha a bola visível durante a sequência."),
    ).not.toBeInTheDocument();
    expect(cycle).toBe(2);
  });

  it("reconciles a pre-commit upload cancellation to the same Free Attempt and selected file", async () => {
    const user = userEvent.setup();
    let creates = 0;
    let uploads = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const pathname = new URL(input.toString()).pathname;
        if (pathname === "/v1/attempts") {
          creates += 1;
          return Promise.resolve(response(createdFreeAttempt, 201));
        }
        if (pathname === "/v1/attempts/attempt-free-w5-1/media") {
          uploads += 1;
          if (uploads === 1)
            return new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener("abort", () =>
                reject(new DOMException("Aborted", "AbortError")),
              );
            });
          return Promise.resolve(response(acceptedFreeUpload, 202));
        }
        if (pathname === "/v1/attempts/attempt-free-w5-1")
          return Promise.resolve(response(createdFreeAttempt));
        throw new Error(`Unexpected request: ${pathname}`);
      }),
    );
    render(<App />);

    await user.click(screen.getByRole("button", { name: "Treino livre" }));
    fireEvent.change(await screen.findByTestId("free-training-video-input"), {
      target: {
        files: [
          new File(["video"], "before-commit.webm", {
            type: "video/webm",
          }),
        ],
      },
    });
    await user.click(screen.getByRole("button", { name: "Enviar vídeo" }));
    await user.click(
      await screen.findByRole("button", { name: "Cancelar envio" }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Envio cancelado. O vídeo continua pronto para tentar novamente.",
    );
    expect(screen.getByText("before-commit.webm")).toBeVisible();
    expect(screen.getByRole("button", { name: "Enviar vídeo" })).toBeEnabled();
    expect(creates).toBe(1);
    await user.click(screen.getByRole("button", { name: "Enviar vídeo" }));
    expect(
      await screen.findByRole("button", { name: "Atualizar agora" }),
    ).toBeEnabled();
    expect(uploads).toBe(2);
    expect(creates).toBe(1);
  });

  it("does not let a stale cancellation read or first upload failure replace a newer accepted Free upload", async () => {
    const user = userEvent.setup();
    let uploads = 0;
    let rejectFirstUpload: ((reason: unknown) => void) | undefined;
    let resolveOldAttempt: ((value: Response) => void) | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const pathname = new URL(input.toString()).pathname;
        if (pathname === "/v1/attempts")
          return Promise.resolve(response(createdFreeAttempt, 201));
        if (pathname === "/v1/attempts/attempt-free-w5-1/media") {
          uploads += 1;
          if (uploads === 1)
            return new Promise<Response>((_resolve, reject) => {
              rejectFirstUpload = reject;
            });
          return Promise.resolve(response(acceptedFreeUpload, 202));
        }
        if (pathname === "/v1/attempts/attempt-free-w5-1")
          return new Promise<Response>((resolve) => {
            resolveOldAttempt = resolve;
          });
        throw new Error(`Unexpected request: ${pathname}`);
      }),
    );
    render(<App />);

    await user.click(screen.getByRole("button", { name: "Treino livre" }));
    fireEvent.change(await screen.findByTestId("free-training-video-input"), {
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
      await screen.findByRole("button", { name: "Atualizar agora" }),
    ).toBeEnabled();

    await act(async () => {
      rejectFirstUpload?.(
        new TypeError("first upload connection closed after replacement"),
      );
      resolveOldAttempt?.(response(createdFreeAttempt));
      await Promise.resolve();
    });
    expect(
      screen.getByRole("button", { name: "Atualizar agora" }),
    ).toBeEnabled();
    expect(screen.queryByText("race.webm")).not.toBeInTheDocument();
    expect(
      screen.queryByText("Não foi possível continuar agora. Tente novamente."),
    ).not.toBeInTheDocument();
  });

  it.each([
    [
      "duplicate",
      () =>
        response(
          {
            code: "duplicate_media_upload",
            message: "Esta tentativa já possui um vídeo.",
            retryable: false,
          },
          409,
        ),
    ],
    ["lost-response", () => Promise.reject(new TypeError("connection closed"))],
  ] as const)(
    "reconciles a %s Free upload response against the authoritative Attempt",
    async (_kind, uploadResponse) => {
      const user = userEvent.setup();
      let attemptReads = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL) => {
          const pathname = new URL(input.toString()).pathname;
          if (pathname === "/v1/attempts")
            return response(createdFreeAttempt, 201);
          if (pathname === "/v1/attempts/attempt-free-w5-1/media")
            return uploadResponse();
          if (pathname === "/v1/attempts/attempt-free-w5-1") {
            attemptReads += 1;
            return response({
              ...createdFreeAttempt,
              status: "processing",
              outcome: {
                state: "pending",
                attemptId: "attempt-free-w5-1",
                mode: "free",
                status: "processing",
              },
            });
          }
          throw new Error(`Unexpected request: ${pathname}`);
        }),
      );
      render(<App />);

      await enterFreePending(user);

      expect(attemptReads).toBe(1);
      expect(screen.queryByText("free.webm")).not.toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Atualizar agora" }),
      ).toBeEnabled();
    },
  );

  it("keeps the selected file and same Free Attempt retryable when lost-response reconciliation also fails", async () => {
    const user = userEvent.setup();
    let creates = 0;
    let uploads = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const pathname = new URL(input.toString()).pathname;
        if (pathname === "/v1/attempts") {
          creates += 1;
          return response(createdFreeAttempt, 201);
        }
        if (pathname === "/v1/attempts/attempt-free-w5-1/media") {
          uploads += 1;
          if (uploads === 1) throw new TypeError("connection closed");
          return response(acceptedFreeUpload, 202);
        }
        if (pathname === "/v1/attempts/attempt-free-w5-1")
          throw new TypeError("attempt read closed");
        throw new Error(`Unexpected request: ${pathname}`);
      }),
    );
    render(<App />);

    await user.click(screen.getByRole("button", { name: "Treino livre" }));
    fireEvent.change(await screen.findByTestId("free-training-video-input"), {
      target: {
        files: [new File(["video"], "retry.webm", { type: "video/webm" })],
      },
    });
    await user.click(screen.getByRole("button", { name: "Enviar vídeo" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Não foi possível continuar agora. Tente novamente.",
    );
    expect(screen.getByText("retry.webm")).toBeVisible();
    expect(creates).toBe(1);

    await user.click(screen.getByRole("button", { name: "Enviar vídeo" }));
    expect(
      await screen.findByRole("button", { name: "Atualizar agora" }),
    ).toBeEnabled();
    expect(uploads).toBe(2);
    expect(creates).toBe(1);
  });

  it("renders all parsed Roboflow Free provenance, observations, and the received two-tip order", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", freeWorkflowFetch(roboflowFreeInsight));
    render(<App />);

    await enterFreePending(user);
    await user.click(screen.getByRole("button", { name: "Atualizar agora" }));

    const provenance = await screen.findByLabelText("Proveniência Roboflow");
    for (const value of [
      "workspace-free-w5",
      "revelai-free-training-v1",
      "1.0.0",
      "free-bundle-w5",
      "roboflow-free-w5",
    ])
      expect(provenance).toHaveTextContent(value);
    for (const observation of ["42% — limited", "30% — limited", "80% — high"])
      expect(screen.getByText(observation)).toBeVisible();
    expect(
      Array.from(
        screen.getByLabelText("Sugestões recebidas").querySelectorAll("li"),
      ).map((tip) => tip.textContent),
    ).toEqual([
      "Mantenha o corpo inteiro visível.",
      "Mantenha a bola visível durante a sequência.",
    ]);
  });

  it.each([
    [
      "pending",
      {
        state: "pending",
        attemptId: "attempt-free-w5-1",
        mode: "verified",
        status: "processing",
      },
    ],
    ["valid", verifiedOutcome],
    [
      "invalid",
      {
        state: "invalid",
        attemptId: "attempt-free-w5-1",
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
        attemptId: "attempt-free-w5-1",
        mode: "verified",
        code: "analysis_internal_error",
        message: "A análise não pôde ser concluída.",
        retryable: false,
      },
    ],
  ] as const)(
    "fails closed when a parsed verified %s arm reaches the Free owner",
    async (_kind, crossModeOutcome) => {
      const user = userEvent.setup();
      vi.stubGlobal("fetch", freeWorkflowFetch(crossModeOutcome));
      render(<App />);

      await enterFreePending(user);
      await user.click(screen.getByRole("button", { name: "Atualizar agora" }));

      expect(await screen.findByText("Resultado indisponível")).toBeVisible();
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Este resultado não está disponível neste fluxo.",
      );
      expect(
        screen.queryByText("Mantenha a bola visível durante a sequência."),
      ).not.toBeInTheDocument();
    },
  );

  it.each([
    ["retryable", freeFailure],
    [
      "non-retryable",
      {
        ...freeFailure,
        code: "analysis_configuration_invalid",
        message: "A análise não está disponível agora.",
        retryable: false,
      },
    ],
  ] as const)(
    "renders only the safe parsed Free %s failure and starts a fresh Attempt",
    async (_kind, failure) => {
      const user = userEvent.setup();
      let creates = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL) => {
          const pathname = new URL(input.toString()).pathname;
          if (pathname === "/v1/attempts") {
            creates += 1;
            const id = `attempt-free-w5-${creates}`;
            return response(
              {
                ...createdFreeAttempt,
                id,
                outcome: { ...createdFreeAttempt.outcome, attemptId: id },
              },
              201,
            );
          }
          if (pathname === "/v1/attempts/attempt-free-w5-1/media")
            return response(acceptedFreeUpload, 202);
          if (pathname === "/v1/attempts/attempt-free-w5-1/result")
            return response(failure);
          throw new Error(`Unexpected request: ${pathname}`);
        }),
      );
      render(<App />);

      await enterFreePending(user);
      await user.click(screen.getByRole("button", { name: "Atualizar agora" }));
      expect(await screen.findByRole("alert")).toHaveTextContent(
        failure.message,
      );
      expect(
        screen.getByRole("button", { name: "Começar outro treino livre" }),
      ).toBeEnabled();
      expect(
        screen.queryByText(/threshold|provider|stack|storage/i),
      ).not.toBeInTheDocument();

      await user.click(
        screen.getByRole("button", { name: "Começar outro treino livre" }),
      );
      expect(
        await screen.findByRole("button", { name: "Selecionar vídeo" }),
      ).toBeEnabled();
      expect(creates).toBe(2);
    },
  );

  it("lets the owner replace or cancel local Free media with preview cleanup", async () => {
    const user = userEvent.setup();
    const createObjectUrl = vi
      .fn()
      .mockReturnValueOnce("blob:first")
      .mockReturnValueOnce("blob:second");
    const revokeObjectUrl = vi.fn();
    Object.defineProperties(URL, {
      createObjectURL: { configurable: true, value: createObjectUrl },
      revokeObjectURL: { configurable: true, value: revokeObjectUrl },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response(createdFreeAttempt, 201)),
    );
    const first = new File(["first"], "first.mov", {
      type: "video/quicktime",
    });
    const second = new File(["second"], "second.webm", {
      type: "video/webm",
    });

    render(<App />);
    await user.click(screen.getByRole("button", { name: "Treino livre" }));
    const input = await screen.findByTestId("free-training-video-input");
    fireEvent.change(input, { target: { files: [first] } });

    expect(screen.getByText("first.mov")).toBeVisible();
    expect(screen.getByText("Tipo declarado: video/quicktime")).toBeVisible();
    expect(
      screen.getByText("Formato de envio normalizado: video/quicktime."),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Substituir vídeo" }),
    ).toBeEnabled();
    expect(
      screen.getByRole("button", { name: "Cancelar vídeo" }),
    ).toBeEnabled();

    fireEvent.change(input, { target: { files: [second] } });
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:first");
    expect(screen.getByText("second.webm")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Cancelar vídeo" }));
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:second");
    expect(screen.queryByText("second.webm")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Selecionar vídeo" }),
    ).toBeEnabled();
    expect(createObjectUrl).toHaveBeenCalledTimes(2);
  });

  it("releases the local Free preview after the server accepts its upload", async () => {
    const user = userEvent.setup();
    const revokeObjectUrl = vi.fn();
    Object.defineProperties(URL, {
      createObjectURL: {
        configurable: true,
        value: vi.fn(() => "blob:accepted"),
      },
      revokeObjectURL: { configurable: true, value: revokeObjectUrl },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const pathname = new URL(input.toString()).pathname;
        if (pathname === "/v1/attempts")
          return response(createdFreeAttempt, 201);
        if (pathname === "/v1/attempts/attempt-free-w5-1/media")
          return response(acceptedFreeUpload, 202);
        throw new Error(`Unexpected request: ${pathname}`);
      }),
    );
    render(<App />);

    await user.click(screen.getByRole("button", { name: "Treino livre" }));
    fireEvent.change(await screen.findByTestId("free-training-video-input"), {
      target: {
        files: [new File(["video"], "accepted.webm", { type: "video/webm" })],
      },
    });
    await user.click(screen.getByRole("button", { name: "Enviar vídeo" }));

    expect(
      await screen.findByRole("button", { name: "Atualizar agora" }),
    ).toBeEnabled();
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:accepted");
    expect(screen.queryByText("accepted.webm")).not.toBeInTheDocument();
  });

  it("confirms Free deletion, then returns focus and completion to device history", async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, "confirm");
    const fetchSpy = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const pathname = new URL(input.toString()).pathname;
        if (pathname === "/v1/attempts" && init?.method === "POST")
          return response(createdFreeAttempt, 201);
        if (pathname === "/v1/attempts/attempt-free-w5-1/media")
          return response(acceptedFreeUpload, 202);
        if (pathname === "/v1/attempts/attempt-free-w5-1/result")
          return response(freeInsight);
        if (
          pathname === "/v1/attempts/attempt-free-w5-1" &&
          init?.method === "DELETE"
        )
          return new Response(null, { status: 204 });
        if (pathname === "/v1/attempts")
          return response({ items: [], nextCursor: null });
        throw new Error(`Unexpected request: ${pathname}`);
      },
    );
    vi.stubGlobal("fetch", fetchSpy);
    const file = new File(["video"], "free.webm", { type: "video/webm" });

    render(<App />);
    await user.click(screen.getByRole("button", { name: "Treino livre" }));
    fireEvent.change(await screen.findByTestId("free-training-video-input"), {
      target: { files: [file] },
    });
    await user.click(screen.getByRole("button", { name: "Enviar vídeo" }));
    await user.click(
      await screen.findByRole("button", { name: "Atualizar agora" }),
    );
    await screen.findByText("Mantenha a bola visível durante a sequência.");

    confirm.mockReturnValueOnce(false);
    await user.click(screen.getByRole("button", { name: "Excluir treino" }));
    expect(fetchSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("/v1/attempts/attempt-free-w5-1"),
      expect.objectContaining({ method: "DELETE" }),
    );
    expect(
      screen.getByText("Mantenha a bola visível durante a sequência."),
    ).toBeVisible();

    confirm.mockReturnValueOnce(true);
    await user.click(screen.getByRole("button", { name: "Excluir treino" }));
    expect(confirm).toHaveBeenLastCalledWith(
      "Excluir este treino? A mídia e a análise aproximada serão removidas.",
    );
    expect(
      await screen.findByRole("heading", {
        name: "Meus treinos neste dispositivo",
        level: 1,
      }),
    ).toHaveFocus();
    expect(screen.getByText("Treino excluído.")).toHaveAttribute(
      "role",
      "status",
    );
  });

  it("keeps the Free terminal visible after a delete error and retries only after another confirmation", async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    let deletes = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const pathname = new URL(input.toString()).pathname;
        if (pathname === "/v1/attempts" && init?.method === "POST")
          return response(createdFreeAttempt, 201);
        if (pathname === "/v1/attempts/attempt-free-w5-1/media")
          return response(acceptedFreeUpload, 202);
        if (pathname === "/v1/attempts/attempt-free-w5-1/result")
          return response(freeInsight);
        if (
          pathname === "/v1/attempts/attempt-free-w5-1" &&
          init?.method === "DELETE"
        ) {
          deletes += 1;
          return deletes === 1
            ? response(
                {
                  code: "service_not_ready",
                  message: "O serviço está temporariamente indisponível.",
                  retryable: true,
                },
                503,
              )
            : new Response(null, { status: 204 });
        }
        if (pathname === "/v1/attempts")
          return response({ items: [], nextCursor: null });
        throw new Error(`Unexpected request: ${pathname}`);
      }),
    );
    const file = new File(["video"], "free.webm", { type: "video/webm" });
    render(<App />);

    await user.click(screen.getByRole("button", { name: "Treino livre" }));
    fireEvent.change(await screen.findByTestId("free-training-video-input"), {
      target: { files: [file] },
    });
    await user.click(screen.getByRole("button", { name: "Enviar vídeo" }));
    await user.click(
      await screen.findByRole("button", { name: "Atualizar agora" }),
    );
    await screen.findByText("Mantenha a bola visível durante a sequência.");

    await user.click(screen.getByRole("button", { name: "Excluir treino" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "O serviço está temporariamente indisponível.",
    );
    expect(
      screen.getByText("Mantenha a bola visível durante a sequência."),
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Excluir treino" }));

    expect(
      await screen.findByRole("heading", {
        name: "Meus treinos neste dispositivo",
        level: 1,
      }),
    ).toHaveFocus();
    expect(deletes).toBe(2);
    expect(confirm).toHaveBeenCalledTimes(2);
  });

  it("serializes same-tick Free deletion and aborts its stale request on unmount", async () => {
    const user = userEvent.setup();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const deletion = deferred<Response>();
    let deletes = 0;
    let deleteSignal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const pathname = new URL(input.toString()).pathname;
        if (pathname === "/v1/attempts" && init?.method === "POST")
          return Promise.resolve(response(createdFreeAttempt, 201));
        if (pathname === "/v1/attempts/attempt-free-w5-1/media")
          return Promise.resolve(response(acceptedFreeUpload, 202));
        if (pathname === "/v1/attempts/attempt-free-w5-1/result")
          return Promise.resolve(response(freeInsight));
        if (
          pathname === "/v1/attempts/attempt-free-w5-1" &&
          init?.method === "DELETE"
        ) {
          deletes += 1;
          deleteSignal = init.signal ?? undefined;
          return deletion.promise;
        }
        throw new Error(`Unexpected request: ${pathname}`);
      }),
    );
    const view = render(<App />);
    await user.click(screen.getByRole("button", { name: "Treino livre" }));
    fireEvent.change(await screen.findByTestId("free-training-video-input"), {
      target: {
        files: [new File(["video"], "delete.webm", { type: "video/webm" })],
      },
    });
    await user.click(screen.getByRole("button", { name: "Enviar vídeo" }));
    await user.click(
      await screen.findByRole("button", { name: "Atualizar agora" }),
    );
    const deleteButton = await screen.findByRole("button", {
      name: "Excluir treino",
    });
    fireEvent.click(deleteButton);
    fireEvent.click(deleteButton);

    await waitFor(() => expect(deletes).toBe(1));
    expect(window.confirm).toHaveBeenCalledTimes(1);
    view.unmount();
    await act(async () => {
      await Promise.resolve();
    });
    expect(deleteSignal?.aborted).toBe(true);
    await act(async () => {
      deletion.resolve(new Response(null, { status: 204 }));
      await Promise.resolve();
    });
    expect(window.location.pathname).toBe("/free-training");
  });

  it("removes a previously cached Free history record before returning after deletion", async () => {
    const user = userEvent.setup();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    let historyReads = 0;
    const laterHistoryRead = deferred<Response>();
    const fetchSpy = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const pathname = new URL(input.toString()).pathname;
        if (pathname === "/v1/attempts" && init?.method === "POST")
          return response(createdFreeAttempt, 201);
        if (pathname === "/v1/attempts") {
          historyReads += 1;
          if (historyReads === 1)
            return response({
              items: [
                {
                  ...createdFreeAttempt,
                  status: "valid",
                  outcome: freeInsight,
                },
              ],
              nextCursor: null,
            });
          return laterHistoryRead.promise;
        }
        if (pathname === "/v1/attempts/attempt-free-w5-1/media")
          return response(acceptedFreeUpload, 202);
        if (pathname === "/v1/attempts/attempt-free-w5-1/result")
          return response(freeInsight);
        if (
          pathname === "/v1/attempts/attempt-free-w5-1" &&
          init?.method === "DELETE"
        )
          return new Response(null, { status: 204 });
        throw new Error(`Unexpected request: ${pathname}`);
      },
    );
    vi.stubGlobal("fetch", fetchSpy);
    const file = new File(["video"], "free.webm", { type: "video/webm" });

    render(<App />);
    await user.click(screen.getByRole("link", { name: "Meus treinos" }));
    expect(
      await screen.findByRole("heading", {
        name: "Treino livre — análise aproximada",
        level: 2,
      }),
    ).toBeVisible();
    await user.click(screen.getByRole("link", { name: "Início" }));
    await user.click(screen.getByRole("button", { name: "Treino livre" }));
    fireEvent.change(await screen.findByTestId("free-training-video-input"), {
      target: { files: [file] },
    });
    await user.click(screen.getByRole("button", { name: "Enviar vídeo" }));
    await user.click(
      await screen.findByRole("button", { name: "Atualizar agora" }),
    );
    await user.click(
      await screen.findByRole("button", { name: "Excluir treino" }),
    );

    expect(
      await screen.findByRole("heading", {
        name: "Meus treinos neste dispositivo",
        level: 1,
      }),
    ).toHaveFocus();
    expect(screen.queryByRole("article")).not.toBeInTheDocument();
    expect(
      screen.getByText("Nenhum treino neste dispositivo ainda."),
    ).toBeVisible();
    laterHistoryRead.resolve(response({ items: [], nextCursor: null }));
  });
});

describe("Free upload reconciliation", () => {
  it.each([
    [
      "awaiting-upload",
      {
        state: "pending",
        attemptId: "attempt-free-w5-1",
        mode: "free",
        status: "awaiting-upload",
      },
      { kind: "capture", preserveMedia: true },
    ],
    [
      "uploaded",
      acceptedFreeUpload.outcome,
      { kind: "pending", preserveMedia: false },
    ],
    [
      "processing",
      {
        state: "pending",
        attemptId: "attempt-free-w5-1",
        mode: "free",
        status: "processing",
      },
      { kind: "pending", preserveMedia: false },
    ],
    ["valid", freeInsight, { kind: "terminal", preserveMedia: false }],
    ["failed", freeFailure, { kind: "terminal", preserveMedia: false }],
  ] as const)(
    "maps authoritative Free %s state without inferring a second owner",
    (_name, outcome, expected) => {
      expect(
        resolveUploadReconciliation(outcome, "attempt-free-w5-1", "free"),
      ).toMatchObject(expected);
    },
  );

  it("fails closed and preserves local media for an outcome outside the owned Free Attempt", () => {
    expect(
      resolveUploadReconciliation(
        {
          state: "pending",
          attemptId: "attempt-other",
          mode: "free",
          status: "uploaded",
        },
        "attempt-free-w5-1",
        "free",
      ),
    ).toEqual({ kind: "mismatch", preserveMedia: true });
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}
