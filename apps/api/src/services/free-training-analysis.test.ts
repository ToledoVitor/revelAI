import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AttemptResultResponseSchema,
  type FreeInsight,
} from "@revelai/contracts";
import { createDemoVisionProvider, VisionProviderError } from "@revelai/vision";
import { openSqliteDatabase } from "../database/sqlite-database.js";
import { createFactoryIssuedFreeTrainingRuntime } from "../composition/free-training-analysis-composition.js";
import { createProductionFreeTrainingAttemptApi } from "../composition/free-training-analysis-composition.js";
import { registerTestDiagnostic } from "../internal/test-diagnostics.js";
import { createAttemptApi } from "../http/attempt-api.js";
import { createC5PipelineTestSupport } from "../media/c5-pipeline-test-support.js";
import {
  InMemoryAnalysisQueue,
  type QueueScheduler,
} from "../queue/in-memory-analysis-queue.js";
import { createStoredMediaAttachment } from "../repositories/attempt-repository.js";
import { SQLiteAttemptRepository } from "../repositories/sqlite-attempt-repository.js";
import { SQLiteRetentionRepository } from "../media/sqlite-retention-repository.js";
import { createAttemptReadService } from "./attempt-read-service.js";
import { createFreeTrainingAnalysisProcessor } from "./free-training-analysis.js";

const ATHLETE_ID = "11111111-1111-4111-8111-111111111111";
const ATTEMPT_ID = "22222222-2222-4222-8222-222222222222";
const MEDIA_ID = "33333333-3333-4333-8333-333333333333";
const NOW = "2030-01-15T12:00:00.000Z";
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

class ManualScheduler implements QueueScheduler {
  readonly tasks: Array<() => Promise<void>> = [];

  public schedule(task: () => Promise<void>): void {
    this.tasks.push(task);
  }

  public async runAll(): Promise<void> {
    while (this.tasks.length > 0) await this.tasks.shift()!();
  }
}

