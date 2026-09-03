import { spawn } from "node:child_process";
import { createServer, request as requestHttp } from "node:http";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createDemoApiEnvironment } from "./demo-e2e-environment.mjs";
import { createDemoMediaFixtures } from "./demo-media-fixtures.mjs";
const webRoot = fileURLToPath(new URL("../", import.meta.url));
const repositoryRoot = resolve(webRoot, "../..");
const apiRoot = resolve(repositoryRoot, "apps/api");
const staticRoot = resolve(webRoot, "dist");
const mediaDirectory = resolve(webRoot, "coverage/demo-media");
const apiPort = 4174;
const webPort = 4175;
const apiOrigin = `http://127.0.0.1:${apiPort}`;
const serveCheck = process.argv.includes("--serve-check");
const apiReadyTimeoutMilliseconds = 60_000;
const apiReadyMessages = new Set([
  "RevelAI local demo is listening on its configured local host.",
  "RevelAI local demo check API is listening on its configured local host.",
]);
// This is kept only for the explicit --serve-check smoke server. Required
// demo-browser acceptance uses the codec-generated C10 fixtures instead.
const c10CheckMedia = Buffer.from([
  0, 0, 0, 16, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 1, 2, 3, 4,
]);
let apiProcess;
let apiReadiness;
let server;
let scratch;
let stopping = false;

try {
  await access(join(staticRoot, "index.html"));
  await mkdir(mediaDirectory, { recursive: true });
  await createMediaFixtures();
  scratch = await mkdtemp(join(tmpdir(), "revelai-web-demo-e2e-"));
  apiProcess = startDemoApi(scratch);
  apiReadiness = observeApiReadiness(apiProcess);
  await waitForApi();
  server = createServer(handleRequest);
  await new Promise((resolveServer, rejectServer) => {
    server.once("error", rejectServer);
    server.listen(webPort, "127.0.0.1", resolveServer);
  });
} catch {
  await stop();
  console.error("RevelAI demo E2E server failed to start.");
  process.exitCode = 1;
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    void stop().finally(() => process.exit(0));
  });
}

