import type { PermissionMap } from "./permission.js";

/**
 * What is cached per user (`auth:ctx:{userId}`).
 *
 * Deliberately does NOT contain the resolved list of allowed org units:
 * subtrees are cached separately per org unit, so restructuring the org
 * chart invalidates a handful of subtree keys instead of every user's context.
 */
export interface CachedAuthContext {
  userId: string;
  roleCode: string;
  orgUnitId: number | null;
  managedOrgUnitIds: number[];
  tokenVersion: number;
  permissions: PermissionMap;
}

/** Resolved per request for one permission. */
export type DataScope =
  | { kind: "own" }
  | { kind: "org"; orgUnitIds: number[] }
  | { kind: "all" };

export interface UserRecord {
  userId: string;
  roleId: number;
  roleCode: string;
  orgUnitId: number | null;
  status: "active" | "inactive";
  /** epoch ms, null when not locked */
  lockedUntil: number | null;
  tokenVersion: number;
}

export function isUsable(user: UserRecord, now: number = Date.now()): boolean {
  return user.status === "active" && (user.lockedUntil === null || user.lockedUntil <= now);
}
