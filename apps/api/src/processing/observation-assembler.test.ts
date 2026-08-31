import { createExtractionManifest } from "../media/extraction-manifest.js";
import { describe, expect, it } from "vitest";
import {
  createDemoVisionProvider,
  VisionBatchScheduler,
  type VisionProvider,
} from "@revelai/vision";
import { assembleFreeObservation } from "./observation-assembler.js";

const attemptId = "11111111-1111-4111-8111-111111111111";

function freeManifest() {
  return createExtractionManifest({
    attemptId,
    generation: 1,
    mediaId: "22222222-2222-4222-8222-222222222222",
    mediaSha256: "a".repeat(64),
    mode: "free",
    probe: {
      container: "mp4",
      durationSeconds: 3,
      displayWidth: 480,
      displayHeight: 853,
      nominalFps: 12,
      codec: "h264",
      sourceRotationDegrees: 90,
    },
    frames: Array.from({ length: 12 }, (_, index) => ({
      timestampSeconds: (index * 3) / 11,
      reference: `33333333-3333-4333-8333-333333333333_${String(index).padStart(4, "0")}`,
      rawBytes: Uint8Array.of(1),
    })),
  });
}

describe("observation assembly cancellation", () => {
  it("threads one abort signal from opaque adaptation through the 640-style scheduler boundary", async () => {
    const manifest = freeManifest();
    if (manifest.mode !== "free") throw new Error("wrong fixture mode");
    const controller = new AbortController();
    const signals: AbortSignal[] = [];
    let started = 0;
    let firstFourStarted: (() => void) | undefined;
    const firstFour = new Promise<void>((resolve) => {
      firstFourStarted = resolve;
    });
    const demo = createDemoVisionProvider();
    const provider: VisionProvider = {
      ...demo,
      analyzeFree: async (_request, signal) => {
        started += 1;
        if (started === 4) firstFourStarted?.();
        return new Promise((resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => reject(new Error("aborted")),
            { once: true },
          );
          void resolve;
        });
      },
    };
    const scheduler = new VisionBatchScheduler({
      clock: {
        now: () => 0,
        sleep: async () => undefined,
        schedule: () => () => undefined,
      },
    });
    const assembly = assembleFreeObservation({
      manifest,
      frames: {
        readFrame: async (_reference, signal) => {
          if (signal) signals.push(signal);
          return Uint8Array.of(1);
        },
      },
      provider,
      scheduler,
      generatedAt: "2030-01-01T00:00:00.000Z",
      signal: controller.signal,
    });

    const observed = assembly.then(
      () => undefined,
      (error: unknown) => error,
    );
    await firstFour;
    controller.abort();

    await expect(observed).resolves.toMatchObject({
      code: "provider_temporary_unavailable",
    });
    expect(started).toBe(4);
    expect(signals).toHaveLength(12);
    expect(signals.every((signal) => signal === controller.signal)).toBe(true);
  });

  it("fails closed when a Free assembler is given verified Roboflow provenance", async () => {
    const demo = createDemoVisionProvider();
    const corruptedProvider = {
      ...demo,
      freeProvenance: {
        kind: "roboflow" as const,
        workspaceId: "revelai",
        workflowId: "revelai-wall-pass-geometry-v1" as const,
        workflowVersion: "1.0.0" as const,
        modelBundleId: "wall-pass-bundle-v1",
        providerVersion: "provider-v1",
      },
    } as unknown as VisionProvider;
    const manifest = freeManifest();
    if (manifest.mode !== "free") throw new Error("wrong fixture mode");
    await expect(
      assembleFreeObservation({
        manifest,
        frames: { readFrame: async () => Uint8Array.of(1) },
        provider: corruptedProvider,
        scheduler: new VisionBatchScheduler({
          clock: {
            now: () => 0,
            sleep: async () => undefined,
            schedule: () => () => undefined,
          },
        }),
        generatedAt: "2030-01-01T00:00:00.000Z",
      }),
    ).rejects.toMatchObject({ code: "provider_output_invalid" });
  });
});
