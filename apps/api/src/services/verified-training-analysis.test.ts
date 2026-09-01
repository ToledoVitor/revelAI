import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import {
  AttemptResultResponseSchema,
  WorkflowBenchmarkReceiptSchema,
  passingWorkflowBenchmarkReceiptFixture,
} from "@revelai/contracts";
import {
  createDemoVisionProvider,
  VisionBatchScheduler,
  type VisionRequestDeadline,
  type VisionProvider,
} from "@revelai/vision";
import { createFactoryIssuedVerifiedTrainingRuntime } from "../composition/verified-training-analysis-composition.js";
import { createProductionTrainingAttemptApi } from "../composition/training-analysis-composition.js";
import { openSqliteDatabase } from "../database/sqlite-database.js";
import { createC5PipelineTestSupport } from "../media/c5-pipeline-test-support.js";
import { SQLiteRetentionRepository } from "../media/sqlite-retention-repository.js";
import { createVerifiedFixtureVisionProvider } from "../processing/c7-fixture.test-support.js";
import {
  createStoredMediaAttachment,
  type MediaUploadContext,
} from "../repositories/attempt-repository.js";
import { SQLiteAttemptRepository } from "../repositories/sqlite-attempt-repository.js";
import { SQLiteCompetitivePolicyRepository } from "../repositories/sqlite-competitive-policy-repository.js";
import {
  InMemoryAnalysisQueue,
  type QueueScheduler,
} from "../queue/in-memory-analysis-queue.js";
import { createVerifiedTrainingRuntime } from "./verified-training-runtime.js";

const ATHLETE_ID = "11111111-1111-4111-8111-111111111111";
const ATTEMPT_ID = "22222222-2222-4222-8222-222222222222";
const SESSION_ID = "33333333-3333-4333-8333-333333333333";
const MEDIA_ID = "44444444-4444-4444-8444-444444444444";
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

