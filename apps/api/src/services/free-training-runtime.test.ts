import { FailureMessageByCode, type AttemptOutcome } from "@revelai/contracts";
import { describe, expect, it } from "vitest";
import { registerTestDiagnostic } from "../internal/test-diagnostics.js";
import type { AnalysisJob, AnalysisQueue } from "../queue/analysis-queue.js";
import type {
  FinalizeTerminalResultOutcome,
  FinalizeTerminalResultInput,
  TerminalCandidate,
} from "../repositories/attempt-repository.js";
import {
  ExpectedProcessingFailure,
  type ProcessingRepository,
} from "../workers/analysis-worker.js";
import { createFreeTrainingRuntime } from "./free-training-runtime.js";

const JOB = Object.freeze({
  attemptId: "11111111-1111-4111-8111-111111111111",
  generation: 1,
  mode: "free" as const,
});
const CLAIM = Object.freeze({
  leaseId: "22222222-2222-4222-8222-222222222222",
  generation: 1,
  mode: "free" as const,
});

describe("Free Training fail-closed terminal boundary", () => {
  it.each([
    [
      "ranked verified result",
      {
        state: "valid",
        result: { kind: "verified-result", competitiveStatus: "ranked" },
      },
      "free-forbidden-ranked-finalization",
    ],
    [
      "non-Free valid result",
      {
        state: "valid",
        result: { kind: "verified-result", competitiveStatus: "experimental" },
      },
      "free-forbidden-integrity-scoring",
    ],
    [
      "verified terminal failure",
      {
        state: "failed",
        attemptId: JOB.attemptId,
        mode: "verified",
      },
      "free-forbidden-policy-lookup",
    ],
    [
      "malformed terminal mode",
      {
        state: "invalid",
        attemptId: JOB.attemptId,
        mode: "crossed-boundary",
      },
      "free-forbidden-leaderboard",
    ],
  ] as const)(
    "turns a malformed %s candidate into one safe Free terminal fact",
    async (_label, malformed, expectedDiagnostic) => {
      const fixture = createRuntimeFixture({
        candidate: malformed as unknown as TerminalCandidate,
      });
      try {
        await fixture.queue.deliver(JOB);

        expect(fixture.events).toEqual([
          expectedDiagnostic,
          "free-terminal-persistence",
        ]);
        expect(fixture.finalizations).toEqual([
          expect.objectContaining({
            candidate: {
              state: "failed",
              attemptId: JOB.attemptId,
              mode: "free",
              code: "analysis_internal_error",
              message: FailureMessageByCode.analysis_internal_error,
              retryable: false,
            },
          }),
        ]);
      } finally {
        fixture.cleanupDiagnostic();
        await fixture.runtime.stop();
      }
    },
  );

  it("retries its safe fallback when a stateless fake returns an unsafe terminal outcome", async () => {
    const fixture = createRuntimeFixture({
      candidate: {
        state: "valid",
        result: { kind: "free-insight" },
      } as unknown as TerminalCandidate,
      firstFinalization: Object.freeze({
        kind: "finalized" as const,
        finalized: Object.freeze({
          attempt: {} as never,
          outcome: {
            state: "valid",
            result: { kind: "verified-result" },
          } as AttemptOutcome,
        }),
      }),
    });

    try {
      await fixture.queue.deliver(JOB);

      expect(fixture.events).toEqual([
        "free-terminal-persistence",
        "free-forbidden-finalization",
        "free-terminal-persistence",
      ]);
      expect(fixture.finalizations).toHaveLength(2);
      expect(fixture.finalizations[1]).toEqual(
        expect.objectContaining({
          candidate: expect.objectContaining({
            state: "failed",
            mode: "free",
            code: "analysis_internal_error",
          }),
        }),
      );
    } finally {
      fixture.cleanupDiagnostic();
      await fixture.runtime.stop();
    }
  });
});

function createRuntimeFixture(
  input: Readonly<{
    candidate: TerminalCandidate;
    firstFinalization?: FinalizeTerminalResultOutcome;
  }>,
) {
  const queue = new ManualQueue();
  const events: string[] = [];
  const finalizations: FinalizeTerminalResultInput[] = [];
  let firstFinalization = input.firstFinalization;
  const repository: ProcessingRepository = Object.freeze({
    claimProcessing: async () => CLAIM,
    releaseProcessingClaim: async () => true,
    recordProcessingFailure: async () =>
      Object.freeze({ kind: "recorded" as const, retryAttempt: 1 }),
    deadLetterProcessingClaim: async () =>
      Object.freeze({ kind: "dead-lettered" as const }),
    finalizeTerminalResult: async (finalization) => {
      finalizations.push(finalization);
      const scripted = firstFinalization;
      firstFinalization = undefined;
      return (
        scripted ??
        Object.freeze({
          kind: "finalized" as const,
          finalized: Object.freeze({
            attempt: {} as never,
            outcome: finalization.candidate as AttemptOutcome,
          }),
        })
      );
    },
  });
  const cleanupDiagnostic = registerTestDiagnostic(
    repository,
    Object.freeze({
      onEvent: (event) => events.push(event.kind),
    }),
  );
  const runtime = createFreeTrainingRuntime({
    queue,
    repository,
    analysis: {
      getProcessingContext: async () => {
        throw new ExpectedProcessingFailure(input.candidate);
      },
      reconstruct: async () => {
        throw new Error(
          "terminal candidate fixture must not reconstruct media",
        );
      },
      frames: Object.freeze({
        readFrame: async () => Buffer.alloc(0),
      }),
      provider: {} as never,
      clock: Object.freeze({ now: () => "2030-01-15T12:00:00.000Z" }),
    },
  });
  return Object.freeze({
    queue,
    runtime,
    events,
    finalizations,
    cleanupDiagnostic,
  });
}

class ManualQueue implements AnalysisQueue {
  #deliver: ((job: AnalysisJob) => Promise<void>) | undefined;

  public async isAvailable(): Promise<boolean> {
    return true;
  }

  public async enqueue(): Promise<void> {
    // The test directly invokes the mode-selected delivery.
  }

  public subscribe(deliver: (job: AnalysisJob) => Promise<void>): () => void {
    this.#deliver = deliver;
    return () => {
      this.#deliver = undefined;
    };
  }

  public async deliver(job: AnalysisJob): Promise<void> {
    if (!this.#deliver) throw new Error("Free runtime did not subscribe");
    await this.#deliver(job);
  }
}
