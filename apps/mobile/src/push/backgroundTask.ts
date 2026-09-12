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
 * One push delivery, foreground or background. Returns whether the wake
 * produced something observable — a notification raised from rows the
 * sync actually received, or (with no mirror session) the query
 * invalidation for the online surfaces. Never the payload: there is no
 * payload content to show (§12.1), and a job the delta did not return
 * raises nothing.
 */
export async function handleDataOnlyPush(): Promise<boolean> {
  // A push to a logged-out handset must not fetch anything (its tokens
  // are revoked) and must not raise a notification.
  if (useSessionStore.getState().status !== 'authenticated') return false;

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
