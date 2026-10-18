/**
 * Pure permission logic — no I/O, fully unit-testable.
 *
 * A permission key is `resource:action` (e.g. `task:view`).
 * Every (role, permission) grant carries its own data scope, so the same user
 * can hold `task:view = team` and `payroll:view = own` at the same time.
 */

export type ScopeCode = string;

/** Scope code -> numeric level. Stored as data (a `scopes` table), not as an enum. */
export type ScopeLevels = Record<ScopeCode, number>;

export const DEFAULT_SCOPE_LEVELS: ScopeLevels = { own: 1, team: 2, all: 99 };

export interface PermissionGrant {
  resource: string;
  action: string;
  scope: ScopeCode;
}

/** `resource:action` -> effective scope. `"*"` is the super-admin wildcard. */
export type PermissionMap = Record<string, ScopeCode>;

/**
 * Merge grants collected from a role and all of its ancestors.
 * When the same permission appears several times, the widest scope wins.
 */
export function mergePermissions(
  grants: PermissionGrant[],
  levels: ScopeLevels = DEFAULT_SCOPE_LEVELS,
): PermissionMap {
  const merged: PermissionMap = {};
  for (const { resource, action, scope } of grants) {
    const key = `${resource}:${action}`;
    const current = merged[key];
    if (current === undefined || levelOf(scope, levels) > levelOf(current, levels)) {
      merged[key] = scope;
    }
  }
  return merged;
}

/** Returns the granted scope, or `null` when the permission is missing. */
export function checkPermission(
  permissions: PermissionMap | null | undefined,
  required: string,
): ScopeCode | null {
  if (!permissions) return null;
  if ("*" in permissions) return highestScope(DEFAULT_SCOPE_LEVELS);
  return permissions[required] ?? null;
}

/**
 * How a scope filters data. The meaning is derived from levels, so a new
 * intermediate scope (e.g. `department = 3`) needs no code change.
 *  - lowest level  -> only the actor's own records
 *  - highest level -> no filter
 *  - anything else -> filter by the actor's org-unit subtrees
 */
export type ScopeKind = "own" | "org" | "all";

export function classifyScope(scope: ScopeCode, levels: ScopeLevels): ScopeKind {
  const values = Object.values(levels);
  const level = levelOf(scope, levels);
  if (level >= Math.max(...values)) return "all";
  if (level <= Math.min(...values)) return "own";
  return "org";
}

export function isScopeAtLeast(granted: ScopeCode, minimum: ScopeCode, levels: ScopeLevels): boolean {
  return levelOf(granted, levels) >= levelOf(minimum, levels);
}

function levelOf(scope: ScopeCode, levels: ScopeLevels): number {
  return levels[scope] ?? Math.min(...Object.values(levels));
}

function highestScope(levels: ScopeLevels): ScopeCode {
  return Object.entries(levels).sort((a, b) => b[1] - a[1])[0]![0];
}
