import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createOwnedChildStop } from "./owned-child-lifecycle.mjs";

const codecTerminationGraceMilliseconds = 1_000;

const fixtureDefinitions = Object.freeze([
  Object.freeze({
    kind: "free-portrait",
    filename: "free-portrait.mp4",
    durationSeconds: 3,
    width: 720,
    height: 1280,
    fps: 24,
  }),
  Object.freeze({
    kind: "verified-landscape",
    filename: "verified-landscape.mp4",
    durationSeconds: 64,
    width: 1280,
    height: 720,
    fps: 24,
  }),
]);

export async function createDemoMediaFixtures({
  directory,
  run = runCodec,
  signal,
}) {
  throwIfAborted(signal);
  await mkdir(directory, { recursive: true });
  throwIfAborted(signal);
  const results = await Promise.allSettled(
    fixtureDefinitions.map(async (definition) => {
      const path = join(directory, definition.filename);
      await runOrThrow(
        run,
        "ffmpeg",
        [
          "-nostdin",
          "-y",
          "-f",
          "lavfi",
          "-i",
          `color=c=black:s=${definition.width}x${definition.height}:r=${definition.fps}:d=${definition.durationSeconds}`,
          "-an",
          "-c:v",
          "mpeg4",
          "-q:v",
          "31",
          "-pix_fmt",
          "yuv420p",
          "-movflags",
          "+faststart",
          path,
        ],
        signal,
      );
      throwIfAborted(signal);
      const probe = await readProbe(run, path, signal);
      throwIfAborted(signal);
      assertFixtureProbe(definition, probe);
      return Object.freeze({ kind: definition.kind, path, probe });
    }),
  );
  const rejected = results.find((result) => result.status === "rejected");
  if (rejected?.status === "rejected") throw rejected.reason;
  return results.map((result) => result.value);
}

async function readProbe(run, path, signal) {
  const output = await runOrThrow(
    run,
    "ffprobe",
    [
      "-v",
      "error",
      "-print_format",
      "json",
      "-show_entries",
      "format=duration:stream=codec_type,width,height,avg_frame_rate",
      "-select_streams",
      "v:0",
      path,
    ],
    signal,
  );
  let parsed;
  try {
    parsed = JSON.parse(output.stdout);
  } catch {
    throw new Error("Demo media fixture probe did not return JSON.");
  }
  const video = parsed.streams?.find((stream) => stream.codec_type === "video");
  const durationSeconds = Number(parsed.format?.duration);
  const width = Number(video?.width);
  const height = Number(video?.height);
  const fps = parseFrameRate(video?.avg_frame_rate);
  if (
    !Number.isFinite(durationSeconds) ||
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    !Number.isFinite(fps)
  )
    throw new Error("Demo media fixture probe is incomplete.");
  return Object.freeze({ durationSeconds, width, height, fps });
}

function parseFrameRate(value) {
  if (typeof value !== "string") return Number.NaN;
  const [numerator, denominator] = value.split("/").map(Number);
  if (
    !Number.isFinite(numerator) ||
    !Number.isFinite(denominator) ||
    denominator === 0
  )
    return Number.NaN;
  return numerator / denominator;
}

function assertFixtureProbe(definition, probe) {
  const expectedDuration = definition.durationSeconds;
  if (
    Math.abs(probe.durationSeconds - expectedDuration) > 0.1 ||
    probe.width !== definition.width ||
    probe.height !== definition.height ||
    probe.fps < definition.fps
  )
    throw new Error(
      `Demo media fixture is not C10-compatible: ${definition.kind}.`,
    );
}

async function runOrThrow(run, executable, arguments_, signal) {
  const result = await run({ executable, arguments: arguments_, signal });
  if (result.exitCode !== 0)
    throw new Error(`Demo media fixture codec command failed: ${executable}.`);
  return result;
}

export function runCodec({ executable, arguments: arguments_, signal }) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, arguments_, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stopChild = createOwnedChildStop(child, {
      graceMilliseconds: codecTerminationGraceMilliseconds,
    });
    const stdout = [];
    const stderr = [];
    let settled = false;
    let cancelled = false;
    const settle = (callback) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", cancel);
      child.off("error", receiveError);
      callback();
    };
    const cancel = () => {
      cancelled = true;
      void stopChild();
    };
    const receiveError = (error) => {
      if (cancelled) return;
      settle(() => reject(error));
    };
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", receiveError);
    child.once("close", (code) => {
      if (cancelled) {
        settle(() =>
          reject(new Error("Demo media fixture generation cancelled.")),
        );
        return;
      }
      settle(() =>
        resolve({
          exitCode: code ?? 1,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
        }),
      );
    });
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
  });
}

function throwIfAborted(signal) {
  if (signal?.aborted)
    throw new Error("Demo media fixture generation cancelled.");
}
