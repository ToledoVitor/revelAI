import {
  chmod,
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, type Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type MediaProbe } from "../media/probe.js";
import { verifiedExtractionCapability } from "../media/extraction-manifest.js";
import { createLocalFrameExtraction } from "./local-frame-extraction.js";

const attemptId = "11111111-1111-4111-8111-111111111111";
const mediaId = "22222222-2222-4222-8222-222222222222";
const batchId = "33333333-3333-4333-8333-333333333333";
const stagedSourceSha256 = createHash("sha256")
  .update(Uint8Array.of(1, 2, 3))
  .digest("hex");
const frameAuthority = {
  athleteId: "44444444-4444-4444-8444-444444444444",
  calibrationSessionId: null,
  calibrationNonce: null,
};
const verifiedFrameAuthority = {
  athleteId: "44444444-4444-4444-8444-444444444444",
  calibrationSessionId: "55555555-5555-4555-8555-555555555555",
  calibrationNonce: "test-calibration-nonce",
};
const verifiedProbe: MediaProbe = {
  container: "mp4",
  durationSeconds: 64,
  displayWidth: 1280,
  displayHeight: 720,
  nominalFps: 30,
  codec: "h264",
  sourceRotationDegrees: 90,
};
// Match the production runner's bounded TERM-to-KILL grace; cleanup awaits close.
const testProcessTerminationGraceMilliseconds = 1_000;
// C5's default process budget. The inner deadline drains tracked children
// before the finite Vitest backstop can hand control to teardown.
const portableFfmpegProcessDeadlineMilliseconds = 30_000;
const portableFfmpegIntegrationTimeoutMilliseconds =
  portableFfmpegProcessDeadlineMilliseconds +
  testProcessTerminationGraceMilliseconds * 2;

type TrackedProcess = Readonly<{
  terminate: () => Promise<void>;
}>;

type ProcessTracker = Readonly<{
  tryReserve: () => ProcessReservation | undefined;
  release: (process: TrackedProcess) => void;
  closeAndDrain: () => Promise<void>;
  size: () => number;
}>;

type ProcessReservation = Readonly<{
  activate: (process: TrackedProcess) => void;
  cancel: () => void;
}>;

type TestBody = Readonly<{
  settled: Promise<void>;
}>;

type Deferred<T> = Readonly<{
  promise: Promise<T>;
  resolve: (value: T) => void;
}>;

type ProcessResult = Readonly<{
  exitCode: number;
  stdout: string;
  stderr: string;
}>;

type ProcessChild = {
  stdout: Pick<Readable, "on">;
  stderr: Pick<Readable, "on">;
  kill: (signal: NodeJS.Signals) => boolean;
  on(event: "error", listener: (error: Error) => void): unknown;
  once(event: "close", listener: (exitCode: number | null) => void): unknown;
};

type ProcessSpawner = (
  executable: string,
  arguments_: readonly string[],
) => ProcessChild;

