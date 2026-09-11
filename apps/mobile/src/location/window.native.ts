/**
 * The device-side work-window filter (PLAN-FRONTEND.md §6, PLAN.md §7):
 * 09:00–19:00 IST, Monday–Saturday, applied BEFORE a ping is buffered.
 *
 * Filter, don't schedule — the background task stays alive at every hour
 * and out-of-window fixes are simply discarded here, so the OS keeps its
 * batching and the battery keeps its charge. The server re-checks every
 * ping independently (`POST /v1/location/pings`), because a rule governing
 * staff should not trust the device clock; this client filter exists to
 * save battery, not to be the authority.
 *
 * The convention mirrors the API's `isWithinWorkWindow` exactly — start
 * inclusive, end EXCLUSIVE — so a ping taken on the boundary cannot be
 * judged differently by the handset and the server (the server would
 * answer `OUT_OF_WINDOW` and the buffer would prune it on ack anyway,
 * but the two sides agreeing is the point).
 *
 * `.native.ts` by rule (PLAN-FRONTEND.md §6: `location/` is `.native.ts`
 * only) — pure date math, but nothing outside the native location graph
 * imports it. Tests load it by its explicit suffix.
 */

const IST_TIME_ZONE = 'Asia/Kolkata';

const wallClockFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: IST_TIME_ZONE,
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
  // `hour12: false` alone can still yield '24' for midnight on some
  // runtimes; h23 pins the 0-23 hour the arithmetic below assumes.
  hourCycle: 'h23',
});

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

export interface WorkWindow {
  /** Inclusive 'HH:MM' lower bound, IST. */
  start: string;
  /** Exclusive 'HH:MM' upper bound, IST. */
  end: string;
}

/** The work window the consent copy states and the server enforces. */
export const WORK_WINDOW: WorkWindow = { start: '09:00', end: '19:00' };

/** '09:00' → 540. */
function parseHHMM(value: string): number {
  const [h, m] = value.split(':');
  return Number(h) * 60 + Number(m);
}

export interface WallClock {
  /** 0 = Sunday … 6 = Saturday, as the instant falls in the IST calendar. */
  weekday: number;
  /** Minutes since IST midnight. */
  minutes: number;
}

/** The Asia/Kolkata wall clock an instant falls on. IST has no DST, but
 * the wall clock is still read through the timezone database rather than
 * a fixed +05:30 offset, so the predicate cannot drift from the calendar
 * everyone else in the company uses. */
export function istWallClock(instant: Date): WallClock {
  const parts = wallClockFormatter.formatToParts(instant);
  const read = (type: string): string => parts.find((part) => part.type === type)?.value ?? '';
  const weekday = WEEKDAY_INDEX[read('weekday')];
  if (weekday === undefined) {
    // Unreachable on a runtime with a working ICU — the formatter names
    // every part it was asked for. Fail loudly rather than guess a window.
    throw new Error(`window: unrecognised weekday part '${read('weekday')}'`);
  }
  return { weekday, minutes: Number(read('hour')) * 60 + Number(read('minute')) };
}

/**
 * True when the instant's IST wall clock falls inside `[start, end)` on a
 * weekday that is not Sunday. 09:00:00 is the first in-window minute; the
 * window closes at 19:00:00 — the same half-open interval the server's
 * ingest applies to every ping.
 */
export function inWorkWindow(instant: Date, window: WorkWindow = WORK_WINDOW): boolean {
  const clock = istWallClock(instant);
  if (clock.weekday === 0) return false;
  return clock.minutes >= parseHHMM(window.start) && clock.minutes < parseHHMM(window.end);
}