function startDemoApi(root) {
  return spawn(
    process.execPath,
    ["scripts/start-local-demo.mjs", ...(serveCheck ? ["--serve-check"] : [])],
    {
      cwd: apiRoot,
      env: createDemoApiEnvironment({
        environment: process.env,
        port: apiPort,
        dataDirectory: join(root, "data"),
        mediaDirectory: join(root, "media"),
      }),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
}

async function createMediaFixtures() {
  if (!serveCheck) {
    await createDemoMediaFixtures({ directory: mediaDirectory });
    return;
  }
  await Promise.all([
    writeFile(join(mediaDirectory, "free-portrait.mp4"), c10CheckMedia),
    writeFile(join(mediaDirectory, "verified-landscape.mp4"), c10CheckMedia),
  ]);
}

async function waitForApi() {
  if (!apiProcess || !apiReadiness)
    throw new Error("The spawned local demo API was not created.");
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    apiReadyTimeoutMilliseconds,
  );
  timeout.unref();
  try {
    await raceOwnedApi(apiReadiness, controller.signal);
    const response = await raceOwnedApi(
      fetch(`${apiOrigin}/health`, { signal: controller.signal }),
      controller.signal,
    );
    if (!response.ok)
      throw new Error(
        `The spawned local demo API health returned ${response.status}.`,
      );
  } catch (error) {
    if (controller.signal.aborted)
      throw new Error("Timed out waiting for the spawned local demo API.");
    throw error;
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
}

function observeApiReadiness(child) {
  return new Promise((resolveReady, rejectReady) => {
    let settled = false;
    let remaining = "";
    const settle = (callback) => {
      if (settled) return;
      settled = true;
      child.off("error", rejectForChildExit);
      child.off("exit", rejectForChildExit);
      callback();
    };
    const rejectForChildExit = () =>
      settle(() =>
        rejectReady(
          new Error("The spawned local demo API exited before readiness."),
        ),
      );
    const receiveStdout = (chunk) => {
      process.stdout.write(chunk);
      const lines = `${remaining}${chunk.toString("utf8")}`.split(/\r?\n/);
      remaining = lines.pop() ?? "";
      if (lines.some((line) => apiReadyMessages.has(line)))
        settle(resolveReady);
    };
    const receiveStderr = (chunk) => process.stderr.write(chunk);

    child.stdout.on("data", receiveStdout);
    child.stderr.on("data", receiveStderr);
    child.once("error", rejectForChildExit);
    child.once("exit", rejectForChildExit);
    if (child.exitCode !== null) rejectForChildExit();
  });
}

function raceOwnedApi(operation, signal) {
  return new Promise((resolveOperation, rejectOperation) => {
    let settled = false;
    const settle = (callback) => {
      if (settled) return;
      settled = true;
      apiProcess?.off("error", rejectForChildExit);
      apiProcess?.off("exit", rejectForChildExit);
      signal.removeEventListener("abort", rejectForTimeout);
      callback();
    };
    const rejectForChildExit = () =>
      settle(() =>
        rejectOperation(
          new Error("The spawned local demo API exited before readiness."),
        ),
      );
    const rejectForTimeout = () =>
      settle(() =>
        rejectOperation(new Error("The local demo API readiness timed out.")),
      );

    if (!apiProcess || apiProcess.exitCode !== null) {
      rejectForChildExit();
      return;
    }
    apiProcess.once("error", rejectForChildExit);
    apiProcess.once("exit", rejectForChildExit);
    signal.addEventListener("abort", rejectForTimeout, { once: true });
    operation.then(
      (value) => settle(() => resolveOperation(value)),
      (error) => settle(() => rejectOperation(error)),
    );
  });
}

function handleRequest(request, response) {
  const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
  if (url.pathname === "/health") {
    response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    response.end("ready");
    return;
  }
  if (url.pathname.startsWith("/v1/") || url.pathname === "/ready") {
    proxyRequest(request, response, url);
    return;
  }
  void serveClient(response, url.pathname);
}

function proxyRequest(request, response, url) {
  const upstream = requestHttp(
    {
      host: "127.0.0.1",
      port: apiPort,
      method: request.method,
      path: `${url.pathname}${url.search}`,
      headers: request.headers,
    },
    (upstreamResponse) => {
      response.writeHead(
        upstreamResponse.statusCode ?? 502,
        upstreamResponse.headers,
      );
      upstreamResponse.pipe(response);
    },
  );
  upstream.once("error", () => {
    if (!response.headersSent) response.writeHead(502);
    response.end();
  });
  request.pipe(upstream);
}

async function serveClient(response, pathname) {
  const candidate = resolve(staticRoot, `.${pathname}`);
  const isStaticAsset =
    candidate === staticRoot || candidate.startsWith(`${staticRoot}${sep}`);
  const path = isStaticAsset ? candidate : join(staticRoot, "index.html");
  const source = extname(path) ? path : join(staticRoot, "index.html");
  try {
    const body = await readFile(source);
    response.writeHead(200, { "content-type": contentType(source) });
    response.end(body);
  } catch {
    const body = await readFile(join(staticRoot, "index.html"));
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(body);
  }
}

function contentType(path) {
  return (
    {
      ".css": "text/css; charset=utf-8",
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".png": "image/png",
      ".svg": "image/svg+xml",
      ".woff": "font/woff",
      ".woff2": "font/woff2",
    }[extname(path)] ?? "application/octet-stream"
  );
}

async function stop() {
  if (stopping) return;
  stopping = true;
  await Promise.all([
    new Promise(
      (resolveServer) => server?.close(resolveServer) ?? resolveServer(),
    ),
    stopProcess(apiProcess),
  ]);
  await rm(mediaDirectory, { recursive: true, force: true });
  if (scratch) await rm(scratch, { recursive: true, force: true });
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null) return;
  await new Promise((resolveChild) => {
    child.once("exit", resolveChild);
    child.kill("SIGTERM");
  });
}