describe("LocalFrameExtraction", () => {
  const roots: string[] = [];
  let testGenerationTracker = createProcessTracker();
  let smokeTestBody: TestBody | undefined;
  beforeEach(() => {
    testGenerationTracker = createProcessTracker();
    smokeTestBody = undefined;
  });
  afterEach(async () => {
    await cleanupTrackedTestRoots(testGenerationTracker, smokeTestBody, roots);
  });

  it("uses process-parsed decoded timestamps and scene records before publishing an opaque readable set", async () => {
    const root = await setupRoot(roots);
    const calls: unknown[] = [];
    const extractor = createLocalFrameExtraction({
      root,
      ids: { next: () => batchId },
      runner: {
        run: async (command) => {
          calls.push(command);
          await writeDecoded(command.outputDirectory, verifiedTimeline());
          return completedEvidence(verifiedTimeline(), verifiedScenes());
        },
      },
      retention: { schedule: async () => ({ kind: "created" as const }) },
    });
    const manifest = await extractor.extract({
      mode: "verified",
      attemptId,
      generation: 1,
      mediaId,
      mediaSha256: stagedSourceSha256,
      probe: verifiedProbe,
      uploadedAt: "2030-01-15T12:00:00.000Z",
      source: "staged",
      authority: verifiedFrameAuthority,
    });
    expect(manifest.frames.items[1]?.timestampSeconds).toBeCloseTo(0.1, 4);
    expect(manifest).toMatchObject({
      preRoll: { count: 40 },
      active: { count: 600 },
    });
    if (manifest.mode !== "verified") throw new Error("wrong fixture mode");
    expect(() => verifiedExtractionCapability(manifest)).not.toThrow();
    await expect(
      extractor.readFrame(manifest.frames.items[0]!.reference),
    ).resolves.toEqual(jpeg(0));
    expect(JSON.stringify(calls)).toContain("showinfo");
    expect(JSON.stringify(calls)).toContain("scene");
  });

  it("materializes zero-based image2 output and retains a bounded complete Verified showinfo stream", async () => {
    const root = await setupRoot(roots);
    const extractor = createLocalFrameExtraction({
      root,
      ids: { next: () => batchId },
      runner: {
        run: async (command) => {
          expect(command.arguments).toContain("-start_number");
          expect(command.arguments).toContain("0");
          expect(command.maxStderrBytes).toBe(640 * 512 + 16 * 1024);
          await writeDecodedFromCommand(command, verifiedTimeline());
          return completedEvidence(
            verifiedTimeline(),
            verifiedScenes(),
            " side_data: ".concat("x".repeat(360)),
          );
        },
      },
      retention: { schedule: async () => ({ kind: "created" as const }) },
    });

    await expect(
      extractor.extract({
        mode: "verified",
        attemptId,
        generation: 1,
        mediaId,
        mediaSha256: stagedSourceSha256,
        probe: verifiedProbe,
        uploadedAt: "2030-01-15T12:00:00.000Z",
        source: "staged",
        authority: verifiedFrameAuthority,
      }),
    ).resolves.toMatchObject({
      frames: { count: 640 },
      preRoll: { count: 40 },
      active: { count: 600 },
    });
  });

  it("owns a comment-free baseline JPEG FFmpeg output contract", async () => {
    const root = await setupRoot(roots);
    let command:
      | Readonly<{
          arguments: readonly string[];
          outputDirectory: string;
        }>
      | undefined;
    const extractor = createLocalFrameExtraction({
      root,
      ids: { next: () => batchId },
      runner: {
        run: async (received) => {
          command = received;
          const timeline = Array.from({ length: 37 }, (_, index) => index / 12);
          await writeDecoded(received.outputDirectory, timeline);
          return completedEvidence(timeline, []);
        },
      },
      retention: { schedule: async () => ({ kind: "created" as const }) },
    });

    await expect(
      extractor.extract({
        mode: "free",
        attemptId,
        generation: 1,
        mediaId,
        mediaSha256: stagedSourceSha256,
        probe: { ...verifiedProbe, durationSeconds: 3 },
        uploadedAt: "2030-01-15T12:00:00.000Z",
        source: "staged",
        authority: frameAuthority,
      }),
    ).resolves.toMatchObject({ frames: { count: 12 } });

    expect(command).toBeDefined();
    const outputPattern = join(command!.outputDirectory, "decoded-%06d.jpg");
    const outputPatternIndex = command!.arguments.indexOf(outputPattern);
    expect(outputPatternIndex).toBeGreaterThan(0);
    expect(
      command!.arguments.slice(outputPatternIndex - 5, outputPatternIndex),
    ).toEqual(["-c:v", "mjpeg", "-pix_fmt", "yuvj420p", "-bitexact"]);
  });

  it("does not treat an inventory-only executable as a portable extraction capability", async () => {
    const root = await setupRoot(roots);
    const executable = join(root, "inventory-only-ffmpeg");
    await writeFile(
      executable,
      [
        `#!${process.execPath}`,
        "const arguments_ = process.argv.slice(2);",
        'if (arguments_.includes("-version")) process.exit(0);',
        'if (arguments_.includes("-filters")) {',
        '  process.stdout.write("... fps\\n... metadata\\n... select\\n... showinfo\\n... split\\n");',
        "  process.exit(0);",
        "}",
        'if (arguments_.includes("-encoders")) {',
        '  process.stdout.write("V..... mjpeg\\nV..... mpeg4\\n");',
        "  process.exit(0);",
        "}",
        "process.exitCode = 1;",
      ].join("\n"),
      { mode: 0o700 },
    );
    await chmod(executable, 0o700);

    await expect(
      ffmpegHasPortableExtractionCapability(executable),
    ).resolves.toBe(false);
  });

  it("waits for a tracked subprocess before removing its owned root", async () => {
    const root = await setupRoot(roots);
    const tracker = createProcessTracker();
    const completed = runProcess(
      process.execPath,
      ["-e", "setTimeout(() => process.exit(0), 1_000)"],
      tracker,
    );

    expect(tracker.size()).toBe(1);
    await tracker.closeAndDrain();
    expect(tracker.size()).toBe(0);
    await expect(completed).resolves.toMatchObject({ exitCode: 1 });
    await expect(
      rm(root, { recursive: true, force: true }),
    ).resolves.toBeUndefined();
  });

  it("does not release a tracked child when termination reports an error before close", async () => {
    const root = await setupRoot(roots);
    const tracker = createProcessTracker();
    const child = new ControlledChildProcess();
    child.errorSignals.add("SIGTERM");
    const completed = runProcess("controlled-child", [], tracker, () => child);
    const rejected = expect(completed).rejects.toThrow(
      "simulated SIGTERM error",
    );

    const draining = tracker.closeAndDrain();
    expect(tracker.size()).toBe(1);
    expect(child.receivedSignals).toEqual(["SIGTERM"]);
    child.emitClose(1);

    await draining;
    await rejected;
    expect(tracker.size()).toBe(0);
    await expect(
      rm(root, { recursive: true, force: true }),
    ).resolves.toBeUndefined();
  });

  it("keeps handling termination errors until close", async () => {
    const root = await setupRoot(roots);
    const tracker = createProcessTracker();
    const child = new ControlledChildProcess();
    child.errorSignals.add("SIGTERM");
    child.errorSignals.add("SIGKILL");
    const completed = runProcess(
      "controlled-child",
      [],
      tracker,
      () => child,
      1,
    );
    const rejected = expect(completed).rejects.toThrow(
      "simulated SIGTERM error",
    );

    const draining = tracker.closeAndDrain();
    await child.waitForSignal("SIGKILL");
    expect(child.receivedSignals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(tracker.size()).toBe(1);
    child.emitClose(1);

    await draining;
    await rejected;
    expect(tracker.size()).toBe(0);
    await expect(
      rm(root, { recursive: true, force: true }),
    ).resolves.toBeUndefined();
  });

  it("drains a deadline-expired smoke child before root cleanup", async () => {
    const root = await setupRoot(roots);
    const tracker = createProcessTracker();
    const child = new ControlledChildProcess();
    const deadline = runWithinTrackedProcessDeadline(
      () => runProcess("controlled-child", [], tracker, () => child),
      tracker,
      1,
    );

    await child.waitForSignal("SIGTERM");
    expect(child.receivedSignals).toEqual(["SIGTERM"]);
    expect(tracker.size()).toBe(1);
    const removal = deadline
      .catch((error: unknown) => {
        expect(error).toMatchObject({
          message: "portable FFmpeg smoke exceeded the owned process deadline",
        });
      })
      .then(async () => {
        expect(tracker.size()).toBe(0);
        await rm(root, { recursive: true, force: true });
      });

    child.emitClose(1);
    await removal;
  });

  it("reports a deadline instead of a pending capability rejection after termination", async () => {
    const tracker = createProcessTracker();
    const child = new ControlledChildProcess();
    const deadline = runWithinTrackedProcessDeadline(
      async () => {
        const capability = await (async () => {
          const completed = runProcess(
            "controlled-child",
            [],
            tracker,
            () => child,
          );
          await child.waitForSignal("SIGTERM");
          child.emitClose(1);
          await completed;
          return false;
        })();
        if (!capability)
          throw Object.assign(new Error("capability probe skipped"), {
            code: "VITEST_PENDING",
            name: "PendingError",
          });
      },
      tracker,
      1,
    );

    await expect(deadline).rejects.toThrow(
      "portable FFmpeg smoke exceeded the owned process deadline",
    );
  });

  it("preserves a smoke root when its body exceeds teardown grace", async () => {
    const root = await setupRoot();
    const tracker = createProcessTracker();
    const bodyCompletion = createDeferred<void>();
    const body: TestBody = Object.freeze({
      settled: bodyCompletion.promise,
    });

    await expect(
      cleanupTrackedTestRoots(tracker, body, [root]),
    ).rejects.toThrow(
      "smoke test body exceeded teardown grace; roots preserved",
    );
    await expect(
      readFile(join(root, "temporary", `${mediaId}.uploading`)),
    ).resolves.toEqual(Buffer.from([1, 2, 3]));

    bodyCompletion.resolve();
    await rm(root, { recursive: true, force: true });
  });

  it("does not spawn a continuation successor while its test generation is closing", async () => {
    const root = await setupRoot(roots);
    const tracker = createProcessTracker();
    const first = new ControlledChildProcess();
    const second = new ControlledChildProcess();
    const firstCompleted = runProcess("first-child", [], tracker, () => first);
    let resolveSecondRegistered: () => void;
    const secondRegistered = new Promise<void>((resolve) => {
      resolveSecondRegistered = resolve;
    });
    let secondSpawns = 0;
    const secondCompleted = firstCompleted.then(() => {
      const completed = runProcess("second-child", [], tracker, () => {
        secondSpawns += 1;
        return second;
      });
      resolveSecondRegistered();
      return completed;
    });
    const rejected = expect(secondCompleted).rejects.toThrow(
      "test process tracker is closed",
    );
    const draining = tracker.closeAndDrain();

    first.emitClose(0);
    await secondRegistered;

    await draining;
    await rejected;
    expect(secondSpawns).toBe(0);
    expect(tracker.size()).toBe(0);
    await expect(
      rm(root, { recursive: true, force: true }),
    ).resolves.toBeUndefined();
  });

  it("does not spawn a successor after its test generation has drained", async () => {
    const root = await setupRoot(roots);
    const tracker = createProcessTracker();
    const first = new ControlledChildProcess();
    const firstCompleted = runProcess("first-child", [], tracker, () => first);

    const draining = tracker.closeAndDrain();
    first.emitClose(0);
    await draining;
    await Promise.resolve();

    const successor = new ControlledChildProcess();
    let successorSpawns = 0;
    const lateResult = runProcess("late-child", [], tracker, () => {
      successorSpawns += 1;
      return successor;
    });
    successor.emitClose(1);

    expect(successorSpawns).toBe(0);
    await expect(lateResult).rejects.toThrow("test process tracker is closed");
    await expect(firstCompleted).resolves.toMatchObject({ exitCode: 0 });
    await expect(
      rm(root, { recursive: true, force: true }),
    ).resolves.toBeUndefined();
  });

  it("rejects a claimed source digest before it can issue a durable receipt", async () => {
    const root = await setupRoot(roots);
    const extractor = createLocalFrameExtraction({
      root,
      ids: { next: () => batchId },
      runner: {
        run: async () => {
          throw new Error("source digest must be checked before extraction");
        },
      },
      retention: { schedule: async () => ({ kind: "created" as const }) },
    });

    await expect(
      extractor.extract({
        mode: "free",
        attemptId,
        generation: 1,
        mediaId,
        mediaSha256: "a".repeat(64),
        probe: { ...verifiedProbe, durationSeconds: 3 },
        uploadedAt: "2030-01-15T12:00:00.000Z",
        source: "staged",
        authority: frameAuthority,
      }),
    ).rejects.toThrow("media_probe_failed");
  });

  it("rejects marker-only JPEG output before exposing a frame reference", async () => {
    const root = await setupRoot(roots);
    const extractor = createLocalFrameExtraction({
      root,
      ids: { next: () => batchId },
      runner: {
        run: async (command) => {
          const timeline = Array.from({ length: 37 }, (_, index) => index / 12);
          await writeDecoded(
            command.outputDirectory,
            timeline,
            markerOnlyJpeg(),
          );
          return completedEvidence(timeline, []);
        },
      },
      retention: { schedule: async () => ({ kind: "created" as const }) },
    });

    await expect(
      extractor.extract({
        mode: "free",
        attemptId,
        generation: 1,
        mediaId,
        mediaSha256: stagedSourceSha256,
        probe: { ...verifiedProbe, durationSeconds: 3 },
        uploadedAt: "2030-01-15T12:00:00.000Z",
        source: "staged",
        authority: verifiedFrameAuthority,
      }),
    ).rejects.toThrow("media_probe_failed");
  });

  it("rejects semantically invalid baseline JPEGs through extraction before publication", async () => {
    const timeline = Array.from({ length: 37 }, (_, index) => index / 12);
    for (const kind of [
      "dqt",
      "dqt-zero",
      "dht",
      "dht-symbol",
      "dht-oversubscribed",
      "sof",
      "sof-precision",
      "sof-progressive",
      "sos",
      "sos-baseline",
      "unsupported-dac",
      "unsupported-dnl",
      "unsupported-sof2",
      "restart-without-dri",
      "bad-stuffing",
      "sampling-aggregate",
      "truncated",
    ] as const) {
      const root = await setupRoot(roots);
      const extractor = createLocalFrameExtraction({
        root,
        ids: { next: () => batchId },
        runner: {
          run: async (command) => {
            await writeDecoded(
              command.outputDirectory,
              timeline,
              malformedJpeg(kind),
            );
            return completedEvidence(timeline, []);
          },
        },
        retention: { schedule: async () => ({ kind: "created" as const }) },
      });
      await expect(
        extractor.extract({
          mode: "free",
          attemptId,
          generation: 1,
          mediaId,
          mediaSha256: stagedSourceSha256,
          probe: { ...verifiedProbe, durationSeconds: 3 },
          uploadedAt: "2030-01-15T12:00:00.000Z",
          source: "staged",
          authority: frameAuthority,
        }),
      ).rejects.toThrow("media_probe_failed");
      await expect(
        readFile(join(root, "frames", batchId, ".complete")),
      ).rejects.toThrow();
    }
  });

  it("makes opaque reads re-validate structural JPEG evidence", async () => {
    const root = await setupRoot(roots);
    const timeline = Array.from({ length: 37 }, (_, index) => index / 12);
    const extractor = createLocalFrameExtraction({
      root,
      ids: { next: () => batchId },
      runner: {
        run: async (command) => {
          await writeDecoded(command.outputDirectory, timeline);
          return completedEvidence(timeline, []);
        },
      },
      retention: { schedule: async () => ({ kind: "created" as const }) },
    });
    const manifest = await extractor.extract({
      mode: "free",
      attemptId,
      generation: 1,
      mediaId,
      mediaSha256: stagedSourceSha256,
      probe: { ...verifiedProbe, durationSeconds: 3 },
      uploadedAt: "2030-01-15T12:00:00.000Z",
      source: "staged",
      authority: frameAuthority,
    });
    await writeFile(
      join(root, "frames", batchId, "frame-0000.jpg"),
      malformedJpeg("sos"),
      { mode: 0o600 },
    );
    await expect(
      extractor.readFrame(manifest.frames.items[0]!.reference),
    ).rejects.toThrow("media_probe_failed");
  });

  it("re-validates semantic baseline JPEG failures through opaque frame reads", async () => {
    const root = await setupRoot(roots);
    const timeline = Array.from({ length: 37 }, (_, index) => index / 12);
    const extractor = createLocalFrameExtraction({
      root,
      ids: { next: () => batchId },
      runner: {
        run: async (command) => {
          await writeDecoded(command.outputDirectory, timeline);
          return completedEvidence(timeline, []);
        },
      },
      retention: { schedule: async () => ({ kind: "created" as const }) },
    });
    const manifest = await extractor.extract({
      mode: "free",
      attemptId,
      generation: 1,
      mediaId,
      mediaSha256: stagedSourceSha256,
      probe: { ...verifiedProbe, durationSeconds: 3 },
      uploadedAt: "2030-01-15T12:00:00.000Z",
      source: "staged",
      authority: frameAuthority,
    });

    for (const kind of [
      "dqt-zero",
      "dht-symbol",
      "dht-oversubscribed",
      "sof-precision",
      "sof-progressive",
      "sos-baseline",
      "unsupported-dac",
      "unsupported-dnl",
      "unsupported-sof2",
      "restart-without-dri",
      "bad-stuffing",
      "sampling-aggregate",
    ] as const) {
      await writeFile(
        join(root, "frames", batchId, "frame-0000.jpg"),
        malformedJpeg(kind),
        { mode: 0o600 },
      );
      await expect(
        extractor.readFrame(manifest.frames.items[0]!.reference),
      ).rejects.toThrow("media_probe_failed");
    }
  });

  it("selects cardinality-exact Free samples from real 12/24/30fps decoded timelines", async () => {
    for (const fps of [12, 24, 30]) {
      const root = await setupRoot(roots);
      const decoded = Array.from(
        { length: fps * 3 + 1 },
        (_, index) => index / fps,
      );
      const extractor = createLocalFrameExtraction({
        root,
        ids: { next: () => batchId },
        runner: {
          run: async (command) => {
            await writeDecoded(command.outputDirectory, decoded);
            return completedEvidence(decoded, []);
          },
        },
        retention: { schedule: async () => ({ kind: "created" as const }) },
      });
      const manifest = await extractor.extract({
        mode: "free",
        attemptId,
        generation: 1,
        mediaId,
        mediaSha256: stagedSourceSha256,
        probe: { ...verifiedProbe, durationSeconds: 3 },
        uploadedAt: "2030-01-15T12:00:00.000Z",
        source: "staged",
        authority: frameAuthority,
      });
      expect(manifest.frames.count).toBe(12);
      expect(manifest.frames.items[0]?.timestampSeconds).toBe(0);
      expect(manifest.frames.items.at(-1)?.timestampSeconds).toBe(3);
    }
  });

  it("rejects missing, discontinuous, or oversized process evidence before any frame set is visible", async () => {
    const root = await setupRoot(roots);
    const extractor = createLocalFrameExtraction({
      root,
      ids: { next: () => batchId },
      runner: {
        run: async (command) => {
          await writeDecoded(command.outputDirectory, verifiedTimeline());
          return completedEvidence(
            verifiedTimeline().map((value, index) =>
              index === 41 ? value + 1 : value,
            ),
            verifiedScenes(),
          );
        },
      },
      retention: { schedule: async () => ({ kind: "created" as const }) },
    });
    await expect(
      extractor.extract({
        mode: "verified",
        attemptId,
        generation: 1,
        mediaId,
        mediaSha256: stagedSourceSha256,
        probe: verifiedProbe,
        uploadedAt: "2030-01-15T12:00:00.000Z",
        source: "staged",
        authority: frameAuthority,
      }),
    ).rejects.toThrow("media_probe_failed");
    await expect(
      readFile(join(root, "frames", batchId, ".complete")),
    ).rejects.toThrow();
  });

  it("binds each verified active scene score to its selected decoded timestamp", async () => {
    const root = await setupRoot(roots);
    const extractor = createLocalFrameExtraction({
      root,
      ids: { next: () => batchId },
      runner: {
        run: async (command) => {
          await writeDecoded(command.outputDirectory, verifiedTimeline());
          return completedEvidence(
            verifiedTimeline(),
            Array.from({ length: 600 }, (_, index) => 4 + index / 20_000),
          );
        },
      },
      retention: { schedule: async () => ({ kind: "created" as const }) },
    });
    await expect(
      extractor.extract({
        mode: "verified",
        attemptId,
        generation: 1,
        mediaId,
        mediaSha256: stagedSourceSha256,
        probe: verifiedProbe,
        uploadedAt: "2030-01-15T12:00:00.000Z",
        source: "staged",
        authority: frameAuthority,
      }),
    ).rejects.toThrow("media_probe_failed");
  });

  it("does not remove a pre-existing completed frame set after an exclusive publication collision", async () => {
    const root = await setupRoot(roots);
    const existing = join(root, "frames", batchId);
    await mkdir(existing, { mode: 0o700 });
    await writeFile(join(existing, ".complete"), "v1", { mode: 0o600 });
    const extractor = createLocalFrameExtraction({
      root,
      ids: { next: () => batchId },
      runner: {
        run: async (command) => {
          const timeline = Array.from({ length: 37 }, (_, index) => index / 12);
          await writeDecoded(command.outputDirectory, timeline);
          return completedEvidence(timeline, []);
        },
      },
      retention: { schedule: async () => ({ kind: "created" as const }) },
    });
    await expect(
      extractor.extract({
        mode: "free",
        attemptId,
        generation: 1,
        mediaId,
        mediaSha256: stagedSourceSha256,
        probe: { ...verifiedProbe, durationSeconds: 3 },
        uploadedAt: "2030-01-15T12:00:00.000Z",
        source: "staged",
        authority: frameAuthority,
      }),
    ).rejects.toThrow("media_probe_failed");
    await expect(readFile(join(existing, ".complete"), "utf8")).resolves.toBe(
      "v1",
    );
  });

  it("rejects fabricated NDJSON because the runner contract carries raw FFmpeg output", async () => {
    const root = await setupRoot(roots);
    const extractor = createLocalFrameExtraction({
      root,
      ids: { next: () => batchId },
      runner: {
        run: async (command) => {
          const timeline = Array.from({ length: 37 }, (_, index) => index / 12);
          await writeDecoded(command.outputDirectory, timeline);
          return {
            exitCode: 0,
            termination: "completed" as const,
            stdout: JSON.stringify({
              kind: "decoded",
              index: 0,
              timestampSeconds: 0,
            }),
            stderr: rawShowinfo(timeline),
          };
        },
      },
      retention: { schedule: async () => ({ kind: "created" as const }) },
    });
    await expect(
      extractor.extract({
        mode: "free",
        attemptId,
        generation: 1,
        mediaId,
        mediaSha256: stagedSourceSha256,
        probe: { ...verifiedProbe, durationSeconds: 3 },
        uploadedAt: "2030-01-15T12:00:00.000Z",
        source: "staged",
        authority: frameAuthority,
      }),
    ).rejects.toThrow("media_probe_failed");
  });

  it(
    "smokes the owned argv against an explicit portable FFmpeg extraction capability",
    async (context) => {
      const tracker = testGenerationTracker;
      const bodyCompletion = createDeferred<void>();
      smokeTestBody = Object.freeze({
        settled: bodyCompletion.promise,
      });
      try {
        return await runWithinTrackedProcessDeadline(
          async () => {
            if (
              !(await ffmpegHasPortableExtractionCapability("ffmpeg", tracker))
            )
              return context.skip();
            const root = await setupRoot();
            try {
              const staged = join(root, "temporary", `${mediaId}.uploading`);
              const generated = await runProcess(
                "ffmpeg",
                [
                  "-nostdin",
                  "-y",
                  "-f",
                  "lavfi",
                  "-i",
                  "color=c=black:s=480x480:r=12:d=4.05",
                  "-c:v",
                  "mpeg4",
                  "-pix_fmt",
                  "yuv420p",
                  "-f",
                  "mp4",
                  staged,
                ],
                tracker,
              );
              expect(generated.exitCode).toBe(0);
              const generatedSourceSha256 = createHash("sha256")
                .update(await readFile(staged))
                .digest("hex");
              const extractor = createLocalFrameExtraction({
                root,
                ids: { next: () => batchId },
                runner: {
                  run: async (command) => {
                    expect(command.timeoutMilliseconds).toBe(
                      portableFfmpegProcessDeadlineMilliseconds,
                    );
                    const filter = command.arguments.indexOf("-filter_complex");
                    expect(
                      command.arguments.slice(filter, filter + 10),
                    ).toEqual([
                      "-filter_complex",
                      "[0:v]fps=10,split=2[decoded][active];[decoded]showinfo[frames];[active]select='gte(t,4)*lt(t,64)*gte(scene,0)',metadata=print:file=-[scene]",
                      "-map",
                      "[frames]",
                      "-vsync",
                      "0",
                      "-start_number",
                      "0",
                      "-y",
                      "-c:v",
                    ]);
                    const output = join(
                      command.outputDirectory,
                      "decoded-%06d.jpg",
                    );
                    const outputIndex = command.arguments.indexOf(output);
                    expect(
                      command.arguments.slice(outputIndex - 5, outputIndex),
                    ).toEqual([
                      "-c:v",
                      "mjpeg",
                      "-pix_fmt",
                      "yuvj420p",
                      "-bitexact",
                    ]);
                    expect(command.arguments.slice(outputIndex + 1)).toEqual([
                      "-map",
                      "[scene]",
                      "-f",
                      "null",
                      "-",
                    ]);
                    const result = await runProcess(
                      command.executable,
                      command.arguments,
                      tracker,
                    );
                    expect(result.exitCode).toBe(0);
                    expect(
                      (await readdir(command.outputDirectory))
                        .filter((name) => /^decoded-\d{6}\.jpg$/.test(name))
                        .sort(),
                    ).toEqual(
                      Array.from(
                        { length: 41 },
                        (_, index) =>
                          `decoded-${String(index).padStart(6, "0")}.jpg`,
                      ),
                    );
                    expect(parseSmokeSceneTimestamps(result.stdout)).toEqual([
                      4,
                    ]);
                    return {
                      exitCode: result.exitCode,
                      termination: "completed" as const,
                      stdout: result.stdout,
                      stderr: result.stderr,
                    };
                  },
                },
                retention: {
                  schedule: async () => ({ kind: "created" as const }),
                },
              });

              await expect(
                extractor.extract({
                  mode: "free",
                  attemptId,
                  generation: 1,
                  mediaId,
                  mediaSha256: generatedSourceSha256,
                  probe: {
                    ...verifiedProbe,
                    durationSeconds: 4.05,
                    displayWidth: 480,
                    displayHeight: 480,
                    nominalFps: 12,
                    codec: "mpeg4",
                    sourceRotationDegrees: 0,
                  },
                  uploadedAt: "2030-01-15T12:00:00.000Z",
                  source: "staged",
                  authority: frameAuthority,
                }),
              ).resolves.toMatchObject({ frames: { count: 12 } });
              expect(
                (
                  await readFile(
                    join(root, "frames", batchId, "frame-0000.jpg"),
                  )
                ).length,
              ).toBeGreaterThan(0);
              expect(
                (
                  await readFile(
                    join(root, "frames", batchId, "frame-0011.jpg"),
                  )
                ).length,
              ).toBeGreaterThan(0);
            } finally {
              await tracker.closeAndDrain();
              await rm(root, { recursive: true, force: true });
            }
          },
          tracker,
          portableFfmpegProcessDeadlineMilliseconds,
        );
      } finally {
        bodyCompletion.resolve();
      }
    },
    portableFfmpegIntegrationTimeoutMilliseconds,
  );
});

async function setupRoot(roots?: string[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "revelai-c5-frames-"));
  roots?.push(root);
  await Promise.all(
    ["frames", "temporary"].map((name) =>
      mkdir(join(root, name), { mode: 0o700 }),
    ),
  );
  await writeFile(
    join(root, "temporary", `${mediaId}.uploading`),
    Buffer.from([1, 2, 3]),
    {
      mode: 0o600,
    },
  );
  await chmod(join(root, "temporary", `${mediaId}.uploading`), 0o600);
  return root;
}

