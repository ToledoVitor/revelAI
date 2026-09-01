import {
  FailureMessageByCode,
  InvalidRetryMessageByCode,
  VerifiedResultSchema,
  type VerifiedResult,
} from "@revelai/contracts";
import {
  VisionProviderError,
  type VisionBatchScheduler,
  type VisionProvider,
} from "@revelai/vision";
import type {
  DurableFrameReader,
  DurableReconstructionAuthority,
  ExtractionManifest,
} from "../media/extraction-manifest.js";
import { assembleVerifiedObservation } from "../processing/observation-assembler.js";
import {
  candidatePolicyFacts,
  evaluateVerifiedIntegrity,
  scoreVerifiedCandidate,
  type VerifiedAttemptCandidate,
} from "../processing/integrity-evaluator.js";
import {
  evaluateCompetitiveEligibility,
  type CompetitivePolicyLookup,
} from "../processing/competitive-policy.js";
import type {
  TransactionalRankedPolicyFinalizationAuthority,
  PersistedProcessingContext,
  ProcessingClaim,
  TerminalCandidate,
} from "../repositories/attempt-repository.js";
import { bindRankedCandidatePolicyFinalization } from "../repositories/attempt-repository.js";
import type { CompetitivePolicyActivation } from "../repositories/competitive-policy-repository.js";
import {
  ExpectedProcessingFailure,
  RetryableProcessingFailure,
  type AnalysisProcessor,
} from "../workers/analysis-worker.js";

export type VerifiedTrainingAnalysisClock = Readonly<{ now(): string }>;

/**
 * The only C8 error allowed to consume the worker's retry budget. C6 turns
 * provider transport and scheduler/deadline failures into this precise fact;
 * durable bindings, policy reads, and implementation defects terminalize
 * safely as nonretryable internal failures instead.
 */
export class VerifiedTemporaryAnalysisError extends RetryableProcessingFailure {
  public constructor() {
    super("Verified vision provider is temporarily unavailable.");
    this.name = "VerifiedTemporaryAnalysisError";
  }
}

/** C8-only C4–C7 closures; no HTTP, SQLite, or raw media implementation. */
export type VerifiedTrainingAnalysisDependencies = Readonly<{
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
  policy: CompetitivePolicyLookup;
  issueRankedPolicyFinalization?(
    activation: CompetitivePolicyActivation,
  ): TransactionalRankedPolicyFinalizationAuthority | undefined;
  clock: VerifiedTrainingAnalysisClock;
}>;

/**
 * Creates the verified-only C8 processor. C4 remains the sole terminal and
 * leaderboard authority: this function can only return a parsed candidate.
 */
