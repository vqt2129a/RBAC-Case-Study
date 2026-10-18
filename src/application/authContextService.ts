import { isUsable, type CachedAuthContext, type DataScope } from "../domain/authContext.js";
import { AuthError } from "../domain/errors.js";
import {
  checkPermission,
  classifyScope,
  isScopeAtLeast,
  mergePermissions,
  type ScopeCode,
  type ScopeLevels,
} from "../domain/permission.js";
import type { AuthReadRepository, KeyValueCache } from "./ports.js";
import { SingleFlight } from "./singleFlight.js";

export const AUTH_CTX_TTL_SECONDS = 24 * 3600;
export const SUBTREE_TTL_SECONDS = 7 * 24 * 3600;

export const authCtxKey = (userId: string) => `auth:ctx:${userId}`;
export const subtreeKey = (orgUnitId: number) => `org:subtree:${orgUnitId}`;

export interface AuthorizeOptions {
  permission: string;
  /** Minimum scope the endpoint requires (e.g. a report that only makes sense at `team`). */
  minScope?: ScopeCode;
  /** Only count units the user *leads*, not the unit they belong to (approvals). */
  managedOnly?: boolean;
}

export class AuthContextService {
  private readonly userFlights = new SingleFlight<string, CachedAuthContext>();
  private readonly subtreeFlights = new SingleFlight<number, number[]>();

  constructor(
    private readonly cache: KeyValueCache,
    private readonly repo: AuthReadRepository,
  ) {}

  /**
   * Called by the authentication middleware after the JWT signature is verified.
   * The token-version check runs on BOTH cache hit and cache miss — otherwise a
   * stolen token would survive a password change as long as the cache is warm.
   */
  async authenticate(userId: string, tokenVersion: number): Promise<CachedAuthContext> {
    const ctx = await this.getOrRebuild(userId);
    if (ctx.tokenVersion !== tokenVersion) {
      throw new AuthError("SESSION_REVOKED", 401);
    }
    return ctx;
  }

  /** Permission + scope check for one endpoint; returns how data must be filtered. */
  async authorize(ctx: CachedAuthContext, options: AuthorizeOptions): Promise<DataScope> {
    const granted = checkPermission(ctx.permissions, options.permission);
    if (!granted) throw new AuthError("PERMISSION_DENIED", 403);

    const levels = await this.repo.getScopeLevels();
    if (options.minScope && !isScopeAtLeast(granted, options.minScope, levels)) {
      throw new AuthError("SCOPE_DENIED", 403);
    }
    return this.toDataScope(ctx, granted, levels, options.managedOnly ?? false);
  }

  async getOrRebuild(userId: string): Promise<CachedAuthContext> {
    const cached = await this.safeGet(authCtxKey(userId));
    if (cached) return JSON.parse(cached) as CachedAuthContext;
    return this.userFlights.run(userId, () => this.rebuild(userId));
  }

  /** Union of the subtrees of every root, fetched with a single MGET. */
  async resolveAllowedOrgUnitIds(rootIds: number[]): Promise<number[]> {
    const roots = [...new Set(rootIds)];
    if (roots.length === 0) return [];

    const raw = await this.cache.mget(roots.map(subtreeKey)).catch(() => roots.map(() => null));
    const result = new Set<number>();
    const missing: number[] = [];

    roots.forEach((id, i) => {
      const hit = raw[i];
      if (hit) JSON.parse(hit).forEach((n: number) => result.add(n));
      else missing.push(id);
    });

    const rebuilt = await Promise.all(missing.map((id) => this.getOrRebuildSubtree(id)));
    rebuilt.flat().forEach((n) => result.add(n));
    return [...result];
  }

  private async rebuild(userId: string): Promise<CachedAuthContext> {
    const user = await this.repo.findUser(userId);
    if (!user) throw new AuthError("ACCOUNT_NOT_FOUND", 401);

    // Safe rebuild: a disabled/locked account is never written back to the cache,
    // so "delete the cache key" is a reliable way to kick a user out.
    if (!isUsable(user)) {
      await this.cache.del([authCtxKey(userId)]).catch(() => undefined);
      throw new AuthError("ACCOUNT_DISABLED", 401);
    }

    const [grants, managedOrgUnitIds, levels] = await Promise.all([
      this.repo.getGrantsWithInheritance(user.roleId),
      this.repo.getManagedOrgUnitIds(userId),
      this.repo.getScopeLevels(),
    ]);

    const ctx: CachedAuthContext = {
      userId,
      roleCode: user.roleCode,
      orgUnitId: user.orgUnitId,
      managedOrgUnitIds,
      tokenVersion: user.tokenVersion,
      permissions: mergePermissions(grants, levels),
    };

    await this.cache.set(authCtxKey(userId), JSON.stringify(ctx), AUTH_CTX_TTL_SECONDS).catch(() => undefined);
    return ctx;
  }

  private getOrRebuildSubtree(orgUnitId: number): Promise<number[]> {
    return this.subtreeFlights.run(orgUnitId, async () => {
      const ids = await this.repo.getOrgSubtreeIds(orgUnitId);
      await this.cache.set(subtreeKey(orgUnitId), JSON.stringify(ids), SUBTREE_TTL_SECONDS).catch(() => undefined);
      return ids;
    });
  }

  private async toDataScope(
    ctx: CachedAuthContext,
    granted: ScopeCode,
    levels: ScopeLevels,
    managedOnly: boolean,
  ): Promise<DataScope> {
    const kind = classifyScope(granted, levels);
    if (kind !== "org") return { kind };

    const roots = managedOnly
      ? ctx.managedOrgUnitIds
      : [...(ctx.orgUnitId !== null ? [ctx.orgUnitId] : []), ...ctx.managedOrgUnitIds];
    return { kind: "org", orgUnitIds: await this.resolveAllowedOrgUnitIds(roots) };
  }

  /** A Redis outage degrades to "rebuild from DB", it does not take the API down. */
  private async safeGet(key: string): Promise<string | null> {
    try {
      return await this.cache.get(key);
    } catch {
      return null;
    }
  }
}
