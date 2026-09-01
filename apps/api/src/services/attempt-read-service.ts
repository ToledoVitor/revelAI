import {
  AttemptReadResponseSchema,
  AttemptResultResponseSchema,
  type AttemptReadResponse,
  type AttemptResultResponse,
} from "@revelai/contracts";
import type {
  AttemptRecord,
  AttemptRepository,
} from "../repositories/attempt-repository.js";

/** C8's narrow, identity-scoped read port; it exposes no media or C4 facts. */
export type AttemptReadRepository = Pick<AttemptRepository, "getAttempt">;

/** The only read projections available to the HTTP attempt routes. */
export type AttemptReadService = Readonly<{
  read(
    input: Readonly<{ attemptId: string; athleteId: string }>,
  ): Promise<AttemptReadResponse | null>;
  result(
    input: Readonly<{ attemptId: string; athleteId: string }>,
  ): Promise<AttemptResultResponse | null>;
}>;

/**
 * Captures C4's scoped-read closure once and emits only parsed, deeply frozen
 * C2 payloads. Database media, athlete, lease, and recovery fields stay local.
 */
export function createAttemptReadService(
  input: Readonly<{
    repository: AttemptReadRepository;
  }>,
): AttemptReadService {
  const load = input.repository.getAttempt.bind(input.repository);

  return Object.freeze({
    read: async (request) => {
      const attempt = await load(request);
      return attempt ? projectAttemptRead(attempt) : null;
    },
    result: async (request) => {
      const attempt = await load(request);
      return attempt ? projectAttemptResult(attempt) : null;
    },
  });
}

function projectAttemptRead(attempt: AttemptRecord): AttemptReadResponse {
  const common = {
    id: attempt.id,
    mode: attempt.mode,
    status: attempt.status,
    createdAt: attempt.createdAt,
    outcome: attempt.outcome,
  };
  const value =
    attempt.mode === "free"
      ? common
      : attempt.challenge
        ? { ...common, challenge: attempt.challenge }
        : failCorruptAttempt();
  return freeze(AttemptReadResponseSchema.parse(value));
}

function projectAttemptResult(attempt: AttemptRecord): AttemptResultResponse {
  return freeze(AttemptResultResponseSchema.parse(attempt.outcome));
}

function failCorruptAttempt(): never {
  throw new Error("C4 attempt projection is inconsistent.");
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
