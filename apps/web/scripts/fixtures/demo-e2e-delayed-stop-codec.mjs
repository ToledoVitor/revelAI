import { appendFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";

const readyPath = process.env.DEMO_E2E_CODEC_READY_PATH;
const closedPath = process.env.DEMO_E2E_CODEC_CLOSED_PATH;
const fixtureName = basename(process.argv.at(-1) ?? "");
let closing = false;

if (!readyPath || !closedPath || !fixtureName)
  throw new Error("Test codec requires owned lifecycle marker paths.");

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    if (closing) return;
    closing = true;
    setTimeout(async () => {
      await appendFile(closedPath, `${fixtureName}:${Date.now()}\n`);
      process.exit(0);
    }, 300);
  });
}

await appendFile(readyPath, `${fixtureName}:handlers-ready\n`);

setInterval(() => undefined, 1_000);
