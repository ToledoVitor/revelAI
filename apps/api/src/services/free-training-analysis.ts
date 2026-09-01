import { FailureMessageByCode, type FreeInsight } from "@revelai/contracts";
import {
  VisionProviderError,
  type VisionBatchScheduler,
  type VisionProvider,
} from "@revelai/vision";
import { assembleFreeObservation } from "../processing/observation-assembler.js";
import {
  ExpectedProcessingFailure,
  RetryableProcessingFailure,
  type AnalysisProcessor,
} from "../workers/analysis-worker.js";
import type {
  DurableReconstructionAuthority,
  ExtractionManifest,
} from "../media/extraction-manifest.js";
import type { DurableFrameReader } from "../media/extraction-manifest.js";
import type {
  PersistedProcessingContext,
  ProcessingClaim,
} from "../repositories/attempt-repository.js";

export type FreeTrainingAnalysisClock = Readonly<{ now(): string }>;

/**
 * Fail-closed mode-separation ports. Free processing receives no calibration,
 * integrity/scoring, policy, ranking, or leaderboard capability; these ports
 * make any malformed value that tries to cross that boundary fail at once.
 */
export type FreeTrainingForbiddenPorts = Readonly<{
  forbidCalibration(): never;
  forbidIntegrityScoring(): never;
  forbidPolicyLookup(): never;
  forbidRankedFinalization(): never;
  forbidLeaderboard(): never;
  allowFreeTerminalPersistence(): void;
}>;

export const defaultFreeTrainingForbiddenPorts: FreeTrainingForbiddenPorts =
  Object.freeze({
    forbidCalibration: () => {
      throw new Error("Free processing cannot access calibration.");
    },
    forbidIntegrityScoring: () => {
      throw new Error("Free processing cannot access integrity or scoring.");
    },
    forbidPolicyLookup: () => {
      throw new Error("Free processing cannot access competitive policy.");
    },
    forbidRankedFinalization: () => {
      throw new Error("Free processing cannot finalize a ranked result.");
    },
    forbidLeaderboard: () => {
      throw new Error("Free processing cannot write a leaderboard entry.");
    },
    allowFreeTerminalPersistence: () => undefined,
  });

/** C8-only C4/C5 closures; no route, SQLite, score, policy, or rank surface. */
export type FreeTrainingAnalysisDependencies = Readonly<{
  getProcessingContext(
    input: Readonly<{
      attemptId: string;
      leaseId: string;
      generation: number;
    }>,
  ): Promise<PersistedProcessingContext | null>;
  reconstruct(
    input: Readonly<{
      context: unknown;
      authority: DurableReconstructionAuthority;
    }>,
  ): Promise<ExtractionManifest>;
  frames: DurableFrameReader;
  provider: VisionProvider;
  scheduler?: VisionBatchScheduler;
  clock: FreeTrainingAnalysisClock;
  forbiddenPorts?: FreeTrainingForbiddenPorts;
}>;

/**
 * Creates the Free-only processor that AnalysisWorker runs after its C4 lease
 * claim. All durable media facts are reconstructed through C5 before Vision
 * sees a byte; terminal persistence remains exclusively in AnalysisWorker/C4.
 */
export function createFreeTrainingAnalysisProcessor(
  input: FreeTrainingAnalysisDependencies,
): AnalysisProcessor {
  const load = input.getProcessingContext;
  const reconstruct = input.reconstruct;
  const frames = input.frames;
  const provider = input.provider;
  const scheduler = input.scheduler;
  const now = input.clock.now;
  const forbiddenPorts =
    input.forbiddenPorts ?? defaultFreeTrainingForbiddenPorts;

  return async ({ job, claim }) => {
    assertFreeClaim(claim);
    const persisted = await load({
      attemptId: job.attemptId,
      leaseId: claim.leaseId,
      generation: claim.generation,
    });
    if (!persisted)
      throw new Error("Free processing claim is no longer active.");
    if (persisted.upload.mode !== "free")
      throw new Error("Free processor received non-Free durable context.");
    if (persisted.upload.verified !== null) forbiddenPorts.forbidCalibration();
    const manifest = await reconstruct({
      context: persisted.processing,
      authority: authorityFor(persisted),
    });
    assertFreeManifest(manifest, job.attemptId, claim);
    let result: FreeInsight;
    try {
      result = await assembleFreeObservation({
        manifest,
        frames,
        provider,
        scheduler,
        generatedAt: now(),
      });
    } catch (error) {
      if (error instanceof VisionProviderError) {
        if (error.code === "provider_temporary_unavailable")
          throw new FreeTemporaryAnalysisError();
        throw new ExpectedProcessingFailure(
          Object.freeze({
            state: "failed" as const,
            attemptId: job.attemptId,
            mode: "free" as const,
            code: "analysis_configuration_invalid" as const,
            message: FailureMessageByCode.analysis_configuration_invalid,
            retryable: false as const,
          }),
        );
      }
      throw error;
    }
    if (result.attemptId !== job.attemptId)
      throw new Error("Free insight attempt binding mismatch.");
    if (!isFreeInsight(result)) forbiddenPorts.forbidIntegrityScoring();
    return Object.freeze({ state: "valid" as const, result });
  };
}

function isFreeInsight(value: unknown): value is FreeInsight {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Readonly<{ kind?: unknown }>).kind === "free-insight"
  );
}

/** Free's equivalent explicit C6 transport/deadline retry signal. */
class FreeTemporaryAnalysisError extends RetryableProcessingFailure {
  public constructor() {
    super("Free vision provider is temporarily unavailable.");
    this.name = "FreeTemporaryAnalysisError";
  }
}

function authorityFor(
  persisted: PersistedProcessingContext,
): DurableReconstructionAuthority {
  const { upload, processing, sourceSha256 } = persisted;
  return Object.freeze({
    upload: Object.freeze({
      attemptId: upload.attemptId,
      athleteId: upload.athleteId,
      generation: upload.generation,
      mode: upload.mode,
      mediaId: processing.receipt.mediaId,
      sourceSha256,
      uploadedAt: upload.uploadedAt,
      calibrationSessionId: null,
      calibrationNonce: null,
    }),
  });
}

function assertFreeClaim(
  claim: ProcessingClaim,
): asserts claim is ProcessingClaim & Readonly<{ mode: "free" }> {
  if (claim.mode !== "free")
    throw new Error("Free processor received a non-Free processing claim.");
}

function assertFreeManifest(
  manifest: ExtractionManifest,
  attemptId: string,
  claim: ProcessingClaim,
): asserts manifest is Extract<ExtractionManifest, Readonly<{ mode: "free" }>> {
  if (
    manifest.mode !== "free" ||
    manifest.attemptId !== attemptId ||
    manifest.generation !== claim.generation
  )
    throw new Error("Free durable manifest binding mismatch.");
}
