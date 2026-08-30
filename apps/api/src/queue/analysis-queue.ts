export type AnalysisJob = Readonly<{
  attemptId: string;
  generation: number;
}>;

export type AnalysisJobDelivery = (job: AnalysisJob) => Promise<void>;

export type AnalysisQueue = Readonly<{
  isAvailable(): Promise<boolean>;
  enqueue(job: AnalysisJob): Promise<void>;
  subscribe(deliver: AnalysisJobDelivery): () => void;
}>;

export class QueueUnavailableError extends Error {
  public constructor() {
    super("Analysis queue is unavailable.");
    this.name = "QueueUnavailableError";
  }
}