function createDeferred<T>(): Deferred<T> {
  let resolve: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  if (!resolve) throw new Error("deferred resolution unavailable");
  return Object.freeze({ promise, resolve });
}

async function cleanupTrackedTestRoots(
  tracker: ProcessTracker,
  body: TestBody | undefined,
  roots: string[],
): Promise<void> {
  if (
    !(await settlesWithin(
      tracker.closeAndDrain(),
      testProcessTerminationGraceMilliseconds,
    ))
  ) {
    roots.splice(0);
    throw new Error(
      "test process tracker exceeded teardown grace; roots preserved",
    );
  }
  if (
    body &&
    !(await settlesWithin(
      body.settled,
      testProcessTerminationGraceMilliseconds,
    ))
  ) {
    roots.splice(0);
    throw new Error("smoke test body exceeded teardown grace; roots preserved");
  }
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
}

function settlesWithin(
  promise: Promise<unknown>,
  timeoutMilliseconds: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (!settled) resolve(false);
    }, timeoutMilliseconds);
    timeout.unref();
    void promise.then(
      () => {
        settled = true;
        clearTimeout(timeout);
        resolve(true);
      },
      () => {
        settled = true;
        clearTimeout(timeout);
        resolve(true);
      },
    );
  });
}

function verifiedTimeline(): number[] {
  return Array.from({ length: 640 }, (_, index) => index / 10);
}

