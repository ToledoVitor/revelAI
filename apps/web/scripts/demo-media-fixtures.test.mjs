import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { createDemoMediaFixtures, runCodec } from "./demo-media-fixtures.mjs";

test("generates and probes C10-compatible portrait and verified fixtures", async () => {
  const directory = await mkdtemp(join(tmpdir(), "revelai-demo-media-test-"));
  const commands = [];
  try {
    const fixtures = await createDemoMediaFixtures({
      directory,
      run: async ({ executable, arguments: args }) => {
        commands.push({ executable, arguments: args });
        if (executable === "ffprobe") {
          const verified = args.at(-1)?.endsWith("verified-landscape.mp4");
          return {
            exitCode: 0,
            stderr: "",
            stdout: JSON.stringify({
              format: { duration: verified ? "64.000000" : "3.000000" },
              streams: [
                {
                  codec_type: "video",
                  width: verified ? 1280 : 720,
                  height: verified ? 720 : 1280,
                  avg_frame_rate: "24/1",
                },
              ],
            }),
          };
        }
        return { exitCode: 0, stderr: "", stdout: "" };
      },
    });

    assert.deepEqual(
      fixtures.map((fixture) => fixture.kind),
      ["free-portrait", "verified-landscape"],
    );
    assert.deepEqual(
      fixtures.map((fixture) => fixture.probe),
      [
        { durationSeconds: 3, width: 720, height: 1280, fps: 24 },
        { durationSeconds: 64, width: 1280, height: 720, fps: 24 },
      ],
    );
    assert.equal(
      commands.filter((command) => command.executable === "ffmpeg").length,
      2,
    );
    assert.equal(
      commands.filter((command) => command.executable === "ffprobe").length,
      2,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("cancels every admitted codec command before starting a demo API", async () => {
  const directory = await mkdtemp(join(tmpdir(), "revelai-demo-media-test-"));
  const controller = new AbortController();
  let started = 0;
  try {
    const fixtures = createDemoMediaFixtures({
      directory,
      signal: controller.signal,
      run: async ({ signal }) => {
        started += 1;
        if (!signal) throw new Error("Expected an owned codec abort signal.");
        return new Promise((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new Error("owned codec cancelled")),
            { once: true },
          );
        });
      },
    });
    const outcome = fixtures.then(
      () => undefined,
      (error) => error,
    );

    await waitFor(() => started === 2);
    controller.abort();
    const error = await outcome;
    assert.match(error?.message, /owned codec cancelled/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("waits for every admitted codec before surfacing one fixture failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "revelai-demo-media-test-"));
  let releaseVerifiedCodec;
  let verifiedCodecStarted = false;
  try {
    const fixtures = createDemoMediaFixtures({
      directory,
      run: async ({ executable, arguments: args }) => {
        const path = args.at(-1);
        if (executable === "ffmpeg" && path.endsWith("free-portrait.mp4"))
          throw new Error("free fixture failed");
        if (executable === "ffmpeg") {
          verifiedCodecStarted = true;
          return new Promise((resolve) => {
            releaseVerifiedCodec = () =>
              resolve({ exitCode: 0, stderr: "", stdout: "" });
          });
        }
        return {
          exitCode: 0,
          stderr: "",
          stdout: JSON.stringify({
            format: { duration: "64.000000" },
            streams: [
              {
                codec_type: "video",
                width: 1280,
                height: 720,
                avg_frame_rate: "24/1",
              },
            ],
          }),
        };
      },
    });
    let settled = false;
    const outcome = fixtures.then(
      () => {
        settled = true;
        return undefined;
      },
      (error) => {
        settled = true;
        return error;
      },
    );

    await waitFor(() => verifiedCodecStarted);
    await new Promise((resolveTimer) => setTimeout(resolveTimer, 20));
    assert.equal(settled, false);
    releaseVerifiedCodec();
    const error = await outcome;
    assert.match(error?.message, /free fixture failed/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("holds a codec error open until the owned child closes", async () => {
  const child = createFakeCodecChild();
  const codec = runCodec({
    executable: "fake-codec",
    arguments: [],
    spawnProcess: () => child,
  });
  let settled = false;
  const outcome = codec.then(
    () => {
      settled = true;
      return undefined;
    },
    (error) => {
      settled = true;
      return error;
    },
  );

  child.emit("error", new Error("codec spawn failed"));
  await new Promise((resolveTimer) => setTimeout(resolveTimer, 20));
  assert.equal(settled, false);

  child.emit("close", 1);
  const error = await outcome;
  assert.match(error?.message, /codec spawn failed/);
  assert.equal(child.listenerCount("error"), 0);
});

test("settles codec exit failures only from close", async () => {
  const child = createFakeCodecChild();
  const codec = runCodec({
    executable: "fake-codec",
    arguments: [],
    spawnProcess: () => child,
  });
  let settled = false;
  const outcome = codec.then(
    () => {
      settled = true;
      return undefined;
    },
    (error) => {
      settled = true;
      return error;
    },
  );

  await new Promise((resolveTimer) => setTimeout(resolveTimer, 20));
  assert.equal(settled, false);
  child.emit("close", 1);
  const error = await outcome;
  assert.match(error?.message, /fake-codec/);
});

test("waits for close after aborting an owned codec child", async () => {
  const controller = new AbortController();
  const child = createFakeCodecChild();
  const killedWith = [];
  child.kill = (signal) => {
    killedWith.push(signal);
    return true;
  };
  const codec = runCodec({
    executable: "fake-codec",
    arguments: [],
    signal: controller.signal,
    spawnProcess: () => child,
  });
  let settled = false;
  const outcome = codec.then(
    () => {
      settled = true;
      return undefined;
    },
    (error) => {
      settled = true;
      return error;
    },
  );

  controller.abort();
  await new Promise((resolveTimer) => setTimeout(resolveTimer, 20));
  assert.deepEqual(killedWith, ["SIGTERM"]);
  assert.equal(settled, false);

  child.signalCode = "SIGTERM";
  child.emit("close", null);
  const error = await outcome;
  assert.match(error?.message, /generation cancelled/);
});

function createFakeCodecChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = () => true;
  return child;
}

async function waitFor(predicate) {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolveTimer) => setTimeout(resolveTimer, 10));
  }
  throw new Error("Timed out waiting for both owned codec commands.");
}
