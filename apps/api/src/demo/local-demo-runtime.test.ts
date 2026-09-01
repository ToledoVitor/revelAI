import { mkdtemp, readdir, rm } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createLocalDemoRuntime,
  runLocalDemoCheckTrace,
} from "../composition/local-demo-runtime.js";
import { openSqliteDatabase } from "../database/sqlite-database.js";
import {
  createConfiguredVisionProvider,
  createHostFrameProcessRunner,
  preflightMediaBinaries,
  type LocalDemoProcessRunner,
} from "./local-demo-support.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("local demo runtime", () => {
  it("runs the complete offline verified check trace to a terminal demo result", async () => {
    const root = await fixtureRoot();
    let processCalls = 0;
    const runtime = await createLocalDemoRuntime({
      check: true,
      environment: demoEnvironment(root, { UNRELATED_SECRET: "not-used" }),
      processRunner: {
        run: async () => {
          processCalls += 1;
          throw new Error("check mode must not invoke a host binary");
        },
      },
    });

    try {
      const terminal = await runLocalDemoCheckTrace(runtime);
      expect(terminal).toMatchObject({
        state: "valid",
        result: {
          kind: "verified-result",
          competitiveStatus: "demo",
          competitiveEligible: false,
        },
      });
      expect(processCalls).toBe(0);
    } finally {
      await runtime.close();
    }
  });

  it("preflights required media binaries before allocating local demo resources", async () => {
    const root = await fixtureRoot();
    const runner: LocalDemoProcessRunner = {
      run: async (command) =>
        command.executable === "ffprobe"
          ? {
              exitCode: 1,
              termination: "completed",
              stdout: "private path",
              stderr: "secret output",
            }
          : {
              exitCode: 0,
              termination: "completed",
              stdout: " ... showinfo V->V\\n ... metadata V->V",
              stderr: "",
            },
    };

    await expect(
      createLocalDemoRuntime({
        check: false,
        environment: demoEnvironment(root),
        processRunner: runner,
      }),
    ).rejects.toThrow("FFmpeg and FFprobe capabilities");
    await expect(rm(join(root, "data"), { recursive: true })).rejects.toThrow();
    await expect(
      rm(join(root, "media"), { recursive: true }),
    ).rejects.toThrow();
  });

  it("selects the configured provider without calling the network during construction", () => {
    let calls = 0;
    const provider = createConfiguredVisionProvider(
      {
        kind: "roboflow",
        apiUrl: "https://inference.example.test",
        workspaceId: "workspace",
        workflowVersion: "1.0.0",
        wallPass: {
          workflowId: "revelai-wall-pass-geometry-v1",
          modelBundleId: "wall-pass-bundle-v1",
        },
        freeTraining: {
          workflowId: "revelai-free-training-v1",
          modelBundleId: "free-training-bundle-v1",
        },
      },
      async () => {
        calls += 1;
        throw new Error("provider construction must not fetch");
      },
    );

    expect(provider.freeProvenance.kind).toBe("roboflow");
    expect(provider.verifiedProvenance.kind).toBe("roboflow");
    expect(calls).toBe(0);
  });

  it("preflights the exact FFmpeg and FFprobe capabilities without leaking process output", async () => {
    const calls: string[] = [];
    await preflightMediaBinaries({
      run: async (command) => {
        calls.push(`${command.executable} ${command.arguments.join(" ")}`);
        return {
          exitCode: 0,
          termination: "completed" as const,
          stdout: command.arguments.includes("-filters")
            ? " ... showinfo V->V\n ... metadata V->V"
            : command.arguments.includes("-encoders")
              ? " V..... mjpeg MJPEG (Motion JPEG)"
              : "",
          stderr: "",
        };
      },
    });

    expect(calls).toEqual([
      "ffprobe -version",
      "ffmpeg -version",
      "ffmpeg -hide_banner -filters",
      "ffmpeg -hide_banner -encoders",
    ]);
  });

  it.each([
    [
      "near-match filters",
      " ... ashowinfo A->A\n ... ametadata V->V",
      " V..... mjpeg MJPEG (Motion JPEG)",
    ],
    [
      "near-match encoder",
      " ... showinfo V->V\n ... metadata V->V",
      " V..... mjpeg_qsv MJPEG (Quick Sync Video acceleration)",
    ],
  ])(
    "rejects %s rather than accepting a substring",
    async (_label, filters, encoders) => {
      await expect(
        preflightMediaBinaries({
          run: async (command) => ({
            exitCode: 0,
            termination: "completed" as const,
            stdout: command.arguments.includes("-filters")
              ? filters
              : command.arguments.includes("-encoders")
                ? encoders
                : "",
            stderr: "",
          }),
        }),
      ).rejects.toThrow("FFmpeg and FFprobe capabilities");
    },
  );

  it.each(["timed_out", "terminated"] as const)(
    "rejects a zero-exit %s media command",
    async (termination) => {
      await expect(
        preflightMediaBinaries({
          run: async (command) => ({
            exitCode: 0,
            termination,
            stdout: command.arguments.includes("-filters")
              ? " ... showinfo V->V\n ... metadata V->V"
              : command.arguments.includes("-encoders")
                ? " V..... mjpeg MJPEG (Motion JPEG)"
                : "",
            stderr: "",
          }),
        }),
      ).rejects.toThrow("FFmpeg and FFprobe capabilities");
    },
  );

  it.each(["timed_out", "terminated"] as const)(
    "keeps a zero-exit %s host frame-process result visible to C5",
    async (termination) => {
      const runner = createHostFrameProcessRunner({
        run: async () => ({
          exitCode: 0,
          termination,
          stdout: "safe stdout",
          stderr: "safe stderr",
        }),
      });

      await expect(
        runner.run({
          executable: "ffmpeg",
          arguments: [],
          inputPath: "/private/input.mp4",
          outputDirectory: "/private/frames",
          timeoutMilliseconds: 1,
          terminationGraceMilliseconds: 1,
          maxStdoutBytes: 1,
          maxStderrBytes: 1,
          maxOutputBytes: 2,
          evidenceFormat: "ffmpeg-showinfo-metadata-v1",
        }),
      ).resolves.toMatchObject({ exitCode: 0, termination });
    },
  );

  it("closes both app-owned workers before queue and database resources", async () => {
    vi.useFakeTimers();
    const root = await fixtureRoot();
    const timersBeforeRuntime = vi.getTimerCount();
    try {
      const runtime = await createLocalDemoRuntime({
        check: true,
        environment: demoEnvironment(root),
        processRunner: unusedProcessRunner,
      });
      expect(vi.getTimerCount()).toBeGreaterThan(timersBeforeRuntime);

      await runtime.close();

      await expect(runtime.queue.isAvailable()).resolves.toBe(false);
      expect(() => runtime.database.raw.prepare("SELECT 1")).toThrow();
      expect(vi.getTimerCount()).toBe(timersBeforeRuntime);
    } finally {
      vi.useRealTimers();
    }
  });

  it("settles a gated upload and leaves no post-close media writes after an injected pending-route failure", async () => {
    const root = await fixtureRoot();
    const runtime = await createLocalDemoRuntime({
      check: true,
      environment: demoEnvironment(root),
      processRunner: unusedProcessRunner,
    });
    let faultPendingRoute = false;
    runtime.app.addHook("onRequest", async (request) => {
      if (faultPendingRoute && request.url.endsWith("/result"))
        throw new Error("injected pending-route failure");
    });

    const upload = await startGatedVerifiedUpload(runtime);
    faultPendingRoute = true;
    const pending = await runtime.app.inject({
      method: "GET",
      url: `/v1/attempts/${upload.attemptId}/result`,
      headers: upload.athleteHeaders,
    });
    expect(pending.statusCode).toBeGreaterThanOrEqual(500);

    await expect(settleWithin(runtime.close())).resolves.toBeUndefined();
    await expect(settleWithin(upload.response)).resolves.toBeDefined();
    await expect(runtime.queue.isAvailable()).resolves.toBe(false);

    const database = openSqliteDatabase(join(root, "data", "revelai.sqlite"));
    try {
      expect(
        database.raw
          .prepare("SELECT media_json FROM attempts WHERE id = ?")
          .get(upload.attemptId),
      ).toEqual({ media_json: null });
    } finally {
      database.close();
    }

    const afterClose = await mediaFiles(root);
    runtime.releaseCheckFrameProcess();
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    expect(await mediaFiles(root)).toEqual(afterClose);
  });
});