function verifiedScenes(): number[] {
  return Array.from({ length: 600 }, (_, index) => 4 + index / 10);
}

async function writeDecoded(
  directory: string,
  timestamps: readonly number[],
  bytes = jpeg(0),
): Promise<void> {
  for (let index = 0; index < timestamps.length; index += 1)
    await writeFile(
      join(directory, `decoded-${String(index).padStart(6, "0")}.jpg`),
      bytes.length === 0 ? jpeg(index) : bytes,
      { mode: 0o600 },
    );
}

async function writeDecodedFromCommand(
  command: Readonly<{ arguments: readonly string[]; outputDirectory: string }>,
  timestamps: readonly number[],
): Promise<void> {
  const start = command.arguments.indexOf("-start_number");
  const startNumber = Number(command.arguments[start + 1]);
  for (let index = 0; index < timestamps.length; index += 1)
    await writeFile(
      join(
        command.outputDirectory,
        `decoded-${String(startNumber + index).padStart(6, "0")}.jpg`,
      ),
      jpeg(index),
      { mode: 0o600 },
    );
}

function jpeg(index: number): Uint8Array {
  if (index !== -1) return validBaselineJpeg();
  return Uint8Array.from(
    Buffer.from(
      "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3+iiigD//2Q==",
      "base64",
    ),
  );
}

