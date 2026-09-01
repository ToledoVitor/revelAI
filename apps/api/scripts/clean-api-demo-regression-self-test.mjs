import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(
  new URL("./clean-api-demo-regression.mjs", import.meta.url),
);
const MAX_OUTPUT_BYTES = 32 * 1024;
const MODE_TIMEOUT_MS = 120_000;
const TERMINATION_GRACE_MS = 250;

await expectMode(
  "--self-test",
  "Clean API executable process guard regression passed.",
);
await expectMode(
  "--mutation-proof",
  "Clean API executable independent mutation regression passed.",
);

console.log("Clean API executable self-tests passed.");

async function expectMode(mode, successMessage) {
  const result = await run(mode);
  if (result.exitCode !== 0 || !result.output.includes(successMessage)) {
    throw new Error("Clean API executable self-test failed.");
  }
}

function run(mode) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let output = Buffer.alloc(0);
    const child = spawn(process.execPath, [script, mode], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), TERMINATION_GRACE_MS).unref();
    }, MODE_TIMEOUT_MS);

    const settle = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(value);
    };

    const append = (chunk) => {
      const remaining = MAX_OUTPUT_BYTES - output.length;
      if (remaining <= 0) return;
      output = Buffer.concat([
        output,
        Buffer.from(chunk).subarray(0, remaining),
      ]);
    };

    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.once("error", () =>
      reject(new Error("Clean API executable self-test failed.")),
    );
    child.once("close", (exitCode) => {
      settle({ exitCode, output: output.toString("utf8") });
    });
  });
}