export function createVerifiedTrainingAnalysisProcessor(
  input: VerifiedTrainingAnalysisDependencies,
): AnalysisProcessor {
  const load = input.getProcessingContext;
  const reconstruct = input.reconstruct;
  const frames = input.frames;
  const provider = input.provider;
  const scheduler = input.scheduler;
  const policy = input.policy;
  const issueRankedPolicy = input.issueRankedPolicyFinalization;
  const now = input.clock.now;

  return async ({ job, claim }) => {
    try {
      assertVerifiedClaim(claim);
      const persisted = await load({
        attemptId: job.attemptId,
        leaseId: claim.leaseId,
        generation: claim.generation,
      });
      if (!persisted)
        throw new Error("Verified processing claim is no longer active.");
      const upload = verifiedUpload(persisted);
      const manifest = await reconstruct({
        context: persisted.processing,
        authority: authorityFor(persisted, upload),
      });
      assertVerifiedManifest(manifest, job.attemptId, claim);

      let evidence;
      try {
        evidence = await assembleVerifiedObservation({
          manifest,
          frames,
          provider,
          scheduler,
          calibrationSessionId: upload.verified.calibrationSessionId,
          calibrationNonce: upload.verified.calibrationNonce,
        });
      } catch (error) {
        if (!(error instanceof VisionProviderError)) throw error;
        if (error.code === "provider_temporary_unavailable")
          throw new VerifiedTemporaryAnalysisError();
        throw configurationFailure(job.attemptId);
      }

      const integrity = evaluateVerifiedIntegrity({
        expected: {
          attemptId: job.attemptId,
          generation: claim.generation,
          challenge: upload.verified.challenge,
          calibrationSessionId: upload.verified.calibrationSessionId,
          calibrationNonce: upload.verified.calibrationNonce,
          mediaId: persisted.processing.receipt.mediaId,
          mediaSha256: persisted.sourceSha256,
          rawPreRollSha256: manifest.rawPreRollSha256,
        },
        manifest,
        evidence,
      });
      if (integrity.kind === "integrity-invalid")
        throw invalidFailure(job.attemptId, integrity.code);
      if (integrity.kind === "analysis-temporary-unavailable")
        throw internalFailure(job.attemptId);

      const eligibility = await evaluateCompetitiveEligibility({
        candidate: integrity.candidate,
        repository: policy,
        clock: Object.freeze({ now }),
      });
      if (eligibility.kind === "analysis-temporary-unavailable")
        throw internalFailure(job.attemptId);
      const rankedPolicy =
        eligibility.kind === "competitive-eligible"
          ? issueRankedPolicy?.(eligibility.activation)
          : undefined;
      const candidate = terminalCandidate({
        attemptId: job.attemptId,
        candidate: integrity.candidate,
        competitiveStatus: rankedPolicy
          ? eligibility.competitiveStatus
          : eligibility.kind === "competitive-eligible"
            ? "experimental"
            : eligibility.competitiveStatus,
        competitiveEligible: rankedPolicy
          ? eligibility.competitiveEligible
          : false,
        completedAt: now(),
      });
      return rankedPolicy
        ? bindRankedCandidatePolicyFinalization(candidate, rankedPolicy)
        : candidate;
    } catch (error) {
      if (
        error instanceof ExpectedProcessingFailure ||
        error instanceof VerifiedTemporaryAnalysisError
      )
        throw error;
      throw internalFailure(job.attemptId);
    }
  };
}

function terminalCandidate(
  input: Readonly<{
    attemptId: string;
    candidate: Parameters<typeof scoreVerifiedCandidate>[0];
    competitiveStatus: "ranked" | "demo" | "experimental";
    competitiveEligible: boolean;
    completedAt: string;
  }>,
): TerminalCandidate {
  const score = scoreVerifiedCandidate(input.candidate);
  const provenance = candidateProvenance(input.candidate);
  if (input.competitiveStatus === "ranked") {
    if (!input.competitiveEligible || provenance.kind !== "roboflow")
      throw new Error("Invalid ranked verified result.");
    return Object.freeze({
      state: "valid" as const,
      result: Object.freeze({
        kind: "verified-result" as const,
        attemptId: input.attemptId,
        challengeId: score.challengeId,
        challengeVersion: score.challengeVersion,
        ruleVersion: score.ruleVersion,
        provenance,
        metrics: score.metrics,
        score: score.score,
        completedAt: input.completedAt,
        competitiveStatus: "ranked" as const,
        competitiveEligible: true as const,
      }),
    });
  }
  if (input.competitiveEligible)
    throw new Error("Invalid unranked verified result.");
  const result = VerifiedResultSchema.parse({
    kind: "verified-result" as const,
    attemptId: input.attemptId,
    challengeId: score.challengeId,
    challengeVersion: score.challengeVersion,
    ruleVersion: score.ruleVersion,
    provenance,
    metrics: score.metrics,
    score: score.score,
    completedAt: input.completedAt,
    competitiveStatus: input.competitiveStatus,
    competitiveEligible: false,
  });
  return Object.freeze({ state: "valid" as const, result });
}

function candidateProvenance(
  candidate: VerifiedAttemptCandidate,
): VerifiedResult["provenance"] {
  // candidatePolicyFacts is deliberately the only C7 capability-to-public
  // provenance bridge. Keeping it local prevents raw observations leaking.
  return candidatePolicyFacts(candidate).provenance;
}

