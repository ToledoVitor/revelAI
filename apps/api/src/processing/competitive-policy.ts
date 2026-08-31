import {
  FailureMessageByCode,
  WorkflowBenchmarkReceiptSchema,
} from "@revelai/contracts";

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
  getActivePolicy(input: CompetitivePolicyQuery): Promise<unknown>;
}>;

export type CompetitivePolicyQuery = Readonly<{
  workspaceId: string;
  workflowId: "revelai-wall-pass-geometry-v1";
  workflowVersion: "1.0.0";
  modelBundleId: string;
  providerVersion: string;
  calibrationEvidenceVersion: string;
  challengeId: "wall-pass";
  challengeVersion: 1;
  ruleVersion: "wall-pass-v1-score-1";
}>;

type ParsedInput = Readonly<{
  query: CompetitivePolicyQuery;
  now: string;
  repository: CompetitivePolicyLookup;
}>;

/**
 * Pure policy boundary: provenance selects a tuple, repository selects an
 * approved record, and this function independently checks every returned fact.
 */
export async function evaluateCompetitiveEligibility(
  input: unknown,
): Promise<CompetitiveEligibilityDecision> {
  if (isFreeInput(input)) return experimental();
  if (isDemoInput(input)) return demo();
  const parsed = parseVerifiedRoboflowInput(input);
  if (!parsed) return experimental();
  let candidate: unknown;
  try {
    candidate = await parsed.repository.getActivePolicy(parsed.query);
  } catch {
    return temporaryCompetitivePolicyDecision();
  }
  return isCurrentExactPolicy(candidate, parsed.query, parsed.now)
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

function isFreeInput(value: unknown): boolean {
  return isRecord(value) && value.mode === "free";
}

function isDemoInput(value: unknown): boolean {
  return (
    isRecord(value) &&
    value.mode === "verified" &&
    isRecord(value.provenance) &&
    value.provenance.kind === "demo"
  );
}

function parseVerifiedRoboflowInput(value: unknown): ParsedInput | null {
  if (
    !hasExactKeys(value, [
      "mode",
      "provenance",
      "calibrationEvidenceVersion",
      "challengeId",
      "challengeVersion",
      "ruleVersion",
      "now",
      "repository",
    ]) ||
    value.mode !== "verified" ||
    !hasExactKeys(value.provenance, [
      "kind",
      "workspaceId",
      "workflowId",
      "workflowVersion",
      "modelBundleId",
      "providerVersion",
    ]) ||
    value.provenance.kind !== "roboflow" ||
    !isNonEmptyString(value.provenance.workspaceId) ||
    value.provenance.workflowId !== "revelai-wall-pass-geometry-v1" ||
    value.provenance.workflowVersion !== "1.0.0" ||
    !isNonEmptyString(value.provenance.modelBundleId) ||
    !isNonEmptyString(value.provenance.providerVersion) ||
    !isNonEmptyString(value.calibrationEvidenceVersion) ||
    value.challengeId !== "wall-pass" ||
    value.challengeVersion !== 1 ||
    value.ruleVersion !== "wall-pass-v1-score-1" ||
    !isUtcTimestamp(value.now) ||
    !isLookup(value.repository)
  )
    return null;
  return Object.freeze({
    query: Object.freeze({
      workspaceId: value.provenance.workspaceId,
      workflowId: value.provenance.workflowId,
      workflowVersion: value.provenance.workflowVersion,
      modelBundleId: value.provenance.modelBundleId,
      providerVersion: value.provenance.providerVersion,
      calibrationEvidenceVersion: value.calibrationEvidenceVersion,
      challengeId: "wall-pass",
      challengeVersion: 1,
      ruleVersion: "wall-pass-v1-score-1",
    }),
    now: value.now,
    repository: value.repository,
  });
}

function isCurrentExactPolicy(
  value: unknown,
  query: CompetitivePolicyQuery,
  now: string,
): boolean {
  if (
    !hasExactKeys(value, [
      "id",
      "workspaceId",
      "workflowId",
      "workflowVersion",
      "modelBundleId",
      "providerVersion",
      "calibrationEvidenceVersion",
      "challengeId",
      "challengeVersion",
      "ruleVersion",
      "receiptId",
      "receiptSha256",
      "receiptSchemaVersion",
      "receipt",
    ]) ||
    !isUuid(value.id) ||
    !isNonEmptyString(value.workspaceId) ||
    value.workflowId !== "revelai-wall-pass-geometry-v1" ||
    value.workflowVersion !== "1.0.0" ||
    !isNonEmptyString(value.modelBundleId) ||
    !isNonEmptyString(value.providerVersion) ||
    !isNonEmptyString(value.calibrationEvidenceVersion) ||
    value.challengeId !== "wall-pass" ||
    value.challengeVersion !== 1 ||
    value.ruleVersion !== "wall-pass-v1-score-1" ||
    !isUuid(value.receiptId) ||
    !isDigest(value.receiptSha256) ||
    value.receiptSchemaVersion !== "workflow-benchmark-receipt-v1" ||
    !sameQueryTuple(value, query)
  )
    return false;
  const receipt = WorkflowBenchmarkReceiptSchema.safeParse(value.receipt);
  if (!receipt.success) return false;
  return (
    receipt.data.id === value.receiptId &&
    receipt.data.receiptSha256 === value.receiptSha256 &&
    receipt.data.schemaVersion === value.receiptSchemaVersion &&
    receipt.data.workflow.workspaceId === value.workspaceId &&
    receipt.data.workflow.workflowId === value.workflowId &&
    receipt.data.workflow.workflowVersion === value.workflowVersion &&
    receipt.data.workflow.modelBundleId === value.modelBundleId &&
    receipt.data.workflow.providerVersion === value.providerVersion &&
    receipt.data.status === "passed" &&
    receipt.data.invalidatedAt === null &&
    receipt.data.invalidationReason === null &&
    Date.parse(receipt.data.validUntil) > Date.parse(now)
  );
}

function sameQueryTuple(
  policy: Record<string, unknown>,
  query: CompetitivePolicyQuery,
): boolean {
  return (
    policy.workspaceId === query.workspaceId &&
    policy.workflowId === query.workflowId &&
    policy.workflowVersion === query.workflowVersion &&
    policy.modelBundleId === query.modelBundleId &&
    policy.providerVersion === query.providerVersion &&
    policy.calibrationEvidenceVersion === query.calibrationEvidenceVersion &&
    policy.challengeId === query.challengeId &&
    policy.challengeVersion === query.challengeVersion &&
    policy.ruleVersion === query.ruleVersion
  );
}

function isLookup(value: unknown): value is CompetitivePolicyLookup {
  return isRecord(value) && typeof value.getActivePolicy === "function";
}

function hasExactKeys(
  value: unknown,
  expected: readonly string[],
): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value).sort();
  const expectedKeys = [...expected].sort();
  return (
    keys.length === expectedKeys.length &&
    keys.every((key, index) => key === expectedKeys[index])
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  );
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function isUtcTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const milliseconds = Date.parse(value);
  return (
    Number.isFinite(milliseconds) &&
    new Date(milliseconds).toISOString() === value
  );
}
