/**
 * The two C4 repositories call this inside their own SQLite transactions.
 * It is deliberately transaction-free: one source owns the exact transition
 * from both opaque resources absent to a resolved recovery outbox record.
 */
export function reconcileMediaDeliveryCleanup(
  raw: Readonly<{
    prepare(
      sql: string,
    ): Readonly<{ run(...values: readonly unknown[]): unknown }>;
  }>,
  input: Readonly<{ attemptId: string; now: string }>,
): void {
  raw
    .prepare(
      `UPDATE media_delivery_recovery_records AS delivery
          SET cleanup_completed_at = COALESCE(cleanup_completed_at, ?),
              state = 'resolved',
              recovery_lease_id = NULL,
              recovery_lease_expires_at = NULL,
              updated_at = ?
        WHERE attempt_id = ?
          AND state = 'cleanup-recoverable'
          AND (requires_rollback = 0 OR rollback_completed_at IS NOT NULL)
          AND NOT EXISTS (
            SELECT 1 FROM media_retention_records original
             WHERE original.attempt_id = delivery.attempt_id
               AND original.media_id = delivery.media_id
          )
          AND NOT EXISTS (
            SELECT 1 FROM retention_cleanup_records frame
             WHERE frame.attempt_id = delivery.attempt_id
               AND frame.resource_id = delivery.frame_batch_id
               AND frame.resource_kind = 'frame'
          )`,
    )
    .run(input.now, input.now, input.attemptId);
}
