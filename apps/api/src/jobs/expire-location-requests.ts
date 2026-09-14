import { getPool } from '../db/pool.js';
import { expireLocationRequests } from '../modules/location/repo.js';

/**
 * `expire-location-requests` (PLAN-BACKEND.md §12: every minute) — the
 * sweep that closes every locate-now request past its `expires_at` with
 * `failure_reason = 'unanswered'`.
 *
 * The console's honesty does not WAIT on this timer — `GET /v1/location/
 * requests/:id` derives `expired` from the row per read, so the UI stops
 * spinning the moment the window closes. What the sweep owns is the
 * durable record: without it, an unanswered request sits open forever in
 * history, indistinguishable from one the API died mid-flight. §12's
 * answer to scheduled work is in-process timers in the single API
 * instance (the same shape `release-held-notifications.ts` runs), with a
 * boot sweep so a request that expired while the API was down is closed
 * on the first tick after start, not a full minute later.
 */

/** §12's cadence for this job. */
export const EXPIRY_SWEEP_INTERVAL_MS = 60_000;

/** The slice of pino this job needs, so tests can stay logger-less. */
export interface ExpiryLog {
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

export interface ExpiryScheduler {
  /** Clear the timer — the app's onClose hook calls this. */
  stop(): void;
}

export function startLocationRequestExpiryScheduler(options: { log?: ExpiryLog } = {}): ExpiryScheduler {
  let stopped = false;

  const runSweep = async (): Promise<void> => {
    try {
      const closed = await expireLocationRequests(getPool(), Date.now());
      if (closed.length > 0) {
        options.log?.warn({ requestIds: closed }, 'locate-now sweep: unanswered requests expired');
      }
    } catch (error) {
      // A failed sweep is failed for this tick — logged, never thrown
      // into the timer chain; the reads stay honest meanwhile and the
      // next tick retries the durable write.
      options.log?.error({ err: error }, 'locate-now sweep failed');
    }
  };

  const timer = setInterval(() => {
    if (!stopped) void runSweep();
  }, EXPIRY_SWEEP_INTERVAL_MS);
  timer.unref();

  void runSweep();

  return {
    stop(): void {
      stopped = true;
      clearInterval(timer);
    },
  };
}
