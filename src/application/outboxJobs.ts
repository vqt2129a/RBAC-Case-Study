import { authCtxKey } from "./authContextService.js";
import type {
  AlertNotifier,
  InvalidationJob,
  InvalidationQueue,
  KeyValueCache,
  OutboxRepository,
} from "./ports.js";

const BATCH_SIZE = 100;

/** Queue consumer (BullMQ worker in production). Throwing lets the queue retry with backoff. */
export async function processInvalidationJob(
  job: InvalidationJob,
  deps: { cache: KeyValueCache; outbox: OutboxRepository },
): Promise<void> {
  await deps.outbox.markStatus(job.outboxId, "PROCESSING");
  try {
    for (let i = 0; i < job.userIds.length; i += BATCH_SIZE) {
      await deps.cache.del(job.userIds.slice(i, i + BATCH_SIZE).map(authCtxKey));
    }
    await deps.outbox.markStatus(job.outboxId, "COMPLETED");
  } catch (error) {
    await deps.outbox.markStatus(job.outboxId, "PENDING", String(error));
    throw error;
  }
}

/** Tier 3: periodically re-enqueue whatever is still waiting (e.g. after a Redis outage). */
export async function reconcileOutbox(deps: {
  outbox: OutboxRepository;
  queue: InvalidationQueue;
  limit?: number;
}): Promise<number> {
  const entries = await deps.outbox.findRetryable(deps.limit ?? 50);
  let enqueued = 0;
  for (const entry of entries) {
    try {
      await deps.queue.enqueue({ outboxId: entry.id, userIds: entry.userIds });
      enqueued++;
    } catch {
      // queue still down — the next run will try again
    }
  }
  return enqueued;
}

/** Who watches the reconciler? An independent check that pages a human. */
export async function watchOutbox(deps: {
  outbox: OutboxRepository;
  notifier: AlertNotifier;
  stuckAfterMs?: number;
}): Promise<number> {
  const stuck = await deps.outbox.findStuck(deps.stuckAfterMs ?? 5 * 60_000, ["PENDING", "PROCESSING", "FAILED"]);
  if (stuck.length > 0) {
    await deps.notifier.critical(
      `${stuck.length} permission-revocation job(s) stuck (ids: ${stuck.map((e) => e.id).join(", ")}). ` +
        `Users may still hold revoked permissions.`,
    );
  }
  return stuck.length;
}
