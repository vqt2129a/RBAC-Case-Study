import type { UserRecord } from "../src/domain/authContext.js";
import type { PermissionGrant, ScopeLevels } from "../src/domain/permission.js";
import { DEFAULT_SCOPE_LEVELS } from "../src/domain/permission.js";
import type {
  AlertNotifier,
  AuthReadRepository,
  InvalidationJob,
  InvalidationQueue,
  KeyValueCache,
  OutboxEntry,
  OutboxRepository,
  OutboxStatus,
} from "../src/application/ports.js";

export class FakeCache implements KeyValueCache {
  store = new Map<string, string>();
  failing = false;

  async get(key: string) {
    this.guard();
    return this.store.get(key) ?? null;
  }
  async mget(keys: string[]) {
    this.guard();
    return keys.map((k) => this.store.get(k) ?? null);
  }
  async set(key: string, value: string) {
    this.guard();
    this.store.set(key, value);
  }
  async del(keys: string[]) {
    this.guard();
    keys.forEach((k) => this.store.delete(k));
  }
  private guard() {
    if (this.failing) throw new Error("cache unavailable");
  }
}

/**
 * In-memory org/role model:
 *   Company(1) ── Engineering(2) ── Backend(5), Frontend(6)
 *             ├─ Sales(3) ── Sales HCM(10)
 *             └─ Admin office(4)
 */
export class FakeAuthRepo implements AuthReadRepository {
  calls = { findUser: 0, subtree: 0 };
  users = new Map<string, UserRecord>();
  leaders = new Map<string, number[]>();
  grantsByRole = new Map<number, PermissionGrant[]>();
  parentRole = new Map<number, number | null>();
  orgParent = new Map<number, number | null>([
    [1, null], [2, 1], [3, 1], [4, 1], [5, 2], [6, 2], [10, 3],
  ]);
  levels: ScopeLevels = { ...DEFAULT_SCOPE_LEVELS };

  async findUser(userId: string) {
    this.calls.findUser++;
    await tick();
    return this.users.get(userId) ?? null;
  }
  async getGrantsWithInheritance(roleId: number) {
    const grants: PermissionGrant[] = [];
    for (let id: number | null | undefined = roleId; id; id = this.parentRole.get(id)) {
      grants.push(...(this.grantsByRole.get(id) ?? []));
    }
    return grants;
  }
  async getManagedOrgUnitIds(userId: string) {
    return this.leaders.get(userId) ?? [];
  }
  async getOrgSubtreeIds(orgUnitId: number) {
    this.calls.subtree++;
    await tick();
    const result = [orgUnitId];
    for (const [id, parent] of this.orgParent) {
      if (parent === orgUnitId) result.push(...(await this.getOrgSubtreeIds(id)));
    }
    return result;
  }
  async getScopeLevels() {
    return this.levels;
  }
}

export class FakeOutbox implements OutboxRepository {
  entries = new Map<number, OutboxEntry & { lastError?: string }>();

  add(id: number, userIds: string[], status: OutboxStatus = "PENDING", createdAt = Date.now()) {
    this.entries.set(id, { id, userIds, status, createdAt });
  }
  async markStatus(id: number, status: OutboxStatus, lastError?: string) {
    const e = this.entries.get(id);
    if (e) Object.assign(e, { status, lastError });
  }
  async findRetryable(limit: number) {
    return [...this.entries.values()].filter((e) => e.status === "PENDING").slice(0, limit);
  }
  async findStuck(olderThanMs: number, statuses: OutboxStatus[]) {
    const cutoff = Date.now() - olderThanMs;
    return [...this.entries.values()].filter((e) => statuses.includes(e.status) && e.createdAt < cutoff);
  }
}

export class FakeQueue implements InvalidationQueue {
  jobs = new Map<string, InvalidationJob>();
  failing = false;

  async enqueue(job: InvalidationJob) {
    if (this.failing) throw new Error("queue unavailable");
    this.jobs.set(`outbox-${job.outboxId}`, job); // same job id => no duplicates
  }
}

export class FakeNotifier implements AlertNotifier {
  messages: string[] = [];
  async critical(message: string) {
    this.messages.push(message);
  }
}

const tick = () => new Promise((r) => setTimeout(r, 1));
