import type { DataScope } from "../domain/authContext.js";

export interface SqlFragment {
  where: string;
  params: unknown[];
}

/**
 * Translate a resolved DataScope into a SQL predicate.
 *
 * Each repository says *which column* represents ownership and org unit for
 * its own table — many tables have no `org_unit_id` and reach it through a JOIN
 * (e.g. tasks -> assignee -> users.org_unit_id). Values always go through `?`.
 */
export function scopeToSql(
  scope: DataScope,
  columns: { owner: string; orgUnit: string },
  actorUserId: string,
): SqlFragment {
  switch (scope.kind) {
    case "all":
      return { where: "1 = 1", params: [] };
    case "own":
      return { where: `${columns.owner} = ?`, params: [actorUserId] };
    case "org":
      if (scope.orgUnitIds.length === 0) return { where: "1 = 0", params: [] };
      return {
        where: `${columns.orgUnit} IN (${scope.orgUnitIds.map(() => "?").join(", ")})`,
        params: scope.orgUnitIds,
      };
  }
}

/* Example — listing tasks, whose org unit comes from the assignee:

  const filter = scopeToSql(scope, { owner: "t.assignee_id", orgUnit: "u.org_unit_id" }, ctx.userId);
  const sql = `
    SELECT t.* FROM tasks t
    JOIN users u ON u.user_id = t.assignee_id
    WHERE ${filter.where}`;
  await db.query(sql, filter.params);
*/
