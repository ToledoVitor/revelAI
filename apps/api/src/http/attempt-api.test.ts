import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AttemptListResponseSchema,
  CalibrationSessionSchema,
  ChallengeListResponseSchema,
  CreateAttemptResponseSchema,
  RouteErrorSchema,
} from "@revelai/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openSqliteDatabase } from "../database/sqlite-database.js";
import { SQLiteAttemptRepository } from "../repositories/sqlite-attempt-repository.js";
import { createAttemptApi } from "./attempt-api.js";

const ATHLETE_A = "11111111-1111-4111-8111-111111111111";
const ATHLETE_B = "22222222-2222-4222-8222-222222222222";
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("attempt HTTP foundation", () => {
  it("serves the C2 challenge, calibration, and attempt lifecycle with header-only ownership", async () => {
    const fixture = await makeApi();
    const publicChallenges = await fixture.app.inject({
      method: "GET",
      url: "/v1/challenges",
    });
    expect(publicChallenges.statusCode).toBe(200);
    expect(ChallengeListResponseSchema.parse(publicChallenges.json())).toEqual({
      items: [
        {
          id: "wall-pass",
          version: 1,
          sport: "futsal",
          activeDurationSeconds: 60,
          calibrationPreRollSeconds: 4,
          requiredGates: ["device", "space", "athlete", "rehearsal", "record"],
        },
      ],
    });
    const challengeQuery = await fixture.app.inject({
      method: "GET",
      url: "/v1/challenges?unexpected=true",
    });
    expect(challengeQuery.statusCode).toBe(400);
    expect(RouteErrorSchema.parse(challengeQuery.json()).code).toBe(
      "invalid_request",
    );

    const invalidIdentity = await fixture.app.inject({
      method: "POST",
      url: "/v1/calibration-sessions",
      payload: "not json",
      headers: { "content-type": "application/json" },
    });
    expect(invalidIdentity.statusCode).toBe(400);
    expect(RouteErrorSchema.parse(invalidIdentity.json()).code).toBe(
      "invalid_athlete_identity",
    );

    const multipleIdentity = await fixture.app.inject({
      method: "POST",
      url: "/v1/calibration-sessions",
      headers: {
        "x-revelai-athlete-id": [ATHLETE_A, ATHLETE_A],
        "content-type": "application/json",
      },
      payload: "not json",
    });
    expect(multipleIdentity.statusCode).toBe(400);
    expect(RouteErrorSchema.parse(multipleIdentity.json()).code).toBe(
      "invalid_athlete_identity",
    );

    const sessionReply = await fixture.app.inject({
      method: "POST",
      url: "/v1/calibration-sessions",
      headers: athleteHeader(ATHLETE_A),
      payload: { challengeId: "wall-pass", challengeVersion: 1 },
    });
    expect(sessionReply.statusCode).toBe(201);
    const session = CalibrationSessionSchema.parse(sessionReply.json());
    expect(session).toMatchObject({
      id: "33333333-3333-4333-8333-333333333333",
      state: "issued",
      nonce: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    });

    const wrongOwner = await fixture.app.inject({
      method: "POST",
      url: `/v1/calibration-sessions/${session.id}/ready`,
      headers: athleteHeader(ATHLETE_B),
      payload: { requiredGates: session.requiredGates },
    });
    expect(wrongOwner.statusCode).toBe(404);
    expect(RouteErrorSchema.parse(wrongOwner.json()).code).toBe(
      "calibration_session_not_found",
    );

    const ready = await fixture.app.inject({
      method: "POST",
      url: `/v1/calibration-sessions/${session.id}/ready`,
      headers: athleteHeader(ATHLETE_A),
      payload: { requiredGates: session.requiredGates },
    });
    expect(ready.statusCode).toBe(204);
    expect(ready.body).toBe("");

    const duplicateReady = await fixture.app.inject({
      method: "POST",
      url: `/v1/calibration-sessions/${session.id}/ready`,
      headers: athleteHeader(ATHLETE_A),
      payload: { requiredGates: session.requiredGates },
    });
    expect(duplicateReady.statusCode).toBe(409);
    expect(RouteErrorSchema.parse(duplicateReady.json()).code).toBe(
      "calibration_session_not_ready",
    );

    const verified = await fixture.app.inject({
      method: "POST",
      url: "/v1/attempts",
      headers: athleteHeader(ATHLETE_A),
      payload: {
        mode: "verified",
        challengeId: "wall-pass",
        challengeVersion: 1,
        calibrationSessionId: session.id,
      },
    });
    expect(verified.statusCode).toBe(201);
    expect(CreateAttemptResponseSchema.parse(verified.json())).toMatchObject({
      id: "44444444-4444-4444-8444-444444444444",
      mode: "verified",
      status: "awaiting-upload",
    });

    const consumed = await fixture.app.inject({
      method: "POST",
      url: "/v1/attempts",
      headers: athleteHeader(ATHLETE_A),
      payload: {
        mode: "verified",
        challengeId: "wall-pass",
        challengeVersion: 1,
        calibrationSessionId: session.id,
      },
    });
    expect(consumed.statusCode).toBe(409);
    expect(RouteErrorSchema.parse(consumed.json()).code).toBe(
      "calibration_session_consumed",
    );

    const free = await fixture.app.inject({
      method: "POST",
      url: "/v1/attempts",
      headers: athleteHeader(ATHLETE_A),
      payload: { mode: "free" },
    });
    expect(free.statusCode).toBe(201);
    expect(CreateAttemptResponseSchema.parse(free.json()).mode).toBe("free");
    await fixture.close();
  });

  it("expires an owned calibration session and maps a well-formed invalid body without framework details", async () => {
    const fixture = await makeApi();
    const sessionReply = await fixture.app.inject({
      method: "POST",
      url: "/v1/calibration-sessions",
      headers: athleteHeader(ATHLETE_A),
      payload: { challengeId: "wall-pass", challengeVersion: 1 },
    });
    const session = CalibrationSessionSchema.parse(sessionReply.json());
    fixture.setNow("2030-01-15T12:15:00.000Z");

    const expired = await fixture.app.inject({
      method: "POST",
      url: `/v1/calibration-sessions/${session.id}/ready`,
      headers: athleteHeader(ATHLETE_A),
      payload: { requiredGates: session.requiredGates },
    });
    expect(expired.statusCode).toBe(410);
    expect(RouteErrorSchema.parse(expired.json()).code).toBe(
      "calibration_session_expired",
    );

    const malformedBody = await fixture.app.inject({
      method: "POST",
      url: "/v1/attempts",
      headers: athleteHeader(ATHLETE_A),
      payload: { mode: "free", athleteId: ATHLETE_B },
    });
    expect(malformedBody.statusCode).toBe(400);
    expect(RouteErrorSchema.parse(malformedBody.json()).code).toBe(
      "invalid_request",
    );
    await fixture.close();
  });

  it("keeps list pagination opaque and scoped, rejects malformed requests, and drains the auto-started runtime on close", async () => {
    const fixture = await makeApi();
    const create = async (athleteId: string) =>
      fixture.app.inject({
        method: "POST",
        url: "/v1/attempts",
        headers: athleteHeader(athleteId),
        payload: { mode: "free" },
      });
    await create(ATHLETE_A);
    await create(ATHLETE_A);
    await create(ATHLETE_B);

    const firstPage = await fixture.app.inject({
      method: "GET",
      url: "/v1/attempts?limit=1",
      headers: athleteHeader(ATHLETE_A),
    });
    expect(firstPage.statusCode).toBe(200);
    const first = AttemptListResponseSchema.parse(firstPage.json());
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).toEqual(expect.any(String));
    expect(first.items[0]!.id).toBe("44444444-4444-4444-8444-444444444444");
    expect(first.nextCursor).not.toContain(first.items[0]!.id);
    expect(first.items[0]).not.toHaveProperty("athleteId");
    expect(first.items[0]).not.toHaveProperty("media");

    const secondPage = await fixture.app.inject({
      method: "GET",
      url: `/v1/attempts?limit=1&cursor=${encodeURIComponent(first.nextCursor!)}`,
      headers: athleteHeader(ATHLETE_A),
    });
    expect(secondPage.statusCode).toBe(200);
    const second = AttemptListResponseSchema.parse(secondPage.json());
    expect(second.items).toHaveLength(1);
    expect(second.items[0]!.id).not.toBe(first.items[0]!.id);

    const otherAthlete = await fixture.app.inject({
      method: "GET",
      url: "/v1/attempts?limit=50",
      headers: athleteHeader(ATHLETE_B),
    });
    expect(
      AttemptListResponseSchema.parse(otherAthlete.json()).items,
    ).toHaveLength(1);

    const invalidQuery = await fixture.app.inject({
      method: "GET",
      url: "/v1/attempts?limit=51&unexpected=true",
      headers: athleteHeader(ATHLETE_A),
    });
    expect(invalidQuery.statusCode).toBe(400);
    expect(RouteErrorSchema.parse(invalidQuery.json()).code).toBe(
      "invalid_request",
    );

    const unmatched = await fixture.app.inject({
      method: "GET",
      url: "/v1/not-a-route",
      headers: athleteHeader(ATHLETE_A),
    });
    expect(unmatched.statusCode).toBe(400);
    expect(RouteErrorSchema.parse(unmatched.json()).code).toBe(
      "invalid_request",
    );

    expect(fixture.scheduled).toHaveLength(1);
    await fixture.close();
    expect(fixture.cancelled).toBe(1);
  });

  it("uses an unrefed hourly scheduler by default and still cancels it on close", async () => {
    const timer = { unref: vi.fn() };
    const setIntervalSpy = vi
      .spyOn(global, "setInterval")
      .mockReturnValue(timer as never);
    const clearIntervalSpy = vi
      .spyOn(global, "clearInterval")
      .mockImplementation(() => undefined);
    try {
      const fixture = await makeApi({ useDefaultScheduler: true });
      expect(setIntervalSpy).toHaveBeenCalledTimes(1);
      expect(timer.unref).toHaveBeenCalledTimes(1);
      await fixture.close();
      expect(clearIntervalSpy).toHaveBeenCalledWith(timer);
    } finally {
      setIntervalSpy.mockRestore();
      clearIntervalSpy.mockRestore();
    }
  });

  it("rejects a second Fastify owner for one repository without disturbing the first, then reopens after close", async () => {
    const fixture = await makeApi();
    const secondScheduler = {
      everyHour: () => ({ timer: 2 }),
      cancel: () => undefined,
    };
    expect(() =>
      createAttemptApi({
        repository: fixture.repository,
        queue: { enqueue: async () => undefined },
        cleaner: { cleanup: async () => undefined },
        scheduler: secondScheduler,
        recoveryBatchLimit: 10,
      }),
    ).toThrow("C8 recovery runtime already has an active owner.");
    await expect(
      fixture.app.inject({ method: "GET", url: "/v1/challenges" }),
    ).resolves.toMatchObject({ statusCode: 200 });

    await fixture.app.close();
    const reopened = createAttemptApi({
      repository: fixture.repository,
      queue: { enqueue: async () => undefined },
      cleaner: { cleanup: async () => undefined },
      scheduler: secondScheduler,
      recoveryBatchLimit: 10,
    });
    await expect(
      reopened.inject({ method: "GET", url: "/v1/challenges" }),
    ).resolves.toMatchObject({ statusCode: 200 });
    await reopened.close();
    fixture.database.close();
  });

  it("rejects invalid generated identifiers and nonces before creating athlete, session, or attempt rows", async () => {
    const invalidSession = await makeApi({
      ids: () => "not-a-uuid",
      nonce: () => "not-a-nonce",
    });
    const sessionReply = await invalidSession.app.inject({
      method: "POST",
      url: "/v1/calibration-sessions",
      headers: athleteHeader(ATHLETE_A),
      payload: { challengeId: "wall-pass", challengeVersion: 1 },
    });
    expect(sessionReply.statusCode).toBe(503);
    expect(RouteErrorSchema.parse(sessionReply.json()).code).toBe(
      "service_not_ready",
    );
    expect(
      invalidSession.database.raw
        .prepare("SELECT COUNT(*) AS count FROM athletes")
        .get(),
    ).toEqual({ count: 0 });
    expect(
      invalidSession.database.raw
        .prepare("SELECT COUNT(*) AS count FROM calibration_sessions")
        .get(),
    ).toEqual({ count: 0 });
    await invalidSession.close();

    const nonCanonicalNonce = await makeApi({
      nonce: () => `${"A".repeat(42)}B`,
    });
    const nonCanonicalNonceReply = await nonCanonicalNonce.app.inject({
      method: "POST",
      url: "/v1/calibration-sessions",
      headers: athleteHeader(ATHLETE_A),
      payload: { challengeId: "wall-pass", challengeVersion: 1 },
    });
    expect(nonCanonicalNonceReply.statusCode).toBe(503);
    expect(
      nonCanonicalNonce.database.raw
        .prepare("SELECT COUNT(*) AS count FROM athletes")
        .get(),
    ).toEqual({ count: 0 });
    await nonCanonicalNonce.close();

    const invalidAttempt = await makeApi({
      ids: () => "not-a-uuid",
    });
    const attemptReply = await invalidAttempt.app.inject({
      method: "POST",
      url: "/v1/attempts",
      headers: athleteHeader(ATHLETE_A),
      payload: { mode: "free" },
    });
    expect(attemptReply.statusCode).toBe(503);
    expect(
      invalidAttempt.database.raw
        .prepare("SELECT COUNT(*) AS count FROM athletes")
        .get(),
    ).toEqual({ count: 0 });
    expect(
      invalidAttempt.database.raw
        .prepare("SELECT COUNT(*) AS count FROM attempts")
        .get(),
    ).toEqual({ count: 0 });
    await invalidAttempt.close();

    const duplicate = await makeApi({
      ids: () => "33333333-3333-4333-8333-333333333333",
      nonce: () => "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    });
    const request = {
      method: "POST" as const,
      url: "/v1/calibration-sessions",
      headers: athleteHeader(ATHLETE_A),
      payload: { challengeId: "wall-pass" as const, challengeVersion: 1 },
    };
    expect((await duplicate.app.inject(request)).statusCode).toBe(201);
    const duplicateReply = await duplicate.app.inject(request);
    expect(duplicateReply.statusCode).toBe(503);
    expect(RouteErrorSchema.parse(duplicateReply.json()).code).toBe(
      "service_not_ready",
    );
    expect(
      duplicate.database.raw
        .prepare("SELECT COUNT(*) AS count FROM calibration_sessions")
        .get(),
    ).toEqual({ count: 1 });
    await duplicate.close();

    const duplicateAttempt = await makeApi({
      ids: () => "44444444-4444-4444-8444-444444444444",
    });
    const attemptRequest = {
      method: "POST" as const,
      url: "/v1/attempts",
      headers: athleteHeader(ATHLETE_A),
      payload: { mode: "free" as const },
    };
    expect((await duplicateAttempt.app.inject(attemptRequest)).statusCode).toBe(
      201,
    );
    const duplicateAttemptReply =
      await duplicateAttempt.app.inject(attemptRequest);
    expect(duplicateAttemptReply.statusCode).toBe(503);
    expect(RouteErrorSchema.parse(duplicateAttemptReply.json()).code).toBe(
      "service_not_ready",
    );
    expect(
      duplicateAttempt.database.raw
        .prepare("SELECT COUNT(*) AS count FROM attempts")
        .get(),
    ).toEqual({ count: 1 });
    await duplicateAttempt.close();
  });

  it("normalizes malformed URL paths and query injection without echoing framework detail", async () => {
    const fixture = await makeApi();
    for (const url of ["/v1/%ZZ", "/v1/challenges?%ZZ"]) {
      const reply = await fixture.app.inject({ method: "GET", url });
      expect(reply.statusCode).toBe(400);
      expect(RouteErrorSchema.parse(reply.json())).toEqual({
        code: "invalid_request",
        message: "Não foi possível entender esta solicitação.",
        retryable: false,
      });
      expect(reply.headers["content-type"]).toContain("application/json");
      expect(Number(reply.headers["content-length"])).toBe(
        Buffer.byteLength(reply.body),
      );
      expect(reply.body).not.toContain("%ZZ");
      expect(reply.body).not.toContain("FST_ERR");
    }
    await fixture.close();
  });
});

function athleteHeader(athleteId: string): Readonly<Record<string, string>> {
  return { "x-revelai-athlete-id": athleteId };
}

async function makeApi(
  input?: Readonly<{
    useDefaultScheduler?: boolean;
    ids?: () => string;
    nonce?: () => string;
  }>,
) {
  const directory = await mkdtemp(join(tmpdir(), "revelai-attempt-api-"));
  directories.push(directory);
  const database = openSqliteDatabase(join(directory, "api.sqlite"));
  let now = "2030-01-15T12:00:00.000Z";
  const clock = { now: () => now };
  const repository = SQLiteAttemptRepository.forReadOnlyTest({
    database,
    clock,
    ids: { next: () => "ffffffff-ffff-4fff-8fff-ffffffffffff" },
  });
  const ids = [
    "33333333-3333-4333-8333-333333333333",
    "44444444-4444-4444-8444-444444444444",
    "55555555-5555-4555-8555-555555555555",
    "66666666-6666-4666-8666-666666666666",
    "77777777-7777-4777-8777-777777777777",
    "88888888-8888-4888-888888888888",
  ];
  const scheduled: Array<() => void> = [];
  let cancelled = 0;
  const scheduler = input?.useDefaultScheduler
    ? undefined
    : {
        everyHour: (task: () => void) => {
          scheduled.push(task);
          return scheduled.length;
        },
        cancel: () => {
          cancelled += 1;
        },
      };
  const app = createAttemptApi({
    repository,
    queue: { enqueue: async () => undefined },
    cleaner: { cleanup: async () => undefined },
    ...(scheduler ? { scheduler } : {}),
    recoveryBatchLimit: 10,
    clock,
    ids: {
      next: () =>
        input?.ids?.() ?? ids.shift() ?? "99999999-9999-4999-8999-999999999999",
    },
    nonce:
      input?.nonce ?? (() => "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"),
  });
  return {
    app,
    database,
    repository,
    scheduled,
    get cancelled() {
      return cancelled;
    },
    setNow(value: string) {
      now = value;
    },
    async close() {
      await app.close();
      database.close();
    },
  };
}
