import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createLocalDemoRuntime,
  runLocalDemoCheckTrace,
} from "./local-demo-runtime.js";
import {
  createConfiguredVisionProvider,
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
          ? { exitCode: 1, stdout: "private path", stderr: "secret output" }
          : { exitCode: 0, stdout: "showinfo metadata", stderr: "" },
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
          stdout: command.arguments.includes("-filters")
            ? "showinfo metadata"
            : command.arguments.includes("-encoders")
              ? "mjpeg"
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

  it("closes both app-owned workers before queue and database resources", async () => {
    const root = await fixtureRoot();
    const runtime = await createLocalDemoRuntime({
      check: true,
      environment: demoEnvironment(root),
      processRunner: unusedProcessRunner,
    });

    await runtime.close();

    await expect(runtime.queue.isAvailable()).resolves.toBe(false);
    expect(() => runtime.database.raw.prepare("SELECT 1")).toThrow();
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
