// @vitest-environment node

import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "vite";
import { waitFor } from "@testing-library/react";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { ReviewSetupPort } from "./verified/setup";
import type { ReviewCapturePort } from "./verified/capture";

const webDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const productionHarnessEntry = resolve(
  webDirectory,
  "src/test/production-router-harness.tsx",
);

type ProductionHarness = Readonly<{
  mountProductionApp(
    element: Element,
    reviewSetupPort?: ReviewSetupPort,
    reviewCapturePort?: ReviewCapturePort,
  ): () => void;
}>;

type BuildOutput = Readonly<{ output: unknown[] }>;
type EntrypointChunk = Readonly<{
  facadeModuleId: string | null;
  fileName: string;
  type: "chunk";
}>;

type JSDOMInstance = Readonly<{
  window: Window &
    Readonly<{
      PopStateEvent: typeof PopStateEvent;
      close(): void;
    }>;
}>;

const require = createRequire(import.meta.url);
const { JSDOM } = require("jsdom") as Readonly<{
  JSDOM: new (
    markup: string,
    options: Readonly<{ pretendToBeVisual: boolean; url: string }>,
  ) => JSDOMInstance;
}>;

let dom: JSDOMInstance;
let harness: ProductionHarness;
let outputDirectory: string;
let restoreDomGlobals: (() => void) | undefined;
let activeUnmount: (() => void) | undefined;
let activeHost: HTMLElement | undefined;

const routerRenderTimeoutMs = 1_000;

function installDomGlobals(window: Window) {
  const keys = [
    "window",
    "document",
    "navigator",
    "location",
    "history",
    "HTMLElement",
    "Node",
    "Text",
    "Event",
    "PopStateEvent",
    "requestAnimationFrame",
    "cancelAnimationFrame",
  ] as const;
  const previous = new Map(
    keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );

  for (const key of keys) {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value: window[key as keyof Window],
      writable: true,
    });
  }

  return () => {
    for (const key of keys) {
      const descriptor = previous.get(key);
      if (descriptor) {
        Object.defineProperty(globalThis, key, descriptor);
      } else {
        Reflect.deleteProperty(globalThis, key);
      }
    }
  };
}

function hasBuildOutput(value: unknown): value is BuildOutput {
  return (
    typeof value === "object" &&
    value !== null &&
    "output" in value &&
    Array.isArray(value.output)
  );
}

function isEntrypointChunk(value: unknown): value is EntrypointChunk {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "chunk" &&
    "fileName" in value &&
    typeof value.fileName === "string" &&
    "facadeModuleId" in value &&
    (typeof value.facadeModuleId === "string" || value.facadeModuleId === null)
  );
}

async function waitForHarnessRender(host: HTMLElement, assertion: () => void) {
  await waitFor(assertion, {
    container: host,
    timeout: routerRenderTimeoutMs,
  });
}

async function buildWithProductionEnvironment() {
  const previousNodeEnvironment = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";

  try {
    return await build({
      root: webDirectory,
      mode: "production",
      logLevel: "silent",
      build: {
        outDir: outputDirectory,
        rollupOptions: {
          input: productionHarnessEntry,
        },
      },
    });
  } finally {
    if (previousNodeEnvironment === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = previousNodeEnvironment;
    }
  }
}

function fakeReviewPort() {
  return {
    getFixture: vi.fn(() => ({
      challenges: [
        {
          id: "wall-pass-v1" as const,
          name: "Passe na parede — futsal",
        },
      ],
      cameraStatus: "pending" as const,
    })),
    retryCamera: vi.fn(() => "pending" as const),
  } satisfies ReviewSetupPort;
}

function fakeCapturePort() {
  return {
    getDraft: vi.fn(() => ({
      kind: "review-verified-draft" as const,
      challengeId: "wall-pass" as const,
      challengeVersion: 1 as const,
    })),
    upload: vi.fn(async () => ({ kind: "accepted" as const })),
  } satisfies ReviewCapturePort;
}

async function mountAt(
  path: string,
  setupPort: ReviewSetupPort,
  capturePort: ReviewCapturePort,
) {
  dom.window.history.replaceState({}, "", path);
  const host = dom.window.document.createElement("div");
  dom.window.document.body.replaceChildren(host);
  activeHost = host;
  activeUnmount = harness.mountProductionApp(host, setupPort, capturePort);
  return host;
}

async function waitForHomeRoute(host: HTMLElement) {
  await waitForHarnessRender(host, () => {
    expect(host.querySelector("h1#home-heading")).toHaveTextContent(
      "Treine. Grave. Evolua.",
    );
  });
}

