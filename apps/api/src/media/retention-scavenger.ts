export type RetentionRecord = Readonly<{
  id: string;
  attemptId: string;
  kind: "original" | "frame" | "temporary" | "observation";
  deleteAt: string;
  cleanupRequestedAt: string | null;
}>;

export interface RetentionRepository {
  listDue(
    input: Readonly<{ now: string; limit: number }>,
  ): Promise<readonly RetentionRecord[]>;
  /** Called only after physical deletion (or a missing-object success). */
  acknowledge(record: RetentionRecord): Promise<void>;
}

export interface RetentionObjectStore {
  delete(record: RetentionRecord): Promise<void>;
}

export interface RetentionLog {
  event(
    event: Readonly<{
      category: "retention_cleanup_failed";
      attempt: string;
      resource: string;
    }>,
  ): void;
}

export interface HourlyScheduler {
  everyHour(task: () => void): unknown;
  cancel(handle: unknown): void;
}

export class RetentionScavenger {
  private readonly repository: RetentionRepository;
  private readonly objects: RetentionObjectStore;
  private readonly maxBatchSize: number;
  private readonly log: RetentionLog;
  private readonly scheduler: HourlyScheduler | undefined;
  private readonly now: () => string;
  private running = false;

  public constructor(
    input: Readonly<{
      repository: RetentionRepository;
      objects: RetentionObjectStore;
      maxBatchSize: number;
      log: RetentionLog;
      scheduler?: HourlyScheduler;
      now?: () => string;
    }>,
  ) {
    if (!Number.isSafeInteger(input.maxBatchSize) || input.maxBatchSize < 1)
      throw new Error("Retention batch size must be a positive safe integer.");
    this.repository = input.repository;
    this.objects = input.objects;
    this.maxBatchSize = input.maxBatchSize;
    this.log = input.log;
    this.scheduler = input.scheduler;
    this.now = input.now ?? (() => new Date().toISOString());
  }

  public start(now = this.now()): () => void {
    void this.run(now);
    const handle = this.scheduler?.everyHour(() => {
      void this.run(this.now());
    });
    return () => {
      if (handle !== undefined) this.scheduler?.cancel(handle);
    };
  }

  public async run(
    now: string,
  ): Promise<
    | Readonly<{ kind: "completed"; processed: number }>
    | Readonly<{ kind: "skipped-overlap" }>
  > {
    if (this.running) return Object.freeze({ kind: "skipped-overlap" });
    this.running = true;
    try {
      const records = await this.repository.listDue({
        now,
        limit: this.maxBatchSize,
      });
      let processed = 0;
      for (const record of records) {
        try {
          await this.objects.delete(record);
          await this.repository.acknowledge(record);
          processed += 1;
        } catch {
          this.log.event(
            Object.freeze({
              category: "retention_cleanup_failed",
              attempt: redact(record.attemptId),
              resource: redact(record.id),
            }),
          );
        }
      }
      return Object.freeze({ kind: "completed", processed });
    } finally {
      this.running = false;
    }
  }
}

function redact(value: string): string {
  return value.slice(0, 8);
}
