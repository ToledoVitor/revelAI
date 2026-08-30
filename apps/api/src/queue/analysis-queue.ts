export type AnalysisJob = Readonly<{
  attemptId: string;
}>;

export type AnalysisJobDelivery = (job: AnalysisJob) => Promise<void>;

export type AnalysisQueue = Readonly<{
  isAvailable(): boolean;
  enqueue(job: AnalysisJob): Promise<void>;
  subscribe(deliver: AnalysisJobDelivery): () => void;
}>;

export class QueueUnavailableError extends Error {
  public constructor() {
    super("Analysis queue is unavailable.");
    this.name = "QueueUnavailableError";
  }
}
