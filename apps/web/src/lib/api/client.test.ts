// @vitest-environment node

import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { mediaUploadFixtures, routeErrorFixtures } from "@revelai/contracts";
import { createRevelApiClient } from "./client";

const athleteId = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("Revel API client", () => {
  it("lists challenges from a schema-parsed response and injects the local athlete header", async () => {
    server.use(
      http.get("http://revelai.test/v1/challenges", ({ request }) => {
        expect(request.headers.get("x-revelai-athlete-id")).toBe(athleteId);
        return HttpResponse.json({
          items: [
            {
              id: "wall-pass",
              version: 1,
              sport: "futsal",
              activeDurationSeconds: 60,
              calibrationPreRollSeconds: 4,
              requiredGates: [
                "device",
                "space",
                "athlete",
                "rehearsal",
                "record",
              ],
            },
          ],
        });
      }),
    );

    await expect(
      createRevelApiClient({
        baseUrl: "http://revelai.test",
        athleteId,
      }).listChallenges(),
    ).resolves.toEqual({
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
  });

  it("creates attempts and calibration sessions with contract JSON bodies", async () => {
    server.use(
      http.post("http://revelai.test/v1/attempts", async ({ request }) => {
        expect(request.headers.get("x-revelai-athlete-id")).toBe(athleteId);
        expect(await request.json()).toStrictEqual({ mode: "free" });
        return HttpResponse.json(pendingAttempt("attempt-created"), {
          status: 201,
        });
      }),
      http.post(
        "http://revelai.test/v1/calibration-sessions",
        async ({ request }) => {
          expect(await request.json()).toStrictEqual({
            challengeId: "wall-pass",
            challengeVersion: 1,
          });
          return HttpResponse.json(calibrationSession, { status: 201 });
        },
      ),
    );
    const client = createRevelApiClient({
      baseUrl: "http://revelai.test",
      athleteId,
    });

    await expect(client.createAttempt({ mode: "free" })).resolves.toEqual(
      pendingAttempt("attempt-created"),
    );
    await expect(
      client.createCalibrationSession({
        challengeId: "wall-pass",
        challengeVersion: 1,
      }),
    ).resolves.toEqual(calibrationSession);
  });

  it("marks a calibration session ready with its exact required gates", async () => {
    server.use(
      http.post(
        "http://revelai.test/v1/calibration-sessions/calibration-1/ready",
        async ({ request }) => {
          expect(request.headers.get("x-revelai-athlete-id")).toBe(athleteId);
          expect(await request.json()).toStrictEqual({
            requiredGates: [
              "device",
              "space",
              "athlete",
              "rehearsal",
              "record",
            ],
          });
          return new HttpResponse(null, { status: 204 });
        },
      ),
    );

    await expect(
      createRevelApiClient({
        baseUrl: "http://revelai.test",
        athleteId,
      }).readyCalibrationSession("calibration-1", {
        requiredGates: ["device", "space", "athlete", "rehearsal", "record"],
      }),
    ).resolves.toBeUndefined();
  });

  it("reads attempts, retains server history order, and deletes an attempt", async () => {
    const newer = pendingAttempt("attempt-newer", "2026-08-30T13:00:00.000Z");
    const older = pendingAttempt("attempt-older", "2026-08-30T12:00:00.000Z");
    server.use(
      http.get("http://revelai.test/v1/attempts", ({ request }) => {
        const url = new URL(request.url);
        expect(url.searchParams.get("limit")).toBe("2");
        expect(url.searchParams.get("cursor")).toBe("page-2");
        return HttpResponse.json({ items: [newer, older], nextCursor: null });
      }),
      http.get("http://revelai.test/v1/attempts/attempt-newer", () =>
        HttpResponse.json(newer),
      ),
      http.get("http://revelai.test/v1/attempts/attempt-newer/result", () =>
        HttpResponse.json(newer.outcome, { status: 202 }),
      ),
      http.delete(
        "http://revelai.test/v1/attempts/attempt-newer",
        () => new HttpResponse(null, { status: 204 }),
      ),
    );
    const client = createRevelApiClient({
      baseUrl: "http://revelai.test",
      athleteId,
    });

    await expect(
      client.listAttempts({ limit: 2, cursor: "page-2" }),
    ).resolves.toEqual({ items: [newer, older], nextCursor: null });
    await expect(client.getAttempt("attempt-newer")).resolves.toEqual(newer);
    await expect(client.getAttemptOutcome("attempt-newer")).resolves.toEqual(
      newer.outcome,
    );
    await expect(
      client.deleteAttempt("attempt-newer"),
    ).resolves.toBeUndefined();
  });

  it("reads the contract leaderboard query", async () => {
    server.use(
      http.get(
        "http://revelai.test/v1/leaderboards/wall-pass",
        ({ request }) => {
          const url = new URL(request.url);
          expect(url.search).toBe(
            "?version=1&ruleVersion=wall-pass-v1-score-1&limit=2&cursor=leaders-2",
          );
          return HttpResponse.json(liveLeaderboard);
        },
      ),
    );

    await expect(
      createRevelApiClient({
        baseUrl: "http://revelai.test",
        athleteId,
      }).getLeaderboard({
        version: 1,
        ruleVersion: "wall-pass-v1-score-1",
        limit: 2,
        cursor: "leaders-2",
      }),
    ).resolves.toEqual(liveLeaderboard);
  });

  it("uploads exactly the C2 media file part without an identity JSON field", async () => {
    const accepted = mediaUploadFixtures.accepted.expected;
    if (accepted.kind !== "accepted") {
      throw new Error("The shared accepted upload fixture is required.");
    }
    server.use(
      http.post(
        "http://revelai.test/v1/attempts/attempt-upload-1/media",
        async ({ request }) => {
          expect(request.headers.get("x-revelai-athlete-id")).toBe(athleteId);
          expect(request.headers.get("content-type")).toContain(
            "multipart/form-data",
          );
          const body = await request.text();
          expect(
            body.match(/Content-Disposition: form-data; name="media"/g),
          ).toHaveLength(1);
          expect(body).toContain('filename="attempt.mp4"');
          expect(body).toContain("Content-Type: video/mp4");
          expect(body).not.toContain('name="athleteId"');
          return HttpResponse.json(accepted.body, { status: accepted.status });
        },
      ),
    );

    await expect(
      createRevelApiClient({
        baseUrl: "http://revelai.test",
        athleteId,
      }).uploadAttemptMedia(
        "attempt-upload-1",
        new File(["video"], "attempt.mp4", { type: "video/mp4" }),
      ),
    ).resolves.toEqual(accepted.body);
  });

  it.each(routeErrorFixtures)(
    "retains only the parsed public error fields for $body.code",
    async (fixture) => {
      server.use(
        http.get("http://revelai.test/v1/attempts/attempt-error", () =>
          HttpResponse.json(fixture.body, { status: fixture.status }),
        ),
      );

      await expect(
        createRevelApiClient({
          baseUrl: "http://revelai.test",
          athleteId,
        }).getAttempt("attempt-error"),
      ).rejects.toStrictEqual({ ...fixture.body, status: fixture.status });
    },
  );

  it.each(
    mediaUploadFixtures.rejected.filter(
      (fixture) => fixture.expected.kind !== "no-response",
    ),
  )("uses the shared C2 upload fixture outcome for $name", async (fixture) => {
    const expected = fixture.expected;
    if (expected.kind === "no-response") {
      throw new Error("No-response fixtures belong to the abort test.");
    }
    server.use(
      http.post("http://revelai.test/v1/attempts/attempt-upload-1/media", () =>
        HttpResponse.json(expected.body, { status: expected.status }),
      ),
    );
    const operation = createRevelApiClient({
      baseUrl: "http://revelai.test",
      athleteId,
    }).uploadAttemptMedia(
      "attempt-upload-1",
      new File(["video"], "attempt.mp4", { type: "video/mp4" }),
    );

    if (expected.kind === "accepted") {
      await expect(operation).resolves.toEqual(expected.body);
    } else {
      await expect(operation).rejects.toStrictEqual({
        ...expected.body,
        status: expected.status,
      });
    }
  });

  it("uses the shared C2 no-response fixture for an abort transport outcome", async () => {
    const fixture = mediaUploadFixtures.rejected.find(
      (candidate) => candidate.expected.kind === "no-response",
    );
    if (!fixture || fixture.expected.kind !== "no-response") {
      throw new Error("The shared C2 no-response fixture is required.");
    }
    const controller = new AbortController();
    const fetchWithoutResponse: typeof fetch = (_input, init) => {
      expect(init?.signal).toBe(controller.signal);
      return new Promise((_resolve, reject) => {
        controller.signal.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    };
    const client = createRevelApiClient({
      baseUrl: "http://revelai.test",
      athleteId,
      fetch: fetchWithoutResponse,
    });
    const upload = client.uploadAttemptMedia(
      "attempt-upload-1",
      new File(["video"], "attempt.mp4", { type: "video/mp4" }),
      { signal: controller.signal },
    );

    controller.abort();

    await expect(upload).rejects.toStrictEqual({ kind: "aborted" });
  });

  it.each([
    {
      name: "challenge list",
      handler: http.get("http://revelai.test/v1/challenges", () =>
        HttpResponse.json({
          items: [{ ...challenge, activeDurationSeconds: 59 }],
        }),
      ),
      call: (client: ReturnType<typeof createRevelApiClient>) =>
        client.listChallenges(),
    },
    {
      name: "attempt creation",
      handler: http.post("http://revelai.test/v1/attempts", () =>
        HttpResponse.json(
          { ...pendingAttempt("attempt-malformed"), mode: "invalid" },
          { status: 201 },
        ),
      ),
      call: (client: ReturnType<typeof createRevelApiClient>) =>
        client.createAttempt({ mode: "free" }),
    },
    {
      name: "calibration creation",
      handler: http.post("http://revelai.test/v1/calibration-sessions", () =>
        HttpResponse.json(
          { ...calibrationSession, nonce: "not-a-nonce" },
          { status: 201 },
        ),
      ),
      call: (client: ReturnType<typeof createRevelApiClient>) =>
        client.createCalibrationSession({
          challengeId: "wall-pass",
          challengeVersion: 1,
        }),
    },
    {
      name: "calibration readiness",
      handler: http.post(
        "http://revelai.test/v1/calibration-sessions/calibration-1/ready",
        () => HttpResponse.json({ unexpected: "response" }),
      ),
      call: (client: ReturnType<typeof createRevelApiClient>) =>
        client.readyCalibrationSession("calibration-1", {
          requiredGates: ["device", "space", "athlete", "rehearsal", "record"],
        }),
    },
    {
      name: "attempt read",
      handler: http.get(
        "http://revelai.test/v1/attempts/attempt-malformed",
        () =>
          HttpResponse.json({
            ...pendingAttempt("attempt-malformed"),
            status: "tombstoned",
          }),
      ),
      call: (client: ReturnType<typeof createRevelApiClient>) =>
        client.getAttempt("attempt-malformed"),
    },
    {
      name: "attempt outcome",
      handler: http.get(
        "http://revelai.test/v1/attempts/attempt-malformed/result",
        () => HttpResponse.json({ state: "unknown" }),
      ),
      call: (client: ReturnType<typeof createRevelApiClient>) =>
        client.getAttemptOutcome("attempt-malformed"),
    },
    {
      name: "attempt list",
      handler: http.get("http://revelai.test/v1/attempts", () =>
        HttpResponse.json({ items: [], nextCursor: 1 }),
      ),
      call: (client: ReturnType<typeof createRevelApiClient>) =>
        client.listAttempts(),
    },
    {
      name: "leaderboard",
      handler: http.get("http://revelai.test/v1/leaderboards/wall-pass", () =>
        HttpResponse.json({ ...liveLeaderboard, view: "archive" }),
      ),
      call: (client: ReturnType<typeof createRevelApiClient>) =>
        client.getLeaderboard({
          version: 1,
          ruleVersion: "wall-pass-v1-score-1",
          limit: 20,
        }),
    },
    {
      name: "media upload",
      handler: http.post(
        "http://revelai.test/v1/attempts/attempt-upload-1/media",
        () => HttpResponse.json({ kind: "not-accepted" }, { status: 202 }),
      ),
      call: (client: ReturnType<typeof createRevelApiClient>) =>
        client.uploadAttemptMedia(
          "attempt-upload-1",
          new File(["video"], "attempt.mp4", { type: "video/mp4" }),
        ),
    },
    {
      name: "attempt deletion",
      handler: http.delete(
        "http://revelai.test/v1/attempts/attempt-malformed",
        () => HttpResponse.json({ unexpected: "response" }),
      ),
      call: (client: ReturnType<typeof createRevelApiClient>) =>
        client.deleteAttempt("attempt-malformed"),
    },
  ])("rejects a malformed $name public response", async ({ handler, call }) => {
    server.use(handler);

    await expect(
      call(
        createRevelApiClient({
          baseUrl: "http://revelai.test",
          athleteId,
        }),
      ),
    ).rejects.toBeDefined();
  });
});

const calibrationSession = {
  id: "calibration-1",
  challengeId: "wall-pass",
  challengeVersion: 1,
  state: "issued",
  nonce: "1234567890123456789012345678901234567890123",
  issuedAt: "2026-08-30T12:00:00.000Z",
  expiresAt: "2026-08-30T12:15:00.000Z",
  requiredGates: ["device", "space", "athlete", "rehearsal", "record"],
} as const;

const challenge = {
  id: "wall-pass",
  version: 1,
  sport: "futsal",
  activeDurationSeconds: 60,
  calibrationPreRollSeconds: 4,
  requiredGates: ["device", "space", "athlete", "rehearsal", "record"],
} as const;

const liveLeaderboard = {
  view: "live",
  challengeId: "wall-pass",
  challengeVersion: 1,
  ruleVersion: "wall-pass-v1-score-1",
  calculatedAt: "2026-08-30T12:00:00.000Z",
  cohortSize: 1,
  entries: [
    {
      entryId: "entry-1",
      rank: 1,
      score: 98,
      completedAt: "2026-08-30T12:00:00.000Z",
    },
  ],
  nextCursor: null,
} as const;

function pendingAttempt(id: string, createdAt = "2026-08-30T12:00:00.000Z") {
  return {
    id,
    mode: "free" as const,
    status: "awaiting-upload" as const,
    createdAt,
    outcome: {
      state: "pending" as const,
      attemptId: id,
      mode: "free" as const,
      status: "awaiting-upload" as const,
    },
  };
}
