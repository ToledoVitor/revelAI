import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { routeErrorFixtures } from "@revelai/contracts";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { App } from "../app";

const athleteId = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => {
  window.history.replaceState({}, "", "/");
  window.localStorage.setItem("revelai.device-athlete-id", athleteId);
});
afterEach(() => {
  cleanup();
  server.resetHandlers();
  vi.restoreAllMocks();
});
afterAll(() => server.close());

describe("training history", () => {
  it("opens the device-local history route with an accessible empty state", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("*/v1/attempts", ({ request }) => {
        expect(request.headers.get("x-revelai-athlete-id")).toBe(athleteId);
        return HttpResponse.json({ items: [], nextCursor: null });
      }),
    );

    render(<App />);
    await user.tab();
    await user.tab();
    await user.tab();
    await user.tab();
    expect(screen.getByRole("link", { name: "Meus treinos" })).toHaveFocus();
    await user.keyboard("{Enter}");

    const heading = await screen.findByRole("heading", {
      name: "Meus treinos neste dispositivo",
      level: 1,
    });
    expect(heading).toHaveFocus();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Nenhum treino neste dispositivo ainda.",
    );
    expect(window.location.pathname).toBe("/training/history");
  });

  it("shows loading before preserving the server's reverse-created history order", async () => {
    const user = userEvent.setup();
    const newer = pendingAttempt("attempt-newer", "2026-08-30T13:00:00.000Z");
    const older = pendingAttempt("attempt-older", "2026-08-30T12:00:00.000Z");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const errorLog = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const releaseResponse = deferred<Response>();
    server.use(http.get("*/v1/attempts", () => releaseResponse.promise));

    render(<App />);
    await user.click(screen.getByRole("link", { name: "Meus treinos" }));

    expect(screen.getByRole("status")).toHaveTextContent("Carregando treinos.");
    releaseResponse.resolve(
      HttpResponse.json({ items: [newer, older], nextCursor: null }),
    );

    await screen.findAllByRole("heading", { name: "Treino livre", level: 2 });
    expect(
      screen.getAllByRole("article").map((item) => item.textContent),
    ).toEqual([
      expect.stringContaining("13:00"),
      expect.stringContaining("12:00"),
    ]);
    expect(document.body.textContent).not.toContain(athleteId);
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining(athleteId));
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining(athleteId));
    expect(errorLog).not.toHaveBeenCalledWith(
      expect.stringContaining(athleteId),
    );
  });

  it("retries an initial history error", async () => {
    const user = userEvent.setup();
    let requestNumber = 0;
    const error = fixtureError("service_not_ready");
    server.use(
      http.get("*/v1/attempts", () => {
        requestNumber += 1;
        return requestNumber === 1
          ? HttpResponse.json(error.body, { status: error.status })
          : HttpResponse.json({ items: [], nextCursor: null });
      }),
    );

    render(<App />);
    await user.click(screen.getByRole("link", { name: "Meus treinos" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      error.body.message,
    );
    await user.click(screen.getByRole("button", { name: "Tentar novamente" }));
    expect(
      await screen.findByText("Nenhum treino neste dispositivo ainda."),
    ).toHaveAttribute("role", "status");
  });

  it("retries a next cursor page without reordering the received history", async () => {
    const user = userEvent.setup();
    const newer = pendingAttempt("attempt-newer", "2026-08-30T13:00:00.000Z");
    const older = pendingAttempt("attempt-older", "2026-08-30T12:00:00.000Z");
    const error = fixtureError("queue_unavailable");
    let nextPageRequest = 0;
    const nextPageResponse = deferred<Response>();
    server.use(
      http.get("*/v1/attempts", ({ request }) => {
        const cursor = new URL(request.url).searchParams.get("cursor");
        if (!cursor) {
          return HttpResponse.json({ items: [newer], nextCursor: "page-2" });
        }
        nextPageRequest += 1;
        return nextPageRequest === 1
          ? nextPageResponse.promise
          : HttpResponse.json({ items: [older], nextCursor: null });
      }),
    );

    render(<App />);
    await user.click(screen.getByRole("link", { name: "Meus treinos" }));
    await screen.findByText(/13:00/);

    await user.click(
      screen.getByRole("button", { name: "Carregar mais treinos" }),
    );
    expect(
      screen.getByRole("button", { name: "Carregando mais treinos" }),
    ).toBeDisabled();
    nextPageResponse.resolve(
      HttpResponse.json(error.body, { status: error.status }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      error.body.message,
    );
    await user.click(
      screen.getByRole("button", { name: "Tentar carregar mais" }),
    );

    await screen.findByText(/12:00/);
    expect(
      screen.getAllByRole("article").map((item) => item.textContent),
    ).toEqual([
      expect.stringContaining("13:00"),
      expect.stringContaining("12:00"),
    ]);
  });

  it("announces deletion completion and moves focus to the history heading", async () => {
    const user = userEvent.setup();
    const newer = pendingAttempt("attempt-newer", "2026-08-30T13:00:00.000Z");
    const older = pendingAttempt("attempt-older", "2026-08-30T12:00:00.000Z");
    const deleteResponse = deferred<Response>();
    server.use(
      http.get("*/v1/attempts", () =>
        HttpResponse.json({ items: [newer, older], nextCursor: null }),
      ),
      http.delete("*/v1/attempts/attempt-newer", () => deleteResponse.promise),
    );

    render(<App />);
    await user.click(screen.getByRole("link", { name: "Meus treinos" }));
    await screen.findAllByRole("article");

    await user.click(
      screen.getAllByRole("button", { name: "Excluir treino" })[0],
    );
    expect(
      screen.getByRole("button", { name: "Excluindo treino" }),
    ).toBeDisabled();

    deleteResponse.resolve(new HttpResponse(null, { status: 204 }));

    expect(await screen.findByRole("status")).toHaveTextContent(
      "Treino excluído.",
    );
    expect(screen.getAllByRole("article")).toHaveLength(1);
    expect(
      screen.getByRole("heading", {
        name: "Meus treinos neste dispositivo",
        level: 1,
      }),
    ).toHaveFocus();
  });

  it("removes a deleted item and recovers from a deletion error", async () => {
    const user = userEvent.setup();
    const attempt = pendingAttempt(
      "attempt-delete",
      "2026-08-30T13:00:00.000Z",
    );
    const error = fixtureError("queue_unavailable");
    let deleteRequest = 0;
    server.use(
      http.get("*/v1/attempts", () =>
        HttpResponse.json({ items: [attempt], nextCursor: null }),
      ),
      http.delete("*/v1/attempts/attempt-delete", () => {
        deleteRequest += 1;
        return deleteRequest === 1
          ? HttpResponse.json(error.body, { status: error.status })
          : new HttpResponse(null, { status: 204 });
      }),
    );

    render(<App />);
    await user.click(screen.getByRole("link", { name: "Meus treinos" }));
    await screen.findByText(/13:00/);

    const deleteButton = screen.getByRole("button", { name: "Excluir treino" });
    await user.click(deleteButton);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      error.body.message,
    );
    expect(deleteButton).toBeEnabled();
    await user.click(deleteButton);

    expect(
      await screen.findByText("Nenhum treino neste dispositivo ainda."),
    ).toHaveAttribute("role", "status");
    expect(screen.queryByRole("article")).not.toBeInTheDocument();
  });
});

function pendingAttempt(id: string, createdAt: string) {
  return {
    id,
    mode: "free" as const,
    status: "awaiting-upload" as const,
    createdAt,
    outcome: {
      state: "pending" as const,
      attemptId: id,
      mode: "free" as const,
      status: "awaiting-upload" as const,
    },
  };
}

function fixtureError(code: string) {
  const fixture = routeErrorFixtures.find(
    (candidate) => candidate.body.code === code,
  );
  if (!fixture) throw new Error(`Missing route error fixture: ${code}`);
  return fixture;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}
