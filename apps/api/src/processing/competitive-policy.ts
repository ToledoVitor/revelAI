import {
  FailureMessageByCode,
  WorkflowBenchmarkReceiptSchema,
} from "@revelai/contracts";
import type {
  CompetitivePolicyActivation,
  CompetitivePolicyTuple,
} from "../repositories/competitive-policy-repository.js";
import { CompetitivePolicyLookupUnavailableError } from "../repositories/competitive-policy-repository.js";
import {
  candidatePolicyFacts,
  type VerifiedAttemptCandidate,
} from "./integrity-evaluator.js";

export type CompetitiveEligibilityDecision =
  | Readonly<{
      kind: "competitive-eligible";
      competitiveStatus: "ranked";
      competitiveEligible: true;
    }>
  | Readonly<{
      kind: "competitive-ineligible";
      competitiveStatus: "demo" | "experimental";
      competitiveEligible: false;
    }>
  | Readonly<{
      kind: "analysis-temporary-unavailable";
      code: "analysis_temporary_unavailable";
      message: string;
      retryable: true;
    }>;

export type CompetitivePolicyLookup = Readonly<{
  getActivePolicy(
    input: CompetitivePolicyTuple,
  ): Promise<CompetitivePolicyActivation | null>;
}>;
export type TrustedClock = Readonly<{ now(): string }>;

/**
 * Ranking is only reachable from the opaque valid integrity candidate. Demo
 * candidates are deliberately terminally noncompetitive and perform no lookup.
 */
export async function evaluateCompetitiveEligibility(
  input: Readonly<{
    candidate: VerifiedAttemptCandidate;
    repository: CompetitivePolicyLookup;
    clock: TrustedClock;
  }>,
): Promise<CompetitiveEligibilityDecision> {
  let facts;
  try {
    facts = candidatePolicyFacts(input.candidate);
  } catch {
    return experimental();
  }
  if (facts.provenance.kind === "demo") return demo();
  const query: CompetitivePolicyTuple = Object.freeze({
    workspaceId: facts.provenance.workspaceId,
    workflowId: facts.provenance.workflowId,
    workflowVersion: facts.provenance.workflowVersion,
    modelBundleId: facts.provenance.modelBundleId,
    providerVersion: facts.provenance.providerVersion,
    calibrationEvidenceVersion: facts.calibrationEvidenceVersion,
    challengeId: "wall-pass",
    challengeVersion: 1,
    ruleVersion: "wall-pass-v1-score-1",
  });
  let activation: CompetitivePolicyActivation | null;
  try {
    activation = await input.repository.getActivePolicy(query);
  } catch (error) {
    return error instanceof CompetitivePolicyLookupUnavailableError
      ? temporaryCompetitivePolicyDecision()
      : experimental();
  }
  return isCurrentExactPolicy(
    activation,
    query,
    facts.execution,
    input.clock.now(),
  )
    ? eligible()
    : experimental();
}

export function temporaryCompetitivePolicyDecision(): CompetitiveEligibilityDecision {
  return Object.freeze({
    kind: "analysis-temporary-unavailable",
    code: "analysis_temporary_unavailable",
    message: FailureMessageByCode.analysis_temporary_unavailable,
    retryable: true,
  });
}

function isCurrentExactPolicy(
  activation: CompetitivePolicyActivation | null,
  query: CompetitivePolicyTuple,
  execution: Readonly<{
    schedulerId: "verified-wall-pass-image-scheduler-v1";
    samplingId: "wall-pass-v1-10fps-640-v1";
  }>,
  now: string,
): boolean {
  if (!activation || !isUtcTimestamp(now) || !sameTuple(activation, query))
    return false;
  const receipt = WorkflowBenchmarkReceiptSchema.safeParse(activation.receipt);
  if (!receipt.success) return false;
  return (
    receipt.data.id === activation.receiptId &&
    receipt.data.receiptSha256 === activation.receiptSha256 &&
    receipt.data.schemaVersion === activation.receiptSchemaVersion &&
    receipt.data.workflow.workspaceId === activation.workspaceId &&
    receipt.data.workflow.workflowId === activation.workflowId &&
    receipt.data.workflow.workflowVersion === activation.workflowVersion &&
    receipt.data.workflow.modelBundleId === activation.modelBundleId &&
    receipt.data.workflow.providerVersion === activation.providerVersion &&
    receipt.data.scheduler.id === execution.schedulerId &&
    receipt.data.sampling.id === execution.samplingId &&
    receipt.data.status === "passed" &&
    receipt.data.invalidatedAt === null &&
    receipt.data.invalidationReason === null &&
    Date.parse(receipt.data.runAt) <= Date.parse(now) &&
    Date.parse(now) < Date.parse(receipt.data.validUntil)
  );
}

function sameTuple(
  activation: CompetitivePolicyActivation,
  query: CompetitivePolicyTuple,
): boolean {
  return (
    activation.workspaceId === query.workspaceId &&
    activation.workflowId === query.workflowId &&
    activation.workflowVersion === query.workflowVersion &&
    activation.modelBundleId === query.modelBundleId &&
    activation.providerVersion === query.providerVersion &&
    activation.calibrationEvidenceVersion ===
      query.calibrationEvidenceVersion &&
    activation.challengeId === query.challengeId &&
    activation.challengeVersion === query.challengeVersion &&
    activation.ruleVersion === query.ruleVersion
  );
}
function isUtcTimestamp(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}
function eligible(): CompetitiveEligibilityDecision {
  return Object.freeze({
    kind: "competitive-eligible",
    competitiveStatus: "ranked",
    competitiveEligible: true,
  });
}
function demo(): CompetitiveEligibilityDecision {
  return Object.freeze({
    kind: "competitive-ineligible",
    competitiveStatus: "demo",
    competitiveEligible: false,
  });
}
function experimental(): CompetitiveEligibilityDecision {
  return Object.freeze({
    kind: "competitive-ineligible",
    competitiveStatus: "experimental",
    competitiveEligible: false,
  });
}
