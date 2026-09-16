/**
 * The owner's four performance charts, as data (OW.3, 2026-09-16).
 *
 * Pure: no react-native, no chart library. The web charts render what
 * this shapes and the phone summary reads the same numbers, so "what the
 * chart says" has one definition.
 *
 * The owner's rules, from the decisions of 2026-09-16:
 *  - revenue means CASH COLLECTED, and the server sends it already summed
 *    per person per day — nothing here adds money up from parts;
 *  - with nobody selected the charts stack one segment per person, so the
 *    day's total and the split read at once;
 *  - choosing a person shows theirs alone.
 */
/** The ranges the endpoint accepts (`?range=`), and the switcher's order. */
export const PERFORMANCE_RANGES = ['week', '30d', '90d'] as const;
export type PerformanceRange = (typeof PERFORMANCE_RANGES)[number];

export const RANGE_LABELS: Record<PerformanceRange, string> = {
  week: 'This week',
  '30d': '30 days',
  '90d': '90 days',
};

export interface PerfPerson {
  id: string;
  name: string;
}

/** A server point, money or count, normalised to a number for drawing. */
export interface PerfPoint {
  date: string;
  employeeId: string;
  value: number;
}

/** What the money series looks like on the wire before normalising. */
export interface PerfMoneyPoint {
  date: string;
  employeeId: string;
  value: string;
}

export interface PerfCountPoint {
  date: string;
  employeeId: string;
  count: number;
}

export function moneyPoints(points: readonly PerfMoneyPoint[]): PerfPoint[] {
  return points.map((p) => ({ date: p.date, employeeId: p.employeeId, value: Number(p.value) }));
}

export function countPoints(points: readonly PerfCountPoint[]): PerfPoint[] {
  return points.map((p) => ({ date: p.date, employeeId: p.employeeId, value: p.count }));
}

/**
 * One row per day, carrying each person's value under their own id — the
 * shape a stacked bar chart consumes directly. `total` rides along so a
 * tooltip can show the day's whole without re-adding the segments.
 */
export interface StackRow {
  date: string;
  label: string;
  total: number;
  values: Record<string, number>;
}

/**
 * `Mon 14` inside a week — the weekday is what the owner reasons with
 * over seven days — and `14 Sep` over 30 or 90, where the weekday is
 * noise and the month is the fact. Parsed literally: a `YYYY-MM-DD` put
 * through `new Date()` renders in the browser's timezone, and that is how
 * an IST business day becomes yesterday.
 */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

export function dayLabel(iso: string, range: PerformanceRange): string {
  const [y = '1970', m = '01', d = '01'] = iso.split('-');
  const day = Number(d);
  const month = MONTHS[Number(m) - 1] ?? m;
  if (range !== 'week') return `${day} ${month}`;
  // Zeller-free: Date.UTC on the parts is timezone-proof, and only the
  // weekday name comes out of it.
  const weekday = WEEKDAYS[new Date(Date.UTC(Number(y), Number(m) - 1, day)).getUTCDay()] ?? '';
  return `${weekday} ${day}`;
}

/**
 * The chart's rows. `selectedId` null stacks everyone; a person's id
 * keeps only theirs — which is the "query one technician" the owner
 * asked for, and it deliberately keeps the same axis so the two readings
 * are comparable.
 */
export function stackRows(
  days: readonly string[],
  points: readonly PerfPoint[],
  people: readonly PerfPerson[],
  selectedId: string | null,
  range: PerformanceRange,
): StackRow[] {
  const ids = new Set(selectedId === null ? people.map((p) => p.id) : [selectedId]);
  const byDay = new Map<string, Record<string, number>>();
  for (const day of days) byDay.set(day, {});
  for (const point of points) {
    if (!ids.has(point.employeeId)) continue;
    const row = byDay.get(point.date);
    if (row === undefined) continue; // a point outside the range the server drew
    row[point.employeeId] = (row[point.employeeId] ?? 0) + point.value;
  }
  return days.map((day) => {
    const values = byDay.get(day) ?? {};
    const total = Object.values(values).reduce((sum, v) => sum + v, 0);
    return { date: day, label: dayLabel(day, range), total, values };
  });
}

/** The people a chart draws: everyone, or the one chosen. */
export function seriesPeople(people: readonly PerfPerson[], selectedId: string | null): PerfPerson[] {
  if (selectedId === null) return [...people];
  return people.filter((p) => p.id === selectedId);
}

/** The range's total for the heading — the one number a chart is an argument about. */
export function rangeTotal(rows: readonly StackRow[]): number {
  return rows.reduce((sum, row) => sum + row.total, 0);
}

/** True when nothing in the range has any value — an empty chart should say so, not draw an axis over nothing. */
export function isEmptySeries(rows: readonly StackRow[]): boolean {
  return rows.every((row) => row.total === 0);
}

/** The person filter's options, with the "everyone" row first. */
export function personOptions(people: readonly PerfPerson[], allLabel: string): { value: string; label: string }[] {
  return [{ value: '', label: allLabel }, ...people.map((p) => ({ value: p.id, label: p.name }))];
}
