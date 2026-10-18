import type { UserRecord } from "../domain/authContext.js";
import type { PermissionGrant, ScopeLevels } from "../domain/permission.js";

/** Minimal key-value cache contract (implemented with Redis in production). */
export interface KeyValueCache {
  get(key: string): Promise<string | null>;
  /** One round-trip for many keys. */
  mget(keys: string[]): Promise<(string | null)[]>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  /** Must throw if the delete could not be confirmed. */
  del(keys: string[]): Promise<void>;
}

/** Read side used to (re)build the auth context. Implemented with MySQL. */
export interface AuthReadRepository {
  findUser(userId: string): Promise<UserRecord | null>;
  /** Grants of the role AND all its ancestors (recursive CTE upwards). */
  getGrantsWithInheritance(roleId: number): Promise<PermissionGrant[]>;
  /** Org units the user leads (many-to-many leaders table). */
  getManagedOrgUnitIds(userId: string): Promise<number[]>;
  /** The unit itself + every descendant (recursive CTE downwards). */
  getOrgSubtreeIds(orgUnitId: number): Promise<number[]>;
  getScopeLevels(): Promise<ScopeLevels>;
}

export type OutboxStatus = "PENDING" | "PROCESSING" | "COMPLETED" | "FAILED";

export interface OutboxEntry {
  id: number;
  userIds: string[];
  status: OutboxStatus;
  createdAt: number;
}

export interface OutboxRepository {
  markStatus(id: number, status: OutboxStatus, lastError?: string): Promise<void>;
  findRetryable(limit: number): Promise<OutboxEntry[]>;
  findStuck(olderThanMs: number, statuses: OutboxStatus[]): Promise<OutboxEntry[]>;
}

export interface InvalidationJob {
  outboxId: number;
  userIds: string[];
}

/** Background queue (BullMQ in production). */
export interface InvalidationQueue {
  /** Implementations should use `outbox-{id}` as job id so re-enqueueing is a no-op. */
  enqueue(job: InvalidationJob): Promise<void>;
}

export interface AlertNotifier {
  critical(message: string): Promise<void>;
}
