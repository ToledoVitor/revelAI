import type {
  RetentionObjectStore,
  RetentionRecord,
} from "../media/retention-scavenger.js";
import { LocalMediaStorage } from "./local-media-storage.js";

/** Maps opaque retention records to local deletion without exposing a path. */
export class LocalRetentionObjectStore implements RetentionObjectStore {
  private readonly storage: LocalMediaStorage;

  public constructor(input: Readonly<{ storage: LocalMediaStorage }>) {
    this.storage = input.storage;
  }

  public async delete(record: RetentionRecord): Promise<void> {
    if (record.kind === "original") return this.storage.delete(record.id);
    if (record.kind === "frame") return this.storage.deleteFrame(record.id);
    if (record.kind === "temporary")
      return this.storage.deleteTemporary(record.id);
    // Canonical observations are database records; their physical counterpart
    // is intentionally absent in this local development storage backend.
  }
}
