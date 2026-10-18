import { describe, expect, it } from "vitest";
import {
  checkPermission,
  classifyScope,
  DEFAULT_SCOPE_LEVELS,
  isScopeAtLeast,
  mergePermissions,
} from "../src/domain/permission.js";

describe("mergePermissions", () => {
  it("keeps the widest scope when a permission is inherited several times", () => {
    const merged = mergePermissions([
      { resource: "task", action: "view", scope: "own" }, // from dev
      { resource: "task", action: "view", scope: "team" }, // from leader
      { resource: "payroll", action: "view", scope: "own" },
    ]);
    expect(merged).toEqual({ "task:view": "team", "payroll:view": "own" });
  });

  it("does not depend on the order of grants", () => {
    const merged = mergePermissions([
      { resource: "task", action: "view", scope: "all" },
      { resource: "task", action: "view", scope: "own" },
    ]);
    expect(merged["task:view"]).toBe("all");
  });
});

describe("checkPermission", () => {
  it("returns the granted scope or null", () => {
    const perms = { "task:view": "team" };
    expect(checkPermission(perms, "task:view")).toBe("team");
    expect(checkPermission(perms, "task:delete")).toBeNull();
    expect(checkPermission(undefined, "task:view")).toBeNull();
  });

  it("treats '*' as super admin with the highest scope", () => {
    expect(checkPermission({ "*": "all" }, "anything:here")).toBe("all");
  });
});

describe("scope levels are data, not code", () => {
  const levels = { ...DEFAULT_SCOPE_LEVELS, department: 3 };

  it("classifies by level: lowest = own, highest = all, otherwise org-tree", () => {
    expect(classifyScope("own", levels)).toBe("own");
    expect(classifyScope("team", levels)).toBe("org");
    expect(classifyScope("department", levels)).toBe("org"); // new scope, no code change
    expect(classifyScope("all", levels)).toBe("all");
  });

  it("compares scopes by level", () => {
    expect(isScopeAtLeast("department", "team", levels)).toBe(true);
    expect(isScopeAtLeast("own", "team", levels)).toBe(false);
  });
});
