import { beforeEach, describe, expect, it } from "vitest";
import { AuthContextService, authCtxKey } from "../src/application/authContextService.js";
import type { UserRecord } from "../src/domain/authContext.js";
import { FakeAuthRepo, FakeCache } from "./fakes.js";

const DEV = 1;
const LEADER = 3; // inherits from DEV

const head: UserRecord = {
  userId: "u-head",
  roleId: LEADER,
  roleCode: "leader",
  orgUnitId: 2, // Engineering
  status: "active",
  lockedUntil: null,
  tokenVersion: 1,
};

let cache: FakeCache;
let repo: FakeAuthRepo;
let service: AuthContextService;

beforeEach(() => {
  cache = new FakeCache();
  repo = new FakeAuthRepo();
  repo.parentRole.set(DEV, null).set(LEADER, DEV);
  repo.grantsByRole.set(DEV, [
    { resource: "task", action: "view", scope: "own" },
    { resource: "payroll", action: "view", scope: "own" },
  ]);
  repo.grantsByRole.set(LEADER, [
    { resource: "task", action: "view", scope: "team" },
    { resource: "leave", action: "approve", scope: "team" },
  ]);
  repo.users.set(head.userId, { ...head });
  repo.leaders.set(head.userId, [4]); // also leads the Admin office (another branch)
  service = new AuthContextService(cache, repo);
});

describe("per-permission scope + org tree", () => {
  it("same user, different scope per permission", async () => {
    const ctx = await service.authenticate("u-head", 1);

    const tasks = await service.authorize(ctx, { permission: "task:view" });
    expect(tasks.kind).toBe("org");
    if (tasks.kind === "org") expect(tasks.orgUnitIds.sort((a, b) => a - b)).toEqual([2, 4, 5, 6]);

    expect(await service.authorize(ctx, { permission: "payroll:view" })).toEqual({ kind: "own" });
  });

  it("managedOnly ignores the unit the user merely belongs to", async () => {
    const ctx = await service.authenticate("u-head", 1);
    expect(await service.authorize(ctx, { permission: "leave:approve", managedOnly: true })).toEqual({
      kind: "org",
      orgUnitIds: [4],
    });
  });

  it("rejects missing permissions and insufficient scope", async () => {
    const ctx = await service.authenticate("u-head", 1);
    await expect(service.authorize(ctx, { permission: "task:delete" })).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    });
    await expect(service.authorize(ctx, { permission: "payroll:view", minScope: "team" })).rejects.toMatchObject({
      code: "SCOPE_DENIED",
    });
  });
});

describe("session revocation and safe rebuild", () => {
  it("rejects an old token even when the cache is warm (cache-hit path)", async () => {
    // password changed elsewhere: DB bumps the version, cache gets rebuilt with v2
    repo.users.get("u-head")!.tokenVersion = 2;
    await service.authenticate("u-head", 2);

    await expect(service.authenticate("u-head", 1)).rejects.toMatchObject({ code: "SESSION_REVOKED" });
  });

  it("never caches a locked account", async () => {
    repo.users.get("u-head")!.lockedUntil = Date.now() + 60_000;

    await expect(service.authenticate("u-head", 1)).rejects.toMatchObject({ code: "ACCOUNT_DISABLED" });
    expect(cache.store.has(authCtxKey("u-head"))).toBe(false);
  });

  it("keeps working from the database when the cache is down", async () => {
    cache.failing = true;
    const ctx = await service.authenticate("u-head", 1);
    expect(ctx.permissions["task:view"]).toBe("team");
  });
});

describe("stampede protection", () => {
  it("10 parallel requests on a cold cache hit the database once", async () => {
    await Promise.all(Array.from({ length: 10 }, () => service.authenticate("u-head", 1)));
    expect(repo.calls.findUser).toBe(1);
  });

  it("parallel subtree lookups for the same unit are collapsed", async () => {
    await Promise.all(Array.from({ length: 5 }, () => service.resolveAllowedOrgUnitIds([2])));
    // subtree of 2 = {2, 5, 6}: one recursive load, not five
    expect(repo.calls.subtree).toBe(3);
  });
});
