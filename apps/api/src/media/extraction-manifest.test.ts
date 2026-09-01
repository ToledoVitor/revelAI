import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  attestVerifiedExtractionContinuity,
  createExtractionManifest,
  parseExtractionManifest,
  reconstructDurableProcessingContext,
} from "./extraction-manifest.js";

const IDs = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
];
const probe = {
  container: "mp4" as const,
  durationSeconds: 64,
  displayWidth: 1280,
  displayHeight: 720,
  nominalFps: 30,
  codec: "h264",
  sourceRotationDegrees: 0 as const,
};

/** Raw receipt fixture only: production issuance belongs to LocalFrameExtraction. */
function storageReceipt<
  T extends Readonly<{
    frameBatchId: string;
    authority: object;
    manifest: object;
    frames: readonly Uint8Array[];
    activeScenes: unknown;
  }>,
>(input: T) {
  return Object.freeze({
    kind: "c5-storage-extraction-receipt-v1" as const,
    frameBatchId: input.frameBatchId,
    authority: input.authority,
    manifest: input.manifest,
    frameSha256: Object.freeze(
      input.frames.map((frame) =>
        createHash("sha256").update(frame).digest("hex"),
      ),
    ),
    activeScenes: input.activeScenes,
  });
}

describe("extraction manifest", () => {
  it("binds verified attempt, generation, media digest, raw pre-roll bytes, and 40/600 partitions", () => {
    const frames = verifiedFrames();
    const manifest = createExtractionManifest({
      attemptId: IDs[0],
      generation: 1,
      mediaId: IDs[1],
      mediaSha256: "a".repeat(64),
      mode: "verified",
      probe,
      frames,
    });

    expect(manifest).toMatchObject({
      kind: "extraction-manifest",
      extractionVersion: "c5-frame-manifest-v1",
      attemptId: IDs[0],
      generation: 1,
      mediaId: IDs[1],
      preRoll: { count: 40 },
      active: { count: 600 },
      rawPreRollSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(JSON.stringify(manifest)).not.toContain("/");
    expect(
      parseExtractionManifest(JSON.parse(JSON.stringify(manifest))),
    ).toEqual(manifest);
  });

  it("frames the raw pre-roll digest and rejects extra nested partition fields", () => {
    const leftFrames = verifiedFrames().map((frame, index) =>
      index === 0
        ? { ...frame, rawBytes: Uint8Array.of(1) }
        : index === 1
          ? { ...frame, rawBytes: Uint8Array.of(2, 3) }
          : frame,
    );
    const rightFrames = verifiedFrames().map((frame, index) =>
      index === 0
        ? { ...frame, rawBytes: Uint8Array.of(1, 2) }
        : index === 1
          ? { ...frame, rawBytes: Uint8Array.of(3) }
          : frame,
    );
    const left = createExtractionManifest({
      attemptId: IDs[0],
      generation: 1,
      mediaId: IDs[1],
      mediaSha256: "a".repeat(64),
      mode: "verified",
      probe,
      frames: leftFrames,
    });
    const right = createExtractionManifest({
      attemptId: IDs[0],
      generation: 1,
      mediaId: IDs[1],
      mediaSha256: "a".repeat(64),
      mode: "verified",
      probe,
      frames: rightFrames,
    });
    if (left.mode !== "verified" || right.mode !== "verified")
      throw new Error("verified fixture required");
    expect(left.rawPreRollSha256).not.toBe(right.rawPreRollSha256);

    for (const nested of ["preRoll", "active"] as const) {
      const persisted = JSON.parse(JSON.stringify(left)) as Record<
        string,
        Record<string, unknown>
      >;
      persisted[nested] = { ...persisted[nested], ignored: true };
      expect(() => parseExtractionManifest(persisted)).toThrow(
        "Invalid extraction manifest.",
      );
    }
  });

  it("reopens an exact legacy unframed receipt only when all ordered frame bytes still match", async () => {
    const frameBatchId = IDs[2];
    const frames = verifiedFrames().map((frame, index) => ({
      ...frame,
      reference: `${frameBatchId}_${String(index).padStart(4, "0")}`,
    }));
    const current = createExtractionManifest({
      attemptId: IDs[0],
      generation: 1,
      mediaId: IDs[1],
      mediaSha256: "a".repeat(64),
      mode: "verified",
      probe,
      frames,
    });
    if (current.mode !== "verified")
      throw new Error("verified fixture required");
    const scenes = current.frames.items.slice(40).map((frame) => ({
      timestampSeconds: frame.timestampSeconds,
      score: 0.1,
    }));
    attestVerifiedExtractionContinuity(current, scenes);
    const legacy = {
      ...current,
      rawPreRollSha256: createHash("sha256")
        .update(
          Buffer.concat(
            frames.slice(0, 40).map((frame) => Buffer.from(frame.rawBytes)),
          ),
        )
        .digest("hex"),
    };
    const receipt = storageReceipt({
      frameBatchId,
      authority: {
        attemptId: IDs[0],
        athleteId: "44444444-4444-4444-8444-444444444444",
        generation: 1,
        mode: "verified",
        mediaId: IDs[1],
        sourceSha256: "a".repeat(64),
        uploadedAt: "2030-01-15T12:00:00.000Z",
        calibrationSessionId: "55555555-5555-4555-8555-555555555555",
        calibrationNonce: "legacy-nonce",
      },
      manifest: legacy,
      frames: frames.map((frame) => frame.rawBytes),
      activeScenes: scenes,
    });
    const bytes = Buffer.from(JSON.stringify(receipt));
    const reader = {
      readReceipt: async () => ({ bytes }),
      readFrame: async (reference: string) =>
        frames.find((frame) => frame.reference === reference)!.rawBytes,
      sourceSha256ForOriginal: async () => "a".repeat(64),
    };

    const rebuilt = await reconstructDurableProcessingContext({
      context: storageContext({
        frameBatchId,
        mediaId: IDs[1],
        sha256: createHash("sha256").update(bytes).digest("hex"),
      }),
      frames: reader,
      receipts: reader,
      authority: {
        upload: {
          attemptId: IDs[0],
          athleteId: "44444444-4444-4444-8444-444444444444",
          generation: 1,
          mode: "verified",
          mediaId: IDs[1],
          sourceSha256: "a".repeat(64),
          uploadedAt: "2030-01-15T12:00:00.000Z",
          calibrationSessionId: "55555555-5555-4555-8555-555555555555",
          calibrationNonce: "legacy-nonce",
        },
      },
    });
    if (rebuilt.mode !== "verified")
      throw new Error("verified reconstruction required");
    expect(rebuilt.rawPreRollSha256).not.toBe(legacy.rawPreRollSha256);
  });

  it("rejects missing, reordered, unopaque, or path-bearing verified frames", () => {
    const base = verifiedFrames();
    for (const frames of [
      base.slice(0, 639),
      [
        ...base.slice(0, 1),
        { ...base[1], timestampSeconds: 0 },
        ...base.slice(2),
      ],
      [
        ...base.slice(0, 1),
        { ...base[1], reference: "/private/frame.jpg" },
        ...base.slice(2),
      ],
    ]) {
      expect(() =>
        createExtractionManifest({
          attemptId: IDs[0],
          generation: 1,
          mediaId: IDs[1],
          mediaSha256: "a".repeat(64),
          mode: "verified",
          probe,
          frames,
        }),
      ).toThrow();
    }
  });

  it("creates Free manifests with exact uniform samples and no verified partitions", () => {
    const duration = 3;
    const frames = Array.from({ length: 12 }, (_, index) => ({
      timestampSeconds: (duration * index) / 11,
      reference: opaqueFrame(index),
      rawBytes: Uint8Array.of(index),
    }));
    const manifest = createExtractionManifest({
      attemptId: IDs[0],
      generation: 1,
      mediaId: IDs[1],
      mediaSha256: "b".repeat(64),
      mode: "free",
      probe: { ...probe, durationSeconds: duration },
      frames,
    });
    expect(manifest).toMatchObject({ mode: "free", frames: { count: 12 } });
    expect("preRoll" in manifest).toBe(false);
    expect("active" in manifest).toBe(false);
  });

  it("strictly rejects persisted manifests with paths or unknown fields", () => {
    expect(() =>
      parseExtractionManifest({
        kind: "extraction-manifest",
        extractionVersion: "c5-frame-manifest-v1",
        mode: "free",
        attemptId: IDs[0],
        generation: 1,
        mediaId: IDs[1],
        mediaSha256: "b".repeat(64),
        display: { width: 1280, height: 720, rotationDegrees: 0 },
        probe,
        frames: {
          count: 1,
          items: [{ ordinal: 0, timestampSeconds: 0, reference: "/tmp/a" }],
        },
        unknown: true,
      }),
    ).toThrow();
  });

  it("rejects a receipt returned for a different durable frame batch", async () => {
    const receiptBatchId = IDs[2];
    const frames = Array.from({ length: 12 }, (_, index) => ({
      timestampSeconds: (3 * index) / 11,
      reference: `${receiptBatchId}_${String(index).padStart(4, "0")}`,
      rawBytes: Uint8Array.of(index),
    }));
    const manifest = createExtractionManifest({
      attemptId: IDs[0],
      generation: 1,
      mediaId: IDs[1],
      mediaSha256: "a".repeat(64),
      mode: "free",
      probe: { ...probe, durationSeconds: 3 },
      frames,
    });
    const receipt = storageReceipt({
      frameBatchId: receiptBatchId,
      authority: {
        attemptId: IDs[0],
        athleteId: "44444444-4444-4444-8444-444444444444",
        generation: 1,
        mode: "free",
        mediaId: IDs[1],
        sourceSha256: "a".repeat(64),
        uploadedAt: "2030-01-15T12:00:00.000Z",
        calibrationSessionId: null,
        calibrationNonce: null,
      },
      manifest,
      frames: frames.map((frame) => frame.rawBytes),
      activeScenes: null,
    });
    const bytes = Buffer.from(JSON.stringify(receipt));
    const context = storageContext({
      frameBatchId: "55555555-5555-4555-8555-555555555555",
      mediaId: IDs[1],
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
    const reader = {
      readReceipt: async () => ({ bytes }),
      readFrame: async (reference: string) =>
        frames.find((frame) => frame.reference === reference)!.rawBytes,
      sourceSha256ForOriginal: async () => "a".repeat(64),
    };

    await expect(
      reconstructDurableProcessingContext({
        context,
        frames: reader,
        receipts: reader,
        authority: {
          upload: {
            attemptId: IDs[0],
            athleteId: "44444444-4444-4444-8444-444444444444",
            generation: 1,
            mode: "free",
            mediaId: IDs[1],
            sourceSha256: "a".repeat(64),
            uploadedAt: "2030-01-15T12:00:00.000Z",
            calibrationSessionId: null,
            calibrationNonce: null,
          },
        },
      }),
    ).rejects.toThrow("durable extraction authority mismatch");
  });

  it("rejects an A-identity/B-byte receipt even when B was completely rehashed", async () => {
    const substitutedBatchId = "66666666-6666-4666-8666-666666666666";
    const acceptedFrames = verifiedFrames();
    const substitutedFrames = verifiedFrames().map((frame, index) => ({
      ...frame,
      reference: `${substitutedBatchId}_${String(index).padStart(4, "0")}`,
      rawBytes: Uint8Array.of((index + 17) % 256),
    }));
    const accepted = createExtractionManifest({
      attemptId: IDs[0],
      generation: 1,
      mediaId: IDs[1],
      mediaSha256: "a".repeat(64),
      mode: "verified",
      probe,
      frames: acceptedFrames,
    });
    const substituted = createExtractionManifest({
      attemptId: IDs[2],
      generation: 2,
      mediaId: IDs[2],
      mediaSha256: "b".repeat(64),
      mode: "verified",
      probe,
      frames: substitutedFrames,
    });
    if (accepted.mode !== "verified" || substituted.mode !== "verified")
      throw new Error("verified required");
    const scenes = substituted.frames.items.slice(40).map((frame) => ({
      timestampSeconds: frame.timestampSeconds,
      score: 0.1,
    }));
    attestVerifiedExtractionContinuity(
      accepted,
      accepted.frames.items.slice(40).map((frame) => ({
        timestampSeconds: frame.timestampSeconds,
        score: 0.1,
      })),
    );
    attestVerifiedExtractionContinuity(substituted, scenes);
    const receipt = storageReceipt({
      frameBatchId: substitutedBatchId,
      authority: {
        attemptId: IDs[2],
        athleteId: IDs[2],
        generation: 2,
        mode: "verified",
        mediaId: IDs[2],
        sourceSha256: "b".repeat(64),
        uploadedAt: "2030-01-15T12:00:00.000Z",
        calibrationSessionId: IDs[1],
        calibrationNonce: "nonce-b",
      },
      manifest: substituted,
      frames: substitutedFrames.map((frame) => frame.rawBytes),
      activeScenes: scenes,
    });
    const receiptBytes = Buffer.from(JSON.stringify(receipt));
    const context = storageContext({
      frameBatchId: substitutedBatchId,
      mediaId: IDs[2],
      sha256: createHash("sha256").update(receiptBytes).digest("hex"),
    });

    await expect(
      reconstructDurableProcessingContext({
        context,
        frames: {
          readFrame: async (reference) =>
            substitutedFrames.find((frame) => frame.reference === reference)!
              .rawBytes,
        },
        receipts: {
          readReceipt: async () => ({ bytes: receiptBytes }),
          readFrame: async () => Uint8Array.of(),
          sourceSha256ForOriginal: async () => "b".repeat(64),
        },
        authority: {
          upload: {
            attemptId: accepted.attemptId,
            athleteId: IDs[0],
            generation: accepted.generation,
            mode: accepted.mode,
            mediaId: accepted.mediaId,
            sourceSha256: accepted.mediaSha256,
            uploadedAt: "2030-01-15T12:00:00.000Z",
            calibrationSessionId: IDs[1],
            calibrationNonce: "nonce-a",
          },
        },
      }),
    ).rejects.toThrow("durable extraction authority mismatch");
  });

  it("rejects an original substituted after the complete receipt batch was published", async () => {
    const frameBatchId = IDs[2];
    const frames = Array.from({ length: 12 }, (_, index) => ({
      timestampSeconds: (3 * index) / 11,
      reference: `${frameBatchId}_${String(index).padStart(4, "0")}`,
      rawBytes: Uint8Array.of(index),
    }));
    const manifest = createExtractionManifest({
      attemptId: IDs[0],
      generation: 1,
      mediaId: IDs[1],
      mediaSha256: "a".repeat(64),
      mode: "free",
      probe: { ...probe, durationSeconds: 3 },
      frames,
    });
    const receipt = storageReceipt({
      frameBatchId,
      authority: {
        attemptId: IDs[0],
        athleteId: "44444444-4444-4444-8444-444444444444",
        generation: 1,
        mode: "free",
        mediaId: IDs[1],
        sourceSha256: "a".repeat(64),
        uploadedAt: "2030-01-15T12:00:00.000Z",
        calibrationSessionId: null,
        calibrationNonce: null,
      },
      manifest,
      frames: frames.map((frame) => frame.rawBytes),
      activeScenes: null,
    });
    const bytes = Buffer.from(JSON.stringify(receipt));
    const reader = {
      readReceipt: async () => ({ bytes }),
      readFrame: async (reference: string) =>
        frames.find((frame) => frame.reference === reference)!.rawBytes,
      sourceSha256ForOriginal: async () => "b".repeat(64),
    };

    await expect(
      reconstructDurableProcessingContext({
        context: storageContext({
          frameBatchId,
          mediaId: IDs[1],
          sha256: createHash("sha256").update(bytes).digest("hex"),
        }),
        frames: reader,
        receipts: reader,
        authority: {
          upload: {
            attemptId: IDs[0],
            athleteId: "44444444-4444-4444-8444-444444444444",
            generation: 1,
            mode: "free",
            mediaId: IDs[1],
            sourceSha256: "a".repeat(64),
            uploadedAt: "2030-01-15T12:00:00.000Z",
            calibrationSessionId: null,
            calibrationNonce: null,
          },
        },
      }),
    ).rejects.toThrow("durable extraction authority mismatch");
  });
});

function storageContext(
  input: Readonly<{
    frameBatchId: string;
    mediaId: string;
    sha256: string;
  }>,
) {
  return Object.freeze({
    kind: "c5-durable-processing-context-v2" as const,
    receipt: Object.freeze({ ...input }),
  });
}

function verifiedFrames() {
  return Array.from({ length: 640 }, (_, index) => ({
    timestampSeconds: index / 10,
    reference: opaqueFrame(index),
    rawBytes: Uint8Array.of(index % 256),
  }));
}

function opaqueFrame(index: number): string {
  return `frame-${String(index).padStart(4, "0")}`;
}
