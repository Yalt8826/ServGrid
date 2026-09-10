/**
 * Time helpers (PLAN-BACKEND.md §2 lib/time.ts): the IST work-window
 * predicate. Business dates themselves are the database's
 * `business_date()` (migration 001); what Node needs is the work-window
 * test for ping ingest — and it lives on the server, not the device,
 * because "a rule governing staff should not trust the device clock"
 * (PLAN.md §7): the window is evaluated against the recorded instant's
 * Asia/Kolkata wall clock, so a handset in any timezone or with any
 * clock offset is judged by the same yardstick the office keeps.
 */

const IST_TIME_ZONE = 'Asia/Kolkata';

const wallClockFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: IST_TIME_ZONE,
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
  // `hour12: false` alone can still yield '24' for midnight on some runtimes;
  // h23 pins the 0-23 hour the arithmetic below assumes.
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

export interface WallClock {
  /** 0 = Sunday … 6 = Saturday, as the instant falls in the IST calendar. */
  weekday: number;
  /** Minutes since IST midnight. */
  minutes: number;
}

/** The Asia/Kolkata wall clock an instant falls on. */
export function istWallClock(instant: Date): WallClock {
  const parts = wallClockFormatter.formatToParts(instant);
  const read = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? '';
  const weekday = WEEKDAY_INDEX[read('weekday')];
  if (weekday === undefined) {
    // Unreachable on a runtime with a working ICU — the formatter names
    // every part it was asked for. Fail loudly rather than guess a window.
    throw new Error(`time: unrecognised weekday part '${read('weekday')}'`);
  }
  return {
    weekday,
    minutes: Number(read('hour')) * 60 + Number(read('minute')),
  };
}

/** '09:00' → 540. Config validation (config.ts) has already shape-checked it. */
export function parseHHMM(value: string): number {
  const [h, m] = value.split(':');
  return Number(h) * 60 + Number(m);
}

export interface WorkWindow {
  /** Inclusive 'HH:MM' lower bound, IST. */
  start: string;
  /** Exclusive 'HH:MM' upper bound, IST. */
  end: string;
}

/**
 * The work window, Monday–Saturday (§7, §8): true when the instant's IST
 * wall clock falls inside `[start, end)`. Start is inclusive (09:00:00 is
 * the first in-window minute); end is exclusive (the window closes at
 * 19:00:00) — the same half-open convention the device filter uses, so
 * server and handset cannot disagree about a ping taken on the boundary.
 * Sunday is out of the window at every hour.
 */
export function isWithinWorkWindow(instant: Date, window: WorkWindow): boolean {
  const clock = istWallClock(instant);
  if (clock.weekday === 0) return false;
  return clock.minutes >= parseHHMM(window.start) && clock.minutes < parseHHMM(window.end);
}