/** A complete, decoder-valid baseline SOF0 fixture generated by libjpeg. */
function validBaselineJpeg(): Uint8Array {
  return Uint8Array.from(
    Buffer.from(
      [
        "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIy",
        "MjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVW",
        "V1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAEC",
        "AxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq",
        "8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3+iiigD//2Q==",
      ].join(""),
      "base64",
    ),
  );
}

function completedEvidence(
  timestamps: readonly number[],
  sceneTimestamps: readonly number[],
  showinfoSuffix = "",
): Readonly<{
  exitCode: number;
  termination: "completed";
  stdout: string;
  stderr: string;
}> {
  return {
    exitCode: 0,
    termination: "completed",
    stdout: sceneTimestamps
      .flatMap((timestampSeconds, index) => [
        `frame:${index} pts:${Math.round(timestampSeconds * 1000)} pts_time:${timestampSeconds.toFixed(6)}`,
        "lavfi.scene_score=0.1",
      ])
      .join("\n"),
    stderr: rawShowinfo(timestamps, showinfoSuffix),
  };
}

function rawShowinfo(timestamps: readonly number[], suffix = ""): string {
  return timestamps
    .map(
      (timestampSeconds, index) =>
        `[Parsed_showinfo_0] n: ${index} pts: ${Math.round(timestampSeconds * 1000)} pts_time:${timestampSeconds.toFixed(6)}${suffix}`,
    )
    .join("\n");
}