describe("Free Training analysis", () => {
  it("fails closed when malformed Free durable context carries calibration", async () => {
    const provider = {} as never;
    const events: string[] = [];
    const cleanupDiagnostic = registerTestDiagnostic(
      provider,
      Object.freeze({
        onEvent: (event) => events.push(event.kind),
      }),
    );
    const process = createFreeTrainingAnalysisProcessor({
      getProcessingContext: async () =>
        ({
          upload: {
            mode: "free",
            verified: { calibrationSessionId: "must-not-reach-c6" },
          },
        }) as never,
      reconstruct: async () => {
        throw new Error("calibration guard must run before reconstruction");
      },
      frames: Object.freeze({
        readFrame: async () => Buffer.alloc(0),
      }),
      provider,
      clock: Object.freeze({ now: () => NOW }),
    });

    try {
      await expect(
        process({
          job: { attemptId: ATTEMPT_ID, generation: 1, mode: "free" },
          claim: {
            leaseId: "55555555-5555-4555-8555-555555555555",
            generation: 1,
            mode: "free",
          },
        }),
      ).rejects.toThrow("Free processing cannot access calibration.");
      expect(events).toEqual(["free-forbidden-calibration"]);
    } finally {
      cleanupDiagnostic();
    }
  });

  it("claims a C5-backed Free job and durably finalizes only a parsed FreeInsight", async () => {
    const root = await mkdtemp(join(tmpdir(), "revelai-free-analysis-"));
    directories.push(root);
    const database = openSqliteDatabase(join(root, "api.sqlite"));
    const c5 = createC5PipelineTestSupport({ root: join(root, "c5") });
    const repository = new SQLiteAttemptRepository({
      database,
      clock: { now: () => NOW },
      ids: { next: ids() },
      handoffVerifier: c5.handoffVerifier,
    });
    const context = await createAttachedFreeAttempt({
      repository,
      retention: new SQLiteRetentionRepository({ database }),
      c5,
    });
    const scheduler = new ManualScheduler();
    const queue = new InMemoryAnalysisQueue({ scheduler });
    const sampledTimestamps: number[] = [];
    const demo = createDemoVisionProvider();
    await queue.enqueue({
      attemptId: context.job.attemptId,
      generation: context.job.generation,
    });
    const worker = createFactoryIssuedFreeTrainingRuntime({
      queue,
      repository,
      mediaPipeline: c5.pipeline,
      options: {
        provider: {
          ...demo,
          analyzeFree: async (request, signal, deadline) => {
            sampledTimestamps.push(request.frame.timestampMs);
            return demo.analyzeFree(request, signal, deadline);
          },
        },
        clock: { now: () => NOW },
      },
    });

    await queue.enqueue(context.job);
    await scheduler.runAll();
    worker.stop();

    const attempt = await repository.getAttempt({
      attemptId: ATTEMPT_ID,
      athleteId: ATHLETE_ID,
    });
    expect(attempt?.outcome).toMatchObject({
      state: "valid",
      result: {
        kind: "free-insight",
        attemptId: ATTEMPT_ID,
        approximate: true,
        generatedAt: NOW,
      },
    });
    const result = AttemptResultResponseSchema.parse(attempt?.outcome);
    const readResult = await createAttemptReadService({ repository }).result({
      attemptId: ATTEMPT_ID,
      athleteId: ATHLETE_ID,
    });
    expect(readResult).toEqual(result);
    expect(deeplyFrozen(readResult)).toBe(true);
    const insight = (result as Readonly<{ result: FreeInsight }>).result;
    expect(insight.tips).toEqual([
      "Boa cobertura para uma análise aproximada.",
    ]);
    expect(sampledTimestamps).toHaveLength(context.manifest.frames.count);
    expect(sampledTimestamps[0]).toBe(
      Math.round(context.manifest.frames.items[0]!.timestampSeconds * 1_000),
    );
    expect(sampledTimestamps.at(-1)).toBe(
      Math.round(
        context.manifest.frames.items.at(-1)!.timestampSeconds * 1_000,
      ),
    );
    expect(JSON.stringify(insight)).not.toMatch(
      /score|percentile|leaderboard|ruleVersion|verified/,
    );
    const stored = database.raw
      .prepare("SELECT outcome_json FROM terminal_results WHERE attempt_id = ?")
      .get(ATTEMPT_ID) as Readonly<{ outcome_json: string }>;
    expect(stored.outcome_json).not.toMatch(
      /score|percentile|leaderboard|ruleVersion|verified/,
    );
    const app = createAttemptApi({
      repository,
      queue,
      cleaner: { cleanup: async () => undefined },
      scheduler: { everyHour: () => undefined, cancel: () => undefined },
    });
    const response = await app.inject({
      method: "GET",
      url: `/v1/attempts/${ATTEMPT_ID}/result`,
      headers: { "x-revelai-athlete-id": ATHLETE_ID },
    });
    await app.close();
    expect(response.statusCode).toBe(200);
    expect(AttemptResultResponseSchema.parse(response.json())).toEqual(result);
    expect(response.body).not.toMatch(
      /score|percentile|leaderboard|ruleVersion|verified/,
    );
    database.close();
  });

  it("snapshots direct Free runtime inputs and nested options before resolving ports", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "revelai-free-runtime-snapshot-"),
    );
    directories.push(root);
    const database = openSqliteDatabase(join(root, "api.sqlite"));
    const c5 = createC5PipelineTestSupport({ root: join(root, "c5") });
    const repository = new SQLiteAttemptRepository({
      database,
      clock: { now: () => NOW },
      ids: { next: ids() },
      handoffVerifier: c5.handoffVerifier,
    });
    const queue = new InMemoryAnalysisQueue({
      scheduler: new ManualScheduler(),
    });
    const demo = createDemoVisionProvider();
    const reads = {
      repository: 0,
      queue: 0,
      mediaPipeline: 0,
      options: 0,
      provider: 0,
      scheduler: 0,
      clock: 0,
    };
    const input = {
      get repository() {
        reads.repository += 1;
        if (reads.repository > 1) throw new Error("repository re-read");
        return repository;
      },
      get queue() {
        reads.queue += 1;
        if (reads.queue > 1) throw new Error("queue re-read");
        return queue;
      },
      get mediaPipeline() {
        reads.mediaPipeline += 1;
        if (reads.mediaPipeline > 1) throw new Error("pipeline re-read");
        return c5.pipeline;
      },
      get options() {
        reads.options += 1;
        if (reads.options > 1) throw new Error("options re-read");
        return {
          get provider() {
            reads.provider += 1;
            if (reads.provider > 1) throw new Error("provider re-read");
            return demo;
          },
          get scheduler() {
            reads.scheduler += 1;
            if (reads.scheduler > 1) throw new Error("scheduler re-read");
            return undefined;
          },
          get clock() {
            reads.clock += 1;
            if (reads.clock > 1) throw new Error("clock re-read");
            return { now: () => NOW };
          },
        };
      },
    };
    const runtime = createFactoryIssuedFreeTrainingRuntime(input);
    expect(reads).toEqual({
      repository: 1,
      queue: 1,
      mediaPipeline: 1,
      options: 1,
      provider: 1,
      scheduler: 1,
      clock: 1,
    });
    await runtime.stop();
    database.close();
  });

  it("keeps a non-Free job pending for its separate worker instead of crossing the Free branch", async () => {
    const scheduler = new ManualScheduler();
    const queue = new InMemoryAnalysisQueue({ scheduler });
    const delivered: string[] = [];
    queue.subscribe(
      async (job) => {
        delivered.push(job.attemptId);
      },
      { mode: "free" },
    );

    await queue.enqueue({
      attemptId: "44444444-4444-4444-8444-444444444444",
      generation: 1,
      mode: "verified",
    });
    await queue.enqueue({
      attemptId: ATTEMPT_ID,
      generation: 1,
      mode: "free",
    });
    await scheduler.runAll();

    expect(delivered).toEqual([ATTEMPT_ID]);
  });

  it("keeps the official Free root on its issued queue after queue method mutation", async () => {
    const root = await mkdtemp(join(tmpdir(), "revelai-free-http-"));
    directories.push(root);
    const database = openSqliteDatabase(join(root, "api.sqlite"));
    const c5 = createC5PipelineTestSupport({ root: join(root, "c5") });
    const repository = new SQLiteAttemptRepository({
      database,
      clock: { now: () => NOW },
      ids: { next: ids() },
      handoffVerifier: c5.handoffVerifier,
    });
    const queueScheduler = new ManualScheduler();
    const queue = new InMemoryAnalysisQueue({ scheduler: queueScheduler });
    const app = createProductionFreeTrainingAttemptApi({
      repository,
      retention: new SQLiteRetentionRepository({ database }),
      mediaPipeline: c5.pipeline,
      queue,
      cleaner: { cleanup: async () => undefined },
      scheduler: { everyHour: () => undefined, cancel: () => undefined },
      clock: { now: () => NOW },
      freeTraining: {
        provider: createDemoVisionProvider(),
        clock: { now: () => NOW },
      },
    });
    Object.assign(queue as object, {
      isAvailable: async () => false,
      enqueue: async () => {
        throw new Error("mutated enqueue");
      },
      subscribe: () => {
        throw new Error("mutated subscribe");
      },
      scheduleDrain: () => undefined,
      drain: async () => undefined,
    });
    Object.setPrototypeOf(
      queue,
      Object.freeze({
        isAvailable: async () => false,
        enqueue: async () => {
          throw new Error("mutated enqueue prototype");
        },
        subscribe: () => {
          throw new Error("mutated subscribe prototype");
        },
        scheduleDrain: () => undefined,
        drain: async () => undefined,
      }),
    );
    const created = await app.inject({
      method: "POST",
      url: "/v1/attempts",
      headers: { "x-revelai-athlete-id": ATHLETE_ID },
      payload: { mode: "free" },
    });
    expect(created.statusCode).toBe(201);
    const attemptId = (created.json() as Readonly<{ id: string }>).id;
    const uploaded = await app.inject({
      method: "POST",
      url: `/v1/attempts/${attemptId}/media`,
      headers: {
        "x-revelai-athlete-id": ATHLETE_ID,
        "content-type": "multipart/form-data; boundary=revelai-free-test",
      },
      payload: multipartBody(),
    });
    expect(uploaded.statusCode).toBe(202);
    await queueScheduler.runAll();
    const result = await app.inject({
      method: "GET",
      url: `/v1/attempts/${attemptId}/result`,
      headers: { "x-revelai-athlete-id": ATHLETE_ID },
    });
    await app.close();
    expect(result.statusCode).toBe(200);
    expect(AttemptResultResponseSchema.parse(result.json())).toMatchObject({
      state: "valid",
      result: { kind: "free-insight", approximate: true },
    });
    database.close();
  });

  it("keeps app close pending for an in-flight Free provider, then leaves no post-close writes", async () => {
    const root = await mkdtemp(join(tmpdir(), "revelai-free-close-"));
    directories.push(root);
    const database = openSqliteDatabase(join(root, "api.sqlite"));
    const c5 = createC5PipelineTestSupport({ root: join(root, "c5") });
    const repository = new SQLiteAttemptRepository({
      database,
      clock: { now: () => NOW },
      ids: { next: ids() },
      handoffVerifier: c5.handoffVerifier,
    });
    const attached = await createAttachedFreeAttempt({
      repository,
      retention: new SQLiteRetentionRepository({ database }),
      c5,
    });
    const queueScheduler = new ManualScheduler();
    const queue = new InMemoryAnalysisQueue({ scheduler: queueScheduler });
    let providerStarted: (() => void) | undefined;
    const providerBegan = new Promise<void>((resolve) => {
      providerStarted = resolve;
    });
    let releaseProvider: (() => void) | undefined;
    const providerGate = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    const demo = createDemoVisionProvider();
    const app = createProductionFreeTrainingAttemptApi({
      repository,
      retention: new SQLiteRetentionRepository({ database }),
      mediaPipeline: c5.pipeline,
      queue,
      cleaner: { cleanup: async () => undefined },
      scheduler: { everyHour: () => undefined, cancel: () => undefined },
      clock: { now: () => NOW },
      freeTraining: {
        provider: {
          ...demo,
          analyzeFree: async (request, signal, deadline) => {
            providerStarted?.();
            await providerGate;
            return demo.analyzeFree(request, signal, deadline);
          },
        },
        clock: { now: () => NOW },
      },
    });

    await queue.enqueue(attached.job);
    const drainingQueue = queueScheduler.runAll();
    await providerBegan;
    const closing = app.close();
    let closed = false;
    void closing.then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);

    releaseProvider!();
    await Promise.all([drainingQueue, closing]);
    const terminalCount = database.raw
      .prepare(
        "SELECT COUNT(*) AS count FROM terminal_results WHERE attempt_id = ?",
      )
      .get(ATTEMPT_ID);
    await Promise.resolve();
    expect(
      database.raw
        .prepare(
          "SELECT COUNT(*) AS count FROM terminal_results WHERE attempt_id = ?",
        )
        .get(ATTEMPT_ID),
    ).toEqual(terminalCount);
    database.close();
  });

  it("reads each official Free host dependency once and keeps a Proxy host coherent end to end", async () => {
    const root = await mkdtemp(join(tmpdir(), "revelai-free-proxy-"));
    directories.push(root);
    const database = openSqliteDatabase(join(root, "api.sqlite"));
    const c5 = createC5PipelineTestSupport({ root: join(root, "c5") });
    const repository = new SQLiteAttemptRepository({
      database,
      clock: { now: () => NOW },
      ids: { next: ids() },
      handoffVerifier: c5.handoffVerifier,
    });
    const queueScheduler = new ManualScheduler();
    const queue = new InMemoryAnalysisQueue({ scheduler: queueScheduler });
    const reads = new Map<string, number>();
    const input = new Proxy(
      {
        repository,
        retention: new SQLiteRetentionRepository({ database }),
        mediaPipeline: c5.pipeline,
        queue,
        cleaner: { cleanup: async () => undefined },
        scheduler: { everyHour: () => undefined, cancel: () => undefined },
        clock: { now: () => NOW },
        freeTraining: {
          provider: createDemoVisionProvider(),
          clock: { now: () => NOW },
        },
      },
      {
        get(target, property, receiver) {
          if (typeof property === "string")
            reads.set(property, (reads.get(property) ?? 0) + 1);
          return Reflect.get(target, property, receiver);
        },
      },
    );
    const app = createProductionFreeTrainingAttemptApi(input);

    expect(Object.fromEntries(reads)).toEqual({
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
      freeTraining: 1,
    });
    const created = await app.inject({
      method: "POST",
      url: "/v1/attempts",
      headers: { "x-revelai-athlete-id": ATHLETE_ID },
      payload: { mode: "free" },
    });
    const uploaded = await app.inject({
      method: "POST",
      url: `/v1/attempts/${(created.json() as Readonly<{ id: string }>).id}/media`,
      headers: {
        "x-revelai-athlete-id": ATHLETE_ID,
        "content-type": "multipart/form-data; boundary=revelai-free-test",
      },
      payload: multipartBody(),
    });
    await queueScheduler.runAll();
    await app.close();
    database.close();

    expect(uploaded.statusCode).toBe(202);
  });

  it("rejects an alternating official host before it can start recovery scheduling", async () => {
    const root = await mkdtemp(join(tmpdir(), "revelai-free-alternating-"));
    directories.push(root);
    const databaseA = openSqliteDatabase(join(root, "a.sqlite"));
    const databaseB = openSqliteDatabase(join(root, "b.sqlite"));
    const c5 = createC5PipelineTestSupport({ root: join(root, "c5") });
    const hostA = {
      repository: new SQLiteAttemptRepository({
        database: databaseA,
        clock: { now: () => NOW },
        ids: { next: ids() },
        handoffVerifier: c5.handoffVerifier,
      }),
      retention: new SQLiteRetentionRepository({ database: databaseA }),
      queue: new InMemoryAnalysisQueue(),
    };
    const hostB = {
      repository: new SQLiteAttemptRepository({
        database: databaseB,
        clock: { now: () => NOW },
        ids: { next: ids() },
        handoffVerifier: c5.handoffVerifier,
      }),
      retention: new SQLiteRetentionRepository({ database: databaseB }),
      queue: new InMemoryAnalysisQueue(),
    };
    let repositoryReads = 0;
    let queueReads = 0;
    let schedulerCalls = 0;
    const alternating = new Proxy(
      {
        repository: hostA.repository,
        retention: hostA.retention,
        queue: hostA.queue,
        mediaPipeline: c5.pipeline,
        cleaner: { cleanup: async () => undefined },
        scheduler: {
          everyHour: () => {
            schedulerCalls += 1;
            return undefined;
          },
          cancel: () => undefined,
        },
        freeTraining: { provider: createDemoVisionProvider() },
      },
      {
        get(target, property, receiver) {
          if (property === "repository") {
            repositoryReads += 1;
            return repositoryReads === 1 ? hostA.repository : hostB.repository;
          }
          if (property === "retention") return hostB.retention;
          if (property === "queue") {
            queueReads += 1;
            return queueReads === 1 ? hostB.queue : hostA.queue;
          }
          return Reflect.get(target, property, receiver);
        },
      },
    );

    expect(() => createProductionFreeTrainingAttemptApi(alternating)).toThrow(
      "factory-issued media upload composition",
    );
    expect({ repositoryReads, queueReads, schedulerCalls }).toEqual({
      repositoryReads: 1,
      queueReads: 1,
      schedulerCalls: 0,
    });
    databaseA.close();
    databaseB.close();
  });

  it("releases retryable Free provider failures and eventually persists the exact retryable outcome", async () => {
    const root = await mkdtemp(join(tmpdir(), "revelai-free-retry-"));
    directories.push(root);
    const database = openSqliteDatabase(join(root, "api.sqlite"));
    const c5 = createC5PipelineTestSupport({ root: join(root, "c5") });
    const repository = new SQLiteAttemptRepository({
      database,
      clock: { now: () => NOW },
      ids: { next: ids() },
      handoffVerifier: c5.handoffVerifier,
    });
    const attached = await createAttachedFreeAttempt({
      repository,
      retention: new SQLiteRetentionRepository({ database }),
      c5,
    });
    const scheduler = new ManualScheduler();
    const queue = new InMemoryAnalysisQueue({ scheduler });
    const demo = createDemoVisionProvider();
    const runtime = createFactoryIssuedFreeTrainingRuntime({
      repository,
      queue,
      mediaPipeline: c5.pipeline,
      options: {
        provider: {
          ...demo,
          analyzeFree: async () => {
            throw new VisionProviderError("provider_temporary_unavailable");
          },
        },
        clock: { now: () => NOW },
      },
    });

    await queue.enqueue(attached.job);
    await scheduler.runAll();
    runtime.stop();

    await expect(
      repository.getAttempt({ attemptId: ATTEMPT_ID, athleteId: ATHLETE_ID }),
    ).resolves.toMatchObject({
      status: "failed",
      outcome: {
        state: "failed",
        mode: "free",
        code: "analysis_temporary_unavailable",
        message: "A análise está indisponível temporariamente.",
        retryable: true,
      },
    });
    database.close();
  });

  it("issues the Free runtime only to the exact current C4/C5 factory pair", async () => {
    const root = await mkdtemp(join(tmpdir(), "revelai-free-topology-"));
    directories.push(root);
    const database = openSqliteDatabase(join(root, "api.sqlite"));
    const c5 = createC5PipelineTestSupport({ root: join(root, "c5") });
    const otherC5 = createC5PipelineTestSupport({
      root: join(root, "other-c5"),
    });
    const production = new SQLiteAttemptRepository({
      database,
      clock: { now: () => NOW },
      ids: { next: ids() },
      handoffVerifier: c5.handoffVerifier,
    });
    const readOnly = SQLiteAttemptRepository.forReadOnlyTest({
      database,
      clock: { now: () => NOW },
      ids: { next: ids() },
    });
    const queue = new InMemoryAnalysisQueue();
    const options = { provider: createDemoVisionProvider() };
    let schedulerCalls = 0;

    expect(() =>
      createProductionFreeTrainingAttemptApi({
        repository: readOnly,
        retention: new SQLiteRetentionRepository({ database }),
        mediaPipeline: c5.pipeline,
        queue,
        cleaner: { cleanup: async () => undefined },
        scheduler: {
          everyHour: () => {
            schedulerCalls += 1;
            return undefined;
          },
          cancel: () => undefined,
        },
        freeTraining: options,
      }),
    ).toThrow("C8 requires a factory-issued");
    expect(schedulerCalls).toBe(0);

    expect(() =>
      createFactoryIssuedFreeTrainingRuntime({
        repository: readOnly,
        queue,
        mediaPipeline: c5.pipeline,
        options,
      }),
    ).toThrow("factory-issued C4/C5 composition");
    expect(() =>
      createFactoryIssuedFreeTrainingRuntime({
        repository: production,
        queue,
        mediaPipeline: Object.create(c5.pipeline),
        options,
      }),
    ).toThrow("factory-issued C4/C5 composition");
    expect(() =>
      createFactoryIssuedFreeTrainingRuntime({
        repository: production,
        queue,
        mediaPipeline: otherC5.pipeline,
        options,
      }),
    ).toThrow("factory-issued C4/C5 composition");

    Object.defineProperty(production, "getProcessingContext", {
      configurable: true,
      value: production.getProcessingContext,
    });
    expect(() =>
      createFactoryIssuedFreeTrainingRuntime({
        repository: production,
        queue,
        mediaPipeline: c5.pipeline,
        options,
      }),
    ).toThrow("factory-issued C4/C5 composition");
    Reflect.deleteProperty(production, "getProcessingContext");
    database.close();
  });

  it("terminalizes typed invalid Free provider output without a retry or competitive result", async () => {
    const root = await mkdtemp(join(tmpdir(), "revelai-free-invalid-"));
    directories.push(root);
    const database = openSqliteDatabase(join(root, "api.sqlite"));
    const c5 = createC5PipelineTestSupport({ root: join(root, "c5") });
    const repository = new SQLiteAttemptRepository({
      database,
      clock: { now: () => NOW },
      ids: { next: ids() },
      handoffVerifier: c5.handoffVerifier,
    });
    const attached = await createAttachedFreeAttempt({
      repository,
      retention: new SQLiteRetentionRepository({ database }),
      c5,
    });
    const scheduler = new ManualScheduler();
    const queue = new InMemoryAnalysisQueue({ scheduler });
    const demo = createDemoVisionProvider();
    const runtime = createFactoryIssuedFreeTrainingRuntime({
      repository,
      queue,
      mediaPipeline: c5.pipeline,
      options: {
        provider: {
          ...demo,
          analyzeFree: async () => {
            throw new VisionProviderError("provider_output_invalid");
          },
        },
        clock: { now: () => NOW },
      },
    });

    await queue.enqueue(attached.job);
    await scheduler.runAll();
    runtime.stop();

    await expect(
      repository.getAttempt({ attemptId: ATTEMPT_ID, athleteId: ATHLETE_ID }),
    ).resolves.toMatchObject({
      status: "failed",
      outcome: {
        state: "failed",
        code: "analysis_configuration_invalid",
        retryable: false,
      },
    });
    database.close();
  });

  it("does not resurrect a tombstoned Free attachment queued before worker startup", async () => {
    const root = await mkdtemp(join(tmpdir(), "revelai-free-tombstone-"));
    directories.push(root);
    const database = openSqliteDatabase(join(root, "api.sqlite"));
    const c5 = createC5PipelineTestSupport({ root: join(root, "c5") });
    const repository = new SQLiteAttemptRepository({
      database,
      clock: { now: () => NOW },
      ids: { next: ids() },
      handoffVerifier: c5.handoffVerifier,
    });
    const attached = await createAttachedFreeAttempt({
      repository,
      retention: new SQLiteRetentionRepository({ database }),
      c5,
    });
    const scheduler = new ManualScheduler();
    const queue = new InMemoryAnalysisQueue({ scheduler });
    let providerCalls = 0;
    const demo = createDemoVisionProvider();

    await queue.enqueue(attached.job);
    await repository.tombstoneAttempt({
      attemptId: ATTEMPT_ID,
      athleteId: ATHLETE_ID,
    });
    const runtime = createFactoryIssuedFreeTrainingRuntime({
      repository,
      queue,
      mediaPipeline: c5.pipeline,
      options: {
        provider: {
          ...demo,
          analyzeFree: async (request, signal, deadline) => {
            providerCalls += 1;
            return demo.analyzeFree(request, signal, deadline);
          },
        },
        clock: { now: () => NOW },
      },
    });
    await scheduler.runAll();
    runtime.stop();

    expect(providerCalls).toBe(0);
    expect(
      database.raw
        .prepare(
          "SELECT COUNT(*) AS count FROM terminal_results WHERE attempt_id = ?",
        )
        .get(ATTEMPT_ID),
    ).toEqual({ count: 0 });
    await expect(
      repository.getAttempt({ attemptId: ATTEMPT_ID, athleteId: ATHLETE_ID }),
    ).resolves.toBeNull();
    database.close();
  });

  it("keeps Free source imports outside score, policy, integrity, and ranking modules", async () => {
    const source = await readFile(
      new URL("./free-training-analysis.ts", import.meta.url),
      "utf8",
    );
    const imports = [...source.matchAll(/from "([^"]+)"/g)].map(
      (match) => match[1]!,
    );
    expect(imports.join("\n")).not.toMatch(
      /domain|score|policy|rank|integrity-evaluator|leaderboard/,
    );
  });
});

