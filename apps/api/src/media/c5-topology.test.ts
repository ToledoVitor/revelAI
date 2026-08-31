import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { createMediaPipeline } from "./media-pipeline.js";

describe("C5 topology", () => {
  it("accepts only an unforgeable frozen local pipeline capability", async () => {
    const storageModule = (await import(
      "../storage/local-media-storage.js"
    )) as Record<string, unknown>;
    const extractionModule = (await import(
      "../storage/local-frame-extraction.js"
    )) as Record<string, unknown>;
    const pipelineModule = (await import("./media-pipeline.js")) as Record<
      string,
      unknown
    >;
    const createStorage = storageModule.createLocalMediaStorage;
    const createExtraction = extractionModule.createLocalFrameExtraction;
    const createCapability = pipelineModule.createMediaPipelineCapability;

    expect(storageModule.LocalMediaStorage).toBeUndefined();
    expect(extractionModule.LocalFrameExtraction).toBeUndefined();
    expect(typeof createStorage).toBe("function");
    expect(typeof createExtraction).toBe("function");
    expect(typeof createCapability).toBe("function");
    if (
      typeof createStorage !== "function" ||
      typeof createExtraction !== "function" ||
      typeof createCapability !== "function"
    )
      return;

    const ids = { next: () => "11111111-1111-4111-8111-111111111111" };
    const storage = createStorage({
      root: tmpdir(),
      ids,
      prober: {
        probe: async () => ({
          container: "mp4" as const,
          durationSeconds: 64,
          displayWidth: 1280,
          displayHeight: 720,
          nominalFps: 30,
          codec: "h264",
          sourceRotationDegrees: 0 as const,
        }),
      },
    });
    const extraction = createExtraction({
      root: tmpdir(),
      ids,
      runner: {
        run: async () => ({
          exitCode: 1,
          termination: "completed" as const,
          stdout: "",
          stderr: "",
        }),
      },
      retention: { schedule: async () => ({ kind: "created" as const }) },
    });
    const capability = createCapability({ storage, extraction });

    expect(Object.isFrozen(capability)).toBe(true);
    expect(() =>
      Object.assign(capability, { extract: async () => undefined }),
    ).toThrow(TypeError);
    expect(() => Object.setPrototypeOf(capability, null)).toThrow(TypeError);
    expect(() =>
      Object.assign(storage, { store: async () => undefined }),
    ).toThrow(TypeError);
    expect(() =>
      Object.assign(extraction, { durableReceiptFor: () => undefined }),
    ).toThrow(TypeError);
    const inheritedStorage = Object.create(storage);
    const inheritedExtraction = Object.create(extraction);
    expect(() =>
      createCapability({ storage: inheritedStorage, extraction }),
    ).toThrow("C5 media pipeline requires factory capabilities");
    expect(() =>
      createCapability({ storage, extraction: inheritedExtraction }),
    ).toThrow("C5 media pipeline requires factory capabilities");
    expect(() =>
      createMediaPipeline(Object.create(capability) as never),
    ).toThrow("C5 media pipeline requires a factory capability");
    expect(() => createMediaPipeline({} as never)).toThrow(
      "C5 media pipeline requires a factory capability",
    );
  });
});
