import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, relative, resolve } from "node:path";

const distDirectory = resolve(import.meta.dirname, "../dist");
const port = Number(process.env.PORT ?? "4186");

const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ttf": "font/ttf",
  ".woff2": "font/woff2",
};

const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(
      new URL(request.url ?? "/", `http://${request.headers.host}`).pathname,
    );
    const candidate = resolve(
      distDirectory,
      pathname === "/" ? "index.html" : `.${pathname}`,
    );

    if (relative(distDirectory, candidate).startsWith("..")) {
      response.writeHead(400).end("Invalid path");
      return;
    }

    const file = await stat(candidate);
    if (!file.isFile()) {
      response.writeHead(404).end("Not found");
      return;
    }

    response.writeHead(200, {
      "content-type":
        contentTypes[extname(candidate)] ?? "application/octet-stream",
    });
    response.end(await readFile(candidate));
  } catch {
    response.writeHead(404).end("Not found");
  }
});

server.listen(port, "127.0.0.1");
