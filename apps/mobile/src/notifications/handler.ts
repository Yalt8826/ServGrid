/**
 * The T2.6 push handler (PLAN-FRONTEND.md §6): what a data-only FCM wake
 * DOES. It never renders the push — the message carries nothing to render
 * (`{"type":"sync"}`, §12.1) — it triggers ONE delta sync and then raises
 * LOCAL notifications from the rows that arrived. A push that carried the
 * job text would be stale the moment the office changed something; the
 * copy here is composed from the synced row, so it can only be as stale
 * as the mirror.
 *
 * **Every push is optional.** Any condition below that cannot be met — no
 * session, no mirror session registered (a headless revival before React
 * mounts), the sync failing offline — degrades to "nothing raised". The
 * rows still arrive on the next foreground sync; a missed push costs
 * latency, never work. That is why a wake for a job the delta did not
 * return raises NOTHING: no notification for content the client cannot
 * show.
 *
 * **Haptics and sound are deliberately absent.** The local notification is
 * the OS's job; the app does not buzz for a sync (UI/plan-2/02-MOTION.md
 * §8 — never on passive arrival of data).
 *
 * The sync itself is not owned here: the drain manager lives with the
 * session's mirror provider, which registers a `PushSyncExecutor` for the
 * lifetime of an employee session (and clears it on switch/logout). The
 * headless task, the foreground listener and any future wake surface all
 * funnel through `handlePushWake`, so there is exactly one composition to
 * be right.
 *
 * **The SDK is imported lazily** (the same seam `db/mirror.ts` uses for
 * expo-sqlite): this module sits in the mirror provider's import graph,
 * which must stay free of native modules — a wake raises through
 * `await import('expo-notifications')` at the moment it raises, never at
 * module load.
 */
import { useSessionStore } from '../state/sessionStore';

/** Marker in `content.data` for notifications this app raised itself —
 * the foreground gate and the wake-loop guard key on it (push/notifications.ts). */
export const PUSH_LOCAL_KIND = 'servgrid-local';

/** The Android 8+ channel per-row notifications post into. Created at
 * first launch by initPush — a channel created late is silently ignored
 * for the app's lifetime, which presents as "push works in dev, not in
 * the build" (§T2.6 "If it fails"). */
export const SYNC_NOTIFICATION_CHANNEL = 'servgrid-sync';

/** The job fields a notification can name — the mirror's row, read back
 * AFTER the sync, never the push payload. */
export interface PushJobRow {
  id: string;
  jobNumber: string;
  title: string;
  status: string;
  priority: string;
  scheduledFor: string | null;
  contactName: string | null;
  version: number;
}

/**
 * The seam the mirror session fills: run one sync cycle (bootstrap if the
 * mirror is fresh, outbox drain, delta — the same cycle every other
 * trigger runs), and read the mirror's job rows for the before/after
 * diff. The wake must not open its own mirror or drive its own drain —
 * two writers to one SQLite file and two single-flight loops is exactly
 * the parallel-write path §5 forbids.
 */
export interface PushSyncExecutor {
  sync(): Promise<void>;
  readJobs(): PushJobRow[];
}

let executor: PushSyncExecutor | null = null;

/** The live session's executor, or null between sessions. Registered by
 * the mirror provider on session open, cleared on switch/logout/unmount. */
export function setPushSyncExecutor(next: PushSyncExecutor | null): void {
  executor = next;
}

/** Whether the OS will present notifications. A refusal is a degraded
 * experience, not a broken one: the sync below still runs — only the
 * raising is skipped, and the tracking chip's amber fourth state is how
 * the technician finds out (§6). Checked WITHOUT prompting: a wake is
 * never the right moment to ask. */
async function notificationsPresentable(): Promise<boolean> {
  try {
    const Notifications = await import('expo-notifications');
    const settings = await Notifications.getPermissionsAsync();
    return settings.granted === true;
  } catch {
    return false; // unpresentable — but the sync still runs
  }
}

/** The copy, composed from the synced row. The push payload is not an
 * input to it — it could not be: the payload is `{"type":"sync"}`. */
export function jobNotificationContent(job: PushJobRow, isNew: boolean): {
  title: string;
  body: string;
} {
  return {
    title: isNew ? 'New job assigned' : 'Job updated',
    body: `${job.jobNumber} · ${job.title}`,
  };
}

async function raiseJobNotification(job: PushJobRow, isNew: boolean): Promise<void> {
  const Notifications = await import('expo-notifications');
  const { title, body } = jobNotificationContent(job, isNew);
  await Notifications.scheduleNotificationAsync({
    content: {
      title,
      body,
      data: { kind: PUSH_LOCAL_KIND, jobId: job.id },
    },
    // The channel rides the trigger: an immediate presentation (`null`
    // trigger) has nowhere to carry it, which is why the Phase 0 bare
    // confirmation could never name its channel.
    trigger: { channelId: SYNC_NOTIFICATION_CHANNEL },
  });
}

/** Rows the sync DELIVERED: ids the mirror did not hold before (an
 * assignment), or rows whose version moved (a reassign, a priority
 * escalation — the wakes §6 lists besides assign). A row the delta did
 * not return is not here, so it raises nothing. */
function arrivedRows(before: ReadonlyMap<string, number>, after: readonly PushJobRow[]): Array<{ job: PushJobRow; isNew: boolean }> {
  const arrivals: Array<{ job: PushJobRow; isNew: boolean }> = [];
  for (const job of after) {
    const previous = before.get(job.id);
    if (previous === undefined) {
      arrivals.push({ job, isNew: true });
    } else if (previous !== job.version) {
      arrivals.push({ job, isNew: false });
    }
  }
  return arrivals;
}

async function runWake(): Promise<boolean> {
  // A push to a logged-out handset must not fetch anything (its tokens
  // are revoked) and must not raise a notification — the §12.1 leak guard.
  if (useSessionStore.getState().status !== 'authenticated') return false;

  const session = executor;
  // No mirror session (headless revival before React mounts, the web
  // build): nothing can sync and nothing can be shown. The next
  // foreground recovers — every push is optional.
  if (session === null) return false;

  const presentable = await notificationsPresentable();

  // Snapshot BEFORE the sync: the diff is against what the client could
  // already show, so exactly the rows this wake pulled are announced.
  const before = new Map(session.readJobs().map((job) => [job.id, job.version]));

  // ONE sync per wake — the same cycle a foreground or reconnect trigger
  // runs. Offline it fails into backoff inside the drain and this wake
  // simply announced nothing.
  await session.sync();

  if (!presentable) return false; // synced, silently — the chip says why

  const arrivals = arrivedRows(before, session.readJobs());
  for (const { job, isNew } of arrivals) {
    await raiseJobNotification(job, isNew);
  }
  return arrivals.length > 0;
}

/** One wake at a time: two FCM messages landing together must not double-
 * announce the same rows. A wake arriving while one is in flight collapses
 * into it — the in-flight sync pulls the delta from the cursor, so the
 * second push's rows are already covered; anything the server committed
 * after that delta read is caught by the next wake or the next foreground. */
let inFlight: Promise<boolean> | null = null;

export function handlePushWake(): Promise<boolean> {
  if (inFlight !== null) return inFlight;
  inFlight = runWake().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/** Test helper: forget the registered session and any in-flight wake. */
export function __resetPushHandlerForTests(): void {
  executor = null;
  inFlight = null;
}
