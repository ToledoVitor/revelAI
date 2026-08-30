import { evaluateMediaEligibility, type MediaMode } from "./eligibility.js";
import { MediaPipelineError } from "./probe.js";
import {
  LocalMediaStorage,
  type StoredLocalMedia,
} from "../storage/local-media-storage.js";

/** C5 orchestration: byte/probe eligibility only; no integrity or score facts. */
export class MediaPipeline {
  private readonly storage: LocalMediaStorage;

  public constructor(input: Readonly<{ storage: LocalMediaStorage }>) {
    this.storage = input.storage;
  }

  public async accept(
    input: Readonly<{
      mode: MediaMode;
      source: AsyncIterable<Uint8Array>;
      maxBytes: number;
      timestamps?: readonly number[];
      activeSceneChangeScores?: readonly number[];
    }>,
  ): Promise<StoredLocalMedia> {
    return this.storage.store({
      source: input.source,
      maxBytes: input.maxBytes,
      validate: ({ probe }) => {
        const eligibility = evaluateMediaEligibility({
          mode: input.mode,
          probe,
          timestamps: input.timestamps,
          activeSceneChangeScores: input.activeSceneChangeScores,
        });
        if (eligibility.kind !== "eligible")
          throw new MediaPipelineError("media_requirements_not_met");
      },
    });
  }
}
