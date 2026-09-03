import { appendFile, writeFile } from "node:fs/promises";

const readyPath = process.env.DEMO_E2E_CODEC_READY_PATH;
const closedPath = process.env.DEMO_E2E_CODEC_CLOSED_PATH;
let closing = false;

if (!readyPath || !closedPath)
  throw new Error("Test codec requires owned lifecycle marker paths.");

await appendFile(readyPath, "started\n");

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    if (closing) return;
    closing = true;
    setTimeout(async () => {
      await appendFile(closedPath, `${Date.now()}\n`);
      process.exit(0);
    }, 300);
  });
}

setInterval(() => undefined, 1_000);
