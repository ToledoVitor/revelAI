import { describe, expect, it } from "vitest";
import { createLocalMediaStorage } from "../storage/local-media-storage.js";
import { createLocalC8AcceptedMediaCleaner } from "./local-c8-accepted-media-cleaner.js";

describe("local C8 accepted-media cleaner", () => {
  it("requires C5's factory capability and refuses unowned opaque identifiers before deletion", async () => {
    expect(() =>
      createLocalC8AcceptedMediaCleaner({
        storage: {} as never,
        ownership: {} as never,
      }),
    ).toThrow("C8 cleaner requires a C5 local storage capability.");

    const storage = createLocalMediaStorage({
      root: "/not-used-before-ownership-check",
      ids: { next: () => "22222222-2222-4222-8222-222222222222" },
      prober: {
        probe: async () => ({
          container: "mp4" as const,
          durationSeconds: 1,
          displayWidth: 1280,
          displayHeight: 720,
          nominalFps: 30,
          codec: "h264",
          sourceRotationDegrees: 0 as const,
        }),
      },
    });
    expect(() =>
      createLocalC8AcceptedMediaCleaner({
        storage,
        ownership: {
          hasExactAcceptedMediaCleanupOwnership: async () => false,
        } as never,
      }),
    ).toThrow("C8 cleaner requires a C4 repository capability.");
  });
});
