export const ATTEMPT_STATUSES = Object.freeze([
  "awaiting-upload",
  "uploaded",
  "processing",
  "valid",
  "invalid",
  "failed",
] as const);

export type AttemptStatus = (typeof ATTEMPT_STATUSES)[number];
export type AttemptMode = "free" | "verified";
export type AttemptDeletionState = "active" | "tombstoned";

export type AttemptLifecycleState = Readonly<{
  id: string;
  mode: AttemptMode;
  status: AttemptStatus;
  deletionState: AttemptDeletionState;
  challenge?: Readonly<{ id: "wall-pass"; version: 1 }>;
}>;

export type AttemptEvent =
  | Readonly<{ type: "media-accepted" }>
  | Readonly<{ type: "queue-claimed" }>
  | Readonly<{
      type: "finalized";
      outcome: "valid" | "invalid" | "failed";
    }>;

export type DomainErrorCode =
  | "invalid_attempt_transition"
  | "invalid_wall_pass_evidence"
  | "invalid_wall_pass_score_input"
  | "invalid_wall_pass_ranking_input";

export class DomainError extends Error {
  public readonly code: DomainErrorCode;

  public constructor(code: DomainErrorCode, message: string) {
    super(message);
    this.name = "DomainError";
    this.code = code;
  }
}

export function isTerminalAttemptStatus(status: AttemptStatus): boolean {
  return status === "valid" || status === "invalid" || status === "failed";
}

export function createFreeAttempt(id: string): AttemptLifecycleState {
  return freezeAttempt({
    id: assertNonEmptyId(id),
    mode: "free",
    status: "awaiting-upload",
    deletionState: "active",
  });
}

export function createVerifiedAttempt(id: string): AttemptLifecycleState {
  return freezeAttempt({
    id: assertNonEmptyId(id),
    mode: "verified",
    status: "awaiting-upload",
    deletionState: "active",
    challenge: { id: "wall-pass", version: 1 },
  });
}

export function advanceAttempt(
  state: AttemptLifecycleState,
  event: AttemptEvent,
): AttemptLifecycleState {
  const validatedEvent = validateAttemptEvent(event);
  assertActive(state);

  switch (validatedEvent.type) {
    case "media-accepted":
      assertTransition(state.status === "awaiting-upload");
      return withStatus(state, "uploaded");
    case "queue-claimed":
      assertTransition(state.status === "uploaded");
      return withStatus(state, "processing");
    case "finalized":
      assertTransition(state.status === "processing");
      return withStatus(state, validatedEvent.outcome);
    default:
      return invalidAttemptTransition();
  }
}

export function tombstoneAttempt(
  state: AttemptLifecycleState,
): AttemptLifecycleState {
  assertTransition(state.deletionState === "active");

  return freezeAttempt({ ...state, deletionState: "tombstoned" });
}

export function retryAttempt(
  terminalAttempt: AttemptLifecycleState,
  newAttemptId: string,
): AttemptLifecycleState {
  assertTransition(
    terminalAttempt.deletionState === "active" &&
      isTerminalAttemptStatus(terminalAttempt.status) &&
      terminalAttempt.id !== newAttemptId,
  );

  return terminalAttempt.mode === "free"
    ? createFreeAttempt(newAttemptId)
    : createVerifiedAttempt(newAttemptId);
}

function withStatus(
  state: AttemptLifecycleState,
  status: AttemptStatus,
): AttemptLifecycleState {
  return freezeAttempt({ ...state, status });
}

function freezeAttempt(state: {
  id: string;
  mode: AttemptMode;
  status: AttemptStatus;
  deletionState: AttemptDeletionState;
  challenge?: Readonly<{ id: "wall-pass"; version: 1 }>;
}): AttemptLifecycleState {
  const challenge = state.challenge
    ? Object.freeze({ ...state.challenge })
    : undefined;
  return Object.freeze({ ...state, ...(challenge ? { challenge } : {}) });
}

function assertActive(state: AttemptLifecycleState): void {
  assertTransition(state.deletionState === "active");
}

function validateAttemptEvent(event: unknown): AttemptEvent {
  if (!isRecord(event) || typeof event.type !== "string") {
    return invalidAttemptTransition();
  }

  switch (event.type) {
    case "media-accepted":
      return Object.freeze({ type: "media-accepted" });
    case "queue-claimed":
      return Object.freeze({ type: "queue-claimed" });
    case "finalized":
      if (
        event.outcome === "valid" ||
        event.outcome === "invalid" ||
        event.outcome === "failed"
      ) {
        return Object.freeze({ type: "finalized", outcome: event.outcome });
      }
      return invalidAttemptTransition();
    default:
      return invalidAttemptTransition();
  }
}

function assertTransition(condition: boolean): asserts condition {
  if (!condition) {
    invalidAttemptTransition();
  }
}

function invalidAttemptTransition(): never {
  throw new DomainError(
    "invalid_attempt_transition",
    "Attempt event is not allowed from the current lifecycle state.",
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function assertNonEmptyId(id: string): string {
  if (id.trim().length === 0) {
    throw new DomainError(
      "invalid_attempt_transition",
      "Attempt identifiers must be non-empty.",
    );
  }

  return id;
}
