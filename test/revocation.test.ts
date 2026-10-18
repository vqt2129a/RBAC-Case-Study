import { beforeEach, describe, expect, it } from "vitest";
import { authCtxKey } from "../src/application/authContextService.js";
import { InvalidationCoordinator } from "../src/application/invalidationCoordinator.js";
import { processInvalidationJob, reconcileOutbox, watchOutbox } from "../src/application/outboxJobs.js";
import { FakeCache, FakeNotifier, FakeOutbox, FakeQueue } from "./fakes.js";

let cache: FakeCache;
let queue: FakeQueue;
let outbox: FakeOutbox;
let threshold: number;
let coordinator: InvalidationCoordinator;

const users = (n: number) => Array.from({ length: n }, (_, i) => `u${i}`);

beforeEach(() => {
  cache = new FakeCache();
  queue = new FakeQueue();
  outbox = new FakeOutbox();
  threshold = 200;
  coordinator = new InvalidationCoordinator(cache, queue, outbox, async () => threshold);
});

describe("3-tier invalidation", () => {
  it("tier 1: small blast radius is revoked synchronously", async () => {
    users(3).forEach((u) => cache.store.set(authCtxKey(u), "{}"));
    outbox.add(1, users(3));

    expect(await coordinator.invalidate(1, users(3))).toBe("SYNC");
    expect(cache.store.size).toBe(0);
    expect(outbox.entries.get(1)!.status).toBe("COMPLETED");
  });

  it("tier 2: above the threshold goes to the queue", async () => {
    threshold = 5;
    outbox.add(1, users(10));
    expect(await coordinator.invalidate(1, users(10))).toBe("ASYNC_QUEUE");
    expect(queue.jobs.size).toBe(1);
  });

  it("tier 1 failure falls back to the queue", async () => {
    cache.failing = true;
    outbox.add(1, users(3));
    expect(await coordinator.invalidate(1, users(3))).toBe("FALLBACK_QUEUED");
  });

  it("tier 3: everything down leaves the outbox row PENDING", async () => {
    cache.failing = true;
    queue.failing = true;
    outbox.add(1, users(3));
    expect(await coordinator.invalidate(1, users(3))).toBe("OUTBOX_PENDING");
    expect(outbox.entries.get(1)!.status).toBe("PENDING");
  });
});

describe("background jobs", () => {
  it("worker deletes in batches and completes the outbox row", async () => {
    users(250).forEach((u) => cache.store.set(authCtxKey(u), "{}"));
    outbox.add(7, users(250));

    await processInvalidationJob({ outboxId: 7, userIds: users(250) }, { cache, outbox });
    expect(cache.store.size).toBe(0);
    expect(outbox.entries.get(7)!.status).toBe("COMPLETED");
  });

  it("worker failure puts the row back to PENDING and rethrows for queue retry", async () => {
    cache.failing = true;
    outbox.add(7, users(2));
    await expect(processInvalidationJob({ outboxId: 7, userIds: users(2) }, { cache, outbox })).rejects.toThrow();
    expect(outbox.entries.get(7)!.status).toBe("PENDING");
  });

  it("reconciler re-enqueues pending rows without creating duplicate jobs", async () => {
    outbox.add(1, users(1));
    outbox.add(2, users(1));
    await reconcileOutbox({ outbox, queue });
    await reconcileOutbox({ outbox, queue }); // runs again 30s later
    expect(queue.jobs.size).toBe(2);
  });

  it("watchdog alerts on rows stuck longer than the threshold", async () => {
    const notifier = new FakeNotifier();
    outbox.add(1, users(1), "PENDING", Date.now() - 10 * 60_000);
    outbox.add(2, users(1), "PENDING"); // fresh, not stuck
    outbox.add(3, users(1), "COMPLETED", Date.now() - 10 * 60_000);

    expect(await watchOutbox({ outbox, notifier })).toBe(1);
    expect(notifier.messages[0]).toContain("ids: 1");
  });
});
