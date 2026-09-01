import { spawn } from "node:child_process";
import type {
  LocalDemoProcessCommand,
  LocalDemoProcessRunner,
} from "./local-demo-support.js";

type LocalDemoProcessResult = Awaited<
  ReturnType<LocalDemoProcessRunner["run"]>
>;

export function createLocalDemoProcessRunner(
  input: Readonly<{ terminationGraceMilliseconds?: number }> = {},
): LocalDemoProcessRunner {
  const terminationGraceMilliseconds =
    input.terminationGraceMilliseconds ?? 1_000;
  if (
    !Number.isSafeInteger(terminationGraceMilliseconds) ||
    terminationGraceMilliseconds < 1
  )
    throw new Error("Local demo process termination grace must be positive.");
  return Object.freeze({
    run: (command) => runProcess(command, terminationGraceMilliseconds),
  });
}

function runProcess(
  input: LocalDemoProcessCommand,
  terminationGraceMilliseconds: number,
): Promise<LocalDemoProcessResult> {
  return new Promise((resolve, reject) => {
    let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let termination: LocalDemoProcessResult["termination"] = "completed";
    let forceKill: NodeJS.Timeout | undefined;
    const child = spawn(input.executable, input.arguments, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const terminate = (reason: LocalDemoProcessResult["termination"]): void => {
      if (termination !== "completed") return;
      termination = reason;
      child.kill("SIGTERM");
      forceKill = setTimeout(
        () => child.kill("SIGKILL"),
        terminationGraceMilliseconds,
      );
      forceKill.unref();
    };
    const timeout = setTimeout(
      () => terminate("timed_out"),
      input.timeoutMilliseconds,
    );
    timeout.unref();
    const append = (current: Buffer, chunk: Buffer, limit: number): Buffer => {
      const bytes = Buffer.from(chunk);
      const allowed = Math.min(
        remaining(limit, current.byteLength),
        remaining(input.maxOutputBytes, stdout.byteLength + stderr.byteLength),
        bytes.byteLength,
      );
      if (bytes.byteLength > allowed) terminate("terminated");
      if (allowed === 0) return current;
      return Buffer.concat([current, bytes.subarray(0, allowed)]);
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = append(stdout, chunk, input.maxStdoutBytes);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = append(stderr, chunk, input.maxStderrBytes);
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
      resolve({
        exitCode: code ?? 1,
        termination,
        stdout: stdout.toString("utf8"),
        stderr: stderr.toString("utf8"),
      });
    });
  });
}

function remaining(limit: unknown, used: number): number {
  if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 0)
    return 0;
  return Math.max(0, limit - used);
}
