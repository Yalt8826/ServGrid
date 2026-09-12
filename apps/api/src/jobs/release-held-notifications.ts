import { isWithinWorkWindow, istWallClock, parseHHMM, type WorkWindow } from '../lib/time.js';
import {
  createNotificationsService,
  type NotificationLog,
} from '../modules/notifications/service.js';

/**
 * The window-open release (PLAN-BACKEND.md §15 item 6, decision B1) —
 * the one piece of SCHEDULED work T2.5 owns, and the reason `src/jobs/`
 * exists ahead of §12's cron table. The §12.1 trigger itself is a
 * mutation, never a cron row; but B1's "held, don't drop" needs something
 * to fire the batch when the window opens, and §12's answer to scheduled
 * work is in-process timers in the single API instance. node-cron would
 * buy a parser for exactly one entry — `nextWindowOpen` computes the same
 * instant from the same WORK_WINDOW_START the ping window uses, and the
 * timer is unref'd so a shutdown is never held open by a push.
 *
 * IST has no DST, so "09:00 IST" is a fixed offset arithmetic problem:
 * shift the epoch, floor to the IST day, land on start-minutes, skip
 * Sundays (the window never opens on one), repeat.
 */

const IST_OFFSET_MINUTES = 330;
const DAY_MS = 86_400_000;

/** The first instant strictly after `now` at which the window opens (never a Sunday). */
export function nextWindowOpen(now: Date, window: WorkWindow): Date {
  const startMinutes = parseHHMM(window.start);
  const istMidnight = Math.floor((now.getTime() + IST_OFFSET_MINUTES * 60_000) / DAY_MS) * DAY_MS;
  for (let addDays = 0; addDays <= 8; addDays++) {
    const candidate = new Date(
      istMidnight + addDays * DAY_MS + startMinutes * 60_000 - IST_OFFSET_MINUTES * 60_000,
    );
    if (candidate.getTime() <= now.getTime()) continue;
    if (istWallClock(candidate).weekday === 0) continue;
    return candidate;
  }
  // Unreachable: eight consecutive days always contain a non-Sunday.
  throw new Error('release scheduler: no window-open found within 8 days');
}

export interface ReleaseSchedulerOptions {
  workWindow: WorkWindow;
  log?: NotificationLog;
}

export interface ReleaseScheduler {
  /** Clear the pending timer — the app's onClose hook calls this. */
  stop(): void;
}

export function startWindowOpenReleaseScheduler(options: ReleaseSchedulerOptions): ReleaseScheduler {
  const service = createNotificationsService(options);
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;

  const runBatch = async (): Promise<void> => {
    try {
      const summary = await service.releaseHeldAtWindowOpen();
      if (summary.rowsReleased > 0) {
        options.log?.warn(
          { ...summary },
          'window-open release: held assignment pushes discharged',
        );
      }
    } catch (error) {
      // Held ≠ dropped, but a failed batch is failed for today — logged,
      // never thrown into the timer chain; the next window-open reschedules.
      options.log?.error({ err: error }, 'window-open release batch failed');
    }
  };

  const scheduleNext = (): void => {
    if (stopped) return;
    const at = nextWindowOpen(new Date(), options.workWindow);
    // One second past the boundary: the batch runs INSIDE the open window.
    timer = setTimeout(
      () => {
        void runBatch().finally(scheduleNext);
      },
      at.getTime() - Date.now() + 1_000,
    );
    timer.unref();
  };

  // Boot sweep: a server restarted inside an open window missed the
  // morning batch — discharge what the gap held now, not tomorrow.
  if (isWithinWorkWindow(new Date(), options.workWindow)) {
    void runBatch();
  }
  scheduleNext();

  return {
    stop() {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}
