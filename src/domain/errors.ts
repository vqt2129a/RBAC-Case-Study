/** Errors carry a stable code; clients map codes to messages. */
export type AuthErrorCode =
  | "UNAUTHORIZED"
  | "ACCOUNT_NOT_FOUND"
  | "ACCOUNT_DISABLED"
  | "SESSION_REVOKED"
  | "PERMISSION_DENIED"
  | "SCOPE_DENIED"
  | "OUT_OF_SCOPE"
  | "SELF_APPROVAL_DISALLOWED";

export class AuthError extends Error {
  constructor(
    public readonly code: AuthErrorCode,
    public readonly status: 401 | 403,
  ) {
    super(code);
  }
}
