import { writeFile } from "node:fs/promises";

const startedPath = process.env.DEMO_E2E_API_STARTED_PATH;
if (!startedPath)
  throw new Error("Test API spy requires a startup marker path.");

await writeFile(startedPath, "started");
setInterval(() => undefined, 1_000);
