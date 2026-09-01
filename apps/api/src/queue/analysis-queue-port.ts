import type { AnalysisJob, AnalysisJobDelivery } from "./analysis-queue.js";

declare const resolvedAnalysisQueuePort: unique symbol;

/**
 * Opaque, factory-resolved queue methods for composition consumers. Only an
 * adapter factory may issue this type; HTTP deliberately receives no queue
 * implementation or host identity.
 */
export type ResolvedAnalysisQueuePort = Readonly<{
  readonly [resolvedAnalysisQueuePort]: "factory-issued";
  isAvailable(): Promise<boolean>;
  enqueue(job: AnalysisJob): Promise<void>;
  subscribe(
    deliver: AnalysisJobDelivery,
    options?: Readonly<{ mode: "free" | "verified" }>,
  ): () => void;
}>;

/** The HTTP upload/recovery layer needs delivery methods, never subscription. */
export type AttemptApiQueuePort = Pick<
  ResolvedAnalysisQueuePort,
  "isAvailable" | "enqueue"
>;
