import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import {
  AttemptListResponseSchema,
  CalibrationSessionSchema,
  ChallengeListResponseSchema,
  CreateAttemptResponseSchema,
  MediaUploadAcceptedSchema,
  mediaUploadFixtures,
  routeErrorFixtures,
  RouteErrorSchema,
} from "@revelai/contracts";
import type { FastifyInstance, InjectOptions } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openSqliteDatabase } from "../database/sqlite-database.js";
import {
  resolveFactoryIssuedSQLiteAttemptRepositoryToken,
  SQLiteAttemptRepository,
} from "../repositories/sqlite-attempt-repository.js";
import type { AcceptedMediaHandoff } from "../media/accepted-media-handoff.js";
import { createC5PipelineTestSupport } from "../media/c5-pipeline-test-support.js";
import type { C5MediaPipeline } from "../media/media-pipeline.js";
import { MediaPipelineError, type MediaFailureCode } from "../media/probe.js";
import { SQLiteRetentionRepository } from "../media/sqlite-retention-repository.js";
import { createLocalC8AcceptedMediaCleaner } from "../services/local-c8-accepted-media-cleaner.js";
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
    fixture.queue.isAvailable = async () => {
      expect(bodyReads).toBe(0);
      return false;
    };
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
    const compositionToken = resolveFactoryIssuedSQLiteAttemptRepositoryToken(
      fixture.repository,
    );
    expect(compositionToken).toBeDefined();
    expect(Reflect.get(compositionToken!, "raw")).toBeUndefined();
    expect(Reflect.get(compositionToken!, "database")).toBeUndefined();
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
      createAttemptApi({
        repository: fixture.repository,
        queue: fixture.queue,
        cleaner: createLocalC8AcceptedMediaCleaner({
          repository: fixture.repository,
          storage: fixture.c5.storage,
        }),
        uploadRetention: foreignRetention,
        mediaPipeline: fixture.c5.pipeline,
        scheduler: { everyHour: () => 1, cancel: () => undefined },
      }),
    ).toThrow("matching factory-issued SQLite repositories");
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

  it("maps every C5 failure code to its shared route-error fixture before attachment", async () => {
    const codes: readonly MediaFailureCode[] = [
      "media_container_not_allowed",
      "media_probe_failed",
      "media_requirements_not_met",
      "media_empty",
      "media_too_large",
      "multipart_body_too_large",
      "media_part_missing",
      "media_part_count_invalid",
      "multipart_extra_part_forbidden",
      "media_filename_mime_mismatch",
    ];
    for (const [index, code] of codes.entries()) {
      const fixture = await makeMediaApi({
        mediaPipeline: throwingMediaPipeline(code),
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
          bytes: validMp4Bytes(),
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
    fixture.queue.enqueue = async () => {
      throw new Error("queue down");
    };
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
        uploadRetention: new SQLiteRetentionRepository({
          database: fixture.database,
        }),
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
      uploadRetention: new SQLiteRetentionRepository({
        database: fixture.database,
      }),
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
    queue: { isAvailable: async () => true, enqueue: async () => undefined },
    cleaner: { cleanup: async () => undefined },
    uploadRetention: new SQLiteRetentionRepository({ database }),
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

async function makeMediaApi(
  input?: Readonly<{
    maxUploadBytes?: number;
    mediaPipeline?: C5MediaPipeline;
  }>,
) {
  const directory = await mkdtemp(join(tmpdir(), "revelai-attempt-media-api-"));
  directories.push(directory);
  const database = openSqliteDatabase(join(directory, "api.sqlite"));
  const c5 = createC5PipelineTestSupport({ root: join(directory, "c5") });
  const repository = new SQLiteAttemptRepository({
    database,
    clock: { now: () => "2030-01-15T12:00:00.000Z" },
    ids: { next: () => "ffffffff-ffff-4fff-8fff-ffffffffffff" },
    handoffVerifier: c5.handoffVerifier,
  });
  const queue = {
    isAvailable: async () => true,
    enqueue: async () => undefined,
    subscribe: () => () => undefined,
  };
  const app = createAttemptApi({
    repository,
    queue,
    cleaner: createLocalC8AcceptedMediaCleaner({
      repository,
      storage: c5.storage,
    }),
    uploadRetention: new SQLiteRetentionRepository({ database }),
    mediaPipeline: input?.mediaPipeline ?? c5.pipeline,
    ...(input?.maxUploadBytes === undefined
      ? {}
      : { maxUploadBytes: input.maxUploadBytes }),
    scheduler: {
      everyHour: () => 1,
      cancel: () => undefined,
    },
  });
  return {
    app,
    database,
    repository,
    queue,
    c5,
    async close() {
      await app.close();
      database.close();
    },
  };
}

const nonIssuingVerifier = Object.freeze({
  accepts: (_value: unknown): _value is AcceptedMediaHandoff => false,
});

function throwingMediaPipeline(code: MediaFailureCode): C5MediaPipeline {
  const reject = async (): Promise<never> => {
    throw new MediaPipelineError(code);
  };
  return Object.freeze({
    handoffVerifier: () => nonIssuingVerifier,
    accept: reject,
    acceptMultipart: reject,
  });
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
