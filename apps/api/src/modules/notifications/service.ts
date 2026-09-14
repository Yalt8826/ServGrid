import { sendDataOnly } from '../../lib/fcm.js';
import { isWithinWorkWindow, type WorkWindow } from '../../lib/time.js';
import { getPool } from '../../db/pool.js';
import { isFlagOn } from '../flags/service.js';
import * as repo from './repo.js';

/**
 * Assignment notifications (PLAN-BACKEND.md §12.1) — the server half of
 * the wake. Not a cron row: the jobs service calls `assignmentChanged`
 * AFTER its mutation has committed, and this service does exactly three
 * things, none of which may ever fail the mutation:
 *
 * 1. GATE — `tech.notifications` per RECIPIENT. The flag exists so pushes
 *    can be switched off without touching dispatch; its failure mode ("a
 *    push spamming a technician at 22:00") belongs to the person receiving
 *    them. Off means off: nothing sent, nothing held.
 *
 * 2. HOLD OR SEND — work-window suppression per §15 item 6, closed as B1
 *    (docs/decisions/2026-09-12-phase-2-entry-decisions.md): out-of-window
 *    assignments are HELD server-side and released at window-open in a
 *    batch; `priority = 'urgent'` bypasses and pushes immediately;
 *    in-window pushes go out now. Held ≠ dropped. The window is the same
 *    IST WORK_WINDOW_START/END the ping ingest enforces — one work window,
 *    one promise to staff, evaluated on the server clock.
 *
 * 3. WAKE — a data-only FCM message per registered device. The payload is
 *    `{"type":"sync"}` and NOTHING else: no customer name, no address, no
 *    phone, no job title, not even the job id. It wakes the app, which
 *    runs a delta sync and raises a local notification from the rows it
 *    just received (T2.6 composes that copy). A push that carried the job
 *    would be stale the moment the office changed something, and would
 *    deliver job details to a handset that may since have been logged out.
 *
 * The system must remain correct with every push dropped: FCM being down,
 * unreachable, or unconfigured costs latency only. Failures are logged,
 * never thrown; UNREGISTERED / SENDER_ID_MISMATCH additionally clear the
 * stale `devices.fcm_token` and record `failure_reason` — §12.1: a device
 * that cannot be reached is itself a tracking-health finding.
 *
 * Sends are fire-and-forget but TRACKED: `drainNotificationSends()`
 * resolves when every in-flight send has settled, which is what the
 * integration suite awaits instead of sleeping.
 */

export type AssignmentTriggerKind = 'assigned' | 'reassigned' | 'cancelled' | 'priority_escalated';

export type AssignmentPriority = 'low' | 'normal' | 'high' | 'urgent';

/** One committed mutation that should wake handsets. No job content — ids only. */
export interface AssignmentPush {
  kind: AssignmentTriggerKind;
  jobId: string;
  priority: AssignmentPriority;
  /** The technicians whose handsets must wake — new assignee AND the loser of a reassign. */
  recipientIds: readonly string[];
}

