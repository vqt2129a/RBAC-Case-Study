import { authCtxKey } from "./authContextService.js";
import type { InvalidationQueue, KeyValueCache, OutboxRepository } from "./ports.js";

export type InvalidationMode = "SYNC" | "ASYNC_QUEUE" | "FALLBACK_QUEUED" | "OUTBOX_PENDING";

/**
 * Runs AFTER the transaction that changed permissions has committed.
 * That transaction already inserted an outbox row with status PENDING, so the
 * revocation can never be lost — every tier below is an optimisation on top.
 *
 *   Tier 1  small blast radius  -> delete cache keys now (a few ms)
 *   Tier 2  large or tier 1 failed -> background queue with retries
 *   Tier 3  queue unreachable   -> leave outbox PENDING for the reconciler
 */
export class InvalidationCoordinator {
  constructor(
    private readonly cache: KeyValueCache,
    private readonly queue: InvalidationQueue,
    private readonly outbox: OutboxRepository,
    /** Read from a config table so ops can tune it without a deploy. */
    private readonly getSyncThreshold: () => Promise<number>,
  ) {}

  async invalidate(outboxId: number, userIds: string[]): Promise<InvalidationMode> {
    const threshold = await this.getSyncThreshold().catch(() => 200);
    let isFallback = false;

    if (userIds.length <= threshold) {
      try {
        await this.cache.del(userIds.map(authCtxKey));
        await this.outbox.markStatus(outboxId, "COMPLETED");
        return "SYNC";
      } catch {
        isFallback = true; // DEL is idempotent, so retrying the whole batch later is safe
      }
    }

    try {
      await this.queue.enqueue({ outboxId, userIds });
      return isFallback ? "FALLBACK_QUEUED" : "ASYNC_QUEUE";
    } catch {
      return "OUTBOX_PENDING";
    }
  }
}
