import type {
  AttemptMode,
  AttemptOutcome,
  CreateAttemptInput,
} from "@revelai/contracts";
import type { AnalysisJob } from "../queue/analysis-queue.js";

export type StoredMedia = Readonly<{
  id: string;
  contentType: string;
  bytes: number;
  deleteAt: string;
}>;

export type CalibrationSessionRecord = Readonly<{
  id: string;
  challengeId: "wall-pass";
  challengeVersion: 1;
  state: "issued" | "ready";
  nonce: string;
  issuedAt: string;
  expiresAt: string;
  requiredGates: readonly ["device", "space", "athlete", "rehearsal", "record"];
}>;

export type AttemptRecord = Readonly<{
  id: string;
  athleteId: string;
  mode: AttemptMode;
  status:
    | "awaiting-upload"
    | "uploaded"
    | "processing"
    | "valid"
    | "invalid"
    | "failed";
  createdAt: string;
  outcome: AttemptOutcome;
  challenge: Readonly<{ id: "wall-pass"; version: 1 }> | null;
  media: StoredMedia | null;
}>;

export type ProcessingClaim = Readonly<{
  leaseId: string;
  generation: number;
}>;

export type FinalizedAttempt = Readonly<{
  attempt: AttemptRecord;
  outcome: AttemptOutcome;
}>;

export type FinalizeTerminalResultInput = Readonly<{
  attemptId: string;
  leaseId: string;
  generation: number;
  outcome: AttemptOutcome;
}>;

export interface AttemptRepository {
  issueCalibrationSession(
    input: Readonly<{
      id: string;
      athleteId: string;
      nonce: string;
      challengeId: "wall-pass";
      challengeVersion: 1;
    }>,
  ): Promise<CalibrationSessionRecord>;
  getCalibrationSession(
    input: Readonly<{ id: string; athleteId: string }>,
  ): Promise<CalibrationSessionRecord | null>;
  readyCalibrationSession(
    input: Readonly<{
      id: string;
      athleteId: string;
      requiredGates: readonly [
        "device",
        "space",
        "athlete",
        "rehearsal",
        "record",
      ];
    }>,
  ): Promise<void>;
  createAttempt(
    input: Readonly<{
      id: string;
      athleteId: string;
      input: CreateAttemptInput;
    }>,
  ): Promise<AttemptRecord>;
  getAttempt(
    input: Readonly<{ attemptId: string; athleteId: string }>,
  ): Promise<AttemptRecord | null>;
  listAttempts(
    input: Readonly<{ athleteId: string; limit: number; cursor?: string }>,
  ): Promise<
    Readonly<{ items: readonly AttemptRecord[]; nextCursor: string | null }>
  >;
  attachValidatedMedia(
    input: Readonly<{
      attemptId: string;
      athleteId: string;
      media: StoredMedia;
    }>,
  ): Promise<AnalysisJob>;
  rollbackMediaAttachment(
    input: Readonly<{ attemptId: string; athleteId: string; mediaId: string }>,
  ): Promise<void>;
  claimProcessing(job: AnalysisJob): Promise<ProcessingClaim | null>;
  finalizeTerminalResult(
    input: FinalizeTerminalResultInput,
  ): Promise<FinalizedAttempt | null>;
  tombstoneAttempt(
    input: Readonly<{ attemptId: string; athleteId: string }>,
  ): Promise<void>;
}