function invalidFailure(
  attemptId: string,
  code:
    | "capture_requirements_not_met"
    | "video_not_continuous"
    | "calibration_not_verified"
    | "tracking_insufficient",
): ExpectedProcessingFailure {
  switch (code) {
    case "capture_requirements_not_met":
      return new ExpectedProcessingFailure(
        Object.freeze({
          state: "invalid" as const,
          attemptId,
          mode: "verified" as const,
          code,
          message: InvalidRetryMessageByCode.capture_requirements_not_met,
          retryable: true as const,
        }),
      );
    case "video_not_continuous":
      return new ExpectedProcessingFailure(
        Object.freeze({
          state: "invalid" as const,
          attemptId,
          mode: "verified" as const,
          code,
          message: InvalidRetryMessageByCode.video_not_continuous,
          retryable: true as const,
        }),
      );
    case "calibration_not_verified":
      return new ExpectedProcessingFailure(
        Object.freeze({
          state: "invalid" as const,
          attemptId,
          mode: "verified" as const,
          code,
          message: InvalidRetryMessageByCode.calibration_not_verified,
          retryable: true as const,
        }),
      );
    case "tracking_insufficient":
      return new ExpectedProcessingFailure(
        Object.freeze({
          state: "invalid" as const,
          attemptId,
          mode: "verified" as const,
          code,
          message: InvalidRetryMessageByCode.tracking_insufficient,
          retryable: true as const,
        }),
      );
  }
}

function configurationFailure(attemptId: string): ExpectedProcessingFailure {
  return new ExpectedProcessingFailure(
    Object.freeze({
      state: "failed" as const,
      attemptId,
      mode: "verified" as const,
      code: "analysis_configuration_invalid" as const,
      message: FailureMessageByCode.analysis_configuration_invalid,
      retryable: false as const,
    }),
  );
}

function internalFailure(attemptId: string): ExpectedProcessingFailure {
  return new ExpectedProcessingFailure(
    Object.freeze({
      state: "failed" as const,
      attemptId,
      mode: "verified" as const,
      code: "analysis_internal_error" as const,
      message: FailureMessageByCode.analysis_internal_error,
      retryable: false as const,
    }),
  );
}

function verifiedUpload(
  persisted: PersistedProcessingContext,
): Extract<PersistedProcessingContext["upload"], { mode: "verified" }> {
  if (
    persisted.upload.mode !== "verified" ||
    persisted.upload.verified === null
  )
    throw new Error(
      "Verified processor received non-Verified durable context.",
    );
  return persisted.upload;
}

function authorityFor(
  persisted: PersistedProcessingContext,
  upload: Extract<PersistedProcessingContext["upload"], { mode: "verified" }>,
): DurableReconstructionAuthority {
  const { processing, sourceSha256 } = persisted;
  return Object.freeze({
    upload: Object.freeze({
      attemptId: upload.attemptId,
      athleteId: upload.athleteId,
      generation: upload.generation,
      mode: upload.mode,
      mediaId: processing.receipt.mediaId,
      sourceSha256,
      uploadedAt: upload.uploadedAt,
      calibrationSessionId: upload.verified.calibrationSessionId,
      calibrationNonce: upload.verified.calibrationNonce,
    }),
  });
}

function assertVerifiedClaim(
  claim: ProcessingClaim,
): asserts claim is ProcessingClaim & Readonly<{ mode: "verified" }> {
  if (claim.mode !== "verified")
    throw new Error(
      "Verified processor received a non-Verified processing claim.",
    );
}

function assertVerifiedManifest(
  manifest: ExtractionManifest,
  attemptId: string,
  claim: ProcessingClaim,
): asserts manifest is Extract<
  ExtractionManifest,
  Readonly<{ mode: "verified" }>
> {
  if (
    manifest.mode !== "verified" ||
    manifest.attemptId !== attemptId ||
    manifest.generation !== claim.generation
  )
    throw new Error("Verified durable manifest binding mismatch.");
}