describe("Verified Training analysis", () => {
  it("snapshots direct Verified runtime inputs and nested options before resolving capabilities", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "revelai-verified-runtime-snapshot-"),
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
    const provider = createDemoVisionProvider();
    const reads = {
      repository: 0,
      queue: 0,
      mediaPipeline: 0,
      options: 0,
      provider: 0,
      scheduler: 0,
      clock: 0,
      policy: 0,
    };
    const runtime = createFactoryIssuedVerifiedTrainingRuntime({
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
        if (reads.mediaPipeline > 1) throw new Error("media pipeline re-read");
        return c5.pipeline;
      },
      get options() {
        reads.options += 1;
        if (reads.options > 1) throw new Error("options re-read");
        return {
          get provider() {
            reads.provider += 1;
            if (reads.provider > 1) throw new Error("provider re-read");
            return provider;
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
          get policy() {
            reads.policy += 1;
            if (reads.policy > 1) throw new Error("policy re-read");
            return undefined;
          },
        };
      },
    });

    expect(reads).toEqual({
      repository: 1,
      queue: 1,
      mediaPipeline: 1,
      options: 1,
      provider: 1,
      scheduler: 1,
      clock: 1,
      policy: 1,
    });
    await runtime.stop();
    database.close();
  });

  it("snapshots every combined official host dependency before either mode runtime starts", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "revelai-training-root-snapshot-"),
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
    const reads = new Map<string, number>();
    const recordRead = (property: string): void => {
      reads.set(property, (reads.get(property) ?? 0) + 1);
    };
    const freeProvider = createDemoVisionProvider();
    const verifiedProvider = createDemoVisionProvider();
    const freeTraining = {
      get provider() {
        recordRead("freeProvider");
        return freeProvider;
      },
      get scheduler() {
        recordRead("freeVisionScheduler");
        return undefined;
      },
      get clock() {
        recordRead("freeVisionClock");
        return { now: () => NOW };
      },
    };
    const verifiedTraining = {
      get provider() {
        recordRead("verifiedProvider");
        return verifiedProvider;
      },
      get scheduler() {
        recordRead("verifiedVisionScheduler");
        return undefined;
      },
      get clock() {
        recordRead("verifiedVisionClock");
        return { now: () => NOW };
      },
      get policy() {
        recordRead("verifiedPolicy");
        return undefined;
      },
    };
    const input = new Proxy(
      {
        repository,
        retention: new SQLiteRetentionRepository({ database }),
        mediaPipeline: c5.pipeline,
        queue,
        cleaner: { cleanup: async () => undefined },
        scheduler: { everyHour: () => undefined, cancel: () => undefined },
        clock: { now: () => NOW },
        freeTraining,
        verifiedTraining,
      },
      {
        get(target, property, receiver) {
          if (typeof property === "string") recordRead(property);
          return Reflect.get(target, property, receiver);
        },
      },
    );
    const app = createProductionTrainingAttemptApi(input);

    expect(Object.fromEntries(reads)).toEqual({
      repository: 1,
      retention: 1,
      queue: 1,
      mediaPipeline: 1,
      cleaner: 1,
      maxUploadBytes: 1,
      scheduler: 1,
      recoveryBatchLimit: 1,
      clock: 1,
      ids: 1,
      nonce: 1,
      log: 1,
      freeTraining: 1,
      verifiedTraining: 1,
      freeProvider: 1,
      freeVisionScheduler: 1,
      freeVisionClock: 1,
      verifiedProvider: 1,
      verifiedVisionScheduler: 1,
      verifiedVisionClock: 1,
      verifiedPolicy: 1,
    });
    await app.close();
    database.close();
  });

  it("accepts only the current policy capability issued from the exact C4 database", async () => {
    const root = await mkdtemp(join(tmpdir(), "revelai-verified-policy-port-"));
    directories.push(root);
    const database = openSqliteDatabase(join(root, "api.sqlite"));
    const otherDatabase = openSqliteDatabase(join(root, "other.sqlite"));
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
    const policy = new SQLiteCompetitivePolicyRepository({
      database,
      clock: { now: () => NOW },
    });
    const options = {
      provider: createDemoVisionProvider(),
      policy,
    };
    const createRuntime = (candidatePolicy = policy) =>
      createFactoryIssuedVerifiedTrainingRuntime({
        repository,
        queue,
        mediaPipeline: c5.pipeline,
        options: { ...options, policy: candidatePolicy },
      });

    const clone = Object.create(policy);
    expect(() => createRuntime(clone)).toThrow(
      "factory-issued C4/C5 composition",
    );
    const proxy = new Proxy(policy, {});
    expect(() => createRuntime(proxy)).toThrow(
      "factory-issued C4/C5 composition",
    );
    const otherPolicy = new SQLiteCompetitivePolicyRepository({
      database: otherDatabase,
      clock: { now: () => NOW },
    });
    expect(() => createRuntime(otherPolicy)).toThrow(
      "factory-issued C4/C5 composition",
    );

    Object.defineProperty(policy, "getActiveCompetitivePolicy", {
      configurable: true,
      value: policy.getActiveCompetitivePolicy,
    });
    expect(() => createRuntime()).toThrow("factory-issued C4/C5 composition");
    Reflect.deleteProperty(policy, "getActiveCompetitivePolicy");
    const runtime = createRuntime();
    await runtime.stop();
    database.close();
    otherDatabase.close();
  });

  it("claims a C5-backed verified job and finalizes a Demo result without a leaderboard entry", async () => {
    const root = await mkdtemp(join(tmpdir(), "revelai-verified-analysis-"));
    directories.push(root);
    const database = openSqliteDatabase(join(root, "api.sqlite"));
    const c5 = createC5PipelineTestSupport({ root: join(root, "c5") });
    const repository = new SQLiteAttemptRepository({
      database,
      clock: { now: () => NOW },
      ids: { next: ids() },
      handoffVerifier: c5.handoffVerifier,
    });
    const retention = new SQLiteRetentionRepository({ database });
    const job = await createAttachedVerifiedAttempt({
      repository,
      retention,
      c5,
    });
    const scheduler = new ManualScheduler();
    const queue = new InMemoryAnalysisQueue({ scheduler });
    const runtime = createFactoryIssuedVerifiedTrainingRuntime({
      repository,
      queue,
      mediaPipeline: c5.pipeline,
      options: {
        provider: createDemoVisionProvider(),
        clock: { now: () => NOW },
      },
    });
    await queue.enqueue(job);
    await scheduler.runAll();
    await runtime.stop();

    const attempt = await repository.getAttempt({
      attemptId: ATTEMPT_ID,
      athleteId: ATHLETE_ID,
    });
    expect(AttemptResultResponseSchema.parse(attempt?.outcome)).toMatchObject({
      state: "valid",
      result: {
        kind: "verified-result",
        attemptId: ATTEMPT_ID,
        competitiveStatus: "demo",
        competitiveEligible: false,
        provenance: { kind: "demo" },
        completedAt: NOW,
      },
    });
    expect(
      database.raw
        .prepare("SELECT COUNT(*) AS count FROM leaderboard_entries")
        .get(),
    ).toEqual({ count: 0 });
    database.close();
  });

  it("turns an approved mock Roboflow analysis into one ranked result and frozen leaderboard snapshot", async () => {
    const root = await mkdtemp(join(tmpdir(), "revelai-verified-ranked-"));
    directories.push(root);
    const database = openSqliteDatabase(join(root, "api.sqlite"));
    const c5 = createC5PipelineTestSupport({ root: join(root, "c5") });
    const repository = new SQLiteAttemptRepository({
      database,
      clock: { now: () => NOW },
      ids: { next: ids() },
      handoffVerifier: c5.handoffVerifier,
    });
    const retention = new SQLiteRetentionRepository({ database });
    const policy = new SQLiteCompetitivePolicyRepository({
      database,
      clock: { now: () => NOW },
    });
    const receipt = WorkflowBenchmarkReceiptSchema.parse(
      passingWorkflowBenchmarkReceiptFixture,
    );
    await policy.storeBenchmarkReceipt(receipt);
    await policy.activateCompetitivePolicy({
      id: "99999999-9999-4999-8999-999999999999",
      receiptId: receipt.id,
      receiptSha256: receipt.receiptSha256,
      receiptSchemaVersion: receipt.schemaVersion,
      workspaceId: receipt.workflow.workspaceId,
      modelBundleId: receipt.workflow.modelBundleId,
      workflowId: receipt.workflow.workflowId,
      workflowVersion: receipt.workflow.workflowVersion,
      providerVersion: receipt.workflow.providerVersion,
      calibrationEvidenceVersion: receipt.evidence.calibrationEvidenceVersion,
      extractionEvidenceVersion: receipt.evidence.extractionEvidenceVersion,
      observationEvidenceVersion: receipt.evidence.observationEvidenceVersion,
      challengeId: "wall-pass",
      challengeVersion: 1,
      ruleVersion: "wall-pass-v1-score-1",
    });
    const job = await createAttachedVerifiedAttempt({
      repository,
      retention,
      c5,
    });
    const scheduler = new ManualScheduler();
    const queue = new InMemoryAnalysisQueue({ scheduler });
    const runtime = createFactoryIssuedVerifiedTrainingRuntime({
      repository,
      queue,
      mediaPipeline: c5.pipeline,
      options: {
        provider: createVerifiedFixtureVisionProvider("roboflow"),
        policy,
        clock: { now: () => NOW },
      },
    });
    Object.assign(policy as object, {
      getActiveCompetitivePolicy: async () => null,
    });
    Object.setPrototypeOf(
      policy,
      Object.freeze({
        getActiveCompetitivePolicy: async () => null,
      }),
    );

    await queue.enqueue(job);
    await scheduler.runAll();
    await runtime.stop();

    const attempt = await repository.getAttempt({
      attemptId: ATTEMPT_ID,
      athleteId: ATHLETE_ID,
    });
    expect(AttemptResultResponseSchema.parse(attempt?.outcome)).toMatchObject({
      state: "valid",
      result: {
        kind: "verified-result",
        competitiveStatus: "ranked",
        competitiveEligible: true,
        provenance: { kind: "roboflow" },
        rankingSnapshot: {
          kind: "frozen",
          rank: 1,
          cohortSize: 1,
          asOfAttemptId: ATTEMPT_ID,
        },
      },
    });
    expect(
      database.raw
        .prepare("SELECT COUNT(*) AS count FROM leaderboard_entries")
        .get(),
    ).toEqual({ count: 1 });
    database.close();
  });

  it("keeps a valid Roboflow result experimental when no parsed approved receipt is active", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "revelai-verified-experimental-"),
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
    const retention = new SQLiteRetentionRepository({ database });
    const job = await createAttachedVerifiedAttempt({
      repository,
      retention,
      c5,
    });
    const scheduler = new ManualScheduler();
    const queue = new InMemoryAnalysisQueue({ scheduler });
    const runtime = createFactoryIssuedVerifiedTrainingRuntime({
      repository,
      queue,
      mediaPipeline: c5.pipeline,
      options: {
        provider: createVerifiedFixtureVisionProvider("roboflow"),
        clock: { now: () => NOW },
      },
    });

    await queue.enqueue(job);
    await scheduler.runAll();
    await runtime.stop();

    const attempt = await repository.getAttempt({
      attemptId: ATTEMPT_ID,
      athleteId: ATHLETE_ID,
    });
    const result = AttemptResultResponseSchema.parse(attempt?.outcome);
    expect(attempt).toMatchObject({
      status: "valid",
      outcome: {
        state: "valid",
        result: {
          kind: "verified-result",
          competitiveStatus: "experimental",
          competitiveEligible: false,
          provenance: { kind: "roboflow" },
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain("rankingSnapshot");
    expect(
      database.raw
        .prepare("SELECT COUNT(*) AS count FROM leaderboard_entries")
        .get(),
    ).toEqual({ count: 0 });
    database.close();
  });

  it("drives an owned ready calibration through HTTP upload, pending, and an unranked Demo result", async () => {
    const root = await mkdtemp(join(tmpdir(), "revelai-verified-http-"));
    directories.push(root);
    const database = openSqliteDatabase(join(root, "api.sqlite"));
    let probeCalls = 0;
    const c5 = createC5PipelineTestSupport({
      root: join(root, "c5"),
      mode: "verified",
      prober: {
        probe: async () => {
          probeCalls += 1;
          return verifiedHttpProber.probe();
        },
      },
    });
    const repository = new SQLiteAttemptRepository({
      database,
      clock: { now: () => NOW },
      ids: { next: ids("aaaaaaaa") },
      handoffVerifier: c5.handoffVerifier,
    });
    const queueScheduler = new ManualScheduler();
    const queue = new InMemoryAnalysisQueue({ scheduler: queueScheduler });
    const app = createProductionTrainingAttemptApi({
      repository,
      retention: new SQLiteRetentionRepository({ database }),
      mediaPipeline: c5.pipeline,
      queue,
      cleaner: { cleanup: async () => undefined },
      scheduler: { everyHour: () => undefined, cancel: () => undefined },
      clock: { now: () => NOW },
      ids: { next: ids("bbbbbbbb") },
      freeTraining: {
        provider: createDemoVisionProvider(),
        clock: { now: () => NOW },
      },
      verifiedTraining: {
        provider: createDemoVisionProvider(),
        clock: { now: () => NOW },
      },
    });

    const calibration = await app.inject({
      method: "POST",
      url: "/v1/calibration-sessions",
      headers: { "x-revelai-athlete-id": ATHLETE_ID },
      payload: { challengeId: "wall-pass", challengeVersion: 1 },
    });
    expect(calibration.statusCode).toBe(201);
    const calibrationId = (calibration.json() as Readonly<{ id: string }>).id;
    const ready = await app.inject({
      method: "POST",
      url: `/v1/calibration-sessions/${calibrationId}/ready`,
      headers: { "x-revelai-athlete-id": ATHLETE_ID },
      payload: {
        requiredGates: ["device", "space", "athlete", "rehearsal", "record"],
      },
    });
    expect(ready.statusCode).toBe(204);
    const created = await app.inject({
      method: "POST",
      url: "/v1/attempts",
      headers: { "x-revelai-athlete-id": ATHLETE_ID },
      payload: {
        mode: "verified",
        challengeId: "wall-pass",
        challengeVersion: 1,
        calibrationSessionId: calibrationId,
      },
    });
    expect(created.statusCode).toBe(201);
    const attemptId = (created.json() as Readonly<{ id: string }>).id;
    const upload = await app.inject({
      method: "POST",
      url: `/v1/attempts/${attemptId}/media`,
      headers: {
        "x-revelai-athlete-id": ATHLETE_ID,
        "content-type": "multipart/form-data; boundary=revelai-verified-test",
      },
      payload: multipartBody("revelai-verified-test"),
    });
    expect(upload.statusCode).toBe(202);
    expect(probeCalls).toBe(1);
    const pending = await app.inject({
      method: "GET",
      url: `/v1/attempts/${attemptId}/result`,
      headers: { "x-revelai-athlete-id": ATHLETE_ID },
    });
    expect(pending.statusCode).toBe(202);
    expect(AttemptResultResponseSchema.parse(pending.json())).toMatchObject({
      state: "pending",
      attemptId,
      mode: "verified",
    });

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
      result: {
        kind: "verified-result",
        attemptId,
        competitiveStatus: "demo",
        competitiveEligible: false,
      },
    });
    expect(
      database.raw
        .prepare("SELECT COUNT(*) AS count FROM leaderboard_entries")
        .get(),
    ).toEqual({ count: 0 });
    database.close();
  });

  it("projects a ranked Verified result from the combined Fastify root without policy internals", async () => {
    const fixture = await makeCombinedVerifiedHttpRoot({
      provider: createVerifiedFixtureVisionProvider("roboflow"),
      approvedPolicy: true,
    });
    try {
      const attemptId = await createVerifiedHttpAttempt(fixture.app);
      await fixture.queueScheduler.runAll();
      const result = await fixture.app.inject({
        method: "GET",
        url: `/v1/attempts/${attemptId}/result`,
        headers: { "x-revelai-athlete-id": ATHLETE_ID },
      });

      expect(result.statusCode).toBe(200);
      expect(AttemptResultResponseSchema.parse(result.json())).toMatchObject({
        state: "valid",
        result: {
          kind: "verified-result",
          attemptId,
          competitiveStatus: "ranked",
          competitiveEligible: true,
          rankingSnapshot: { kind: "frozen", rank: 1, cohortSize: 1 },
        },
      });
      expectPublicResultDoesNotLeakInternals(result.json());
    } finally {
      await fixture.close();
    }
  });

  it("projects an experimental Roboflow result from the combined Fastify root when no policy is active", async () => {
    const fixture = await makeCombinedVerifiedHttpRoot({
      provider: createVerifiedFixtureVisionProvider("roboflow"),
    });
    try {
      const attemptId = await createVerifiedHttpAttempt(fixture.app);
      await fixture.queueScheduler.runAll();
      const result = await fixture.app.inject({
        method: "GET",
        url: `/v1/attempts/${attemptId}/result`,
        headers: { "x-revelai-athlete-id": ATHLETE_ID },
      });

      expect(result.statusCode).toBe(200);
      const body = AttemptResultResponseSchema.parse(result.json());
      expect(body).toMatchObject({
        state: "valid",
        result: {
          kind: "verified-result",
          attemptId,
          competitiveStatus: "experimental",
          competitiveEligible: false,
        },
      });
      expect(JSON.stringify(body)).not.toContain("rankingSnapshot");
      expectPublicResultDoesNotLeakInternals(body);
    } finally {
      await fixture.close();
    }
  });

  it("projects a Verified invalid outcome from the combined Fastify root without C5/C7 details", async () => {
    const fixture = await makeCombinedVerifiedHttpRoot({
      provider: createDemoVisionProvider({
        free: "free-well-framed-active-v1",
        verified: "wall-pass-insufficient-v1",
      }),
    });
    try {
      const attemptId = await createVerifiedHttpAttempt(fixture.app);
      await fixture.queueScheduler.runAll();
      const result = await fixture.app.inject({
        method: "GET",
        url: `/v1/attempts/${attemptId}/result`,
        headers: { "x-revelai-athlete-id": ATHLETE_ID },
      });

      expect(result.statusCode).toBe(200);
      expect(AttemptResultResponseSchema.parse(result.json())).toEqual(
        expect.objectContaining({
          state: "invalid",
          attemptId,
          mode: "verified",
          code: "calibration_not_verified",
          retryable: true,
        }),
      );
      expectPublicResultDoesNotLeakInternals(result.json());
    } finally {
      await fixture.close();
    }
  });

  it("projects exhausted Verified provider retries from the combined Fastify root as the public safe failure", async () => {
    const fixture = await makeCombinedVerifiedHttpRoot({
      provider: createDemoVisionProvider(),
      scheduler: immediatelyExpiredVisionScheduler(),
    });
    try {
      const attemptId = await createVerifiedHttpAttempt(fixture.app);
      await fixture.queueScheduler.runAll();
      const result = await fixture.app.inject({
        method: "GET",
        url: `/v1/attempts/${attemptId}/result`,
        headers: { "x-revelai-athlete-id": ATHLETE_ID },
      });

      expect(result.statusCode).toBe(200);
      expect(AttemptResultResponseSchema.parse(result.json())).toEqual(
        expect.objectContaining({
          state: "failed",
          attemptId,
          mode: "verified",
          code: "analysis_temporary_unavailable",
          retryable: true,
        }),
      );
      expectPublicResultDoesNotLeakInternals(result.json());
    } finally {
      await fixture.close();
    }
  });

  it("drains an in-flight Verified analysis before the combined root closes", async () => {
    const root = await mkdtemp(join(tmpdir(), "revelai-training-root-close-"));
    directories.push(root);
    const database = openSqliteDatabase(join(root, "api.sqlite"));
    const c5 = createC5PipelineTestSupport({ root: join(root, "c5") });
    const repository = new SQLiteAttemptRepository({
      database,
      clock: { now: () => NOW },
      ids: { next: ids() },
      handoffVerifier: c5.handoffVerifier,
    });
    const retention = new SQLiteRetentionRepository({ database });
    const job = await createAttachedVerifiedAttempt({
      repository,
      retention,
      c5,
    });
    const queueScheduler = new ManualScheduler();
    const queue = new InMemoryAnalysisQueue({ scheduler: queueScheduler });
    const visionScheduler = new BlockingVisionBatchScheduler();
    const app = createProductionTrainingAttemptApi({
      repository,
      retention,
      mediaPipeline: c5.pipeline,
      queue,
      cleaner: { cleanup: async () => undefined },
      scheduler: { everyHour: () => undefined, cancel: () => undefined },
      clock: { now: () => NOW },
      freeTraining: {
        provider: createDemoVisionProvider(),
        clock: { now: () => NOW },
      },
      verifiedTraining: {
        provider: createDemoVisionProvider(),
        scheduler: visionScheduler,
        clock: { now: () => NOW },
      },
    });

    await queue.enqueue(job);
    const drainingQueue = queueScheduler.runAll();
    await visionScheduler.waitUntilStarted();
    let closed = false;
    const closing = app.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);

    visionScheduler.release();
    await Promise.all([drainingQueue, closing]);
    expect(
      database.raw
        .prepare(
          "SELECT COUNT(*) AS count FROM terminal_results WHERE attempt_id = ?",
        )
        .get(ATTEMPT_ID),
    ).toEqual({ count: 1 });
    database.close();
  });

  it("routes untagged duplicate delivery by the C4 claim mode without letting Free process verified evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "revelai-verified-routing-"));
    directories.push(root);
    const database = openSqliteDatabase(join(root, "api.sqlite"));
    const c5 = createC5PipelineTestSupport({ root: join(root, "c5") });
    const repository = new SQLiteAttemptRepository({
      database,
      clock: { now: () => NOW },
      ids: { next: ids() },
      handoffVerifier: c5.handoffVerifier,
    });
    const retention = new SQLiteRetentionRepository({ database });
    const job = await createAttachedVerifiedAttempt({
      repository,
      retention,
      c5,
    });
    const scheduler = new ManualScheduler();
    const queue = new InMemoryAnalysisQueue({ scheduler });
    const demo = createDemoVisionProvider();
    let freeCalls = 0;
    const app = createProductionTrainingAttemptApi({
      repository,
      retention,
      mediaPipeline: c5.pipeline,
      queue,
      cleaner: { cleanup: async () => undefined },
      scheduler: { everyHour: () => undefined, cancel: () => undefined },
      clock: { now: () => NOW },
      freeTraining: {
        provider: {
          ...demo,
          analyzeFree: async (request, signal, deadline) => {
            freeCalls += 1;
            return demo.analyzeFree(request, signal, deadline);
          },
        },
        clock: { now: () => NOW },
      },
      verifiedTraining: {
        provider: demo,
        clock: { now: () => NOW },
      },
    });

    await queue.enqueue({
      attemptId: job.attemptId,
      generation: job.generation,
    });
    await queue.enqueue({
      attemptId: job.attemptId,
      generation: job.generation,
    });
    await scheduler.runAll();
    await app.close();

    expect(freeCalls).toBe(0);
    await expect(
      repository.getAttempt({ attemptId: ATTEMPT_ID, athleteId: ATHLETE_ID }),
    ).resolves.toMatchObject({
      status: "valid",
      outcome: {
        state: "valid",
        result: { kind: "verified-result", competitiveStatus: "demo" },
      },
    });
    expect(
      database.raw
        .prepare("SELECT COUNT(*) AS count FROM terminal_results")
        .get(),
    ).toEqual({ count: 1 });
    database.close();
  });

  it("leaves a stale verified delivery unfinalized for its current C4 generation", async () => {
    const root = await mkdtemp(join(tmpdir(), "revelai-verified-stale-"));
    directories.push(root);
    const database = openSqliteDatabase(join(root, "api.sqlite"));
    const c5 = createC5PipelineTestSupport({ root: join(root, "c5") });
    const repository = new SQLiteAttemptRepository({
      database,
      clock: { now: () => NOW },
      ids: { next: ids() },
      handoffVerifier: c5.handoffVerifier,
    });
    const retention = new SQLiteRetentionRepository({ database });
    const job = await createAttachedVerifiedAttempt({
      repository,
      retention,
      c5,
    });
    const scheduler = new ManualScheduler();
    const queue = new InMemoryAnalysisQueue({ scheduler });
    const runtime = createFactoryIssuedVerifiedTrainingRuntime({
      repository,
      queue,
      mediaPipeline: c5.pipeline,
      options: {
        provider: createDemoVisionProvider(),
        clock: { now: () => NOW },
      },
    });

    await queue.enqueue({
      attemptId: job.attemptId,
      generation: job.generation - 1,
      mode: "verified",
    });
    await scheduler.runAll();
    await runtime.stop();

    expect(
      database.raw
        .prepare(
          "SELECT COUNT(*) AS count FROM terminal_results WHERE attempt_id = ?",
        )
        .get(ATTEMPT_ID),
    ).toEqual({ count: 0 });
    await expect(
      repository.getAttempt({ attemptId: ATTEMPT_ID, athleteId: ATHLETE_ID }),
    ).resolves.toMatchObject({
      status: "uploaded",
      outcome: { state: "pending", mode: "verified" },
    });
    database.close();
  });

  it("does not resurrect a tombstoned verified delivery queued before worker startup", async () => {
    const root = await mkdtemp(join(tmpdir(), "revelai-verified-tombstone-"));
    directories.push(root);
    const database = openSqliteDatabase(join(root, "api.sqlite"));
    const c5 = createC5PipelineTestSupport({ root: join(root, "c5") });
    const repository = new SQLiteAttemptRepository({
      database,
      clock: { now: () => NOW },
      ids: { next: ids() },
      handoffVerifier: c5.handoffVerifier,
    });
    const retention = new SQLiteRetentionRepository({ database });
    const job = await createAttachedVerifiedAttempt({
      repository,
      retention,
      c5,
    });
    const scheduler = new ManualScheduler();
    const queue = new InMemoryAnalysisQueue({ scheduler });

    await queue.enqueue(job);
    await repository.tombstoneAttempt({
      attemptId: ATTEMPT_ID,
      athleteId: ATHLETE_ID,
    });
    const runtime = createFactoryIssuedVerifiedTrainingRuntime({
      repository,
      queue,
      mediaPipeline: c5.pipeline,
      options: {
        provider: createDemoVisionProvider(),
        clock: { now: () => NOW },
      },
    });
    await scheduler.runAll();
    await runtime.stop();

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

  it("processes an accepted verified delivery after its mode runtime restarts", async () => {
    const root = await mkdtemp(join(tmpdir(), "revelai-verified-restart-"));
    directories.push(root);
    const database = openSqliteDatabase(join(root, "api.sqlite"));
    const c5 = createC5PipelineTestSupport({ root: join(root, "c5") });
    const repository = new SQLiteAttemptRepository({
      database,
      clock: { now: () => NOW },
      ids: { next: ids() },
      handoffVerifier: c5.handoffVerifier,
    });
    const retention = new SQLiteRetentionRepository({ database });
    const job = await createAttachedVerifiedAttempt({
      repository,
      retention,
      c5,
    });
    const scheduler = new ManualScheduler();
    const queue = new InMemoryAnalysisQueue({ scheduler });
    const options = {
      provider: createDemoVisionProvider(),
      clock: { now: () => NOW },
    };
    const first = createFactoryIssuedVerifiedTrainingRuntime({
      repository,
      queue,
      mediaPipeline: c5.pipeline,
      options,
    });
    await first.stop();

    await queue.enqueue(job);
    const restarted = createFactoryIssuedVerifiedTrainingRuntime({
      repository,
      queue,
      mediaPipeline: c5.pipeline,
      options,
    });
    await scheduler.runAll();
    await restarted.stop();

    await expect(
      repository.getAttempt({ attemptId: ATTEMPT_ID, athleteId: ATHLETE_ID }),
    ).resolves.toMatchObject({
      status: "valid",
      outcome: {
        state: "valid",
        result: { kind: "verified-result", competitiveStatus: "demo" },
      },
    });
    database.close();
  });

  it("maps insufficient verified evidence to one public invalid outcome without a leaderboard entry", async () => {
    const root = await mkdtemp(join(tmpdir(), "revelai-verified-invalid-"));
    directories.push(root);
    const database = openSqliteDatabase(join(root, "api.sqlite"));
    const c5 = createC5PipelineTestSupport({ root: join(root, "c5") });
    const repository = new SQLiteAttemptRepository({
      database,
      clock: { now: () => NOW },
      ids: { next: ids() },
      handoffVerifier: c5.handoffVerifier,
    });
    const retention = new SQLiteRetentionRepository({ database });
    const job = await createAttachedVerifiedAttempt({
      repository,
      retention,
      c5,
    });
    const scheduler = new ManualScheduler();
    const queue = new InMemoryAnalysisQueue({ scheduler });
    const runtime = createFactoryIssuedVerifiedTrainingRuntime({
      repository,
      queue,
      mediaPipeline: c5.pipeline,
      options: {
        provider: createDemoVisionProvider({
          free: "free-well-framed-active-v1",
          verified: "wall-pass-insufficient-v1",
        }),
        clock: { now: () => NOW },
      },
    });

    await queue.enqueue(job);
    await scheduler.runAll();
    await runtime.stop();

    await expect(
      repository.getAttempt({ attemptId: ATTEMPT_ID, athleteId: ATHLETE_ID }),
    ).resolves.toMatchObject({
      status: "invalid",
      outcome: {
        state: "invalid",
        mode: "verified",
        code: "calibration_not_verified",
        retryable: true,
      },
    });
    expect(
      database.raw
        .prepare("SELECT COUNT(*) AS count FROM leaderboard_entries")
        .get(),
    ).toEqual({ count: 0 });
    database.close();
  });

  it("releases retryable verified provider failures and eventually persists the safe failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "revelai-verified-retry-"));
    directories.push(root);
    const database = openSqliteDatabase(join(root, "api.sqlite"));
    const c5 = createC5PipelineTestSupport({ root: join(root, "c5") });
    const repository = new SQLiteAttemptRepository({
      database,
      clock: { now: () => NOW },
      ids: { next: ids() },
      handoffVerifier: c5.handoffVerifier,
    });
    const retention = new SQLiteRetentionRepository({ database });
    const job = await createAttachedVerifiedAttempt({
      repository,
      retention,
      c5,
    });
    const scheduler = new ManualScheduler();
    const queue = new InMemoryAnalysisQueue({ scheduler });
    const runtime = createFactoryIssuedVerifiedTrainingRuntime({
      repository,
      queue,
      mediaPipeline: c5.pipeline,
      options: {
        provider: createDemoVisionProvider(),
        // Demo's C6 seam permits a scheduler, so force the bounded scheduler
        // deadline without forging or mutating the factory-issued provider.
        scheduler: immediatelyExpiredVisionScheduler(),
        clock: { now: () => NOW },
      },
    });

    await queue.enqueue(job);
    await scheduler.runAll();
    await runtime.stop();

    await expect(
      repository.getAttempt({ attemptId: ATTEMPT_ID, athleteId: ATHLETE_ID }),
    ).resolves.toMatchObject({
      status: "failed",
      outcome: {
        state: "failed",
        mode: "verified",
        code: "analysis_temporary_unavailable",
        retryable: true,
      },
    });
    expect(
      database.raw
        .prepare(
          "SELECT COUNT(*) AS count FROM processing_events WHERE event_type = 'processing-claimed'",
        )
        .get(),
    ).toEqual({ count: 3 });
    database.close();
  });

  it("terminalizes unexpected C8 binding failures as internal without spending retry budget", async () => {
    const scheduler = new ManualScheduler();
    const queue = new InMemoryAnalysisQueue({ scheduler });
    const claim = {
      leaseId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      generation: 1,
      mode: "verified" as const,
    };
    const finalized: unknown[] = [];
    let recoveries = 0;
    const runtime = createVerifiedTrainingRuntime({
      queue,
      repository: {
        claimProcessing: async () => claim,
        releaseProcessingClaim: async () => true,
        recordProcessingFailure: async () => {
          recoveries += 1;
          return { kind: "recorded" as const, retryAttempt: 1 };
        },
        deadLetterProcessingClaim: async () => ({
          kind: "dead-lettered" as const,
        }),
        finalizeTerminalResult: async (input) => {
          finalized.push(input.candidate);
          return { kind: "tombstoned" as const };
        },
      },
      analysis: {
        getProcessingContext: async () => {
          throw new Error("durable binding unexpectedly failed");
        },
        reconstruct: async () => {
          throw new Error("unreachable");
        },
        frames: { readFrame: async () => new Uint8Array() },
        provider: createDemoVisionProvider(),
        policy: { getActivePolicy: async () => null },
        clock: { now: () => NOW },
      },
    });
    await queue.enqueue({
      attemptId: ATTEMPT_ID,
      generation: 1,
      mode: "verified",
    });
    await scheduler.runAll();
    await runtime.stop();

    expect(recoveries).toBe(0);
    expect(finalized).toEqual([
      expect.objectContaining({
        state: "failed",
        attemptId: ATTEMPT_ID,
        mode: "verified",
        code: "analysis_internal_error",
        retryable: false,
      }),
    ]);
  });
});