async function createAttachedFreeAttempt(
  input: Readonly<{
    repository: SQLiteAttemptRepository;
    retention: SQLiteRetentionRepository;
    c5: ReturnType<typeof createC5PipelineTestSupport>;
  }>,
) {
  await input.repository.createAttempt({
    id: ATTEMPT_ID,
    athleteId: ATHLETE_ID,
    input: { mode: "free" },
  });
  const upload = await input.repository.prepareMediaUpload({
    attemptId: ATTEMPT_ID,
    athleteId: ATHLETE_ID,
  });
  const accepted = await input.c5.accept(
    upload,
    createStoredMediaAttachment({
      id: MEDIA_ID,
      contentType: "video/mp4",
      bytes: 16,
      uploadedAt: NOW,
      deleteAt: "2030-01-22T12:00:00.000Z",
      transition: {
        kind: "upload-transition",
        resourceId: MEDIA_ID,
        deleteAt: "2030-01-16T12:00:00.000Z",
      },
    }),
    { retentionRepository: input.retention },
  );
  return Object.freeze({
    manifest: accepted.manifest,
    job: await input.repository.attachPreparedMedia({ accepted }),
  });
}

function ids(): () => string {
  let sequence = 0;
  return () => {
    sequence += 1;
    return `aaaaaaaa-aaaa-4aaa-8aaa-${sequence.toString(16).padStart(12, "0")}`;
  };
}

function deeplyFrozen(value: unknown): boolean {
  if (value === null || typeof value !== "object") return true;
  return Object.isFrozen(value) && Object.values(value).every(deeplyFrozen);
}

function multipartBody(): Buffer {
  const boundary = "revelai-free-test";
  return Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="media"; filename="attempt.mp4"\r\nContent-Type: video/mp4\r\n\r\n`,
      "utf8",
    ),
    Buffer.from([
      0, 0, 0, 16, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 1, 2, 3, 4,
    ]),
    Buffer.from(`\r\n--${boundary}--\r\n`, "utf8"),
  ]);
}