function expectUnavailableBoundary(
  host: HTMLElement,
  setupPort: ReturnType<typeof fakeReviewPort>,
  capturePort: ReturnType<typeof fakeCapturePort>,
) {
  expect(host.textContent).toContain("Indisponível");
  expect(host.textContent).toContain("Disponível após ativação do fluxo");
  expect(host.textContent).toContain(
    "A orientação de preparação aguarda a ativação completa da captura e do resultado.",
  );
  expect(setupPort.getFixture).not.toHaveBeenCalled();
  expect(setupPort.retryCamera).not.toHaveBeenCalled();
  expect(capturePort.getDraft).not.toHaveBeenCalled();
  expect(capturePort.upload).not.toHaveBeenCalled();
  expect(
    (
      dom.window as typeof window & {
        __revelaiReviewSetupModuleEvaluations?: number;
      }
    ).__revelaiReviewSetupModuleEvaluations,
  ).toBeUndefined();
  expect(
    (
      dom.window as typeof window & {
        __revelaiReviewCaptureModuleEvaluations?: number;
      }
    ).__revelaiReviewCaptureModuleEvaluations,
  ).toBeUndefined();
}

async function waitForUnavailableBoundary(
  host: HTMLElement,
  setupPort: ReturnType<typeof fakeReviewPort>,
  capturePort: ReturnType<typeof fakeCapturePort>,
) {
  await waitForHarnessRender(host, () => {
    expectUnavailableBoundary(host, setupPort, capturePort);
  });
}

describe("transformed production router harness", () => {
  const fetchSpy = vi.fn();

  beforeAll(async () => {
    outputDirectory = await mkdtemp(
      resolve(webDirectory, "coverage/production-router-harness-"),
    );
    const buildResult = await buildWithProductionEnvironment();
    const entrypoint = (
      Array.isArray(buildResult) ? buildResult : [buildResult]
    )
      .flatMap((output) => (hasBuildOutput(output) ? output.output : []))
      .find(
        (output) =>
          isEntrypointChunk(output) &&
          output.facadeModuleId === productionHarnessEntry,
      );

    if (!isEntrypointChunk(entrypoint)) {
      throw new Error("Vite did not emit the transformed production harness.");
    }
    dom = new JSDOM("<!doctype html><html><body></body></html>", {
      pretendToBeVisual: true,
      url: "http://revelai.test/",
    });
    restoreDomGlobals = installDomGlobals(dom.window);
    await import(
      `${pathToFileURL(resolve(outputDirectory, entrypoint.fileName)).href}?${Date.now()}`
    );
    const mountedHarness = dom.window.__revelaiProductionRouterHarness;
    if (!mountedHarness) {
      throw new Error("The transformed production harness did not mount.");
    }
    harness = mountedHarness;
  });

  beforeEach(() => {
    activeUnmount?.();
    activeUnmount = undefined;
    activeHost = undefined;
    fetchSpy.mockReset();
    vi.stubGlobal("fetch", fetchSpy);
    Reflect.deleteProperty(dom.window, "__revelaiReviewSetupModuleEvaluations");
    Reflect.deleteProperty(
      dom.window,
      "__revelaiReviewCaptureModuleEvaluations",
    );
  });

  afterAll(async () => {
    activeUnmount?.();
    if (activeHost) {
      await waitForHarnessRender(activeHost, () => {
        expect(activeHost).toBeEmptyDOMElement();
      });
    }
    vi.unstubAllGlobals();
    restoreDomGlobals?.();
    dom.window.close();
    if (outputDirectory) {
      await rm(outputDirectory, { force: true, recursive: true });
    }
  });

  it.each(["/_test/verified/setup", "/_test/verified/capture"])(
    "keeps direct production navigation to %s unavailable without review effects",
    async (path) => {
      const setupPort = fakeReviewPort();
      const capturePort = fakeCapturePort();
      const host = await mountAt(path, setupPort, capturePort);

      await waitForUnavailableBoundary(host, setupPort, capturePort);
      expect(fetchSpy).not.toHaveBeenCalled();
    },
  );

  it.each(["/_test/verified/setup", "/_test/verified/capture"])(
    "keeps in-app production navigation to %s unavailable without review effects",
    async (path) => {
      const setupPort = fakeReviewPort();
      const capturePort = fakeCapturePort();
      const host = await mountAt("/", setupPort, capturePort);
      await waitForHomeRoute(host);

      dom.window.history.pushState({}, "", path);
      dom.window.dispatchEvent(new dom.window.PopStateEvent("popstate"));

      await waitForUnavailableBoundary(host, setupPort, capturePort);
      expect(fetchSpy).not.toHaveBeenCalled();
    },
  );
});