/** The slice of pino this module needs, so tests can stay logger-less. */
export interface NotificationLog {
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

export interface NotificationsServiceDeps {
  /** From config: WORK_WINDOW_START/END (§13) — the same window the pings keep. */
  workWindow: WorkWindow;
  log?: NotificationLog;
}

/** The whole data-only payload. Content-free by contract (§12.1); asserted verbatim in tests. */
export const WAKE_DATA: Readonly<Record<string, string>> = Object.freeze({ type: 'sync' });

/**
 * FCM answers a token minted for another sender with SENDER_ID_MISMATCH —
 * permanent, and as unrecoverable as UNREGISTERED, so lib/fcm.ts's
 * `unregistered` flag alone is not the whole stale set (§12.1 names both).
 */
export const SENDER_ID_MISMATCH = /sender.?id.?mismatch/i;

/** Sends started but not yet settled — the drain hook's subject. Module-level so the
 * HTTP-triggered sends are observable from the integration suite without plumbing. */
const inFlight = new Set<Promise<unknown>>();

/**
 * Resolves when every fire-and-forget send has settled. Test and
 * shutdown plumbing — production code never needs to await the wake.
 */
export async function drainNotificationSends(): Promise<void> {
  // Re-snapshot until empty: a settling batch may have started another.
  while (inFlight.size > 0) {
    await Promise.allSettled([...inFlight]);
  }
}

function track(promise: Promise<void>): void {
  const tracked = promise.finally(() => inFlight.delete(tracked));
  inFlight.add(tracked);
}

export interface WakeOutcome {
  attempted: number;
  delivered: number;
  staleTokens: number;
}

export interface ReleaseSummary extends WakeOutcome {
  /** Held rows discharged by this batch. */
  rowsReleased: number;
  /** Distinct technicians the batch covered. */
  employees: number;
}

export function createNotificationsService(deps: NotificationsServiceDeps) {
  /**
   * One wake to every registered device of one technician. Resolves with
   * what happened; THROWS NOTHING — every failure mode below is priced in
   * by §12.1 ("correct with every push dropped") and only sharpens the
   * log line or the device's tracking-health record.
   */
  async function wakeEmployee(employeeId: string, reason: string): Promise<WakeOutcome> {
    const pool = getPool();
    const devices = await repo.listPushableDevices(pool, employeeId);
    const outcome: WakeOutcome = { attempted: 0, delivered: 0, staleTokens: 0 };

    for (const device of devices) {
      outcome.attempted += 1;
      try {
        const result = await sendDataOnly({ token: device.fcm_token, data: { ...WAKE_DATA } });
        if (result.ok) {
          outcome.delivered += 1;
          // The token demonstrably works; a recorded failure is stale history.
          await repo.clearFailureReason(pool, device.id);
          continue;
        }
        const stale = result.unregistered || SENDER_ID_MISMATCH.test(result.error ?? '');
        if (stale) {
          // §12.1: clear the stale token, name the failure on the device row.
          await repo.recordStaleToken(pool, device.id, result.error ?? `HTTP ${result.httpStatus ?? '?'}`);
          outcome.staleTokens += 1;
        }
        deps.log?.warn(
          { employeeId, deviceId: device.id, error: result.error, stale },
          `assignment push failed: ${reason}`,
        );
      } catch (error) {
        // Unconfigured FCM is a boot bug surfaced at boot, not here; a thrown
        // send is a dropped push — logged, never propagated (§12.1).
        deps.log?.error(
          { employeeId, deviceId: device.id, err: error },
          `assignment push threw: ${reason}`,
        );
      }
    }
    return outcome;
  }

  /**
   * The send path the jobs mutations call after commit. Fire-and-forget:
   * the dispatcher's assign must never wait on — nor fail with — a push
   * nobody can guarantee (§12.1: push is a latency improvement, never the
   * transport).
   */
  function assignmentChanged(push: AssignmentPush): void {
    track(
      (async (): Promise<void> => {
        const nowMs = Date.now();
        const now = new Date(nowMs);
        const inWindow = isWithinWorkWindow(now, deps.workWindow);
        // 'urgent' is the ONLY priority that overrides the window (§15
        // item 6) — which is why the dispatch form shows four explicit
        // segments rather than a dropdown.
        const bypass = push.priority === 'urgent';

        // Dedupe: a bulk reassign can name the same losing technician for
        // several jobs — the hold is per event, the wake collapses at release.
        const recipients = [...new Set(push.recipientIds)].filter((id) => id.length > 0);

        for (const employeeId of recipients) {
          try {
            // Off means off: nothing sent, nothing held (the flag is the
            // kill switch the owner reaches for "in a hurry").
            if (!(await isFlagOn(employeeId, 'tech.notifications'))) continue;

            if (bypass || inWindow) {
              await wakeEmployee(employeeId, `${push.kind} (${push.priority})`);
            } else {
              await repo.insertHeldNotification(getPool(), {
                employeeId,
                jobId: push.jobId,
                kind: push.kind,
                priority: push.priority,
              });
            }
          } catch (error) {
            deps.log?.error({ employeeId, jobId: push.jobId, err: error }, 'assignment notification failed');
          }
        }
      })(),
    );
  }

  /**
   * The window-open batch (decision B1): release everything still held,
   * one collapsed wake per technician — five held assignments are one
   * sync, not five buzzes; the delta sync delivers all five rows and T2.6
   * composes the summary copy. Rows are marked released BEFORE the wakes
   * go out: a crash mid-batch loses a wake (§12.1 prices that in) but can
   * never re-release the same rows into a second batch.
   *
   * Called by the scheduler in `src/jobs/release-held-notifications.ts`
   * at every window-open (with a boot-time sweep for a restart inside the
   * window), and directly by the integration suite with a fixed clock.
   */
  async function releaseHeldAtWindowOpen(nowMs: number = Date.now()): Promise<ReleaseSummary> {
    const pool = getPool();
    const held = await repo.listUnreleased(pool);
    const rowsReleased = await repo.markAllReleased(pool, new Date(nowMs));
    const summary: ReleaseSummary = { rowsReleased, employees: 0, attempted: 0, delivered: 0, staleTokens: 0 };

    const byEmployee = [...new Set(held.map((row) => row.employee_id))];
    summary.employees = byEmployee.length;
    for (const employeeId of byEmployee) {
      try {
        // The flag is checked again at release: turned off overnight means
        // the morning batch stays silent too.
        if (!(await isFlagOn(employeeId, 'tech.notifications'))) continue;
        const outcome = await wakeEmployee(employeeId, 'window-open release');
        summary.attempted += outcome.attempted;
        summary.delivered += outcome.delivered;
        summary.staleTokens += outcome.staleTokens;
      } catch (error) {
        deps.log?.error({ employeeId, err: error }, 'window-open release failed for employee');
      }
    }
    return summary;
  }

  return { assignmentChanged, releaseHeldAtWindowOpen };
}

export type NotificationsService = ReturnType<typeof createNotificationsService>;