const unusedProcessRunner: LocalDemoProcessRunner = {
  run: async () => {
    throw new Error("check mode must not use a real process runner");
  },
};

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "revelai-local-demo-runtime-"));
  directories.push(root);
  return root;
}

function demoEnvironment(
  root: string,
  overrides: Readonly<Record<string, string>> = {},
) {
  return {
    DATA_DIR: join(root, "data"),
    MEDIA_DIR: join(root, "media"),
    ...overrides,
  };
}

async function startGatedVerifiedUpload(
  runtime: Awaited<ReturnType<typeof createLocalDemoRuntime>>,
): Promise<
  Readonly<{
    athleteHeaders: Readonly<{ "x-revelai-athlete-id": string }>;
    attemptId: string;
    response: Promise<unknown>;
  }>
> {
  const athleteHeaders = { "x-revelai-athlete-id": crypto.randomUUID() };
  const calibration = await runtime.app.inject({
    method: "POST",
    url: "/v1/calibration-sessions",
    headers: athleteHeaders,
    payload: { challengeId: "wall-pass", challengeVersion: 1 },
  });
  expect(calibration.statusCode).toBe(201);
  const calibrationId = (calibration.json() as { id: string }).id;
  const ready = await runtime.app.inject({
    method: "POST",
    url: `/v1/calibration-sessions/${calibrationId}/ready`,
    headers: athleteHeaders,
    payload: {
      requiredGates: ["device", "space", "athlete", "rehearsal", "record"],
    },
  });
  expect(ready.statusCode).toBe(204);
  const created = await runtime.app.inject({
    method: "POST",
    url: "/v1/attempts",
    headers: athleteHeaders,
    payload: {
      mode: "verified",
      challengeId: "wall-pass",
      challengeVersion: 1,
      calibrationSessionId: calibrationId,
    },
  });
  expect(created.statusCode).toBe(201);
  const attemptId = (created.json() as { id: string }).id;
  const boundary = "revelai-close-gate";
  const response = runtime.app.inject({
    method: "POST",
    url: `/v1/attempts/${attemptId}/media`,
    headers: {
      ...athleteHeaders,
      "content-type": `multipart/form-data; boundary=${boundary}`,
    },
    payload: multipartFixture(boundary),
  });
  await runtime.waitForCheckFrameProcess();
  return Object.freeze({ athleteHeaders, attemptId, response });
}

async function settleWithin<T>(operation: Promise<T>): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Local demo close did not settle in time.")),
          1_000,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function mediaFiles(root: string): Promise<readonly string[]> {
  const mediaRoot = join(root, "media");
  const visit = async (
    directory: string,
    relative: string,
  ): Promise<string[]> => {
    let entries: Dirent[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return [];
    }
    const files = await Promise.all(
      entries.map(async (entry) => {
        const childRelative = join(relative, entry.name);
        if (entry.isDirectory())
          return visit(join(directory, entry.name), childRelative);
        return [childRelative];
      }),
    );
    return files.flat();
  };
  return visit(mediaRoot, "");
}

function multipartFixture(boundary: string): Buffer {
  return Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="media"; filename="demo.mp4"\r\nContent-Type: video/mp4\r\n\r\n`,
    ),
    Buffer.from([
      0, 0, 0, 16, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 1, 2, 3, 4,
    ]),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
}
