/**
 * The headless sync trigger — the half of §12.1 that makes a data-only
 * push correct rather than just timely. The message carries no job
 * content; this task IS the handler: it triggers a refetch of the sync
 * queries (the full sync engine lands in a later phase — until then the
 * invalidated queries are whatever the running app has mounted, which
 * the probe test asserts), raises the local notification from the rows
 * just received, and must never throw (a rejected executor marks the
 * task failed in the OS and it will not be re-delivered).
 *
 * Registered as a headless Android task via `expo-task-manager`, so it
 * runs with the app backgrounded or killed — the exact condition the
 * push exists for. Registered for the foreground by the same executor
 * (`notifications.ts`), so one code path serves both.
 */
import { getQueryClient } from '../state/runtimeQueryClient';
import { useSessionStore } from '../state/sessionStore';

/** The expo-task-manager task name this module owns. */
export const SYNC_ON_PUSH_TASK = 'servgrid-sync-on-push';

/**
 * Queries the push means "the server has new work". Phase 0 has no sync
 * engine yet; the login/job queries are the closest real surface and the
 * same keys the sync engine will invalidate. Exported so tests can
 * assert against the same list.
 */
export const PUSH_INVALIDATED_QUERY_KEYS = [
  ['jobs', 'list'],
  ['notifications', 'count'],
] as const;

/**
 * One push delivery, foreground or background. Returns whether the
 * notification should be raised locally — the handler raises it from
 * rows it actually received, never from payload content (§12.1: a push
 * that carried the job would be stale the moment the office changed
 * something, and would leak job details to a logged-out handset).
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
    // No query client yet (push raced the cold start). Nothing to
    // refresh — the next foreground will sync anyway.
  }

  // The local notification is raised from the rows the sync just
  // received. Until the sync engine exists the sync is the query
  // invalidation itself, so the probe raises a bare confirmation —
  // enough to prove delivery, never carrying job content.
  return hasClient;
}
