/**
 * The declarations history, grouped for reading (2026-09-18, Yashas: "the
 * sales rep can have a history of cash declarations" — grouped "by month,
 * with the month's total").
 *
 * Pure and React-free, the same shape `rep/model.ts` gives the sales list:
 * the screen renders what these return, so a test can assert a month
 * before a pixel exists.
 */
import type { CashHandover } from '@servgrid/shared';
import { sumMoney } from '../rep/money';
import { shiftBusinessDate } from './handoverModel';

/**
 * The months, spelled out here rather than through `Intl` — the app's own
 * list, like `rep/model.ts`'s `MONTHS` and for the same reason: ICU
 * renders September as "Sept", and a money record that reads "Sept 2026"
 * next to "18 Sep" looks like two different applications.
 */
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

/** One month of declarations, newest day first, with what he declared in it. */
export interface CashMonthSection {
  /** `YYYY-MM` — the section's key. */
  month: string;
  /** `September 2026`. */
  label: string;
  /** Everything declared in the month, as money. The figure he reconciles against. */
  total: string;
  rows: CashHandover[];
}

/** `2026-09-18` → `2026-09`. */
export function monthOf(businessDate: string): string {
  return businessDate.slice(0, 7);
}

/** `2026-09` → `September 2026`. */
export function monthLabelFor(month: string): string {
  const [year = '', index = ''] = month.split('-');
  const name = MONTHS[Number(index) - 1];
  return name === undefined ? month : `${name} ${year}`;
}

/**
 * The rows inside the caller's window. `days` is undefined for the rep —
 * he reads the whole record — and `HANDOVER_WINDOW_DAYS` for the
 * technician, whose history is the week he can still declare for
 * (2026-09-18, Yashas: "the sales rep gets the full history whereas the
 * technician gets only the last 7 days history").
 *
 * The server applies the same rule; this is the belt to that braces. It
 * exists so the tab can never *claim* a span it is not showing — the
 * caption and the contents come from one expression.
 */
export function withinHistoryWindow(
  rows: readonly CashHandover[],
  todayIso: string,
  days?: number,
): CashHandover[] {
  if (days === undefined) return [...rows];
  const floor = shiftBusinessDate(todayIso, -days);
  return rows.filter((row) => row.businessDate >= floor && row.businessDate <= todayIso);
}

/**
 * The history as month sections, newest month first, each with the sum of
 * what he declared in it. Days sort newest first inside a section, and a
 * window that straddles a month boundary produces two sections — which is
 * correct, not a rounding artefact.
 */
export function cashMonthSections(
  rows: readonly CashHandover[],
  todayIso: string,
  days?: number,
): CashMonthSection[] {
  const kept = withinHistoryWindow(rows, todayIso, days);
  const byMonth = new Map<string, CashHandover[]>();
  for (const row of kept) {
    const key = monthOf(row.businessDate);
    const bucket = byMonth.get(key);
    if (bucket === undefined) byMonth.set(key, [row]);
    else bucket.push(row);
  }
  return [...byMonth.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .map(([month, list]) => {
      const sorted = [...list].sort((a, b) => (a.businessDate < b.businessDate ? 1 : -1));
      return {
        month,
        label: monthLabelFor(month),
        total: sumMoney(sorted.map((row) => row.declaredAmount)),
        rows: sorted,
      };
    });
}
