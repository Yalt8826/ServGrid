/**
 * The headless sync trigger — the half of §12.1 that makes a data-only
 * push correct rather than just timely. The message carries no job
 * content; this task IS the handler: it triggers a refetch of the sync
 * queries for the online-role surfaces mounted in react-query, hands the
 * technician's half to the T2.6 composition (`handlePushWake` — one delta
 * sync, then local notifications raised from the rows that arrived), and
 * must never throw (a rejected executor marks the task failed in the OS
 * and it will not be re-delivered).
 *
 * Registered as a headless Android task via `expo-task-manager`, so it
 * runs with the app backgrounded or killed — the exact condition the
 * push exists for. Registered for the foreground by the same executor
 * (`notifications.ts`), so one code path serves both.
 */
import { getQueryClient } from '../state/runtimeQueryClient';
import { useSessionStore } from '../state/sessionStore';
import { handlePushWake } from '../notifications/handler';
import { onLocationLivePush } from '../location/live-window';

/** The expo-task-manager task name this module owns. */
export const SYNC_ON_PUSH_TASK = 'servgrid-sync-on-push';

/**
 * Queries the push means "the server has new work". The online roles'
 * dashboards read through react-query; the offline role's mirror is
 * refreshed by the delta sync inside `handlePushWake` instead. Exported
 * so tests can assert against the same list.
 */
export const PUSH_INVALIDATED_QUERY_KEYS = [
  ['jobs', 'list'],
  ['notifications', 'count'],
] as const;

/**
 * One push delivery, foreground or background. `data` is the FCM data
 * message when the delivery surface could read it (foreground listener);
 * the headless task currently receives none and passes undefined. Returns
 * whether the wake produced something observable — a notification raised
 * from rows the sync actually received, the query invalidation for the
 * online surfaces, or (T4.4) a live locate-now window opened. Never the
 * payload: there is no payload content to show (§12.1), and a job the
 * delta did not return raises nothing.
 */
export async function handleDataOnlyPush(data?: Record<string, unknown>): Promise<boolean> {
  // A push to a logged-out handset must not fetch anything (its tokens
  // are revoked) and must not raise a notification — and must not flip
  // tracking into a live cadence for a session that no longer exists.
  if (useSessionStore.getState().status !== 'authenticated') return false;

  // T4.4: a `live` locate-now push is a tracking instruction, not a job
  // event — it raises the cadence to ~10s (the five-minute revert is
  // armed inside the live window) and needs no sync. The window is
  // configured on the native graph only; unconfigured (web, tests) this
  // answers false and the push falls through like any unknown payload.
  if (onLocationLivePush(data)) return true;

  let hasClient = false;
  try {
    const client = getQueryClient();
    for (const key of PUSH_INVALIDATED_QUERY_KEYS) {
      void client.invalidateQueries({ queryKey: [...key] });
    }
    hasClient = true;
  } catch {
    // No query client yet (push raced the cold start). The T2.6 sync
    // below does not depend on one — a missing client only means no
    // react-query surface needed refreshing.
  }

  // The technician's half (T2.6, PLAN-FRONTEND.md §6): one delta sync,
  // then LOCAL notifications composed from the rows that arrived. A
  // missing mirror session degrades to no notification inside the
  // handler — the next foreground sync recovers, every push is optional.
  const raised = await handlePushWake();

  return hasClient || raised;
}
