import { createServer } from "node:http";

const port = Number(process.env.PORT);
const host = process.env.HOST;
const readyDelayMilliseconds = 1_000;
const server = createServer((request, response) => {
  if (request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"status":"ok"}');
    return;
  }
  response.writeHead(404);
  response.end();
});

server.listen(port, host, () => {
  const ready = setTimeout(() => {
    process.stdout.write(
      "RevelAI local demo check API is listening on its configured local host.\n",
    );
  }, readyDelayMilliseconds);
  ready.unref();
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    server.close(() => process.exit(0));
  });
}
