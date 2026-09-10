/**
 * Error envelope contracts (PLAN-BACKEND.md §3.1).
 *
 * `ErrorCode` is an exhaustive union so the client can switch on it;
 * `ERROR_HTTP_STATUS` is typed `Record<ErrorCode, number>` so the compiler
 * refuses a code added to the union without an HTTP mapping.
 *
 * `PingRejectCode` is deliberately a *separate, smaller* union: per-ping
 * outcomes are not error codes and never appear in an error envelope,
 * because a rejected ping is a normal outcome of a batch that succeeded
 * (§8). Keeping them in a different type is what stops a client treating
 * an out-of-window ping as a request failure and retrying forever.
 */

export type ErrorCode =
  | 'UNAUTHENTICATED' // 401 — missing/expired access token
  | 'TOKEN_REUSED' // 401 — revoked refresh token replayed; whole chain revoked
  | 'FORBIDDEN' // 403 — role lacks the permission
  | 'OUT_OF_SCOPE' // 403 — role has the permission but not for this row
  | 'NOT_FOUND' // 404
  | 'VERSION_CONFLICT' // 409 — If-Match version stale
  | 'ILLEGAL_TRANSITION' // 409 — status machine refused
  | 'JOB_ALREADY_CLOSED' // 409 — completed/cancelled while client was offline
  | 'DUPLICATE_ENTITY' // 409 — unique violation on an offline create
  | 'RECONCILIATION_CONFIRMED' // 409 — completion amendment refused; day signed off
  | 'EMPLOYEE_HAS_OPEN_WORK' // 409 — deactivation refused
  | 'IDEMPOTENCY_IN_FLIGHT' // 409 — same key still processing
  | 'PAYLOAD_TOO_LARGE' // 413 — upload past the attachment size cap; no retry without shrinking can succeed
  | 'IDEMPOTENCY_KEY_REUSED' // 422 — same key, different body
  | 'VALIDATION_FAILED' // 422 — zod issues in details.issues
  | 'RATE_LIMITED' // 429
  | 'INTERNAL'; // 500 — unhandled server fault; safe to retry later, nothing to fix client-side

export const ERROR_CODES = [
  'UNAUTHENTICATED',
  'TOKEN_REUSED',
  'FORBIDDEN',
  'OUT_OF_SCOPE',
  'NOT_FOUND',
  'VERSION_CONFLICT',
  'ILLEGAL_TRANSITION',
  'JOB_ALREADY_CLOSED',
  'DUPLICATE_ENTITY',
  'RECONCILIATION_CONFIRMED',
  'EMPLOYEE_HAS_OPEN_WORK',
  'IDEMPOTENCY_IN_FLIGHT',
  'PAYLOAD_TOO_LARGE',
  'IDEMPOTENCY_KEY_REUSED',
  'VALIDATION_FAILED',
  'RATE_LIMITED',
  'INTERNAL',
] as const satisfies readonly ErrorCode[];

/** Exhaustive by type: adding an ErrorCode without an HTTP status fails to compile. */
export const ERROR_HTTP_STATUS: Readonly<Record<ErrorCode, number>> = {
  UNAUTHENTICATED: 401,
  TOKEN_REUSED: 401,
  FORBIDDEN: 403,
  OUT_OF_SCOPE: 403,
  NOT_FOUND: 404,
  VERSION_CONFLICT: 409,
  ILLEGAL_TRANSITION: 409,
  JOB_ALREADY_CLOSED: 409,
  DUPLICATE_ENTITY: 409,
  RECONCILIATION_CONFIRMED: 409,
  EMPLOYEE_HAS_OPEN_WORK: 409,
  IDEMPOTENCY_IN_FLIGHT: 409,
  PAYLOAD_TOO_LARGE: 413,
  IDEMPOTENCY_KEY_REUSED: 422,
  VALIDATION_FAILED: 422,
  RATE_LIMITED: 429,
  INTERNAL: 500,
};

/**
 * Per-ping outcomes (§8) — a different union on purpose; see the header.
 * `DUPLICATE` here is a normal batch outcome (the ping already landed),
 * not the HTTP `DUPLICATE_ENTITY` conflict.
 */
export type PingRejectCode = 'OUT_OF_WINDOW' | 'TOO_OLD' | 'FUTURE' | 'DUPLICATE';

export const PING_REJECT_CODES = [
  'OUT_OF_WINDOW',
  'TOO_OLD',
  'FUTURE',
  'DUPLICATE',
] as const satisfies readonly PingRejectCode[];

/** The one envelope shape, always (§3.1). */
export interface ErrorEnvelope {
  error: {
    /** Written for the technician holding the phone — the offline conflict banner shows it verbatim. */
    code: ErrorCode;
    message: string;
    details?: unknown;
    requestId: string;
  };
}

/** `POST /v1/location/pings` response — HTTP 200 even when every ping is rejected. */
export interface PingBatchResult {
  accepted: number;
  rejected: ReadonlyArray<{ index: number; code: PingRejectCode }>;
}
