import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLocalDemoProcessRunner } from "./local-demo-process-runner.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("local demo process runner", () => {
  it("caps an FFprobe-shaped command at its aggregate limit through termination grace", async () => {
    const executable = await oversizedFfprobe();
    const runner = createLocalDemoProcessRunner({
      terminationGraceMilliseconds: 25,
    });

    const result = await settleWithin(
      runner.run({
        executable,
        arguments: [
          "-v",
          "error",
          "-print_format",
          "json",
          "-show_format",
          "-show_streams",
          "/private/video.mp4",
        ],
        timeoutMilliseconds: 1_000,
        maxStdoutBytes: 65_536,
        maxStderrBytes: 65_536,
        maxOutputBytes: 1_024,
      }),
    );

    expect(result.termination).toBe("terminated");
    expect(Buffer.byteLength(result.stdout, "utf8")).toBeGreaterThan(0);
    expect(
      Buffer.byteLength(result.stdout, "utf8") +
        Buffer.byteLength(result.stderr, "utf8"),
    ).toBeLessThanOrEqual(1_024);
  });
});

async function oversizedFfprobe(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "revelai-ffprobe-runner-"));
  directories.push(directory);
  const executable = join(directory, "ffprobe");
  await writeFile(
    executable,
    [
      "#!/usr/bin/env node",
      "const spam = () => { process.stdout.write('o'.repeat(65536)); process.stderr.write('e'.repeat(65536)); };",
      "process.on('SIGTERM', spam);",
      "spam();",
      "setInterval(() => {}, 1000);",
    ].join("\n"),
    { mode: 0o700 },
  );
  await chmod(executable, 0o700);
  return executable;
}

async function settleWithin<T>(operation: Promise<T>): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Local demo process did not settle in time.")),
          1_000,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