async function createAttachedVerifiedAttempt(
  input: Readonly<{
    repository: SQLiteAttemptRepository;
    retention: SQLiteRetentionRepository;
    c5: ReturnType<typeof createC5PipelineTestSupport>;
  }>,
) {
  await input.repository.issueCalibrationSession({
    id: SESSION_ID,
    athleteId: ATHLETE_ID,
    nonce: "c".repeat(43),
    challengeId: "wall-pass",
    challengeVersion: 1,
  });
  await input.repository.readyCalibrationSession({
    id: SESSION_ID,
    athleteId: ATHLETE_ID,
    requiredGates: ["device", "space", "athlete", "rehearsal", "record"],
  });
  await input.repository.createAttempt({
    id: ATTEMPT_ID,
    athleteId: ATHLETE_ID,
    input: {
      mode: "verified",
      challengeId: "wall-pass",
      challengeVersion: 1,
      calibrationSessionId: SESSION_ID,
    },
  });
  const upload = await input.repository.prepareMediaUpload({
    attemptId: ATTEMPT_ID,
    athleteId: ATHLETE_ID,
  });
  if (upload.mode !== "verified") throw new Error("verified upload required");
  const accepted = await input.c5.accept(
    upload satisfies MediaUploadContext,
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
  return input.repository.attachPreparedMedia({ accepted });
}

async function makeCombinedVerifiedHttpRoot(
  input: Readonly<{
    provider: VisionProvider;
    scheduler?: VisionBatchScheduler;
    approvedPolicy?: boolean;
  }>,
) {
  const root = await mkdtemp(join(tmpdir(), "revelai-verified-http-root-"));
  directories.push(root);
  const database = openSqliteDatabase(join(root, "api.sqlite"));
  const c5 = createC5PipelineTestSupport({
    root: join(root, "c5"),
    mode: "verified",
    prober: verifiedHttpProber,
  });
  const repository = new SQLiteAttemptRepository({
    database,
    clock: { now: () => NOW },
    ids: { next: ids("aaaaaaaa") },
    handoffVerifier: c5.handoffVerifier,
  });
  const queueScheduler = new ManualScheduler();
  const queue = new InMemoryAnalysisQueue({ scheduler: queueScheduler });
  let policy: SQLiteCompetitivePolicyRepository | undefined;
  if (input.approvedPolicy) {
    policy = new SQLiteCompetitivePolicyRepository({
      database,
      clock: { now: () => NOW },
    });
    const receipt = WorkflowBenchmarkReceiptSchema.parse(
      passingWorkflowBenchmarkReceiptFixture,
    );
    await policy.storeBenchmarkReceipt(receipt);
    await policy.activateCompetitivePolicy({
      id: "99999999-9999-4999-8999-999999999999",
      receiptId: receipt.id,
      receiptSha256: receipt.receiptSha256,
      receiptSchemaVersion: receipt.schemaVersion,
      workspaceId: receipt.workflow.workspaceId,
      modelBundleId: receipt.workflow.modelBundleId,
      workflowId: receipt.workflow.workflowId,
      workflowVersion: receipt.workflow.workflowVersion,
      providerVersion: receipt.workflow.providerVersion,
      calibrationEvidenceVersion: receipt.evidence.calibrationEvidenceVersion,
      extractionEvidenceVersion: receipt.evidence.extractionEvidenceVersion,
      observationEvidenceVersion: receipt.evidence.observationEvidenceVersion,
      challengeId: "wall-pass",
      challengeVersion: 1,
      ruleVersion: "wall-pass-v1-score-1",
    });
  }
  const app = createProductionTrainingAttemptApi({
    repository,
    retention: new SQLiteRetentionRepository({ database }),
    mediaPipeline: c5.pipeline,
    queue,
    cleaner: { cleanup: async () => undefined },
    scheduler: { everyHour: () => undefined, cancel: () => undefined },
    clock: { now: () => NOW },
    ids: { next: ids("bbbbbbbb") },
    freeTraining: {
      provider: createDemoVisionProvider(),
      clock: { now: () => NOW },
    },
    verifiedTraining: {
      provider: input.provider,
      scheduler: input.scheduler,
      policy,
      clock: { now: () => NOW },
    },
  });
  return Object.freeze({
    app,
    database,
    queueScheduler,
    close: async () => {
      await app.close();
      database.close();
    },
  });
}

async function createVerifiedHttpAttempt(
  app: FastifyInstance,
): Promise<string> {
  const calibration = await app.inject({
    method: "POST",
    url: "/v1/calibration-sessions",
    headers: { "x-revelai-athlete-id": ATHLETE_ID },
    payload: { challengeId: "wall-pass", challengeVersion: 1 },
  });
  expect(calibration.statusCode).toBe(201);
  const calibrationId = (calibration.json() as Readonly<{ id: string }>).id;
  const ready = await app.inject({
    method: "POST",
    url: `/v1/calibration-sessions/${calibrationId}/ready`,
    headers: { "x-revelai-athlete-id": ATHLETE_ID },
    payload: {
      requiredGates: ["device", "space", "athlete", "rehearsal", "record"],
    },
  });
  expect(ready.statusCode).toBe(204);
  const created = await app.inject({
    method: "POST",
    url: "/v1/attempts",
    headers: { "x-revelai-athlete-id": ATHLETE_ID },
    payload: {
      mode: "verified",
      challengeId: "wall-pass",
      challengeVersion: 1,
      calibrationSessionId: calibrationId,
    },
  });
  expect(created.statusCode).toBe(201);
  const attemptId = (created.json() as Readonly<{ id: string }>).id;
  const upload = await app.inject({
    method: "POST",
    url: `/v1/attempts/${attemptId}/media`,
    headers: {
      "x-revelai-athlete-id": ATHLETE_ID,
      "content-type": "multipart/form-data; boundary=revelai-verified-test",
    },
    payload: multipartBody("revelai-verified-test"),
  });
  expect(upload.statusCode).toBe(202);
  return attemptId;
}

function expectPublicResultDoesNotLeakInternals(value: unknown): void {
  const body = JSON.stringify(value);
  for (const internal of [
    "lease",
    "generation",
    "receipt",
    "policy",
    "frameBatch",
    "mediaSha",
    "calibrationNonce",
  ])
    expect(body).not.toContain(internal);
}

function ids(prefix = "aaaaaaaa"): () => string {
  let sequence = 0;
  return () => {
    sequence += 1;
    return `${prefix}-${prefix.slice(0, 4)}-4${prefix.slice(0, 3)}-8${prefix.slice(0, 3)}-${sequence.toString(16).padStart(12, "0")}`;
  };
}

function multipartBody(boundary: string): Buffer {
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

const verifiedHttpProber = Object.freeze({
  probe: async () =>
    Object.freeze({
      container: "mp4" as const,
      durationSeconds: 64,
      displayWidth: 1280,
      displayHeight: 720,
      nominalFps: 30,
      codec: "h264",
      sourceRotationDegrees: 0 as const,
    }),
});

function immediatelyExpiredVisionScheduler(): VisionBatchScheduler {
  return new VisionBatchScheduler({
    clock: {
      now: () => 0,
      sleep: async () => undefined,
      schedule: (_milliseconds, callback) => {
        callback();
        return () => undefined;
      },
    },
  });
}

class BlockingVisionBatchScheduler extends VisionBatchScheduler {
  readonly #started: Promise<void>;
  readonly #released: Promise<void>;
  readonly #resolveStarted: () => void;
  readonly #resolveReleased: () => void;

  public constructor() {
    super();
    let resolveStarted: (() => void) | undefined;
    let resolveReleased: (() => void) | undefined;
    this.#started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    this.#released = new Promise<void>((resolve) => {
      resolveReleased = resolve;
    });
    if (!resolveStarted || !resolveReleased)
      throw new Error("blocking scheduler resolvers are required");
    this.#resolveStarted = resolveStarted;
    this.#resolveReleased = resolveReleased;
  }

  public waitUntilStarted(): Promise<void> {
    return this.#started;
  }

  public release(): void {
    this.#resolveReleased();
  }

  public override async run<Item, Result>(
    items: readonly Item[],
    dispatch: (
      item: Item,
      signal: AbortSignal,
      deadline: VisionRequestDeadline,
    ) => Promise<Result> | Result,
    signal?: AbortSignal,
  ): Promise<readonly Result[]> {
    this.#resolveStarted();
    await this.#released;
    return super.run(items, dispatch, signal);
  }
}
