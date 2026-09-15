/**
 * Contract types for the T0.11 shell. Deliberately local: `packages/shared`
 * owns the canonical error-code union and permission matrix (T0.5) and this
 * file collapses onto those imports then. Shapes follow PLAN-BACKEND.md §3.1
 * and §4 so the collapse is mechanical.
 */

/** Error codes the client switches on (PLAN-BACKEND.md §3.1). `UNKNOWN`
 * and `NETWORK` are client-side: the union in `packages/shared` covers
 * the server's codes and collapses onto it in T0.5. */
export type ErrorCode =
  | 'UNKNOWN'
  | 'NETWORK'
  | 'UNAUTHENTICATED'
  | 'TOKEN_REUSED'
  | 'FORBIDDEN'
  | 'OUT_OF_SCOPE'
  | 'NOT_FOUND'
  | 'VERSION_CONFLICT'
  | 'ILLEGAL_TRANSITION'
  | 'JOB_ALREADY_CLOSED'
  | 'DUPLICATE_ENTITY'
  | 'RECONCILIATION_CONFIRMED'
  | 'EMPLOYEE_HAS_OPEN_WORK'
  | 'IDEMPOTENCY_IN_FLIGHT'
  | 'IDEMPOTENCY_KEY_REUSED'
  | 'VALIDATION_FAILED'
  | 'RATE_LIMITED'
  | 'NETWORK';

/** The one error envelope shape (PLAN-BACKEND.md §3.1). */
export interface ErrorEnvelope {
  error: {
    code: ErrorCode;
    message: string;
    details?: unknown;
    requestId: string;
  };
}

/** Parse the envelope without assuming the response is one. */
export function parseErrorEnvelope(body: unknown): ErrorEnvelope['error'] | null {
  if (typeof body !== 'object' || body === null) return null;
  const candidate = body as { error?: unknown };
  if (typeof candidate.error !== 'object' || candidate.error === null) return null;
  const err = candidate.error as { code?: unknown; message?: unknown; details?: unknown; requestId?: unknown };
  if (typeof err.code !== 'string' || typeof err.message !== 'string') return null;
  return {
    code: err.code as ErrorCode,
    message: err.message,
    details: err.details,
    requestId: typeof err.requestId === 'string' ? err.requestId : '',
  };
}

/** Roles from PLAN.md §3. Every role works online (PLAN-FRONTEND.md §4). */
export type Role = 'technician' | 'dispatcher' | 'sales_rep' | 'owner';

/** The actor record `GET /v1/auth/me` returns. */
export interface StoredActor {
  id: string;
  role: Role;
  username: string;
}