function parseSmokeSceneTimestamps(output: string): readonly number[] {
  const lines = output.split("\n").filter((line) => line.trim());
  const timestamps: number[] = [];
  for (let index = 0; index < lines.length; index += 2) {
    const frame = /^frame:\d+\s+pts:\d+\s+pts_time:([0-9]+(?:\.\d+)?)$/.exec(
      lines[index]!,
    );
    const score = /^lavfi\.scene_score=([0-9]+(?:\.\d+)?)$/.exec(
      lines[index + 1] ?? "",
    );
    if (!frame || !score) throw new Error("invalid smoke scene metadata");
    timestamps.push(Number(frame[1]));
  }
  return Object.freeze(timestamps);
}

function markerOnlyJpeg(): Uint8Array {
  return Uint8Array.of(0xff, 0xd8, 0xff, 0xd9);
}

function malformedJpeg(
  kind:
    | "dqt"
    | "dqt-zero"
    | "dht"
    | "dht-symbol"
    | "dht-oversubscribed"
    | "sof"
    | "sof-precision"
    | "sof-progressive"
    | "sos"
    | "sos-baseline"
    | "unsupported-dac"
    | "unsupported-dnl"
    | "unsupported-sof2"
    | "restart-without-dri"
    | "bad-stuffing"
    | "sampling-aggregate"
    | "truncated",
): Uint8Array {
  const output = Uint8Array.from(jpeg(0));
  if (kind === "truncated") return output.slice(0, -3);
  if (kind === "unsupported-dac")
    return insertBeforeSos(output, Uint8Array.of(0xff, 0xcc, 0x00, 0x02));
  if (kind === "unsupported-dnl")
    return insertBeforeSos(output, Uint8Array.of(0xff, 0xdc, 0x00, 0x02));
  if (kind === "unsupported-sof2")
    return insertBeforeSos(
      output,
      Uint8Array.of(0xff, 0xc2, 0x00, 0x08, 8, 0, 1, 0, 1, 1),
    );
  if (kind === "restart-without-dri")
    return insertBeforeEoi(output, Uint8Array.of(0xff, 0xd0));
  if (kind === "bad-stuffing")
    return insertBeforeEoi(output, Uint8Array.of(0xff, 0xff, 0x00));
  let cursor = 2;
  let huffmanTableIndex = 0;
  while (cursor + 4 <= output.length) {
    if (output[cursor] !== 0xff) throw new Error("fixture marker missing");
    while (output[cursor] === 0xff) cursor += 1;
    const marker = output[cursor++]!;
    const length = (output[cursor]! << 8) | output[cursor + 1]!;
    const start = cursor + 2;
    if (kind === "dqt" && marker === 0xdb) {
      output[start] = 0xff;
      return output;
    }
    if (kind === "dqt-zero" && marker === 0xdb) {
      output[start + 1] = 0;
      return output;
    }
    if (kind === "dht" && marker === 0xc4) {
      output[start + 1] = 0x02;
      return output;
    }
    if (kind === "dht-symbol" && marker === 0xc4) {
      output[start + 17] = 0xff;
      return output;
    }
    if (marker === 0xc4) {
      huffmanTableIndex += 1;
      if (kind === "dht-oversubscribed" && huffmanTableIndex === 2) {
        const bits = start + 1;
        // Preserve this table's symbol count while making three 1-bit codes.
        for (let index = 0; index < 16; index += 1) output[bits + index] = 0;
        output[bits] = 3;
        output[bits + 15] = 159;
        return output;
      }
    }
    if (kind === "sof" && marker === 0xc0) {
      output[start + 5] = 0x02;
      return output;
    }
    if (kind === "sof-precision" && marker === 0xc0) {
      output[start] = 12;
      return output;
    }
    if (kind === "sof-progressive" && marker === 0xc0) {
      output[cursor - 1] = 0xc2;
      return output;
    }
    if (kind === "sampling-aggregate" && marker === 0xc0) {
      output[start + 7] = 0x44;
      return output;
    }
    if (kind === "sos" && marker === 0xda) {
      output[start + 2] = 0x22;
      return output;
    }
    if (kind === "sos-baseline" && marker === 0xda) {
      output[start + 5] = 62;
      return output;
    }
    cursor += length;
  }
  throw new Error(`fixture ${kind} marker missing`);
}

