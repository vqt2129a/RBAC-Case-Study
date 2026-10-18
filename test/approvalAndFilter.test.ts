import { describe, expect, it } from "vitest";
import { assertCanApprove } from "../src/domain/approval.js";
import { scopeToSql } from "../src/infrastructure/scopeFilter.js";

describe("assertCanApprove", () => {
  const base = { actorUserId: "lead", targetUserId: "dev", targetOrgUnitId: 5 };

  it("blocks self-approval regardless of scope", () => {
    expect(() =>
      assertCanApprove({ ...base, targetUserId: "lead", scope: { kind: "all" } }),
    ).toThrow("SELF_APPROVAL_DISALLOWED");
  });

  it("allows targets inside the org scope only", () => {
    expect(() => assertCanApprove({ ...base, scope: { kind: "org", orgUnitIds: [2, 5, 6] } })).not.toThrow();
    expect(() => assertCanApprove({ ...base, scope: { kind: "org", orgUnitIds: [3, 10] } })).toThrow("OUT_OF_SCOPE");
  });

  it("own scope can never approve someone else", () => {
    expect(() => assertCanApprove({ ...base, scope: { kind: "own" } })).toThrow("OUT_OF_SCOPE");
  });
});

describe("scopeToSql", () => {
  const cols = { owner: "t.assignee_id", orgUnit: "u.org_unit_id" };

  it("builds parameterised predicates", () => {
    expect(scopeToSql({ kind: "own" }, cols, "u1")).toEqual({ where: "t.assignee_id = ?", params: ["u1"] });
    expect(scopeToSql({ kind: "org", orgUnitIds: [2, 5] }, cols, "u1")).toEqual({
      where: "u.org_unit_id IN (?, ?)",
      params: [2, 5],
    });
    expect(scopeToSql({ kind: "all" }, cols, "u1").where).toBe("1 = 1");
  });

  it("an empty org list matches nothing instead of producing invalid SQL", () => {
    expect(scopeToSql({ kind: "org", orgUnitIds: [] }, cols, "u1").where).toBe("1 = 0");
  });
});
