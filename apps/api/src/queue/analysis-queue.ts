export type AnalysisJob = Readonly<{
  attemptId: string;
  generation: number;
  /** Factory-issued uploads can be dispatched without crossing modes. */
  mode?: "free" | "verified";
}>;

export type AnalysisJobDelivery = (job: AnalysisJob) => Promise<void>;

export type AnalysisQueue = Readonly<{
  isAvailable(): Promise<boolean>;
  enqueue(job: AnalysisJob): Promise<void>;
  subscribe(
    deliver: AnalysisJobDelivery,
    options?: Readonly<{ mode: "free" | "verified" }>,
  ): () => void;
}>;

export class QueueUnavailableError extends Error {
  public constructor() {
    super("Analysis queue is unavailable.");
    this.name = "QueueUnavailableError";
  }
}
