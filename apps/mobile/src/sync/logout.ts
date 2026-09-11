/**
 * The logout gate (T1.14, PLAN-FRONTEND.md §5).
 *
 * **Logout is a gate, not a negotiation.** Blocked while any of this
 * employee's rows is `queued` or `inflight`; the count IS the message
 * ("3 items not yet synced") and the only offer is *Retry now* (the
 * profile's `retrySync` → `DrainManager.drainNow()`). There is no
 * confirm-and-lose path — this module deliberately exports no function
 * that can wipe queued work, so a confirm-and-lose flow cannot be
 * accidentally built on top of it later.
 *
 * If only `rejected` or `failed` rows remain, logout proceeds and those
 * rows are KEPT, keyed to their `employee_id`: the mirror is cleared on
 * user switch (T1.13's `clearMirror`), the outbox is not — a preserved
 * rejection reappears for the right person on his next login and never
 * leaks into the next user's session. `rowsForEmployee` is the scope.
 */
import type { MirrorDatabase } from '../db/mirror';
import { pendingSyncCount } from './outbox';

export interface LogoutDecision {
  /** False exactly when `pendingCount > 0`. */
  allowed: boolean;
  /** `queued` + `inflight` rows for this employee. */
  pendingCount: number;
  /** The gate's message verbatim; null when logout may proceed. */
  message: string | null;
}

/** The blocked message, verbatim from §5 ("3 items not yet synced") — the
 * same string the profile screen's gate banner and disabled button carry. */
export function logoutBlockedMessage(pendingCount: number): string {
  return `${pendingCount} items not yet synced`;
}

/**
 * The whole gate. Pure read — it mutates nothing, so calling it to decide
 * whether to render a blocked banner can never itself destroy work.
 */
export function evaluateLogout(database: MirrorDatabase, employeeId: string): LogoutDecision {
  const pendingCount = pendingSyncCount(database, employeeId);
  if (pendingCount > 0) {
    return { allowed: false, pendingCount, message: logoutBlockedMessage(pendingCount) };
  }
  return { allowed: true, pendingCount: 0, message: null };
}
