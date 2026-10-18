import type { DataScope } from "./authContext.js";
import { AuthError } from "./errors.js";

/**
 * Shared rule for approval flows (leave, overtime, attendance corrections...):
 *  1. Segregation of duties — nobody approves their own request.
 *  2. The target must fall inside the approver's data scope.
 */
export function assertCanApprove(params: {
  actorUserId: string;
  targetUserId: string;
  targetOrgUnitId: number | null;
  scope: DataScope;
}): void {
  const { actorUserId, targetUserId, targetOrgUnitId, scope } = params;

  if (actorUserId === targetUserId) {
    throw new AuthError("SELF_APPROVAL_DISALLOWED", 403);
  }

  switch (scope.kind) {
    case "all":
      return;
    case "org":
      if (targetOrgUnitId !== null && scope.orgUnitIds.includes(targetOrgUnitId)) return;
      throw new AuthError("OUT_OF_SCOPE", 403);
    case "own":
      // "own" can never approve someone else.
      throw new AuthError("OUT_OF_SCOPE", 403);
  }
}
