import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import ts from "typescript";
import {
  AttemptListResponseSchema,
  AttemptReadResponseSchema,
  AttemptResultResponseSchema,
  CalibrationSessionSchema,
  ChallengeListResponseSchema,
  CreateAttemptResponseSchema,
  MediaUploadAcceptedSchema,
  mediaUploadFixtures,
  routeErrorFixtures,
  RouteErrorSchema,
} from "@revelai/contracts";
import { type FastifyInstance, type InjectOptions } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  openSqliteDatabase,
  openSqliteDatabaseAtVersionForTest,
} from "../database/sqlite-database.js";
import {
  createStoredMediaAttachment,
  type TerminalCandidate,
} from "../repositories/attempt-repository.js";
import { SQLiteAttemptRepository } from "../repositories/sqlite-attempt-repository.js";
import { createC5PipelineTestSupport } from "../media/c5-pipeline-test-support.js";
import { MediaPipelineError } from "../media/probe.js";
import { SQLiteRetentionRepository } from "../media/sqlite-retention-repository.js";
import {
  RetentionScavenger,
  type RetentionLog,
} from "../media/retention-scavenger.js";
import type { LocalMediaProber } from "../storage/local-media-storage.js";
import { createLocalC8AcceptedMediaCleaner } from "../services/local-c8-accepted-media-cleaner.js";
import type { MediaUploadService } from "../services/media-upload-service.js";
import {
  InMemoryAnalysisQueue,
  resolveFactoryIssuedAnalysisQueuePort,
} from "../queue/in-memory-analysis-queue.js";
import {
  createFactoryIssuedMediaUploadService,
  createFactoryIssuedRetentionRuntimeFactory,
  createProductionAttemptApi,
  createProductionAttemptApiFromResolvedQueue,
} from "../composition/sqlite-media-upload-composition.js";
import {
  createAttemptApi,
  createInternallyComposedAttemptApi,
} from "./attempt-api.js";
import { apiRoute, apiRouteRegistry, fastifyRoutePath } from "./openapi.js";

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
  it("exposes liveness and offline demo readiness from the official composition", async () => {
    const fixture = await makeMediaApi();
    try {
      const health = await fixture.app.inject({
        method: "GET",
        url: "/health",
      });
      const ready = await fixture.app.inject({ method: "GET", url: "/ready" });

      expect(health.statusCode).toBe(200);
      expect(health.json()).toEqual({ status: "ok" });
      expect(ready.statusCode).toBe(200);
      expect(ready.json()).toEqual({ status: "ready" });
    } finally {
      await fixture.close();
    }
  });

  it("replays a Free create causally for one athlete and creates one row", async () => {
    const fixture = await makeApi();
    const idempotencyKey = "a1111111-1111-4111-8111-111111111111";
    try {
      const first = await fixture.app.inject({
        method: "POST",
        url: "/v1/attempts",
        headers: {
          ...athleteHeader(ATHLETE_A),
          "idempotency-key": idempotencyKey,
        },
        payload: { mode: "free" },
      });
      const replay = await fixture.app.inject({
        method: "POST",
        url: "/v1/attempts",
        headers: {
          ...athleteHeader(ATHLETE_A),
          "idempotency-key": idempotencyKey,
        },
        payload: { mode: "free" },
      });

      expect(first.statusCode).toBe(201);
      expect(replay.statusCode).toBe(201);
      expect(CreateAttemptResponseSchema.parse(replay.json()).id).toBe(
        CreateAttemptResponseSchema.parse(first.json()).id,
      );
      expect(
        fixture.database.raw
          .prepare(
            "SELECT COUNT(*) AS count FROM attempts WHERE athlete_id = ? AND idempotency_key = ?",
          )
          .get(ATHLETE_A, idempotencyKey),
      ).toEqual({ count: 1 });
    } finally {
      await fixture.close();
    }
  });

  it("keeps an idempotency key scoped to its athlete", async () => {
    const fixture = await makeApi();
    const idempotencyKey = "b1111111-1111-4111-8111-111111111111";
    try {
      const first = await fixture.app.inject({
        method: "POST",
        url: "/v1/attempts",
        headers: {
          ...athleteHeader(ATHLETE_A),
          "idempotency-key": idempotencyKey,
        },
        payload: { mode: "free" },
      });
      const otherAthlete = await fixture.app.inject({
        method: "POST",
        url: "/v1/attempts",
        headers: {
          ...athleteHeader(ATHLETE_B),
          "idempotency-key": idempotencyKey,
        },
        payload: { mode: "free" },
      });

      expect(
        CreateAttemptResponseSchema.parse(otherAthlete.json()).id,
      ).not.toBe(CreateAttemptResponseSchema.parse(first.json()).id);
    } finally {
      await fixture.close();
    }
  });

  it("fails closed when a reused causal key carries a conflicting create payload", async () => {
    const fixture = await makeApi();
    const idempotencyKey = "c2222222-2222-4222-8222-222222222222";
    try {
      await fixture.app.inject({
        method: "POST",
        url: "/v1/attempts",
        headers: {
          ...athleteHeader(ATHLETE_A),
          "idempotency-key": idempotencyKey,
        },
        payload: { mode: "free" },
      });
      const calibration = CalibrationSessionSchema.parse(
        (
          await fixture.app.inject({
            method: "POST",
            url: "/v1/calibration-sessions",
            headers: athleteHeader(ATHLETE_A),
            payload: { challengeId: "wall-pass", challengeVersion: 1 },
          })
        ).json(),
      );
      await fixture.app.inject({
        method: "POST",
        url: `/v1/calibration-sessions/${calibration.id}/ready`,
        headers: athleteHeader(ATHLETE_A),
        payload: {
          requiredGates: ["device", "space", "athlete", "rehearsal", "record"],
        },
      });

      const conflict = await fixture.app.inject({
        method: "POST",
        url: "/v1/attempts",
        headers: {
          ...athleteHeader(ATHLETE_A),
          "idempotency-key": idempotencyKey,
        },
        payload: {
          mode: "verified",
          challengeId: "wall-pass",
          challengeVersion: 1,
          calibrationSessionId: calibration.id,
        },
      });

      expect(conflict.statusCode).toBe(400);
      expect(RouteErrorSchema.parse(conflict.json()).code).toBe(
        "invalid_request",
      );
    } finally {
      await fixture.close();
    }
  });

  it("registers every shared C2 method at its shared path", async () => {
    const fixture = await makeMediaApi();
    try {
      await fixture.app.ready();
      const unregistered = apiRouteRegistry.filter(
        (route) =>
          !route.multipart &&
          !fixture.app.hasRoute({
            method: route.method.toUpperCase() as "GET" | "POST" | "DELETE",
            url: fastifyRoutePath(route),
          }),
      );
      expect(unregistered).toEqual([]);
      await expect(
        fixture.app.inject({
          method: "POST",
          url: "/v1/attempts/11111111-1111-4111-8111-111111111111/media",
          headers: athleteHeader(ATHLETE_A),
        }),
      ).resolves.toMatchObject({ statusCode: 404 });
      for (const route of apiRouteRegistry) {
        expect(
          route.responses.some((response) => response.status === 503),
        ).toBe(route.operationId !== "getHealth");
      }
    } finally {
      await fixture.close();
    }
  });

  it("uses a matched attempt descriptor's declared error schema", async () => {
    const route = apiRoute("getAttempt");
    const originalResponses = route.responses;
    const descriptorMessage = "Attempt descriptor rejected this read.";
    Reflect.set(
      route,
      "responses",
      originalResponses.map((response) =>
        response.status === 404
          ? {
              ...response,
              schema: RouteErrorSchema.transform((body) => ({
                ...body,
                message: descriptorMessage,
              })),
            }
          : response,
      ),
    );
    const fixture = await makeApi();
    try {
      const response = await fixture.app.inject({
        method: "GET",
        url: "/v1/attempts/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        headers: athleteHeader(ATHLETE_A),
      });

      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({
        code: "attempt_not_found",
        message: descriptorMessage,
        retryable: false,
      });
    } finally {
      await fixture.close();
      Reflect.set(route, "responses", originalResponses);
    }
  });

  it("rejects an omitted matched attempt error status", async () => {
    const route = apiRoute("getAttempt");
    const originalResponses = route.responses;
    Reflect.set(
      route,
      "responses",
      originalResponses.filter((response) => response.status !== 404),
    );
    const fixture = await makeApi();
    try {
      const response = await fixture.app.inject({
        method: "GET",
        url: "/v1/attempts/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        headers: athleteHeader(ATHLETE_A),
      });

      expect(response.statusCode).toBe(500);
    } finally {
      await fixture.close();
      Reflect.set(route, "responses", originalResponses);
    }
  });

  it("starts the official recovery and retention owners atomically when scheduler registration fails", async () => {
    const fixture = await makeMediaApi();
    let healthyApp: FastifyInstance | undefined;
    let stopDeliveries: (() => void) | undefined;
    try {
      await fixture.app.close();
      const cleanup = await seedAttachedMedia(fixture, {
        attemptId: "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1",
        mediaId: "a2a2a2a2-a2a2-4a2a-8a2a-a2a2a2a2a2a2",
        transitionId: "a3a3a3a3-a3a3-4a3a-8a3a-a3a3a3a3a3a3",
      });
      await fixture.repository.beginMediaAttachmentRecovery({
        attemptId: cleanup.attemptId,
        generation: cleanup.generation,
        mediaId: cleanup.mediaId,
        frameBatchId: cleanup.frameBatchId,
      });
      const delivery = await seedAttachedMedia(fixture, {
        attemptId: "b1b1b1b1-b1b1-4b1a-8b1a-b1b1b1b1b1b1",
        mediaId: "b2b2b2b2-b2b2-4b2a-8b2a-b2b2b2b2b2b2",
        transitionId: "b3b3b3b3-b3b3-4b3a-8b3a-b3b3b3b3b3b3",
      });
      const delivered: unknown[] = [];
      stopDeliveries = fixture.queue.subscribe(async (job) => {
        delivered.push(job);
      });
      const cleanupPayload = join(
        fixture.directory,
        "c5",
        "originals",
        cleanup.mediaId,
        "payload",
      );
      await expect(readFile(cleanupPayload)).resolves.toHaveLength(
        validMp4Bytes().byteLength,
      );
      const acceptedHandle = Object.freeze({ timer: "recovery" });
      const cancelled: unknown[] = [];
      let registrations = 0;
      let clockReads = 0;
      const failingInput: Parameters<typeof createProductionAttemptApi>[0] = {
        repository: fixture.repository,
        retention: fixture.retention,
        queue: fixture.queue,
        mediaPipeline: fixture.c5.pipeline,
        cleaner: createLocalC8AcceptedMediaCleaner({
          repository: fixture.repository,
          storage: fixture.c5.storage,
        }),
        scheduler: {
          everyHour: (task) => {
            registrations += 1;
            if (registrations === 1) {
              // A host is permitted to invoke synchronously while registering;
              // the paired lifecycle must still be inert at this point.
              task();
              return acceptedHandle;
            }
            throw new Error("retention scheduler unavailable");
          },
          cancel: (handle) => {
            cancelled.push(handle);
          },
        },
        clock: {
          now: () => {
            clockReads += 1;
            return "2030-01-15T12:00:00.000Z";
          },
        },
      };

      expect(() =>
        createProductionAttemptApi({
          ...failingInput,
          scheduler: {
            everyHour: () => {
              throw new Error("recovery scheduler unavailable");
            },
            cancel: () => {
              throw new Error("no timer was accepted");
            },
          },
        }),
      ).toThrow("recovery scheduler unavailable");
      expect(cancelled).toEqual([]);
      expect(clockReads).toBe(0);
      expect(delivered).toEqual([]);

      expect(() => createProductionAttemptApi(failingInput)).toThrow(
        "retention scheduler unavailable",
      );
      expect(cancelled).toEqual([acceptedHandle]);
      expect(clockReads).toBe(0);
      // A prematurely activated recovery pass would enqueue the pending
      // delivery and roll back/delete this exact C5 original and frame batch.
      await nextEventTurn();
      expect(delivered).toEqual([]);
      await expect(readFile(cleanupPayload)).resolves.toHaveLength(
        validMp4Bytes().byteLength,
      );
      await expect(
        fixture.repository.getMediaDeliveryRecovery({
          attemptId: cleanup.attemptId,
          generation: cleanup.generation,
        }),
      ).resolves.toMatchObject({ state: "cleanup-recoverable" });
      await expect(
        fixture.repository.getMediaDeliveryRecovery({
          attemptId: delivery.attemptId,
          generation: delivery.generation,
        }),
      ).resolves.toMatchObject({ state: "pending-delivery" });

      const scheduled: Array<() => void> = [];
      healthyApp = createProductionAttemptApi({
        ...failingInput,
        scheduler: {
          everyHour: (task) => {
            scheduled.push(task);
            return task;
          },
          cancel: (handle) => {
            cancelled.push(handle);
          },
        },
      });
      await nextEventTurn();
      expect(scheduled).toHaveLength(2);
      expect(clockReads).toBe(1);
      await healthyApp.close();
      healthyApp = undefined;
      expect(delivered).toEqual([
        {
          attemptId: delivery.attemptId,
          generation: delivery.generation,
          mode: "free",
        },
      ]);
      await expect(readFile(cleanupPayload)).rejects.toThrow();
      expect(cancelled).toEqual([acceptedHandle, ...scheduled]);
    } finally {
      stopDeliveries?.();
      await healthyApp?.close();
      await fixture.close();
    }
  });

  it("tombstones an owned active attempt through one empty DELETE response", async () => {
    const fixture = await makeMediaApi();
    try {
      const attempt = await fixture.repository.createAttempt({
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        athleteId: ATHLETE_A,
        input: { mode: "free" },
      });

      const deleted = await fixture.app.inject({
        method: "DELETE",
        url: `/v1/attempts/${attempt.id}`,
        headers: athleteHeader(ATHLETE_A),
      });
      expect(deleted.statusCode).toBe(204);
      expect(deleted.body).toBe("");

      for (const suffix of ["", "/result"]) {
        const read = await fixture.app.inject({
          method: "GET",
          url: `/v1/attempts/${attempt.id}${suffix}`,
          headers: athleteHeader(ATHLETE_A),
        });
        expect(read.statusCode).toBe(404);
        expect(RouteErrorSchema.parse(read.json()).code).toBe(
          "attempt_not_found",
        );
      }

      const duplicate = await fixture.app.inject({
        method: "DELETE",
        url: `/v1/attempts/${attempt.id}`,
        headers: athleteHeader(ATHLETE_A),
      });
      expect(duplicate.statusCode).toBe(404);
      expect(RouteErrorSchema.parse(duplicate.json()).code).toBe(
        "attempt_not_found",
      );
    } finally {
      await fixture.close();
    }
  });

  it("scopes DELETE to its athlete and rejects ambiguous delete requests", async () => {
    const fixture = await makeMediaApi();
    try {
      const attempt = await fixture.repository.createAttempt({
        id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        athleteId: ATHLETE_A,
        input: { mode: "free" },
      });

      const wrongOwner = await fixture.app.inject({
        method: "DELETE",
        url: `/v1/attempts/${attempt.id}`,
        headers: athleteHeader(ATHLETE_B),
      });
      expect(wrongOwner.statusCode).toBe(404);
      expect(RouteErrorSchema.parse(wrongOwner.json()).code).toBe(
        "attempt_not_found",
      );

      const unknown = await fixture.app.inject({
        method: "DELETE",
        url: "/v1/attempts/cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        headers: athleteHeader(ATHLETE_A),
      });
      expect(unknown.statusCode).toBe(404);
      expect(RouteErrorSchema.parse(unknown.json()).code).toBe(
        "attempt_not_found",
      );

      for (const request of [
        {
          url: `/v1/attempts/${attempt.id}?unexpected=true`,
          headers: athleteHeader(ATHLETE_A),
        },
        {
          url: `/v1/attempts/${attempt.id.toUpperCase()}`,
          headers: athleteHeader(ATHLETE_A),
        },
        {
          url: `/v1/attempts/${attempt.id}`,
          headers: {
            ...athleteHeader(ATHLETE_A),
            "content-type": "application/json",
          },
          payload: {},
        },
      ] as const) {
        const rejected = await fixture.app.inject({
          method: "DELETE",
          ...request,
        });
        expect(rejected.statusCode).toBe(400);
        expect(RouteErrorSchema.parse(rejected.json()).code).toBe(
          "invalid_request",
        );
      }

      const stillActive = await fixture.app.inject({
        method: "GET",
        url: `/v1/attempts/${attempt.id}`,
        headers: athleteHeader(ATHLETE_A),
      });
      expect(stillActive.statusCode).toBe(200);

      await fixture.app.listen({ host: "127.0.0.1", port: 0 });
      for (const path of [
        `/v1/attempts/${attempt.id}?`,
        `/v1/attempts/${attempt.id}?&`,
      ]) {
        const rejected = await rawHttpDelete(
          fixture.app,
          path,
          athleteHeader(ATHLETE_A),
        );
        expect(rejected.statusCode, path).toBe(400);
        expect(
          RouteErrorSchema.parse(JSON.parse(rejected.body)).code,
          path,
        ).toBe("invalid_request");
      }

      for (const headers of [
        {},
        { "x-revelai-athlete-id": "not-an-athlete" },
        { "x-revelai-athlete-id": [ATHLETE_A, ATHLETE_B] },
      ]) {
        const rejected = await fixture.app.inject({
          method: "DELETE",
          url: `/v1/attempts/${attempt.id}`,
          headers,
        });
        expect(rejected.statusCode).toBe(400);
        expect(RouteErrorSchema.parse(rejected.json()).code).toBe(
          "invalid_athlete_identity",
        );
      }
    } finally {
      await fixture.close();
    }
  });

  it("makes every owned retention fact due atomically when DELETE tombstones media", async () => {
    const fixture = await makeMediaApi();
    try {
      const attempt = await fixture.repository.createAttempt({
        id: "dededede-dede-4ded-8ded-dededededede",
        athleteId: ATHLETE_A,
        input: { mode: "free" },
      });
      const body = rawMultipartBody({
        name: "media",
        filename: "attempt.mp4",
        contentType: "video/mp4",
        bytes: validMp4Bytes(),
      });
      const uploaded = await fixture.app.inject({
        method: "POST",
        url: `/v1/attempts/${attempt.id}/media`,
        headers: {
          ...athleteHeader(ATHLETE_A),
          "content-type": "multipart/form-data; boundary=revelai-test-boundary",
        },
        payload: body,
      });
      expect(uploaded.statusCode).toBe(202);

      const deleteAt = "2030-02-15T12:00:00.000Z";
      await Promise.all([
        fixture.retention.schedule({
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          attemptId: attempt.id,
          kind: "frame",
          deleteAt,
        }),
        fixture.retention.schedule({
          id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          attemptId: attempt.id,
          kind: "temporary",
          deleteAt,
        }),
        fixture.retention.schedule({
          id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          attemptId: attempt.id,
          kind: "observation",
          deleteAt,
        }),
      ]);
      expect(
        await fixture.retention.listDue({
          now: "2030-01-15T12:00:00.000Z",
          limit: 10,
        }),
      ).toEqual([]);

      const deleted = await fixture.app.inject({
        method: "DELETE",
        url: `/v1/attempts/${attempt.id}`,
        headers: athleteHeader(ATHLETE_A),
      });
      expect(deleted.statusCode).toBe(204);

      const due = await fixture.retention.listDue({
        now: "2030-01-15T12:00:00.000Z",
        limit: 10,
      });
      expect(due.map((record) => record.kind)).toEqual(
        expect.arrayContaining([
          "original",
          "frame",
          "temporary",
          "observation",
        ]),
      );
      for (const record of due)
        expect(record.cleanupRequestedAt).toBe("2030-01-15T12:00:00.000Z");

      const restartedDatabase = fixture.database.reopen();
      try {
        const restartedRetention = new SQLiteRetentionRepository({
          database: restartedDatabase,
        });
        expect(
          (
            await restartedRetention.listDue({
              now: "2030-01-15T12:00:00.000Z",
              limit: 10,
            })
          ).map((record) => record.id),
        ).toEqual(expect.arrayContaining(due.map((record) => record.id)));
      } finally {
        restartedDatabase.close();
      }

      let failOnce = true;
      const events: unknown[] = [];
      const scavenger = new RetentionScavenger({
        repository: fixture.retention,
        objects: {
          delete: async (record) => {
            if (
              record.id === "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" &&
              failOnce
            ) {
              failOnce = false;
              throw new Error("must-not-leak /private/media-path");
            }
          },
        },
        maxBatchSize: 10,
        log: { event: (event) => events.push(event) },
        now: () => "2030-01-15T12:00:00.000Z",
      });
      await expect(scavenger.run("2030-01-15T12:00:00.000Z")).resolves.toEqual(
        expect.objectContaining({
          kind: "completed",
          processed: due.length - 1,
        }),
      );
      expect(
        await fixture.retention.listDue({
          now: "2030-01-15T12:00:00.000Z",
          limit: 10,
        }),
      ).toEqual([
        expect.objectContaining({
          id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          kind: "temporary",
        }),
      ]);
      expect(JSON.stringify(events)).not.toContain("/private/media-path");
      await expect(scavenger.run("2030-01-15T12:00:00.000Z")).resolves.toEqual(
        expect.objectContaining({ kind: "completed", processed: 1 }),
      );
      await expect(
        fixture.retention.listDue({
          now: "2030-01-15T12:00:00.000Z",
          limit: 10,
        }),
      ).resolves.toEqual([]);
    } finally {
      await fixture.close();
    }
  });

  it("drains terminal DELETE retention from the official root's separate hourly task", async () => {
    const fixture = await makeMediaApi();
    try {
      const attempt = await createAttemptForReadProjection(fixture, {
        id: "f0f0f0f0-f0f0-4f0f-8f0f-f0f0f0f0f0f0",
        mode: "free",
        candidate: freeTerminalCandidate(
          "f0f0f0f0-f0f0-4f0f-8f0f-f0f0f0f0f0f0",
        ),
      });
      const claim = await fixture.repository.claimProcessing({
        attemptId: attempt.id,
        generation: 1,
      });
      expect(claim).not.toBeNull();
      const context = await fixture.repository.getProcessingContext({
        attemptId: attempt.id,
        generation: claim!.generation,
        leaseId: claim!.leaseId,
      });
      expect(context).not.toBeNull();
      const mediaId = context!.processing.receipt.mediaId;
      const frameBatchId = context!.processing.receipt.frameBatchId;
      await fixture.repository.finalizeTerminalResult({
        attemptId: attempt.id,
        leaseId: claim!.leaseId,
        generation: claim!.generation,
        candidate: freeTerminalCandidate(attempt.id),
      });
      const temporaryId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      const observationId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
      await writeFile(
        join(fixture.directory, "c5", "temporary", `${temporaryId}.uploading`),
        "orphaned temporary evidence",
        { mode: 0o600 },
      );
      fixture.database.raw
        .prepare(
          "INSERT INTO canonical_observations (id, attempt_id, payload_json, delete_at, created_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run(
          observationId,
          attempt.id,
          JSON.stringify({ source: "retention-route-fixture" }),
          "2030-02-15T12:00:00.000Z",
          "2030-01-15T12:00:00.000Z",
        );
      await Promise.all([
        fixture.retention.schedule({
          id: temporaryId,
          attemptId: attempt.id,
          kind: "temporary",
          deleteAt: "2030-02-15T12:00:00.000Z",
        }),
        fixture.retention.schedule({
          id: frameBatchId,
          attemptId: attempt.id,
          kind: "frame",
          deleteAt: "2030-02-15T12:00:00.000Z",
        }),
        fixture.retention.schedule({
          id: observationId,
          attemptId: attempt.id,
          kind: "observation",
          deleteAt: "2030-02-15T12:00:00.000Z",
        }),
      ]);
      await expect(
        readFile(
          join(fixture.directory, "c5", "originals", mediaId, "payload"),
        ),
      ).resolves.toHaveLength(validMp4Bytes().byteLength);

      const deleted = await fixture.app.inject({
        method: "DELETE",
        url: `/v1/attempts/${attempt.id}`,
        headers: athleteHeader(ATHLETE_A),
      });
      expect(deleted.statusCode).toBe(204);
      expect(
        fixture.database.raw
          .prepare(
            "SELECT COUNT(*) AS count FROM canonical_observations WHERE id = ?",
          )
          .get(observationId),
      ).toEqual({ count: 0 });
      expect(fixture.hourlyTasks).toHaveLength(2);

      fixture.hourlyTasks[0]!();
      await nextEventTurn();
      expect(
        (
          await fixture.retention.listDue({
            now: "2030-01-15T12:00:00.000Z",
            limit: 10,
          })
        ).map((record) => record.kind),
      ).toEqual(
        expect.arrayContaining([
          "original",
          "frame",
          "temporary",
          "observation",
        ]),
      );

      fixture.hourlyTasks[1]!();
      await waitForRetentionDrain(fixture.retention);
      await expect(
        readFile(
          join(fixture.directory, "c5", "originals", mediaId, "payload"),
        ),
      ).rejects.toThrow();
      await expect(
        readdir(join(fixture.directory, "c5", "frames", frameBatchId)),
      ).rejects.toThrow();
      await expect(
        readFile(
          join(
            fixture.directory,
            "c5",
            "temporary",
            `${temporaryId}.uploading`,
          ),
        ),
      ).rejects.toThrow();
      await fixture.app.close();
      expect(fixture.cancelledHourlyTasks).toHaveLength(2);
    } finally {
      await fixture.close();
    }
  });

  it("tombstones valid, invalid, and failed terminal attempts through the same HTTP boundary", async () => {
    const fixture = await makeMediaApi();
    const cases: readonly Readonly<{
      id: string;
      mode: "free" | "verified";
      candidate: TerminalCandidate;
    }>[] = [
      {
        id: "abababab-abab-4bab-8bab-abababababab",
        mode: "free",
        candidate: freeTerminalCandidate(
          "abababab-abab-4bab-8bab-abababababab",
        ),
      },
      {
        id: "bcbcbcbc-bcbc-4bcb-8bcb-bcbcbcbcbcbc",
        mode: "free",
        candidate: {
          state: "failed",
          attemptId: "bcbcbcbc-bcbc-4bcb-8bcb-bcbcbcbcbcbc",
          mode: "free",
          code: "analysis_internal_error",
          message: "A análise não pôde ser concluída.",
          retryable: false,
        },
      },
      {
        id: "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd",
        mode: "verified",
        candidate: {
          state: "invalid",
          attemptId: "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd",
          mode: "verified",
          code: "calibration_not_verified",
          message: "Refaça a calibração antes de tentar novamente.",
          retryable: true,
        },
      },
    ];
    try {
      const physical: Array<
        Readonly<{ mediaId: string; frameBatchId: string }>
      > = [];
      for (const [index, input] of cases.entries()) {
        const attempt = await createAttemptForReadProjection(fixture, input);
        const claim = await fixture.repository.claimProcessing({
          attemptId: attempt.id,
          generation: 1,
        });
        expect(claim).not.toBeNull();
        const context = await fixture.repository.getProcessingContext({
          attemptId: attempt.id,
          generation: claim!.generation,
          leaseId: claim!.leaseId,
        });
        expect(context).not.toBeNull();
        const mediaId = context!.processing.receipt.mediaId;
        const frameBatchId = context!.processing.receipt.frameBatchId;
        physical.push(Object.freeze({ mediaId, frameBatchId }));
        const scheduled = await Promise.all([
          fixture.retention.schedule({
            id: frameBatchId,
            attemptId: attempt.id,
            kind: "frame",
            deleteAt: "2030-02-15T12:00:00.000Z",
          }),
          fixture.retention.schedule({
            id: `99999999-9999-4999-8999-${String(index + 1).padStart(12, "0")}`,
            attemptId: attempt.id,
            kind: "observation",
            deleteAt: "2030-02-15T12:00:00.000Z",
          }),
        ]);
        expect(scheduled).not.toContainEqual({ kind: "conflict" });
        await fixture.repository.finalizeTerminalResult({
          attemptId: attempt.id,
          leaseId: claim!.leaseId,
          generation: claim!.generation,
          candidate: input.candidate,
        });

        const deleted = await fixture.app.inject({
          method: "DELETE",
          url: `/v1/attempts/${attempt.id}`,
          headers: athleteHeader(ATHLETE_A),
        });
        expect(deleted.statusCode, attempt.id).toBe(204);
        expect(deleted.body, attempt.id).toBe("");
        const read = await fixture.app.inject({
          method: "GET",
          url: `/v1/attempts/${attempt.id}/result`,
          headers: athleteHeader(ATHLETE_A),
        });
        expect(read.statusCode, attempt.id).toBe(404);
        expect(RouteErrorSchema.parse(read.json()).code, attempt.id).toBe(
          "attempt_not_found",
        );
      }
      fixture.hourlyTasks[1]!();
      await waitForRetentionDrain(fixture.retention);
      for (const record of physical) {
        await expect(
          readFile(
            join(
              fixture.directory,
              "c5",
              "originals",
              record.mediaId,
              "payload",
            ),
          ),
        ).rejects.toThrow();
        await expect(
          readdir(join(fixture.directory, "c5", "frames", record.frameBatchId)),
        ).rejects.toThrow();
      }
    } finally {
      await fixture.close();
    }
  });

  it("retries a real C5 deletion failure from the official retention timer without leaking a path", async () => {
    const events: unknown[] = [];
    const fixture = await makeMediaApi({
      retentionLog: { event: (event) => void events.push(event) },
    });
    try {
      const attempt = await createAttemptForReadProjection(fixture, {
        id: "dededede-dede-4ede-8ede-dededededede",
        mode: "free",
        candidate: freeTerminalCandidate(
          "dededede-dede-4ede-8ede-dededededede",
        ),
      });
      const claim = await fixture.repository.claimProcessing({
        attemptId: attempt.id,
        generation: 1,
      });
      expect(claim).not.toBeNull();
      await fixture.repository.finalizeTerminalResult({
        attemptId: attempt.id,
        leaseId: claim!.leaseId,
        generation: claim!.generation,
        candidate: freeTerminalCandidate(attempt.id),
      });
      await chmod(join(fixture.directory, "c5", "originals"), 0o500);
      const deleted = await fixture.app.inject({
        method: "DELETE",
        url: `/v1/attempts/${attempt.id}`,
        headers: athleteHeader(ATHLETE_A),
      });
      expect(deleted.statusCode).toBe(204);

      fixture.hourlyTasks[1]!();
      await resolvesSoon(() => events.length > 0);
      expect(events).toEqual([
        {
          category: "retention_cleanup_failed",
          attempt: attempt.id.slice(0, 8),
          resource: expect.any(String),
        },
      ]);
      expect(JSON.stringify(events)).not.toContain(fixture.directory);
      expect(
        await fixture.retention.listDue({
          now: "2030-01-15T12:00:00.000Z",
          limit: 10,
        }),
      ).not.toEqual([]);

      await chmod(join(fixture.directory, "c5", "originals"), 0o700);
      fixture.hourlyTasks[1]!();
      await waitForRetentionDrain(fixture.retention);
    } finally {
      await chmod(join(fixture.directory, "c5", "originals"), 0o700).catch(
        () => undefined,
      );
      await fixture.close();
    }
  });

  it("drains DELETE retention from a reopened official root on immediate startup", async () => {
    const fixture = await makeMediaApi();
    let initialClosed = false;
    let reopened:
      | Readonly<{
          app: FastifyInstance;
          database: ReturnType<typeof openSqliteDatabase>;
          retention: SQLiteRetentionRepository;
          scheduled: Array<() => void>;
        }>
      | undefined;
    try {
      const attempt = await createAttemptForReadProjection(fixture, {
        id: "ecececec-ecec-4ece-8ece-ecececececec",
        mode: "free",
        candidate: freeTerminalCandidate(
          "ecececec-ecec-4ece-8ece-ecececececec",
        ),
      });
      const claim = await fixture.repository.claimProcessing({
        attemptId: attempt.id,
        generation: 1,
      });
      expect(claim).not.toBeNull();
      const context = await fixture.repository.getProcessingContext({
        attemptId: attempt.id,
        generation: claim!.generation,
        leaseId: claim!.leaseId,
      });
      expect(context).not.toBeNull();
      await fixture.repository.releaseProcessingClaim({
        attemptId: attempt.id,
        generation: claim!.generation,
        leaseId: claim!.leaseId,
      });
      const mediaId = context!.processing.receipt.mediaId;
      const frameBatchId = context!.processing.receipt.frameBatchId;
      await Promise.all([
        fixture.retention.schedule({
          id: frameBatchId,
          attemptId: attempt.id,
          kind: "frame",
          deleteAt: "2030-02-15T12:00:00.000Z",
        }),
        fixture.retention.schedule({
          id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
          attemptId: attempt.id,
          kind: "observation",
          deleteAt: "2030-02-15T12:00:00.000Z",
        }),
      ]);
      await expect(
        readFile(
          join(fixture.directory, "c5", "originals", mediaId, "payload"),
        ),
      ).resolves.toHaveLength(validMp4Bytes().byteLength);

      await expect(
        fixture.app.inject({
          method: "DELETE",
          url: `/v1/attempts/${attempt.id}`,
          headers: athleteHeader(ATHLETE_A),
        }),
      ).resolves.toMatchObject({ statusCode: 204 });
      await fixture.app.close();
      fixture.database.close();
      initialClosed = true;

      const database = openSqliteDatabase(
        join(fixture.directory, "api.sqlite"),
      );
      const repository = new SQLiteAttemptRepository({
        database,
        clock: { now: () => "2030-01-15T12:00:00.000Z" },
        ids: { next: () => "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
        handoffVerifier: fixture.c5.handoffVerifier,
      });
      const retention = new SQLiteRetentionRepository({ database });
      const queue = new InMemoryAnalysisQueue({ available: () => true });
      const scheduled: Array<() => void> = [];
      const app = createProductionAttemptApi({
        repository,
        retention,
        queue,
        mediaPipeline: fixture.c5.pipeline,
        cleaner: createLocalC8AcceptedMediaCleaner({
          repository,
          storage: fixture.c5.storage,
        }),
        scheduler: {
          everyHour: (task) => {
            scheduled.push(task);
            return task;
          },
          cancel: () => undefined,
        },
      });
      reopened = Object.freeze({ app, database, retention, scheduled });
      await waitForRetentionDrain(reopened.retention);
      expect(reopened.scheduled).toHaveLength(2);
      await expect(
        readFile(
          join(fixture.directory, "c5", "originals", mediaId, "payload"),
        ),
      ).rejects.toThrow();
      await expect(
        readdir(join(fixture.directory, "c5", "frames", frameBatchId)),
      ).rejects.toThrow();
      await expect(
        reopened.retention.listDue({
          now: "2030-01-15T12:00:00.000Z",
          limit: 10,
        }),
      ).resolves.toEqual([]);
    } finally {
      await reopened?.app.close();
      reopened?.database.close();
      if (!initialClosed) await fixture.close();
    }
  });

  it("keeps an already-queued processing generation inert after HTTP deletion", async () => {
    const fixture = await makeMediaApi();
    try {
      const attempt = await createAttemptForReadProjection(fixture, {
        id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        mode: "free",
        candidate: freeTerminalCandidate(
          "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        ),
      });
      const deleted = await fixture.app.inject({
        method: "DELETE",
        url: `/v1/attempts/${attempt.id}`,
        headers: athleteHeader(ATHLETE_A),
      });
      expect(deleted.statusCode).toBe(204);
      await expect(
        fixture.repository.claimProcessing({
          attemptId: attempt.id,
          generation: 1,
        }),
      ).resolves.toBeNull();
    } finally {
      await fixture.close();
    }
  });

  it("enforces one compiler-resolved production upload-composition path", async () => {
    await expect(
      assertSingleProductionUploadCompositionPath(
        resolve(import.meta.dirname, ".."),
      ),
    ).resolves.toBeUndefined();
  });

  it("keeps analysis queue resolution out of HTTP and services", async () => {
    await expect(
      assertAnalysisQueueResolutionTopology(resolve(import.meta.dirname, "..")),
    ).resolves.toBeUndefined();
  });

  it("rejects a compiler-resolved queue resolver outside outer composition", async () => {
    const root = await mkdtemp(join(tmpdir(), "revelai-queue-topology-"));
    directories.push(root);
    await Promise.all([
      mkdir(join(root, "queue"), { recursive: true }),
      mkdir(join(root, "composition"), { recursive: true }),
      mkdir(join(root, "services"), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(
        join(root, "queue", "in-memory-analysis-queue.ts"),
        "export function resolveFactoryIssuedAnalysisQueuePort(): void {}\n",
      ),
      writeFile(
        join(root, "composition", "sqlite-media-upload-composition.ts"),
        [
          'import { resolveFactoryIssuedAnalysisQueuePort } from "../queue/in-memory-analysis-queue.js";',
          "resolveFactoryIssuedAnalysisQueuePort();",
          "",
        ].join("\n"),
      ),
    ]);
    await expect(
      assertAnalysisQueueResolutionTopology(root),
    ).resolves.toBeUndefined();

    await writeFile(
      join(root, "services", "forged-queue-resolution.ts"),
      [
        'import { resolveFactoryIssuedAnalysisQueuePort } from "../queue/in-memory-analysis-queue.js";',
        "resolveFactoryIssuedAnalysisQueuePort();",
        "",
      ].join("\n"),
    );
    await expect(assertAnalysisQueueResolutionTopology(root)).rejects.toThrow(
      "only from outer composition",
    );
  });

  it("rejects a second compiler-resolved production upload-composition import", async () => {
    const root = await mkdtemp(join(tmpdir(), "revelai-upload-topology-"));
    directories.push(root);
    await Promise.all([
      mkdir(join(root, "http"), { recursive: true }),
      mkdir(join(root, "composition"), { recursive: true }),
      mkdir(join(root, "workers"), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(
        join(root, "http", "attempt-api.ts"),
        "export function createInternallyComposedAttemptApi(): void {}\n",
      ),
      writeFile(
        join(root, "composition", "sqlite-media-upload-composition.ts"),
        [
          'import { createInternallyComposedAttemptApi } from "../http/attempt-api.js";',
          "createInternallyComposedAttemptApi();",
          "",
        ].join("\n"),
      ),
    ]);
    await expect(
      assertSingleProductionUploadCompositionPath(root),
    ).resolves.toBeUndefined();

    await writeFile(
      join(root, "workers", "forged-upload-composition.ts"),
      [
        'import * as attemptApi from "../http/attempt-api.js";',
        "void attemptApi;",
        "",
      ].join("\n"),
    );
    await expect(
      assertSingleProductionUploadCompositionPath(root),
    ).rejects.toThrow("exactly one production composition import and call");

    await writeFile(
      join(root, "workers", "forged-upload-composition.ts"),
      'void import("../http/attempt-api.js");\n',
    );
    await expect(
      assertSingleProductionUploadCompositionPath(root),
    ).rejects.toThrow("exactly one production composition import and call");
  });

  it("refuses to compose read-only SQLite with a C5 media pipeline", async () => {
    const directory = await mkdtemp(join(tmpdir(), "revelai-read-only-media-"));
    directories.push(directory);
    const database = openSqliteDatabase(join(directory, "api.sqlite"));
    const c5 = createC5PipelineTestSupport({ root: join(directory, "c5") });
    const repository = SQLiteAttemptRepository.forReadOnlyTest({
      database,
      clock: { now: () => "2030-01-15T12:00:00.000Z" },
      ids: { next: () => "ffffffff-ffff-4fff-8fff-ffffffffffff" },
    });

    expect(() =>
      createFactoryIssuedMediaUploadService({
        repository,
        queue: {
          isAvailable: async () => true,
          enqueue: async () => undefined,
        },
        retention: new SQLiteRetentionRepository({ database }),
        mediaPipeline: c5.pipeline,
      }),
    ).toThrow("factory-issued media upload composition");

    database.close();
  });

  it("issues upload and tombstone capabilities only to exact C4/C5 factory instances", async () => {
    const fixture = await makeMediaApi();
    const issue = (repository: SQLiteAttemptRepository) =>
      createFactoryIssuedMediaUploadService({
        repository,
        retention: fixture.retention,
        queue: fixture.queue,
        mediaPipeline: fixture.c5.pipeline,
      });
    const issueAttemptApi = (repository: SQLiteAttemptRepository) =>
      createProductionAttemptApi({
        repository,
        retention: fixture.retention,
        queue: fixture.queue,
        mediaPipeline: fixture.c5.pipeline,
        cleaner: createLocalC8AcceptedMediaCleaner({
          repository: fixture.repository,
          storage: fixture.c5.storage,
        }),
        scheduler: { everyHour: () => undefined, cancel: () => undefined },
      });
    const issueRetention = (
      repository: SQLiteAttemptRepository,
      retention = fixture.retention,
      mediaPipeline = fixture.c5.pipeline,
    ) =>
      createFactoryIssuedRetentionRuntimeFactory({
        repository,
        retention,
        mediaPipeline,
      });
    class DerivedAttemptRepository extends SQLiteAttemptRepository {}
    const derived = new DerivedAttemptRepository({
      database: fixture.database,
      clock: { now: () => "2030-01-15T12:00:00.000Z" },
      ids: { next: () => "abababab-abab-4bab-8bab-abababababab" },
      handoffVerifier: fixture.c5.handoffVerifier,
    });
    const proxy = new Proxy(fixture.repository, {});
    const clone = Object.assign(
      Object.create(SQLiteAttemptRepository.prototype),
      fixture.repository,
    );
    class DerivedRetentionRepository extends SQLiteRetentionRepository {}
    const derivedRetention = new DerivedRetentionRepository({
      database: fixture.database,
    });
    const retentionProxy = new Proxy(fixture.retention, {});
    const retentionClone = Object.assign(
      Object.create(SQLiteRetentionRepository.prototype),
      fixture.retention,
    );
    const queueProxy = new Proxy(fixture.queue, {});
    const queueClone = Object.assign({}, fixture.queue);
    const foreignC5 = createC5PipelineTestSupport({
      root: join(fixture.directory, "foreign-c5"),
    });
    const crossDatabase = openSqliteDatabase(
      join(fixture.directory, "cross-authority.sqlite"),
    );
    const crossDatabaseRepository = new SQLiteAttemptRepository({
      database: crossDatabase,
      clock: { now: () => "2030-01-15T12:00:00.000Z" },
      ids: { next: () => "fefefefe-fefe-4efe-8efe-fefefefefefe" },
      handoffVerifier: fixture.c5.handoffVerifier,
    });

    expect(() => issue(derived)).toThrow(
      "factory-issued media upload composition",
    );
    expect(() => issue(proxy)).toThrow(
      "factory-issued media upload composition",
    );
    expect(() => issue(clone)).toThrow(
      "factory-issued media upload composition",
    );
    for (const repository of [derived, proxy, clone])
      expect(() => issueAttemptApi(repository)).toThrow(
        "factory-issued leaderboard composition",
      );
    expect(() => issueAttemptApi(crossDatabaseRepository)).toThrow(
      "factory-issued media upload composition",
    );
    for (const repository of [derived, proxy, clone])
      expect(() => issueRetention(repository)).toThrow(
        "factory-issued retention composition",
      );
    expect(() => issueRetention(crossDatabaseRepository)).toThrow(
      "factory-issued retention composition",
    );
    expect(() => issueRetention(fixture.repository, derivedRetention)).toThrow(
      "factory-issued retention composition",
    );
    expect(() => issueRetention(fixture.repository, retentionProxy)).toThrow(
      "factory-issued retention composition",
    );
    expect(() => issueRetention(fixture.repository, retentionClone)).toThrow(
      "factory-issued retention composition",
    );
    expect(() =>
      issueRetention(fixture.repository, fixture.retention, foreignC5.pipeline),
    ).toThrow("factory-issued retention composition");
    expect(() =>
      issueRetention(
        fixture.repository,
        fixture.retention,
        new Proxy(fixture.c5.pipeline, {}),
      ),
    ).toThrow("factory-issued retention composition");
    expect(() =>
      issueRetention(
        fixture.repository,
        fixture.retention,
        Object.assign({}, fixture.c5.pipeline),
      ),
    ).toThrow("factory-issued retention composition");
    expect(() =>
      createFactoryIssuedMediaUploadService({
        repository: fixture.repository,
        retention: fixture.retention,
        queue: queueProxy,
        mediaPipeline: fixture.c5.pipeline,
      }),
    ).toThrow("factory-issued media upload composition");
    expect(() =>
      createFactoryIssuedMediaUploadService({
        repository: fixture.repository,
        retention: fixture.retention,
        queue: queueClone,
        mediaPipeline: fixture.c5.pipeline,
      }),
    ).toThrow("factory-issued media upload composition");
    expect(() =>
      createFactoryIssuedMediaUploadService({
        repository: fixture.repository,
        retention: fixture.retention,
        queue: {
          isAvailable: async () => true,
          enqueue: async () => undefined,
        },
        mediaPipeline: fixture.c5.pipeline,
      }),
    ).toThrow("factory-issued media upload composition");
    expect(() =>
      createFactoryIssuedMediaUploadService({
        repository: fixture.repository,
        retention: derivedRetention,
        queue: fixture.queue,
        mediaPipeline: fixture.c5.pipeline,
      }),
    ).toThrow("factory-issued media upload composition");
    expect(() =>
      createFactoryIssuedMediaUploadService({
        repository: fixture.repository,
        retention: retentionProxy,
        queue: fixture.queue,
        mediaPipeline: fixture.c5.pipeline,
      }),
    ).toThrow("factory-issued media upload composition");
    expect(() =>
      createFactoryIssuedMediaUploadService({
        repository: fixture.repository,
        retention: retentionClone,
        queue: fixture.queue,
        mediaPipeline: fixture.c5.pipeline,
      }),
    ).toThrow("factory-issued media upload composition");

    const ownPrepare = fixture.repository.prepareMediaUpload;
    Object.defineProperty(fixture.repository, "prepareMediaUpload", {
      configurable: true,
      value: ownPrepare,
    });
    expect(() => issue(fixture.repository)).toThrow(
      "factory-issued media upload composition",
    );
    Reflect.deleteProperty(fixture.repository, "prepareMediaUpload");

    const prototypePrepare =
      SQLiteAttemptRepository.prototype.prepareMediaUpload;
    try {
      Object.defineProperty(
        SQLiteAttemptRepository.prototype,
        "prepareMediaUpload",
        {
          configurable: true,
          value: () => {
            throw new Error("mutated prototype");
          },
        },
      );
      expect(() => issue(fixture.repository)).toThrow(
        "factory-issued media upload composition",
      );
    } finally {
      Object.defineProperty(
        SQLiteAttemptRepository.prototype,
        "prepareMediaUpload",
        {
          configurable: true,
          value: prototypePrepare,
        },
      );
    }

    const ownSchedule = fixture.retention.schedule;
    Object.defineProperty(fixture.retention, "schedule", {
      configurable: true,
      value: ownSchedule,
    });
    expect(() => issue(fixture.repository)).toThrow(
      "factory-issued media upload composition",
    );
    Reflect.deleteProperty(fixture.retention, "schedule");

    const prototypeSchedule = SQLiteRetentionRepository.prototype.schedule;
    try {
      Object.defineProperty(SQLiteRetentionRepository.prototype, "schedule", {
        configurable: true,
        value: () => {
          throw new Error("mutated prototype");
        },
      });
      expect(() => issue(fixture.repository)).toThrow(
        "factory-issued media upload composition",
      );
      expect(() => issueRetention(fixture.repository)).toThrow(
        "factory-issued retention composition",
      );
    } finally {
      Object.defineProperty(SQLiteRetentionRepository.prototype, "schedule", {
        configurable: true,
        value: prototypeSchedule,
      });
    }

    const ownListDue = fixture.retention.listDue;
    Object.defineProperty(fixture.retention, "listDue", {
      configurable: true,
      value: ownListDue,
    });
    expect(() => issueRetention(fixture.repository)).toThrow(
      "factory-issued retention composition",
    );
    Reflect.deleteProperty(fixture.retention, "listDue");

    const prototypeListDue = SQLiteRetentionRepository.prototype.listDue;
    try {
      Object.defineProperty(SQLiteRetentionRepository.prototype, "listDue", {
        configurable: true,
        value: () => {
          throw new Error("mutated prototype");
        },
      });
      expect(() => issueRetention(fixture.repository)).toThrow(
        "factory-issued retention composition",
      );
    } finally {
      Object.defineProperty(SQLiteRetentionRepository.prototype, "listDue", {
        configurable: true,
        value: prototypeListDue,
      });
    }

    crossDatabase.close();
    await fixture.close();
  });

  it("rejects a capability when its C4 facade changes before upload preflight", async () => {
    const fixture = await makeMediaApi();
    const attempt = await fixture.repository.createAttempt({
      id: "abababab-abab-4bab-8bab-ababababababab",
      athleteId: ATHLETE_A,
      input: { mode: "free" },
    });
    const prepare = fixture.repository.prepareMediaUpload;
    Object.defineProperty(fixture.repository, "prepareMediaUpload", {
      configurable: true,
      value: prepare,
    });
    try {
      const reply = await fixture.app.inject({
        method: "POST",
        url: `/v1/attempts/${attempt.id}/media`,
        headers: {
          ...athleteHeader(ATHLETE_A),
          "content-type": "multipart/form-data; boundary=revelai-test-boundary",
        },
        payload: rawMultipartBody({
          name: "media",
          filename: "attempt.mp4",
          contentType: "video/mp4",
          bytes: validMp4Bytes(),
        }),
      });
      expect(reply.statusCode).toBe(503);
      expect(
        await fixture.repository.getAttempt({
          attemptId: attempt.id,
          athleteId: ATHLETE_A,
        }),
      ).toMatchObject({ status: "awaiting-upload", media: null });
    } finally {
      Reflect.deleteProperty(fixture.repository, "prepareMediaUpload");
    }
    await fixture.close();
  });

  it("fails DELETE closed without reading hostile tombstone accessors issued after composition", async () => {
    const fixture = await makeMediaApi();
    const attempt = await fixture.repository.createAttempt({
      id: "fefefefe-fefe-4efe-8efe-fefefefefefe",
      athleteId: ATHLETE_A,
      input: { mode: "free" },
    });
    const expectBlocked = async () => {
      const reply = await fixture.app.inject({
        method: "DELETE",
        url: `/v1/attempts/${attempt.id}`,
        headers: athleteHeader(ATHLETE_A),
      });
      expect(reply.statusCode).toBe(503);
      expect(RouteErrorSchema.parse(reply.json())).toMatchObject({
        code: "service_not_ready",
      });
    };

    let ownReads = 0;
    Object.defineProperty(fixture.repository, "tombstoneAttempt", {
      configurable: true,
      get: () => {
        ownReads += 1;
        throw new Error("hostile own accessor");
      },
    });
    try {
      await expectBlocked();
      expect(ownReads).toBe(0);
    } finally {
      Reflect.deleteProperty(fixture.repository, "tombstoneAttempt");
    }

    const original = Object.getOwnPropertyDescriptor(
      SQLiteAttemptRepository.prototype,
      "tombstoneAttempt",
    );
    let prototypeReads = 0;
    Object.defineProperty(
      SQLiteAttemptRepository.prototype,
      "tombstoneAttempt",
      {
        configurable: true,
        get: () => {
          prototypeReads += 1;
          throw new Error("hostile prototype accessor");
        },
      },
    );
    try {
      await expectBlocked();
      expect(prototypeReads).toBe(0);
    } finally {
      if (original)
        Object.defineProperty(
          SQLiteAttemptRepository.prototype,
          "tombstoneAttempt",
          original,
        );
    }

    expect(
      await fixture.repository.getAttempt({
        attemptId: attempt.id,
        athleteId: ATHLETE_A,
      }),
    ).toMatchObject({ status: "awaiting-upload" });
    await fixture.close();
  });

  it("fails scheduled retention closed without reading a hostile listDue accessor issued after composition", async () => {
    const events: unknown[] = [];
    const fixture = await makeMediaApi({
      retentionLog: { event: (event) => void events.push(event) },
    });
    try {
      const attempt = await createAttemptForReadProjection(fixture, {
        id: "afafafaf-afaf-4faf-8faf-afafafafafaf",
        mode: "free",
        candidate: freeTerminalCandidate(
          "afafafaf-afaf-4faf-8faf-afafafafafaf",
        ),
      });
      await expect(
        fixture.app.inject({
          method: "DELETE",
          url: `/v1/attempts/${attempt.id}`,
          headers: athleteHeader(ATHLETE_A),
        }),
      ).resolves.toMatchObject({ statusCode: 204 });

      let ownReads = 0;
      Object.defineProperty(fixture.retention, "listDue", {
        configurable: true,
        get: () => {
          ownReads += 1;
          throw new Error("hostile own accessor");
        },
      });
      try {
        fixture.hourlyTasks[1]!();
        await resolvesSoon(() => events.length > 0);
        expect(ownReads).toBe(0);
        expect(events).toEqual([{ category: "retention_cleanup_run_failed" }]);
      } finally {
        Reflect.deleteProperty(fixture.retention, "listDue");
      }

      fixture.hourlyTasks[1]!();
      await waitForRetentionDrain(fixture.retention);

      const descriptor = Object.getOwnPropertyDescriptor(
        SQLiteRetentionRepository.prototype,
        "listDue",
      );
      let prototypeReads = 0;
      Object.defineProperty(SQLiteRetentionRepository.prototype, "listDue", {
        configurable: true,
        get: () => {
          prototypeReads += 1;
          throw new Error("hostile prototype accessor");
        },
      });
      try {
        fixture.hourlyTasks[1]!();
        await resolvesSoon(() => events.length > 1);
        expect(prototypeReads).toBe(0);
      } finally {
        if (descriptor)
          Object.defineProperty(
            SQLiteRetentionRepository.prototype,
            "listDue",
            descriptor,
          );
      }
    } finally {
      await fixture.close();
    }
  });

  it("keeps C4 and retention transactions unreachable after post-issuance mutation", async () => {
    const fixtures = await Promise.all(
      Array.from({ length: 4 }, () => makeMediaApi()),
    );
    const transactionCalls = [0, 0, 0, 0];
    const restore: Array<() => void> = [];
    const installOwn = (target: object, index: number) => {
      Object.defineProperty(target, "transaction", {
        configurable: true,
        value: (operation: () => unknown) => {
          transactionCalls[index] += 1;
          return operation();
        },
      });
      restore.push(() => Reflect.deleteProperty(target, "transaction"));
    };
    const installPrototype = (target: object, index: number) => {
      const descriptor = Object.getOwnPropertyDescriptor(target, "transaction");
      Object.defineProperty(target, "transaction", {
        configurable: true,
        value: (operation: () => unknown) => {
          transactionCalls[index] += 1;
          return operation();
        },
      });
      restore.push(() => {
        if (descriptor)
          Object.defineProperty(target, "transaction", descriptor);
        else Reflect.deleteProperty(target, "transaction");
      });
    };
    installOwn(fixtures[0]!.repository, 0);
    installPrototype(SQLiteAttemptRepository.prototype, 1);
    installOwn(fixtures[2]!.retention, 2);
    installPrototype(SQLiteRetentionRepository.prototype, 3);
    try {
      for (const [index, fixture] of fixtures.entries()) {
        const attempt = await fixture.repository.createAttempt({
          id: `cccccccc-cccc-4ccc-8ccc-${String(index + 1).padStart(12, "0")}`,
          athleteId: ATHLETE_A,
          input: { mode: "free" },
        });
        const reply = await fixture.app.inject({
          method: "POST",
          url: `/v1/attempts/${attempt.id}/media`,
          headers: {
            ...athleteHeader(ATHLETE_A),
            "content-type":
              "multipart/form-data; boundary=revelai-test-boundary",
          },
          payload: rawMultipartBody({
            name: "media",
            filename: "attempt.mp4",
            contentType: "video/mp4",
            bytes: validMp4Bytes(),
          }),
        });
        expect(reply.statusCode).toBe(202);
        expect(
          await fixture.repository.getAttempt({
            attemptId: attempt.id,
            athleteId: ATHLETE_A,
          }),
        ).toMatchObject({ status: "uploaded" });
      }
      expect(transactionCalls).toEqual([0, 0, 0, 0]);
    } finally {
      for (const undo of restore.reverse()) undo();
      await Promise.all(fixtures.map((fixture) => fixture.close()));
    }
  });

  it("keeps C4 event and delivery helpers unreachable after capability issuance", async () => {
    const fixtures = await Promise.all(
      Array.from({ length: 4 }, () => makeMediaApi()),
    );
    const helperCalls = [0, 0, 0, 0];
    const restore: Array<() => void> = [];
    const installOwn = (target: object, helper: string, index: number) => {
      Object.defineProperty(target, helper, {
        configurable: true,
        value: () => {
          helperCalls[index] += 1;
        },
      });
      restore.push(() => Reflect.deleteProperty(target, helper));
    };
    const installPrototype = (
      target: object,
      helper: string,
      index: number,
    ) => {
      const descriptor = Object.getOwnPropertyDescriptor(target, helper);
      Object.defineProperty(target, helper, {
        configurable: true,
        value: () => {
          helperCalls[index] += 1;
        },
      });
      restore.push(() => {
        if (descriptor) Object.defineProperty(target, helper, descriptor);
        else Reflect.deleteProperty(target, helper);
      });
    };
    installOwn(fixtures[0]!.repository, "event", 0);
    installPrototype(SQLiteAttemptRepository.prototype, "event", 1);
    installOwn(fixtures[2]!.repository, "deliveryRecovery", 2);
    installPrototype(SQLiteAttemptRepository.prototype, "deliveryRecovery", 3);
    try {
      for (const [index, fixture] of fixtures.entries()) {
        const attempt = await fixture.repository.createAttempt({
          id: `dddddddd-dddd-4ddd-8ddd-${String(index + 1).padStart(12, "0")}`,
          athleteId: ATHLETE_A,
          input: { mode: "free" },
        });
        const reply = await fixture.app.inject({
          method: "POST",
          url: `/v1/attempts/${attempt.id}/media`,
          headers: {
            ...athleteHeader(ATHLETE_A),
            "content-type":
              "multipart/form-data; boundary=revelai-test-boundary",
          },
          payload: rawMultipartBody({
            name: "media",
            filename: "attempt.mp4",
            contentType: "video/mp4",
            bytes: validMp4Bytes(),
          }),
        });
        expect(reply.statusCode).toBe(202);
        expect(
          await fixture.repository.getAttempt({
            attemptId: attempt.id,
            athleteId: ATHLETE_A,
          }),
        ).toMatchObject({ status: "uploaded" });
      }
      expect(helperCalls).toEqual([0, 0, 0, 0]);
    } finally {
      for (const undo of restore.reverse()) undo();
      await Promise.all(fixtures.map((fixture) => fixture.close()));
    }
  });

  it("rejects structural or cross-C5 media composition before runtime startup", async () => {
    const fixture = await makeMediaApi();
    const foreignRoot = await mkdtemp(join(tmpdir(), "revelai-foreign-c5-"));
    directories.push(foreignRoot);
    const foreignC5 = createC5PipelineTestSupport({ root: foreignRoot });
    expect(() =>
      createFactoryIssuedMediaUploadService({
        repository: fixture.repository,
        retention: fixture.retention,
        queue: fixture.queue,
        mediaPipeline: foreignC5.pipeline,
      }),
    ).toThrow("does not match C4 authority");
    const structuralPipeline = Object.freeze({
      handoffVerifier: () => fixture.c5.handoffVerifier,
      accept: async () => {
        throw new Error("structural C5 pipeline");
      },
      acceptMultipart: async () => {
        throw new Error("structural C5 pipeline");
      },
    });
    expect(() =>
      createFactoryIssuedMediaUploadService({
        repository: fixture.repository,
        retention: fixture.retention,
        queue: fixture.queue,
        mediaPipeline: structuralPipeline,
      }),
    ).toThrow("factory-issued media upload composition");
    expect(() =>
      createFactoryIssuedMediaUploadService({
        repository: fixture.repository,
        retention: fixture.retention,
        queue: fixture.queue,
        mediaPipeline: new Proxy(fixture.c5.pipeline, {}),
      }),
    ).toThrow("factory-issued media upload composition");
    expect(() =>
      createFactoryIssuedMediaUploadService({
        repository: fixture.repository,
        retention: fixture.retention,
        queue: fixture.queue,
        mediaPipeline: Object.assign({}, fixture.c5.pipeline),
      }),
    ).toThrow("factory-issued media upload composition");
    await fixture.close();
  });

  it("official production composition ignores a supplied fake upload seam", async () => {
    const fixture = await makeMediaApi();
    await fixture.app.close();
    const fake: MediaUploadService = Object.freeze({
      preflight: async () => {
        throw new Error("fake preflight must never run");
      },
      accept: async () => {
        throw new Error("fake accept must never run");
      },
    });
    const input: Readonly<
      Parameters<typeof createProductionAttemptApi>[0] & {
        mediaUpload: MediaUploadService;
      }
    > = {
      repository: fixture.repository,
      queue: fixture.queue,
      cleaner: createLocalC8AcceptedMediaCleaner({
        repository: fixture.repository,
        storage: fixture.c5.storage,
      }),
      retention: fixture.retention,
      mediaPipeline: fixture.c5.pipeline,
      mediaUpload: fake,
      scheduler: { everyHour: () => 1, cancel: () => undefined },
    };
    const app = createProductionAttemptApi(input);
    try {
      const attempt = await fixture.repository.createAttempt({
        id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        athleteId: ATHLETE_A,
        input: { mode: "free" },
      });
      const response = await app.inject({
        method: "POST",
        url: `/v1/attempts/${attempt.id}/media`,
        headers: {
          ...athleteHeader(ATHLETE_A),
          "content-type": "multipart/form-data; boundary=revelai-test-boundary",
        },
        payload: rawMultipartBody({
          name: "media",
          filename: "attempt.mp4",
          contentType: "video/mp4",
          bytes: validMp4Bytes(),
        }),
      });
      expect(response.statusCode).toBe(202);
      expect(
        await fixture.repository.getAttempt({
          attemptId: attempt.id,
          athleteId: ATHLETE_A,
        }),
      ).toMatchObject({
        status: "uploaded",
        media: { id: expect.any(String) },
      });
    } finally {
      await app.close();
      await fixture.close();
    }
  });

  it("rejects a cross-host upload handle before recovery can acquire a scheduler", async () => {
    const owner = await makeMediaApi();
    const other = await makeMediaApi();
    const ownerHandle = createFactoryIssuedMediaUploadService({
      repository: owner.repository,
      retention: owner.retention,
      queue: owner.queue,
      mediaPipeline: owner.c5.pipeline,
    });
    const otherHandle = createFactoryIssuedMediaUploadService({
      repository: other.repository,
      retention: other.retention,
      queue: other.queue,
      mediaPipeline: other.c5.pipeline,
    });
    await owner.app.close();
    await other.app.close();
    const everyHour = vi.fn(() => ({ timer: 1 }));
    const scheduler = { everyHour, cancel: () => undefined };
    const otherService = otherHandle.forHost(
      Object.freeze({ repository: other.repository, queue: other.queue }),
    );
    const ownerQueue = resolveFactoryIssuedAnalysisQueuePort(owner.queue);
    const otherQueue = resolveFactoryIssuedAnalysisQueuePort(other.queue);
    if (!otherService || !ownerQueue || !otherQueue)
      throw new Error("Expected a factory-issued cross-host test composition.");
    const input = {
      repository: other.repository,
      queue: otherQueue,
      cleaner: createLocalC8AcceptedMediaCleaner({
        repository: other.repository,
        storage: other.c5.storage,
      }),
      scheduler,
    };
    try {
      expect(() =>
        createProductionAttemptApiFromResolvedQueue({
          repository: other.repository,
          retention: other.retention,
          mediaPipeline: other.c5.pipeline,
          queue: ownerQueue,
          queueHost: other.queue,
          cleaner: input.cleaner,
          scheduler,
        }),
      ).toThrow("factory-issued media upload composition");
      expect(() =>
        createProductionAttemptApi({
          repository: other.repository,
          retention: other.retention,
          mediaPipeline: other.c5.pipeline,
          queue: {
            isAvailable: async () => true,
            enqueue: async () => undefined,
            subscribe: () => () => undefined,
          },
          cleaner: input.cleaner,
          scheduler,
        }),
      ).toThrow("factory-issued media upload composition");
      expect(
        ownerHandle.forHost(
          Object.freeze({ repository: other.repository, queue: other.queue }),
        ),
      ).toBeUndefined();
      expect(everyHour).not.toHaveBeenCalled();

      const otherApp = createInternallyComposedAttemptApi(input, otherService);
      expect(everyHour).toHaveBeenCalledTimes(1);
      await expect(
        otherApp.inject({ method: "GET", url: "/v1/challenges" }),
      ).resolves.toMatchObject({ statusCode: 200 });
      await otherApp.close();
    } finally {
      await owner.close();
      await other.close();
    }
  });

  it("snapshots each official queue composition input before validation", async () => {
    const owner = await makeMediaApi();
    const other = await makeMediaApi();
    await owner.app.close();
    await other.app.close();
    const ownerPort = resolveFactoryIssuedAnalysisQueuePort(owner.queue);
    if (!ownerPort)
      throw new Error("Expected factory-issued queue ports for this test.");

    const cleaner = createLocalC8AcceptedMediaCleaner({
      repository: owner.repository,
      storage: owner.c5.storage,
    });
    const scheduler = { everyHour: () => 1, cancel: () => undefined };
    const clock = { now: () => "2030-01-15T12:00:00.000Z" };
    const ids = { next: () => "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" };
    const nonce = () => "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const log = { event: () => undefined };
    const retentionLog = { event: () => undefined };
    const resolvedReads = {
      repository: 0,
      retention: 0,
      mediaPipeline: 0,
      queue: 0,
      queueHost: 0,
      cleaner: 0,
      maxUploadBytes: 0,
      scheduler: 0,
      recoveryBatchLimit: 0,
      clock: 0,
      ids: 0,
      nonce: 0,
      log: 0,
      retentionLog: 0,
    };
    const resolvedInput = {
      get repository() {
        resolvedReads.repository += 1;
        return owner.repository;
      },
      get retention() {
        resolvedReads.retention += 1;
        return owner.retention;
      },
      get mediaPipeline() {
        resolvedReads.mediaPipeline += 1;
        return owner.c5.pipeline;
      },
      get queue() {
        resolvedReads.queue += 1;
        return ownerPort;
      },
      get queueHost() {
        resolvedReads.queueHost += 1;
        return resolvedReads.queueHost === 1 ? owner.queue : other.queue;
      },
      get cleaner() {
        resolvedReads.cleaner += 1;
        return cleaner;
      },
      get maxUploadBytes() {
        resolvedReads.maxUploadBytes += 1;
        return undefined;
      },
      get scheduler() {
        resolvedReads.scheduler += 1;
        return scheduler;
      },
      get recoveryBatchLimit() {
        resolvedReads.recoveryBatchLimit += 1;
        return 1;
      },
      get clock() {
        resolvedReads.clock += 1;
        return clock;
      },
      get ids() {
        resolvedReads.ids += 1;
        return ids;
      },
      get nonce() {
        resolvedReads.nonce += 1;
        return nonce;
      },
      get log() {
        resolvedReads.log += 1;
        return log;
      },
      get retentionLog() {
        resolvedReads.retentionLog += 1;
        return retentionLog;
      },
    };
    const rawReads = {
      repository: 0,
      retention: 0,
      mediaPipeline: 0,
      queue: 0,
      cleaner: 0,
      maxUploadBytes: 0,
      scheduler: 0,
      recoveryBatchLimit: 0,
      clock: 0,
      ids: 0,
      nonce: 0,
      log: 0,
      retentionLog: 0,
    };
    const rawInput = {
      get repository() {
        rawReads.repository += 1;
        return owner.repository;
      },
      get retention() {
        rawReads.retention += 1;
        return owner.retention;
      },
      get mediaPipeline() {
        rawReads.mediaPipeline += 1;
        return owner.c5.pipeline;
      },
      get queue() {
        rawReads.queue += 1;
        return rawReads.queue === 1 ? owner.queue : other.queue;
      },
      get cleaner() {
        rawReads.cleaner += 1;
        return cleaner;
      },
      get maxUploadBytes() {
        rawReads.maxUploadBytes += 1;
        return undefined;
      },
      get scheduler() {
        rawReads.scheduler += 1;
        return scheduler;
      },
      get recoveryBatchLimit() {
        rawReads.recoveryBatchLimit += 1;
        return 1;
      },
      get clock() {
        rawReads.clock += 1;
        return clock;
      },
      get ids() {
        rawReads.ids += 1;
        return ids;
      },
      get nonce() {
        rawReads.nonce += 1;
        return nonce;
      },
      get log() {
        rawReads.log += 1;
        return log;
      },
      get retentionLog() {
        rawReads.retentionLog += 1;
        return retentionLog;
      },
    };

    let resolvedApp:
      | ReturnType<typeof createProductionAttemptApiFromResolvedQueue>
      | undefined;
    let rawApp: ReturnType<typeof createProductionAttemptApi> | undefined;
    const ownerDeliveries = vi.fn();
    const otherDeliveries = vi.fn();
    const stopOwner = owner.queue.subscribe(ownerDeliveries);
    const stopOther = other.queue.subscribe(otherDeliveries);
    try {
      resolvedApp = createProductionAttemptApiFromResolvedQueue(resolvedInput);
      expect(resolvedReads).toEqual({
        repository: 1,
        retention: 1,
        mediaPipeline: 1,
        queue: 1,
        queueHost: 1,
        cleaner: 1,
        maxUploadBytes: 1,
        scheduler: 1,
        recoveryBatchLimit: 1,
        clock: 1,
        ids: 1,
        nonce: 1,
        log: 1,
        retentionLog: 1,
      });
      await expect(
        resolvedApp.inject({ method: "GET", url: "/v1/challenges" }),
      ).resolves.toMatchObject({ statusCode: 200 });
      const attempt = await owner.repository.createAttempt({
        id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        athleteId: ATHLETE_A,
        input: { mode: "free" },
      });
      await expect(
        resolvedApp.inject({
          method: "POST",
          url: `/v1/attempts/${attempt.id}/media`,
          headers: {
            ...athleteHeader(ATHLETE_A),
            "content-type":
              "multipart/form-data; boundary=revelai-test-boundary",
          },
          payload: rawMultipartBody({
            name: "media",
            filename: "attempt.mp4",
            contentType: "video/mp4",
            bytes: validMp4Bytes(),
          }),
        }),
      ).resolves.toMatchObject({ statusCode: 202 });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(ownerDeliveries).toHaveBeenCalledTimes(1);
      expect(otherDeliveries).not.toHaveBeenCalled();
      await resolvedApp.close();
      resolvedApp = undefined;

      rawApp = createProductionAttemptApi(rawInput);
      expect(rawReads).toEqual({
        repository: 1,
        retention: 1,
        mediaPipeline: 1,
        queue: 1,
        cleaner: 1,
        maxUploadBytes: 1,
        scheduler: 1,
        recoveryBatchLimit: 1,
        clock: 1,
        ids: 1,
        nonce: 1,
        log: 1,
        retentionLog: 1,
      });
      await expect(
        rawApp.inject({ method: "GET", url: "/v1/challenges" }),
      ).resolves.toMatchObject({ statusCode: 200 });
    } finally {
      stopOwner();
      stopOther();
      await resolvedApp?.close();
      await rawApp?.close();
      await owner.close();
      await other.close();
    }
  });

  it("accepts one raw multipart media upload through the real C5 pipeline", async () => {
    const fixture = await makeMediaApi();
    const attempt = await fixture.repository.createAttempt({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      athleteId: ATHLETE_A,
      input: { mode: "free" },
    });
    const body = rawMultipartBody({
      name: "media",
      filename: "attempt.mp4",
      contentType: "video/mp4",
      bytes: validMp4Bytes(),
    });

    const reply = await fixture.app.inject({
      method: "POST",
      url: `/v1/attempts/${attempt.id}/media`,
      headers: {
        ...athleteHeader(ATHLETE_A),
        "content-type": "multipart/form-data; boundary=revelai-test-boundary",
        "content-length": String(body.byteLength),
      },
      payload: Readable.from(chunked(body, [1, 3, 7, 2, 11])),
    });

    expect(reply.statusCode).toBe(202);
    expect(MediaUploadAcceptedSchema.parse(reply.json())).toEqual({
      kind: "media-upload-accepted",
      attemptId: attempt.id,
      mode: "free",
      acceptedStatus: "uploaded",
      outcome: {
        state: "pending",
        attemptId: attempt.id,
        mode: "free",
        status: "uploaded",
      },
    });
    expect(
      await fixture.repository.getAttempt({
        attemptId: attempt.id,
        athleteId: ATHLETE_A,
      }),
    ).toMatchObject({ status: "uploaded" });
    const duplicate = await fixture.app.inject({
      method: "POST",
      url: `/v1/attempts/${attempt.id}/media`,
      headers: {
        ...athleteHeader(ATHLETE_A),
        "content-type": "multipart/form-data; boundary=revelai-test-boundary",
      },
      payload: body,
    });
    expect(duplicate.statusCode).toBe(409);
    expect(RouteErrorSchema.parse(duplicate.json()).code).toBe(
      uploadFixtureError("duplicate-media-upload"),
    );
    await fixture.close();
  });

  it("preflights ownership and queue availability before starting a raw multipart body", async () => {
    const fixture = await makeMediaApi();
    const attempt = await fixture.repository.createAttempt({
      id: "abababab-abab-4bab-8bab-abababababab",
      athleteId: ATHLETE_A,
      input: { mode: "free" },
    });
    const body = rawMultipartBody({
      name: "media",
      filename: "attempt.mp4",
      contentType: "video/mp4",
      bytes: validMp4Bytes(),
    });
    let bodyReads = 0;
    fixture.setQueueAvailability(() => {
      expect(bodyReads).toBe(0);
      return false;
    });
    const reply = await fixture.app.inject({
      method: "POST",
      url: `/v1/attempts/${attempt.id}/media`,
      headers: {
        ...athleteHeader(ATHLETE_A),
        "content-type": "multipart/form-data; boundary=revelai-test-boundary",
      },
      payload: Readable.from(
        (async function* () {
          bodyReads += 1;
          yield body;
        })(),
      ),
    });
    expect(reply.statusCode).toBe(503);
    expect(RouteErrorSchema.parse(reply.json()).code).toBe(
      uploadFixtureError("queue-unavailable-before-body"),
    );
    expect(bodyReads).toBe(1);
    expect(
      await fixture.repository.getAttempt({
        attemptId: attempt.id,
        athleteId: ATHLETE_A,
      }),
    ).toMatchObject({ status: "awaiting-upload", media: null });

    const wrongOwner = await fixture.app.inject({
      method: "POST",
      url: `/v1/attempts/${attempt.id}/media`,
      headers: {
        ...athleteHeader(ATHLETE_B),
        "content-type": "multipart/form-data; boundary=revelai-test-boundary",
      },
      payload: body,
    });
    expect(wrongOwner.statusCode).toBe(404);
    expect(RouteErrorSchema.parse(wrongOwner.json()).code).toBe(
      uploadFixtureError("attempt-owned-by-another-athlete"),
    );
    const unknown = await fixture.app.inject({
      method: "POST",
      url: "/v1/attempts/cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd/media",
      headers: {
        ...athleteHeader(ATHLETE_A),
        "content-type": "multipart/form-data; boundary=revelai-test-boundary",
      },
      payload: body,
    });
    expect(unknown.statusCode).toBe(404);
    expect(RouteErrorSchema.parse(unknown.json()).code).toBe(
      uploadFixtureError("attempt-not-found"),
    );
    await fixture.close();
  });

  it("returns finite invalid_request responses for non-multipart and malformed multipart bodies", async () => {
    const fixture = await makeMediaApi();
    const attempt = await fixture.repository.createAttempt({
      id: "babababa-baba-4aba-8aba-babababababa",
      athleteId: ATHLETE_A,
      input: { mode: "free" },
    });
    for (const request of [
      {
        headers: { "content-type": "application/json" },
        payload: '{"media":"not-a-multipart-upload"}',
      },
      {
        headers: { "content-type": "text/plain" },
        payload: "not-a-multipart-upload",
      },
      {
        headers: {},
        payload: "missing-content-type",
      },
      {
        headers: { "content-type": "multipart/form-data; boundary=" },
        payload: "malformed-boundary",
      },
    ]) {
      const reply = await injectWithin(fixture.app, {
        method: "POST",
        url: `/v1/attempts/${attempt.id}/media`,
        headers: { ...athleteHeader(ATHLETE_A), ...request.headers },
        payload: request.payload,
      });
      expect(reply.statusCode).toBe(400);
      expect(RouteErrorSchema.parse(reply.json()).code).toBe("invalid_request");
    }
    await fixture.close();
  });

  it("keeps multipart parser and drain state inside the media route child scope", async () => {
    const fixture = await makeMediaApi();
    const body = rawMultipartBody({
      name: "media",
      filename: "attempt.mp4",
      contentType: "video/mp4",
      bytes: validMp4Bytes(),
    });
    let createRouteRead = false;
    const createReply = await injectWithin(fixture.app, {
      method: "POST",
      url: "/v1/attempts",
      headers: {
        ...athleteHeader(ATHLETE_A),
        "content-type": "multipart/form-data; boundary=revelai-test-boundary",
      },
      payload: Readable.from(
        (async function* () {
          yield body;
          createRouteRead = true;
        })(),
      ),
    });
    expect(createReply.statusCode).toBe(400);
    expect(RouteErrorSchema.parse(createReply.json()).code).toBe(
      "invalid_request",
    );
    expect(createRouteRead).toBe(false);

    let missingRouteRead = false;
    const missingReply = await injectWithin(fixture.app, {
      method: "POST",
      url: "/v1/not-an-upload-route",
      headers: {
        ...athleteHeader(ATHLETE_A),
        "content-type": "multipart/form-data; boundary=revelai-test-boundary",
      },
      payload: Readable.from(
        (async function* () {
          yield body;
          missingRouteRead = true;
        })(),
      ),
    });
    expect(missingReply.statusCode).toBe(400);
    expect(RouteErrorSchema.parse(missingReply.json()).code).toBe(
      "invalid_request",
    );
    expect(missingRouteRead).toBe(false);
    await fixture.close();
  });

  it("leaves all bytes untouched until preflight, then drains rejected requests without leaking stream errors", async () => {
    const fixture = await makeMediaApi();
    let reads = 0;
    let fullyRead = false;
    const payload = Readable.from(
      (async function* () {
        reads += 1;
        yield Buffer.from("not-", "utf8");
        reads += 1;
        yield Buffer.from("multipart", "utf8");
        fullyRead = true;
      })(),
    );
    const reply = await fixture.app.inject({
      method: "POST",
      url: "/v1/attempts/bcbcbcbc-bcbc-4cbc-8cbc-bcbcbcbcbcbc/media",
      headers: {
        "x-revelai-athlete-id": "not-a-uuid",
        "content-type": "text/plain",
      },
      payload,
    });
    expect(reply.statusCode).toBe(400);
    expect(RouteErrorSchema.parse(reply.json()).code).toBe(
      "invalid_athlete_identity",
    );
    await resolvesSoon(() => fullyRead);
    expect(reads).toBe(2);

    const streamError = await fixture.app.inject({
      method: "POST",
      url: "/v1/attempts/cacacaca-caca-4aca-8aca-cacacacacaca/media",
      headers: {
        "x-revelai-athlete-id": "not-a-uuid",
        "content-type": "text/plain",
      },
      payload: Readable.from(
        (async function* () {
          yield Buffer.from("partial", "utf8");
          throw new Error("private body failure");
        })(),
      ),
    });
    expect(streamError.statusCode).toBe(400);
    expect(streamError.body).not.toContain("private body failure");
    await fixture.close();
  });

  it("detaches the parser wrapper before draining a large early C5 rejection", async () => {
    const fixture = await makeMediaApi();
    const attempt = await fixture.repository.createAttempt({
      id: "cececece-cece-4ece-8ece-cececececece",
      athleteId: ATHLETE_A,
      input: { mode: "free" },
    });
    const body = rawMultipartBody({
      name: "media",
      filename: "invalid.txt",
      contentType: "video/mp4",
      bytes: Buffer.alloc(48 * 1_024, 0),
    });
    let chunksRead = 0;
    let fullyRead = false;
    const payload = Readable.from(
      (async function* () {
        for (const chunk of chunked(body, [512])) {
          chunksRead += 1;
          yield chunk;
        }
        fullyRead = true;
      })(),
    );

    const reply = await injectWithin(fixture.app, {
      method: "POST",
      url: `/v1/attempts/${attempt.id}/media`,
      headers: {
        ...athleteHeader(ATHLETE_A),
        "content-type": "multipart/form-data; boundary=revelai-test-boundary",
      },
      payload,
    });

    expect(reply.statusCode).toBe(400);
    expect(RouteErrorSchema.parse(reply.json()).code).toBe(
      "media_filename_mime_mismatch",
    );
    await resolvesSoon(() => fullyRead);
    expect(chunksRead).toBeGreaterThan(32);
    await fixture.close();
  });

  it("rejects a mixed SQLite retention composition before it can create an orphan", async () => {
    const fixture = await makeMediaApi();
    expect(Reflect.get(fixture.repository, "raw")).toBeUndefined();
    expect(Reflect.get(fixture.repository, "database")).toBeUndefined();
    const attempt = await fixture.repository.createAttempt({
      id: "dededede-dede-4ede-8ede-dededededede",
      athleteId: ATHLETE_A,
      input: { mode: "free" },
    });
    const foreignDirectory = await mkdtemp(
      join(tmpdir(), "revelai-attempt-media-foreign-retention-"),
    );
    directories.push(foreignDirectory);
    const foreignDatabase = openSqliteDatabase(
      join(foreignDirectory, "foreign.sqlite"),
    );
    const foreignRetention = new SQLiteRetentionRepository({
      database: foreignDatabase,
    });

    expect(() =>
      createFactoryIssuedMediaUploadService({
        repository: fixture.repository,
        queue: fixture.queue,
        retention: foreignRetention,
        mediaPipeline: fixture.c5.pipeline,
      }),
    ).toThrow("factory-issued media upload composition");
    expect(
      foreignDatabase.raw
        .prepare("SELECT COUNT(*) AS count FROM media_retention_records")
        .get(),
    ).toEqual({ count: 0 });
    expect(
      await fixture.repository.getAttempt({
        attemptId: attempt.id,
        athleteId: ATHLETE_A,
      }),
    ).toMatchObject({ status: "awaiting-upload", media: null });

    foreignDatabase.close();
    await fixture.close();
  });

  it("rejects a pre-existing non-upload state before parsing its multipart body", async () => {
    const fixture = await makeMediaApi();
    const attempt = await fixture.repository.createAttempt({
      id: "cececece-cece-4ece-8ece-cececececece",
      athleteId: ATHLETE_A,
      input: { mode: "free" },
    });
    fixture.database.raw
      .prepare("UPDATE attempts SET status = 'processing' WHERE id = ?")
      .run(attempt.id);
    const reply = await fixture.app.inject({
      method: "POST",
      url: `/v1/attempts/${attempt.id}/media`,
      headers: {
        ...athleteHeader(ATHLETE_A),
        "content-type": "multipart/form-data; boundary=revelai-test-boundary",
      },
      payload: rawMultipartBody({
        name: "media",
        filename: "attempt.mp4",
        contentType: "video/mp4",
        bytes: validMp4Bytes(),
      }),
    });
    expect(reply.statusCode).toBe(409);
    expect(RouteErrorSchema.parse(reply.json()).code).toBe(
      uploadFixtureError("invalid-attempt-transition"),
    );
    await fixture.close();
  });

  it("consumes the shared raw multipart fixture through Fastify and keeps parser detail private", async () => {
    const fixture = await makeMediaApi();
    const attempt = await fixture.repository.createAttempt({
      id: "acacacac-acac-4cac-8cac-acacacacacac",
      athleteId: ATHLETE_A,
      input: { mode: "free" },
    });
    const shared = mediaUploadFixtures.rawMultipart;
    if (shared.adapter !== "fastify-raw")
      throw new Error("Expected raw fixture.");
    const reply = await fixture.app.inject({
      method: "POST",
      url: `/v1/attempts/${attempt.id}/media`,
      headers: { ...shared.headers, ...athleteHeader(ATHLETE_A) },
      payload: shared.body,
    });
    expect(reply.statusCode).toBe(415);
    expect(RouteErrorSchema.parse(reply.json())).toMatchObject({
      code: uploadFixtureError("container-not-allowed"),
    });
    expect(reply.body).not.toMatch(/boundary|ffprobe|\/tmp/i);
    await fixture.close();
  });

  it("normalizes a malformed multipart parser failure without attaching media", async () => {
    const fixture = await makeMediaApi();
    const attempt = await fixture.repository.createAttempt({
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      athleteId: ATHLETE_A,
      input: { mode: "free" },
    });
    const reply = await fixture.app.inject({
      method: "POST",
      url: `/v1/attempts/${attempt.id}/media`,
      headers: {
        ...athleteHeader(ATHLETE_A),
        "content-type": "multipart/form-data; boundary=revelai-test-boundary",
      },
      payload: Buffer.from("--revelai-test-boundary\r\n", "utf8"),
    });
    expect(reply.statusCode).toBe(400);
    expect(RouteErrorSchema.parse(reply.json())).toEqual({
      code: "invalid_request",
      message: "Não foi possível entender esta solicitação.",
      retryable: false,
    });
    expect(
      await fixture.repository.getAttempt({
        attemptId: attempt.id,
        athleteId: ATHLETE_A,
      }),
    ).toMatchObject({ status: "awaiting-upload", media: null });
    await fixture.close();
  });

  it("maps real C5 storage failures to their shared route-error fixtures before attachment", async () => {
    const cases: readonly Readonly<{
      code:
        | "media_container_not_allowed"
        | "media_probe_failed"
        | "media_requirements_not_met";
      bytes: Uint8Array;
      prober?: LocalMediaProber;
    }>[] = [
      {
        code: "media_container_not_allowed",
        bytes: Uint8Array.from([1, 2, 3, 4]),
      },
      {
        code: "media_probe_failed",
        bytes: validMp4Bytes(),
        prober: Object.freeze({
          probe: async () => {
            throw new MediaPipelineError("media_probe_failed");
          },
        }),
      },
      {
        code: "media_requirements_not_met",
        bytes: validMp4Bytes(),
        prober: Object.freeze({
          probe: async () =>
            Object.freeze({
              container: "mp4" as const,
              durationSeconds: 1,
              displayWidth: 1280,
              displayHeight: 720,
              nominalFps: 30,
              codec: "h264",
              sourceRotationDegrees: 0 as const,
            }),
        }),
      },
    ];
    for (const [index, entry] of cases.entries()) {
      const { code } = entry;
      const fixture = await makeMediaApi({
        ...(entry.prober ? { prober: entry.prober } : {}),
      });
      const attempt = await fixture.repository.createAttempt({
        id: `beefbeef-beef-4eef-8eef-${String(index + 1).padStart(12, "0")}`,
        athleteId: ATHLETE_A,
        input: { mode: "free" },
      });
      const reply = await fixture.app.inject({
        method: "POST",
        url: `/v1/attempts/${attempt.id}/media`,
        headers: {
          ...athleteHeader(ATHLETE_A),
          "content-type": "multipart/form-data; boundary=revelai-test-boundary",
        },
        payload: rawMultipartBody({
          name: "media",
          filename: "attempt.mp4",
          contentType: "video/mp4",
          bytes: entry.bytes,
        }),
      });
      const expected = routeErrorFixtures.find(
        (candidate) => candidate.body.code === code,
      );
      expect(expected, code).toBeDefined();
      expect(reply.statusCode, code).toBe(expected?.status);
      expect(RouteErrorSchema.parse(reply.json()).code, code).toBe(code);
      expect(
        await fixture.repository.getAttempt({
          attemptId: attempt.id,
          athleteId: ATHLETE_A,
        }),
      ).toMatchObject({ status: "awaiting-upload", media: null });
      await fixture.close();
    }
  });

  it("abandons a partially-read client upload before C5 can attach media", async () => {
    const contract = uploadFixture("client-abort-before-commit");
    expect(contract.expected.kind).toBe("no-response");
    const fixture = await makeMediaApi();
    const attempt = await fixture.repository.createAttempt({
      id: "bcbcbcbc-bcbc-4cbc-8cbc-bcbcbcbcbcbc",
      athleteId: ATHLETE_A,
      input: { mode: "free" },
    });
    const body = rawMultipartBody({
      name: "media",
      filename: "attempt.mp4",
      contentType: "video/mp4",
      bytes: validMp4Bytes(),
    });
    await Promise.allSettled([
      fixture.app.inject({
        method: "POST",
        url: `/v1/attempts/${attempt.id}/media`,
        headers: {
          ...athleteHeader(ATHLETE_A),
          "content-type": "multipart/form-data; boundary=revelai-test-boundary",
        },
        payload: Readable.from(
          (async function* () {
            yield body.subarray(0, body.byteLength - 8);
            throw new Error("client cancelled upload");
          })(),
        ),
      }),
    ]);
    expect(
      await fixture.repository.getAttempt({
        attemptId: attempt.id,
        athleteId: ATHLETE_A,
      }),
    ).toMatchObject({ status: "awaiting-upload", media: null });
    expect(await fixture.c5.storage.discoverReservedOrphans(10)).toEqual([]);
    await fixture.close();
  });

  it("rejects duplicate and malformed multipart upload boundaries without attaching media", async () => {
    const fixture = await makeMediaApi();
    const malformed = [
      {
        fixtureName: "missing-media-part",
        body: rawMultipartParts([]),
      },
      {
        fixtureName: "zero-byte-media",
        body: rawMultipartBody({
          name: "media",
          filename: "attempt.mp4",
          contentType: "video/mp4",
          bytes: new Uint8Array(),
        }),
      },
      {
        fixtureName: "wrong-file-field-name",
        body: rawMultipartBody({
          name: "video",
          filename: "attempt.mp4",
          contentType: "video/mp4",
          bytes: validMp4Bytes(),
        }),
      },
      {
        fixtureName: "extra-text-part",
        body: rawMultipartParts([
          {
            kind: "file",
            name: "media",
            filename: "attempt.mp4",
            contentType: "video/mp4",
            bytes: validMp4Bytes(),
          },
          {
            kind: "field",
            name: "note",
            value: "forbidden",
          },
        ]),
      },
      {
        fixtureName: "extra-file-part",
        body: rawMultipartParts([
          {
            kind: "file",
            name: "media",
            filename: "attempt.mp4",
            contentType: "video/mp4",
            bytes: validMp4Bytes(),
          },
          {
            kind: "file",
            name: "thumbnail",
            filename: "thumbnail.mp4",
            contentType: "video/mp4",
            bytes: validMp4Bytes(),
          },
        ]),
      },
      {
        fixtureName: "filename-mime-mismatch",
        body: rawMultipartBody({
          name: "media",
          filename: "attempt.mov",
          contentType: "video/mp4",
          bytes: validMp4Bytes(),
        }),
      },
      {
        fixtureName: "repeated-media-part",
        body: rawMultipartParts([
          {
            kind: "file",
            name: "media",
            filename: "attempt.mp4",
            contentType: "video/mp4",
            bytes: validMp4Bytes(),
          },
          {
            kind: "file",
            name: "media",
            filename: "retry.mp4",
            contentType: "video/mp4",
            bytes: validMp4Bytes(),
          },
        ]),
      },
    ] as const;
    for (const [index, malformedCase] of malformed.entries()) {
      const attempt = await fixture.repository.createAttempt({
        id: `acacacac-acac-4cac-8cac-${String(index + 1).padStart(12, "0")}`,
        athleteId: ATHLETE_A,
        input: { mode: "free" },
      });
      const reply = await fixture.app.inject({
        method: "POST",
        url: `/v1/attempts/${attempt.id}/media`,
        headers: {
          ...athleteHeader(ATHLETE_A),
          "content-type": "multipart/form-data; boundary=revelai-test-boundary",
        },
        payload: malformedCase.body,
      });
      const code = uploadFixtureError(malformedCase.fixtureName);
      expect(reply.statusCode, malformedCase.fixtureName).toBe(
        code === "media_empty" ? 422 : 400,
      );
      expect(RouteErrorSchema.parse(reply.json()).code).toBe(code);
      expect(
        await fixture.repository.getAttempt({
          attemptId: attempt.id,
          athleteId: ATHLETE_A,
        }),
      ).toMatchObject({ status: "awaiting-upload", media: null });
    }
    await fixture.close();
  });

  it("rolls back an accepted C5 upload when queue delivery fails", async () => {
    const fixture = await makeMediaApi();
    const attempt = await fixture.repository.createAttempt({
      id: "adadadad-adad-4dad-8dad-adadadadadad",
      athleteId: ATHLETE_A,
      input: { mode: "free" },
    });
    let availabilityChecks = 0;
    fixture.setQueueAvailability(() => {
      availabilityChecks += 1;
      return availabilityChecks < 3;
    });
    const reply = await fixture.app.inject({
      method: "POST",
      url: `/v1/attempts/${attempt.id}/media`,
      headers: {
        ...athleteHeader(ATHLETE_A),
        "content-type": "multipart/form-data; boundary=revelai-test-boundary",
      },
      payload: rawMultipartBody({
        name: "media",
        filename: "attempt.mp4",
        contentType: "video/mp4",
        bytes: validMp4Bytes(),
      }),
    });
    expect(reply.statusCode).toBe(503);
    expect(RouteErrorSchema.parse(reply.json()).code).toBe(
      uploadFixtureError("queue-enqueue-failed-after-attach-rolls-back"),
    );
    expect(
      await fixture.repository.getAttempt({
        attemptId: attempt.id,
        athleteId: ATHLETE_A,
      }),
    ).toMatchObject({ status: "awaiting-upload", media: null });
    await fixture.close();
  });

  it("uses observed bytes, not Content-Length, for file and envelope limits", async () => {
    const fixture = await makeMediaApi({ maxUploadBytes: 16 });
    const accepted = await fixture.repository.createAttempt({
      id: "aeaeaeae-aeae-4eae-8eae-aeaeaeaeaeae",
      athleteId: ATHLETE_A,
      input: { mode: "free" },
    });
    const acceptedReply = await fixture.app.inject({
      method: "POST",
      url: `/v1/attempts/${accepted.id}/media`,
      headers: {
        ...athleteHeader(ATHLETE_A),
        "content-type": "multipart/form-data; boundary=revelai-test-boundary",
        "content-length": "65553",
      },
      payload: rawMultipartBody({
        name: "media",
        filename: "attempt.mp4",
        contentType: "video/mp4",
        bytes: validMp4Bytes(),
      }),
    });
    expect(acceptedReply.statusCode).toBe(202);

    const tooLarge = await fixture.repository.createAttempt({
      id: "afafafaf-afaf-4faf-8faf-afafafafafaf",
      athleteId: ATHLETE_A,
      input: { mode: "free" },
    });
    const tooLargeReply = await fixture.app.inject({
      method: "POST",
      url: `/v1/attempts/${tooLarge.id}/media`,
      headers: {
        ...athleteHeader(ATHLETE_A),
        "content-type": "multipart/form-data; boundary=revelai-test-boundary",
        "content-length": "1",
      },
      payload: rawMultipartBody({
        name: "media",
        filename: "attempt.mp4",
        contentType: "video/mp4",
        bytes: Buffer.concat([Buffer.from(validMp4Bytes()), Buffer.from([0])]),
      }),
    });
    expect(tooLargeReply.statusCode).toBe(413);
    expect(RouteErrorSchema.parse(tooLargeReply.json()).code).toBe(
      uploadFixtureError("media-byte-limit-exceeded"),
    );

    const tooLargeEnvelope = await fixture.repository.createAttempt({
      id: "babababa-baba-4aba-8aba-babababababa",
      athleteId: ATHLETE_A,
      input: { mode: "free" },
    });
    const tooLargeEnvelopeReply = await fixture.app.inject({
      method: "POST",
      url: `/v1/attempts/${tooLargeEnvelope.id}/media`,
      headers: {
        ...athleteHeader(ATHLETE_A),
        "content-type": "multipart/form-data; boundary=revelai-test-boundary",
        "content-length": "1",
      },
      payload: Buffer.alloc(16 + 65_536 + 1, 0),
    });
    expect(tooLargeEnvelopeReply.statusCode).toBe(413);
    expect(RouteErrorSchema.parse(tooLargeEnvelopeReply.json()).code).toBe(
      uploadFixtureError("multipart-envelope-limit-exceeded"),
    );
    await fixture.close();
  });

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

  it("reads an owned active attempt and its deterministic pending outcome", async () => {
    const fixture = await makeApi();
    const created = CreateAttemptResponseSchema.parse(
      (
        await fixture.app.inject({
          method: "POST",
          url: "/v1/attempts",
          headers: athleteHeader(ATHLETE_A),
          payload: { mode: "free" },
        })
      ).json(),
    );

    const attempt = await fixture.app.inject({
      method: "GET",
      url: `/v1/attempts/${created.id}`,
      headers: athleteHeader(ATHLETE_A),
    });
    expect(attempt.statusCode).toBe(200);
    expect(AttemptReadResponseSchema.parse(attempt.json())).toEqual({
      id: created.id,
      mode: "free",
      status: "awaiting-upload",
      createdAt: "2030-01-15T12:00:00.000Z",
      outcome: {
        state: "pending",
        attemptId: created.id,
        mode: "free",
        status: "awaiting-upload",
      },
    });

    const result = await fixture.app.inject({
      method: "GET",
      url: `/v1/attempts/${created.id}/result`,
      headers: athleteHeader(ATHLETE_A),
    });
    expect(result.statusCode).toBe(202);
    expect(AttemptResultResponseSchema.parse(result.json())).toEqual({
      state: "pending",
      attemptId: created.id,
      mode: "free",
      status: "awaiting-upload",
    });
    await fixture.close();
  });

  it("makes attempt reads identity-scoped and rejects malformed or tombstoned identifiers", async () => {
    const fixture = await makeApi();
    const created = CreateAttemptResponseSchema.parse(
      (
        await fixture.app.inject({
          method: "POST",
          url: "/v1/attempts",
          headers: athleteHeader(ATHLETE_A),
          payload: { mode: "free" },
        })
      ).json(),
    );
    const requests = [
      {
        label: "missing athlete header",
        url: `/v1/attempts/${created.id}/result`,
        headers: {},
        statusCode: 400,
        code: "invalid_athlete_identity",
      },
      {
        label: "other athlete summary",
        url: `/v1/attempts/${created.id}`,
        headers: athleteHeader(ATHLETE_B),
        statusCode: 404,
        code: "attempt_not_found",
      },
      {
        label: "other athlete result",
        url: `/v1/attempts/${created.id}/result`,
        headers: athleteHeader(ATHLETE_B),
        statusCode: 404,
        code: "attempt_not_found",
      },
      {
        label: "unknown attempt summary",
        url: "/v1/attempts/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        headers: athleteHeader(ATHLETE_A),
        statusCode: 404,
        code: "attempt_not_found",
      },
      {
        label: "unknown attempt result",
        url: "/v1/attempts/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/result",
        headers: athleteHeader(ATHLETE_A),
        statusCode: 404,
        code: "attempt_not_found",
      },
      {
        label: "noncanonical path",
        url: "/v1/attempts/AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA",
        headers: athleteHeader(ATHLETE_A),
        statusCode: 400,
        code: "invalid_request",
      },
      {
        label: "trimmed path",
        url: `/v1/attempts/%20${created.id}%20`,
        headers: athleteHeader(ATHLETE_A),
        statusCode: 400,
        code: "invalid_request",
      },
      {
        label: "encoded UUID separator",
        url: `/v1/attempts/${created.id.replaceAll("-", "%2D")}`,
        headers: athleteHeader(ATHLETE_A),
        statusCode: 400,
        code: "invalid_request",
      },
      {
        label: "query injection",
        url: `/v1/attempts/${created.id}/result?athleteId=${ATHLETE_B}`,
        headers: athleteHeader(ATHLETE_A),
        statusCode: 400,
        code: "invalid_request",
      },
    ] as const;
    for (const request of requests) {
      const response = await fixture.app.inject({
        method: "GET",
        url: request.url,
        headers: request.headers,
      });
      expect(response.statusCode, request.label).toBe(request.statusCode);
      expect(RouteErrorSchema.parse(response.json()).code, request.label).toBe(
        request.code,
      );
    }

    await fixture.repository.tombstoneAttempt({
      attemptId: created.id,
      athleteId: ATHLETE_A,
    });
    for (const suffix of ["", "/result"]) {
      const response = await fixture.app.inject({
        method: "GET",
        url: `/v1/attempts/${created.id}${suffix}`,
        headers: athleteHeader(ATHLETE_A),
      });
      expect(response.statusCode).toBe(404);
      expect(RouteErrorSchema.parse(response.json()).code).toBe(
        "attempt_not_found",
      );
    }
    await fixture.close();
  });

  it("rejects every raw query suffix from both canonical attempt read URLs", async () => {
    const fixture = await makeApi();
    const created = CreateAttemptResponseSchema.parse(
      (
        await fixture.app.inject({
          method: "POST",
          url: "/v1/attempts",
          headers: athleteHeader(ATHLETE_A),
          payload: { mode: "free" },
        })
      ).json(),
    );
    await fixture.app.listen({ host: "127.0.0.1", port: 0 });

    try {
      for (const path of [
        `/v1/attempts/${created.id}?`,
        `/v1/attempts/${created.id}?&`,
        `/v1/attempts/${created.id}/result?`,
        `/v1/attempts/${created.id}/result?&`,
      ]) {
        const response = await rawHttpGet(
          fixture.app,
          path,
          athleteHeader(ATHLETE_A),
        );
        expect(response.statusCode, path).toBe(400);
        expect(
          RouteErrorSchema.parse(JSON.parse(response.body)).code,
          path,
        ).toBe("invalid_request");
      }
    } finally {
      await fixture.close();
    }
  });

  it("projects C4's authoritative pending and terminal outcomes through the exact C2 schemas", async () => {
    const issuedIds = [
      "11111111-1111-4111-8111-111111111112",
      "11111111-1111-4111-8111-111111111113",
      "11111111-1111-4111-8111-111111111114",
      "11111111-1111-4111-8111-111111111115",
      "11111111-1111-4111-8111-111111111116",
      "11111111-1111-4111-8111-111111111117",
    ];
    const fixture = await makeMediaApi({
      ids: () => issuedIds.shift() ?? "ffffffff-ffff-4fff-8fff-ffffffffffff",
    });
    const cases: readonly Readonly<{
      id: string;
      mode: "free" | "verified";
      candidate: TerminalCandidate;
      expectedStatus: "valid" | "invalid" | "failed";
    }>[] = [
      {
        id: "abababab-abab-4bab-8bab-aaaaaaaaaaaa",
        mode: "free",
        candidate: freeTerminalCandidate(
          "abababab-abab-4bab-8bab-aaaaaaaaaaaa",
        ),
        expectedStatus: "valid",
      },
      {
        id: "bcbcbcbc-bcbc-4bcb-8bcb-bbbbbbbbbbbb",
        mode: "free",
        candidate: {
          state: "failed",
          attemptId: "bcbcbcbc-bcbc-4bcb-8bcb-bbbbbbbbbbbb",
          mode: "free",
          code: "analysis_temporary_unavailable",
          message: "A análise está indisponível temporariamente.",
          retryable: true,
        },
        expectedStatus: "failed",
      },
      {
        id: "cdcdcdcd-cdcd-4dcd-8dcd-cccccccccccc",
        mode: "verified",
        candidate: {
          state: "invalid",
          attemptId: "cdcdcdcd-cdcd-4dcd-8dcd-cccccccccccc",
          mode: "verified",
          code: "calibration_not_verified",
          message: "Refaça a calibração antes de tentar novamente.",
          retryable: true,
        },
        expectedStatus: "invalid",
      },
      {
        id: "dededede-dede-4ede-8ede-dddddddddddd",
        mode: "verified",
        candidate: verifiedDemoTerminalOutcome(
          "dededede-dede-4ede-8ede-dddddddddddd",
          "2030-01-15T12:00:00.000Z",
        ),
        expectedStatus: "valid",
      },
    ];
    for (const input of cases) {
      const attempt = await createAttemptForReadProjection(fixture, input);
      const pending = await fixture.app.inject({
        method: "GET",
        url: `/v1/attempts/${attempt.id}/result`,
        headers: athleteHeader(ATHLETE_A),
      });
      expect(pending.statusCode).toBe(202);
      expect(AttemptResultResponseSchema.parse(pending.json())).toEqual({
        state: "pending",
        attemptId: attempt.id,
        mode: input.mode,
        status: "uploaded",
      });

      const claim = await fixture.repository.claimProcessing({
        attemptId: attempt.id,
        generation: 1,
      });
      expect(claim).not.toBeNull();
      const processing = await fixture.app.inject({
        method: "GET",
        url: `/v1/attempts/${attempt.id}/result`,
        headers: athleteHeader(ATHLETE_A),
      });
      expect(processing.statusCode).toBe(202);
      expect(AttemptResultResponseSchema.parse(processing.json())).toEqual({
        state: "pending",
        attemptId: attempt.id,
        mode: input.mode,
        status: "processing",
      });
      await fixture.repository.finalizeTerminalResult({
        attemptId: attempt.id,
        leaseId: claim!.leaseId,
        generation: claim!.generation,
        candidate: input.candidate,
      });

      const attemptRead = await fixture.app.inject({
        method: "GET",
        url: `/v1/attempts/${attempt.id}`,
        headers: athleteHeader(ATHLETE_A),
      });
      expect(attemptRead.statusCode).toBe(200);
      const summary = AttemptReadResponseSchema.parse(attemptRead.json());
      expect(summary.status).toBe(input.expectedStatus);
      expect(summary.outcome).toEqual(input.candidate);
      expect(summary).not.toHaveProperty("athleteId");
      expect(summary).not.toHaveProperty("media");
      expect(JSON.stringify(summary)).not.toContain("lease");
      expect(JSON.stringify(summary)).not.toContain("generation");

      const result = await fixture.app.inject({
        method: "GET",
        url: `/v1/attempts/${attempt.id}/result`,
        headers: athleteHeader(ATHLETE_A),
      });
      expect(result.statusCode).toBe(200);
      expect(AttemptResultResponseSchema.parse(result.json())).toEqual(
        input.candidate,
      );
    }
    await fixture.close();
  });

  it("normalizes a legacy terminal attempt once before presenting coherent public reads", async () => {
    const directory = await mkdtemp(join(tmpdir(), "revelai-legacy-read-"));
    directories.push(directory);
    const filename = join(directory, "api.sqlite");
    const legacy = openSqliteDatabaseAtVersionForTest(filename, 4);
    const completedAt = "2030-01-15T12:00:00.000Z";
    const attemptId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    const sessionId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const outcome = verifiedDemoTerminalOutcome(attemptId, completedAt);
    legacy.raw
      .prepare("INSERT INTO athletes (id, created_at) VALUES (?, ?)")
      .run(ATHLETE_A, completedAt);
    legacy.raw
      .prepare(
        "INSERT INTO calibration_sessions (id, athlete_id, nonce, challenge_id, challenge_version, state, issued_at, expires_at, consumed_at) VALUES (?, ?, ?, 'wall-pass', 1, 'consumed', ?, ?, ?)",
      )
      .run(
        sessionId,
        ATHLETE_A,
        "A".repeat(43),
        completedAt,
        "2030-01-15T12:15:00.000Z",
        completedAt,
      );
    legacy.raw
      .prepare(
        "INSERT INTO attempts (id, athlete_id, mode, challenge_id, challenge_version, calibration_session_id, status, deletion_state, media_json, processing_generation, processing_lease_id, processing_lease_expires_at, created_at, updated_at) VALUES (?, ?, 'verified', 'wall-pass', 1, ?, 'processing', 'active', ?, 1, ?, ?, ?, ?)",
      )
      .run(
        attemptId,
        ATHLETE_A,
        sessionId,
        JSON.stringify({
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          contentType: "video/mp4",
          bytes: 10,
          deleteAt: "2030-01-16T12:00:00.000Z",
        }),
        "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        "2030-01-15T12:05:00.000Z",
        completedAt,
        completedAt,
      );
    legacy.raw
      .prepare(
        "INSERT INTO terminal_results (id, attempt_id, lease_id, generation, terminal_state, outcome_json, completed_at, created_at, request_outcome_json) VALUES (?, ?, ?, 1, 'valid', ?, ?, ?, ?)",
      )
      .run(
        "legacy-result",
        attemptId,
        "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        JSON.stringify(outcome),
        completedAt,
        completedAt,
        JSON.stringify(outcome),
      );
    legacy.close();

    const database = openSqliteDatabase(filename);
    const repository = SQLiteAttemptRepository.forReadOnlyTest({
      database,
      clock: { now: () => completedAt },
      ids: { next: () => "ffffffff-ffff-4fff-8fff-ffffffffffff" },
    });
    const app = createAttemptApi({
      repository,
      queue: { isAvailable: async () => true, enqueue: async () => undefined },
      cleaner: { cleanup: async () => undefined },
      scheduler: { everyHour: () => 1, cancel: () => undefined },
    });
    try {
      const attempt = await app.inject({
        method: "GET",
        url: `/v1/attempts/${attemptId}`,
        headers: athleteHeader(ATHLETE_A),
      });
      expect(attempt.statusCode).toBe(200);
      expect(AttemptReadResponseSchema.parse(attempt.json())).toEqual({
        id: attemptId,
        mode: "verified",
        status: "valid",
        createdAt: completedAt,
        challenge: { id: "wall-pass", version: 1 },
        outcome,
      });
      const result = await app.inject({
        method: "GET",
        url: `/v1/attempts/${attemptId}/result`,
        headers: athleteHeader(ATHLETE_A),
      });
      expect(result.statusCode).toBe(200);
      expect(AttemptResultResponseSchema.parse(result.json())).toEqual(outcome);
      expect(
        database.raw
          .prepare("SELECT status FROM attempts WHERE id = ?")
          .get(attemptId),
      ).toEqual({ status: "valid" });
    } finally {
      await app.close();
      database.close();
    }
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
        queue: {
          isAvailable: async () => true,
          enqueue: async () => undefined,
        },
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
      queue: { isAvailable: async () => true, enqueue: async () => undefined },
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

function uploadFixture(name: string) {
  const fixture = mediaUploadFixtures.rejected.find(
    (candidate) => candidate.name === name,
  );
  if (!fixture) throw new Error(`Missing media upload fixture: ${name}`);
  return fixture;
}

function uploadFixtureError(name: string) {
  const expected = uploadFixture(name).expected;
  if (expected.kind !== "route-error")
    throw new Error(`Fixture does not contain a route error: ${name}`);
  return expected.body.code;
}

async function injectWithin(app: FastifyInstance, input: InjectOptions) {
  return Promise.race([
    app.inject(input),
    new Promise<never>((_resolve, reject) => {
      setTimeout(
        () => reject(new Error("Fastify injection did not settle.")),
        500,
      );
    }),
  ]);
}

async function resolvesSoon(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 500;
  while (!predicate()) {
    if (Date.now() >= deadline)
      throw new Error("Expected rejected request body to drain.");
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
}

function nextEventTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function waitForRetentionDrain(
  retention: SQLiteRetentionRepository,
): Promise<void> {
  const deadline = Date.now() + 500;
  while (true) {
    const due = await retention.listDue({
      now: "2030-01-15T12:00:00.000Z",
      limit: 10,
    });
    if (due.length === 0) return;
    if (Date.now() >= deadline)
      throw new Error("Expected the official retention runtime to drain.");
    await nextEventTurn();
  }
}

function athleteHeader(athleteId: string): Readonly<Record<string, string>> {
  return { "x-revelai-athlete-id": athleteId };
}

async function rawHttpGet(
  app: FastifyInstance,
  path: string,
  headers: Readonly<Record<string, string>>,
): Promise<Readonly<{ statusCode: number; body: string }>> {
  return rawHttpRequest(app, "GET", path, headers);
}

async function rawHttpDelete(
  app: FastifyInstance,
  path: string,
  headers: Readonly<Record<string, string>>,
): Promise<Readonly<{ statusCode: number; body: string }>> {
  return rawHttpRequest(app, "DELETE", path, headers);
}

async function rawHttpRequest(
  app: FastifyInstance,
  method: "GET" | "DELETE",
  path: string,
  headers: Readonly<Record<string, string>>,
): Promise<Readonly<{ statusCode: number; body: string }>> {
  const address = app.server.address();
  if (address === null || typeof address === "string")
    throw new Error("Expected a listening TCP Fastify server.");
  return new Promise((resolveRequest, rejectRequest) => {
    const request = httpRequest(
      {
        hostname: "127.0.0.1",
        port: address.port,
        method,
        path,
        headers,
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          body += chunk;
        });
        response.once("error", rejectRequest);
        response.once("end", () =>
          resolveRequest(
            Object.freeze({ statusCode: response.statusCode ?? 0, body }),
          ),
        );
      },
    );
    request.once("error", rejectRequest);
    request.end();
  });
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
    queue: { isAvailable: async () => true, enqueue: async () => undefined },
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
    directory,
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

async function makeMediaApi(
  input?: Readonly<{
    ids?: () => string;
    maxUploadBytes?: number;
    prober?: LocalMediaProber;
    retentionLog?: RetentionLog;
  }>,
) {
  const directory = await mkdtemp(join(tmpdir(), "revelai-attempt-media-api-"));
  directories.push(directory);
  const database = openSqliteDatabase(join(directory, "api.sqlite"));
  const c5 = createC5PipelineTestSupport({
    root: join(directory, "c5"),
    ...(input?.prober ? { prober: input.prober } : {}),
  });
  const repository = new SQLiteAttemptRepository({
    database,
    clock: { now: () => "2030-01-15T12:00:00.000Z" },
    ids: {
      next: () => input?.ids?.() ?? "ffffffff-ffff-4fff-8fff-ffffffffffff",
    },
    handoffVerifier: c5.handoffVerifier,
  });
  let availability = (): boolean => true;
  const queue = new InMemoryAnalysisQueue({
    available: () => availability(),
  });
  const retention = new SQLiteRetentionRepository({ database });
  const hourlyTasks: Array<() => void> = [];
  const cancelledHourlyTasks: unknown[] = [];
  const app = createProductionAttemptApi({
    repository,
    queue,
    cleaner: createLocalC8AcceptedMediaCleaner({
      repository,
      storage: c5.storage,
    }),
    retention,
    mediaPipeline: c5.pipeline,
    ...(input?.maxUploadBytes === undefined
      ? {}
      : { maxUploadBytes: input.maxUploadBytes }),
    ...(input?.retentionLog ? { retentionLog: input.retentionLog } : {}),
    scheduler: {
      everyHour: (task) => {
        hourlyTasks.push(task);
        return task;
      },
      cancel: (handle) => {
        cancelledHourlyTasks.push(handle);
      },
    },
  });
  return {
    app,
    database,
    directory,
    repository,
    queue,
    c5,
    retention,
    hourlyTasks,
    cancelledHourlyTasks,
    setQueueAvailability(value: () => boolean) {
      availability = value;
    },
    async close() {
      await app.close();
      database.close();
    },
  };
}

function rawMultipartBody(
  input: Readonly<{
    name: string;
    filename: string;
    contentType: string;
    bytes: Uint8Array;
  }>,
): Buffer {
  return rawMultipartParts([{ kind: "file", ...input }]);
}

function rawMultipartParts(
  parts: readonly (
    | Readonly<{
        kind: "file";
        name: string;
        filename: string;
        contentType: string;
        bytes: Uint8Array;
      }>
    | Readonly<{ kind: "field"; name: string; value: string }>
  )[],
): Buffer {
  const body: Buffer[] = [];
  for (const part of parts) {
    body.push(Buffer.from("--revelai-test-boundary\r\n", "utf8"));
    if (part.kind === "file") {
      body.push(
        Buffer.from(
          `Content-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\nContent-Type: ${part.contentType}\r\n\r\n`,
          "utf8",
        ),
        Buffer.from(part.bytes),
      );
    } else {
      body.push(
        Buffer.from(
          `Content-Disposition: form-data; name="${part.name}"\r\n\r\n${part.value}`,
          "utf8",
        ),
      );
    }
    body.push(Buffer.from("\r\n", "utf8"));
  }
  body.push(Buffer.from("--revelai-test-boundary--\r\n", "utf8"));
  return Buffer.concat(body);
}

function validMp4Bytes(): Uint8Array {
  return Uint8Array.from([
    0, 0, 0, 16, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 1, 2, 3, 4,
  ]);
}

function freeTerminalCandidate(attemptId: string): TerminalCandidate {
  return {
    state: "valid",
    result: {
      kind: "free-insight",
      attemptId,
      provenance: {
        kind: "demo",
        fixtureId: "free-well-framed-active-v1",
        providerVersion: "demo-observations-v1",
      },
      approximate: true,
      observations: [
        {
          kind: "athlete-visibility",
          unit: "percent",
          value: 90,
          range: "consistent",
        },
        {
          kind: "ball-visibility",
          unit: "percent",
          value: 90,
          range: "consistent",
        },
        {
          kind: "movement-activity",
          unit: "percent",
          value: 90,
          range: "high",
        },
      ],
      tips: ["Boa cobertura para uma análise aproximada."],
      generatedAt: "2030-01-15T12:00:00.000Z",
    },
  };
}

function verifiedDemoTerminalOutcome(
  attemptId: string,
  completedAt: string,
): TerminalCandidate {
  return {
    state: "valid",
    result: {
      kind: "verified-result",
      attemptId,
      challengeId: "wall-pass",
      challengeVersion: 1,
      ruleVersion: "wall-pass-v1-score-1",
      provenance: {
        kind: "demo",
        fixtureId: "wall-pass-balanced-v1",
        providerVersion: "demo-observations-v1",
      },
      metrics: {
        validPasses: 24,
        accuracyPercent: 80,
        meanCadenceSeconds: 2.5,
        leftFootPercent: 50,
        rightFootPercent: 50,
      },
      score: 76,
      completedAt,
      competitiveStatus: "demo",
      competitiveEligible: false,
    },
  };
}

async function createAttemptForReadProjection(
  fixture: Awaited<ReturnType<typeof makeMediaApi>>,
  input: Readonly<{
    id: string;
    mode: "free" | "verified";
    candidate: TerminalCandidate;
  }>,
) {
  if (input.mode === "verified") {
    await fixture.repository.issueCalibrationSession({
      id: input.id,
      athleteId: ATHLETE_A,
      nonce: "A".repeat(43),
      challengeId: "wall-pass",
      challengeVersion: 1,
    });
    await fixture.repository.readyCalibrationSession({
      id: input.id,
      athleteId: ATHLETE_A,
      requiredGates: ["device", "space", "athlete", "rehearsal", "record"],
    });
  }
  const attempt = await fixture.repository.createAttempt({
    id: input.id,
    athleteId: ATHLETE_A,
    input:
      input.mode === "free"
        ? { mode: "free" }
        : {
            mode: "verified",
            challengeId: "wall-pass",
            challengeVersion: 1,
            calibrationSessionId: input.id,
          },
  });
  if (input.mode === "verified") {
    const context = await fixture.repository.prepareMediaUpload({
      attemptId: attempt.id,
      athleteId: ATHLETE_A,
    });
    const media = createStoredMediaAttachment({
      id: input.id,
      contentType: "video/mp4",
      bytes: validMp4Bytes().byteLength,
      uploadedAt: context.uploadedAt,
      deleteAt: "2030-01-16T12:00:00.000Z",
      transition: {
        kind: "upload-transition",
        resourceId: input.id,
        deleteAt: "2030-01-15T13:00:00.000Z",
      },
    });
    await fixture.repository.attachPreparedMedia({
      accepted: await fixture.c5.accept(context, media, {
        retentionRepository: fixture.retention,
      }),
    });
  } else {
    const response = await fixture.app.inject({
      method: "POST",
      url: `/v1/attempts/${attempt.id}/media`,
      headers: {
        ...athleteHeader(ATHLETE_A),
        "content-type": "multipart/form-data; boundary=revelai-test-boundary",
      },
      payload: rawMultipartBody({
        name: "media",
        filename: "attempt.mp4",
        contentType: "video/mp4",
        bytes: validMp4Bytes(),
      }),
    });
    expect(response.statusCode, `${input.id}: ${response.body}`).toBe(202);
  }
  return attempt;
}

/** Creates real C4/C5 durable work without using the route's queue seam. */
async function seedAttachedMedia(
  fixture: Awaited<ReturnType<typeof makeMediaApi>>,
  input: Readonly<{
    attemptId: string;
    mediaId: string;
    transitionId: string;
  }>,
) {
  const attempt = await fixture.repository.createAttempt({
    id: input.attemptId,
    athleteId: ATHLETE_A,
    input: { mode: "free" },
  });
  const context = await fixture.repository.prepareMediaUpload({
    attemptId: attempt.id,
    athleteId: ATHLETE_A,
  });
  const media = createStoredMediaAttachment({
    id: input.mediaId,
    contentType: "video/mp4",
    bytes: validMp4Bytes().byteLength,
    uploadedAt: context.uploadedAt,
    deleteAt: "2030-01-16T12:00:00.000Z",
    transition: {
      kind: "upload-transition",
      resourceId: input.transitionId,
      deleteAt: "2030-01-15T13:00:00.000Z",
    },
  });
  await fixture.repository.attachPreparedMedia({
    accepted: await fixture.c5.accept(context, media, {
      retentionRepository: fixture.retention,
    }),
  });
  const recovery = await fixture.repository.getMediaDeliveryRecovery({
    attemptId: attempt.id,
    generation: context.generation,
  });
  if (!recovery) throw new Error("C8 seed must create delivery recovery.");
  // The deterministic C5 fixture's frame extractor has an intentionally
  // storage-only retention stub, whereas production schedules this frame
  // record. Install the matching durable fact so C4 can authorize a real C5
  // cleanup if an inactive runtime were ever to run.
  await fixture.retention.schedule({
    id: recovery.frameBatchId,
    attemptId: attempt.id,
    kind: "frame",
    deleteAt: media.deleteAt,
  });
  return Object.freeze({
    attemptId: attempt.id,
    generation: context.generation,
    mediaId: media.id,
    frameBatchId: recovery.frameBatchId,
  });
}

function chunked(
  bytes: Uint8Array,
  sizes: readonly number[],
): readonly Uint8Array[] {
  const chunks: Uint8Array[] = [];
  let offset = 0;
  let index = 0;
  while (offset < bytes.byteLength) {
    const size = sizes[index % sizes.length]!;
    chunks.push(bytes.subarray(offset, offset + size));
    offset += size;
    index += 1;
  }
  return chunks;
}

const internalAttemptApiFactoryName = "createInternallyComposedAttemptApi";
const expectedCompositionFile = join(
  "composition",
  "sqlite-media-upload-composition.ts",
);
const expectedAttemptApiFile = join("http", "attempt-api.ts");
const expectedQueueAdapterFile = join("queue", "in-memory-analysis-queue.ts");
const permittedQueueResolutionFiles = new Set([
  join("composition", "sqlite-media-upload-composition.ts"),
  join("composition", "free-training-analysis-composition.ts"),
  join("composition", "local-demo-runtime.ts"),
  join("composition", "training-analysis-composition.ts"),
  join("composition", "verified-training-analysis-composition.ts"),
]);

async function assertAnalysisQueueResolutionTopology(
  sourceRoot: string,
): Promise<void> {
  const files = await productionTypeScriptFiles(sourceRoot);
  const compilerOptions = {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    noEmit: true,
    target: ts.ScriptTarget.ES2023,
  };
  const adapterFile = resolve(sourceRoot, expectedQueueAdapterFile);
  const program = ts.createProgram(files, compilerOptions);
  const forbidden: string[] = [];
  for (const source of program.getSourceFiles()) {
    if (!files.includes(source.fileName)) continue;
    visit(source, source.fileName);
  }
  if (forbidden.length > 0)
    throw new Error(
      "C8 permits analysis queue resolution only from outer composition.",
    );

  function visit(node: ts.Node, containingFile: string): void {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      resolvesQueueAdapter(node, containingFile)
    ) {
      const relative = sourceRootRelative(containingFile);
      if (!permittedQueueResolutionFiles.has(relative))
        forbidden.push(relative);
    }
    if (
      ts.isCallExpression(node) &&
      resolvesDynamicQueueAdapter(node, containingFile)
    ) {
      const relative = sourceRootRelative(containingFile);
      if (!permittedQueueResolutionFiles.has(relative))
        forbidden.push(relative);
    }
    ts.forEachChild(node, (child) => visit(child, containingFile));
  }

  function resolvesQueueAdapter(
    node: ts.ImportDeclaration | ts.ExportDeclaration,
    containingFile: string,
  ): boolean {
    if (!node.moduleSpecifier || !ts.isStringLiteral(node.moduleSpecifier))
      return false;
    return resolvesModuleSpecifier(node.moduleSpecifier.text, containingFile);
  }

  function resolvesDynamicQueueAdapter(
    node: ts.CallExpression,
    containingFile: string,
  ): boolean {
    if (node.expression.kind !== ts.SyntaxKind.ImportKeyword) return false;
    const moduleSpecifier = node.arguments[0];
    if (!moduleSpecifier || !ts.isStringLiteral(moduleSpecifier)) return false;
    return resolvesModuleSpecifier(moduleSpecifier.text, containingFile);
  }

  function resolvesModuleSpecifier(
    moduleSpecifier: string,
    containingFile: string,
  ): boolean {
    const result = ts.resolveModuleName(
      moduleSpecifier,
      containingFile,
      compilerOptions,
      ts.sys,
    ).resolvedModule;
    return (
      result !== undefined && resolve(result.resolvedFileName) === adapterFile
    );
  }

  function sourceRootRelative(file: string): string {
    return file.slice(sourceRoot.length + 1).replaceAll("\\", "/");
  }
}

async function assertSingleProductionUploadCompositionPath(
  sourceRoot: string,
): Promise<void> {
  const files = await productionTypeScriptFiles(sourceRoot);
  const compilerOptions = {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    noEmit: true,
    target: ts.ScriptTarget.ES2023,
  };
  const program = ts.createProgram(files, compilerOptions);
  const checker = program.getTypeChecker();
  const apiFile = resolve(sourceRoot, expectedAttemptApiFile);
  const compositionFile = resolve(sourceRoot, expectedCompositionFile);
  const apiSource = program.getSourceFile(apiFile);
  if (!apiSource)
    throw new Error("Missing production attempt API composition entrypoint.");
  const declarations = productionFactoryDeclarations(program, files);
  if (
    declarations.length !== 1 ||
    declarations[0]!.getSourceFile() !== apiSource
  )
    throw new Error("Missing production upload-composition declaration.");
  const declaration = declarations[0]!;
  if (!declaration.name)
    throw new Error("Missing production upload-composition declaration.");
  const target = checker.getSymbolAtLocation(declaration.name);
  if (!target) throw new Error("Missing production upload-composition symbol.");

  const imports: string[] = [];
  const calls: string[] = [];
  for (const file of program.getSourceFiles()) {
    if (!files.includes(file.fileName)) continue;
    visit(file);
  }
  if (
    imports.length !== 1 ||
    calls.length !== 1 ||
    imports[0] !== compositionFile ||
    calls[0] !== compositionFile
  )
    throw new Error(
      "C8 requires exactly one production composition import and call for its internal upload API.",
    );

  function visit(node: ts.Node): void {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      resolvesModuleToAttemptApi(node)
    )
      imports.push(node.getSourceFile().fileName);
    if (ts.isCallExpression(node) && resolvesDynamicImportToAttemptApi(node))
      imports.push(node.getSourceFile().fileName);
    if (ts.isCallExpression(node) && resolvesToTarget(node.expression))
      calls.push(node.getSourceFile().fileName);
    ts.forEachChild(node, visit);
  }

  function resolvesToTarget(node: ts.Node): boolean {
    const symbol = checker.getSymbolAtLocation(node);
    if (!symbol) return false;
    const resolved =
      symbol.flags & ts.SymbolFlags.Alias
        ? checker.getAliasedSymbol(symbol)
        : symbol;
    return resolved === target;
  }

  function resolvesModuleToAttemptApi(
    node: ts.ImportDeclaration | ts.ExportDeclaration,
  ): boolean {
    if (!node.moduleSpecifier || !ts.isStringLiteral(node.moduleSpecifier))
      return false;
    return resolvesModuleSpecifier(
      node.moduleSpecifier.text,
      node.getSourceFile().fileName,
    );
  }

  function resolvesDynamicImportToAttemptApi(node: ts.CallExpression): boolean {
    if (node.expression.kind !== ts.SyntaxKind.ImportKeyword) return false;
    const moduleSpecifier = node.arguments[0];
    if (!moduleSpecifier || !ts.isStringLiteral(moduleSpecifier)) return false;
    return resolvesModuleSpecifier(
      moduleSpecifier.text,
      node.getSourceFile().fileName,
    );
  }

  function resolvesModuleSpecifier(
    moduleSpecifier: string,
    containingFile: string,
  ): boolean {
    const result = ts.resolveModuleName(
      moduleSpecifier,
      containingFile,
      compilerOptions,
      ts.sys,
    ).resolvedModule;
    return result !== undefined && resolve(result.resolvedFileName) === apiFile;
  }
}

function productionFactoryDeclarations(
  program: ts.Program,
  files: readonly string[],
): ts.FunctionDeclaration[] {
  const declarations: ts.FunctionDeclaration[] = [];
  for (const source of program.getSourceFiles()) {
    if (!files.includes(source.fileName)) continue;
    const visit = (node: ts.Node): void => {
      if (
        ts.isFunctionDeclaration(node) &&
        node.name?.text === internalAttemptApiFactoryName
      )
        declarations.push(node);
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return declarations;
}

async function productionTypeScriptFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    await Promise.all(
      entries.map(async (entry) => {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
          if (["dist", "fixtures", "node_modules"].includes(entry.name)) return;
          await visit(path);
          return;
        }
        if (entry.isFile() && entry.name.endsWith(".ts")) {
          if (!entry.name.endsWith(".test.ts")) files.push(resolve(path));
        }
      }),
    );
  }
  await visit(root);
  return files.sort();
}