function insertBeforeSos(bytes: Uint8Array, insert: Uint8Array): Uint8Array {
  for (let index = 2; index + 1 < bytes.length; index += 1)
    if (bytes[index] === 0xff && bytes[index + 1] === 0xda)
      return Uint8Array.from([
        ...bytes.slice(0, index),
        ...insert,
        ...bytes.slice(index),
      ]);
  throw new Error("fixture SOS marker missing");
}

function insertBeforeEoi(bytes: Uint8Array, insert: Uint8Array): Uint8Array {
  return Uint8Array.from([
    ...bytes.slice(0, -2),
    ...insert,
    ...bytes.slice(-2),
  ]);
}

/** Skip only when a real invocation cannot execute the complete owned pipeline. */
async function ffmpegHasPortableExtractionCapability(
  executable = "ffmpeg",
  tracker?: ProcessTracker,
): Promise<boolean> {
  const root = await mkdtemp(join(tmpdir(), "revelai-ffmpeg-capability-"));
  const source = join(root, "source.mp4");
  const outputPattern = join(root, "frame-%06d.jpg");
  try {
    const generated = await runProcess(
      executable,
      [
        "-nostdin",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "color=c=black:s=16x16:r=10:d=1",
        "-c:v",
        "mpeg4",
        "-pix_fmt",
        "yuv420p",
        "-f",
        "mp4",
        source,
      ],
      tracker,
    );
    if (generated.exitCode !== 0) return false;
    const extracted = await runProcess(
      executable,
      [
        "-nostdin",
        "-v",
        "info",
        "-i",
        source,
        "-filter_complex",
        "[0:v]fps=10,split=2[decoded][active];[decoded]showinfo[frames];[active]select='gte(t,0)*lt(t,1)*gte(scene,0)',metadata=print:file=-[scene]",
        "-map",
        "[frames]",
        "-vsync",
        "0",
        "-start_number",
        "0",
        "-y",
        "-c:v",
        "mjpeg",
        "-pix_fmt",
        "yuvj420p",
        "-bitexact",
        outputPattern,
        "-map",
        "[scene]",
        "-f",
        "null",
        "-",
      ],
      tracker,
    );
    if (extracted.exitCode !== 0) return false;
    return (await readFile(join(root, "frame-000000.jpg"))).length > 0;
  } catch {
    return false;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

class ControlledChildProcess extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly receivedSignals: NodeJS.Signals[] = [];
  readonly errorSignals = new Set<NodeJS.Signals>();
  private readonly signalWaiters = new Map<NodeJS.Signals, Array<() => void>>();

  kill(signal: NodeJS.Signals): boolean {
    this.receivedSignals.push(signal);
    const waiters = this.signalWaiters.get(signal) ?? [];
    this.signalWaiters.delete(signal);
    for (const resolve of waiters) resolve();
    if (this.errorSignals.has(signal))
      this.emit("error", new Error(`simulated ${signal} error`));
    return !this.errorSignals.has(signal);
  }

  waitForSignal(signal: NodeJS.Signals): Promise<void> {
    if (this.receivedSignals.includes(signal)) return Promise.resolve();
    return new Promise((resolve) => {
      const waiters = this.signalWaiters.get(signal) ?? [];
      waiters.push(resolve);
      this.signalWaiters.set(signal, waiters);
    });
  }

  emitClose(exitCode: number | null): void {
    this.emit("close", exitCode);
    this.stdout.end();
    this.stderr.end();
  }
}

async function runWithinTrackedProcessDeadline<T>(
  operation: () => Promise<T>,
  tracker: ProcessTracker,
  timeoutMilliseconds: number,
): Promise<T> {
  let deadlineExceeded = false;
  const deadline = setTimeout(() => {
    deadlineExceeded = true;
    void tracker.closeAndDrain();
  }, timeoutMilliseconds);
  deadline.unref();
  try {
    const result = await operation();
    if (deadlineExceeded)
      throw new Error(
        "portable FFmpeg smoke exceeded the owned process deadline",
      );
    return result;
  } catch (error) {
    if (deadlineExceeded)
      throw new Error(
        "portable FFmpeg smoke exceeded the owned process deadline",
      );
    throw error;
  } finally {
    clearTimeout(deadline);
    await tracker.closeAndDrain();
  }
}

async function runProcess(
  executable: string,
  arguments_: readonly string[],
  tracker?: ProcessTracker,
  spawnProcess: ProcessSpawner = spawnProcessNative,
  terminationGraceMilliseconds = testProcessTerminationGraceMilliseconds,
): Promise<ProcessResult> {
  const reservation = tracker?.tryReserve();
  if (tracker && !reservation)
    return Promise.reject(new Error("test process tracker is closed"));
  let child: ProcessChild;
  try {
    child = spawnProcess(executable, arguments_);
  } catch (error) {
    reservation?.cancel();
    return Promise.reject(error);
  }
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let forceKill: ReturnType<typeof setTimeout> | undefined;
  let finished = false;
  let terminating = false;
  let processError: Error | undefined;
  let resolveClosed: () => void;
  let resolveCompleted: (result: ProcessResult) => void;
  let rejectCompleted: (error: Error) => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  const completed = new Promise<ProcessResult>((resolve, reject) => {
    resolveCompleted = resolve;
    rejectCompleted = reject;
  });
  const tracked: TrackedProcess = Object.freeze({
    terminate: async () => {
      if (!finished && !terminating) {
        terminating = true;
        child.kill("SIGTERM");
        forceKill = setTimeout(() => {
          if (!finished) child.kill("SIGKILL");
        }, terminationGraceMilliseconds);
        forceKill.unref();
      }
      await closed;
    },
  });
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  child.on("error", (error: Error) => {
    processError ??= error;
  });
  child.once("close", (code) => {
    if (finished) return;
    finished = true;
    if (forceKill) clearTimeout(forceKill);
    tracker?.release(tracked);
    if (processError) rejectCompleted(processError);
    else
      resolveCompleted(
        Object.freeze({
          exitCode: code ?? 1,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
        }),
      );
    resolveClosed();
  });
  reservation?.activate(tracked);
  return completed;
}

const spawnProcessNative: ProcessSpawner = (executable, arguments_) =>
  spawn(executable, arguments_, { stdio: ["ignore", "pipe", "pipe"] });

function createProcessTracker(): ProcessTracker {
  const processes = new Set<TrackedProcess>();
  let closing = false;
  return Object.freeze({
    tryReserve: () => {
      if (closing) return undefined;
      let claimed = true;
      let resolveActivation: (process: TrackedProcess | undefined) => void;
      const activated = new Promise<TrackedProcess | undefined>((resolve) => {
        resolveActivation = resolve;
      });
      const reservation: TrackedProcess = Object.freeze({
        terminate: async () => {
          const process = await activated;
          if (process) await process.terminate();
        },
      });
      processes.add(reservation);
      return Object.freeze({
        activate: (process: TrackedProcess) => {
          if (!claimed) throw new Error("process reservation already settled");
          claimed = false;
          processes.delete(reservation);
          processes.add(process);
          resolveActivation(process);
          if (closing) void process.terminate();
        },
        cancel: () => {
          if (!claimed) return;
          claimed = false;
          processes.delete(reservation);
          resolveActivation(undefined);
        },
      });
    },
    release: (process) => {
      processes.delete(process);
    },
    closeAndDrain: async () => {
      closing = true;
      while (processes.size > 0)
        await Promise.all([...processes].map((process) => process.terminate()));
    },
    size: () => processes.size,
  });
}
