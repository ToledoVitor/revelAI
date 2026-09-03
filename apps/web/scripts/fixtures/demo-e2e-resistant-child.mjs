import { createServer } from "node:http";

const port = Number(process.env.PORT);
const server = createServer((request, response) => {
  if (request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"status":"ok"}');
    return;
  }
  response.writeHead(404);
  response.end();
});

process.on("SIGTERM", () => undefined);
server.listen(port, "127.0.0.1", () => {
  console.log(
    "RevelAI local demo check API is listening on its configured local host.",
  );
});
