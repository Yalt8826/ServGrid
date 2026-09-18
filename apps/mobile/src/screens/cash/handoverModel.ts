/**
 * The cash handover's pure half (UI/plan-2/04-TECHNICIAN.md §T6) — dates,
 * the status vocabulary, and the copy that goes with them. Moved here on
 * 2026-09-18 when the declarations history came back (Yashas: "the sales
 * rep can have a history of cash declarations"): the surface is shared by
 * the technician and the rep and now has more than one screen under it,
 * so the rules left the screen file rather than being imported from one
 * screen by another.
 *
 * Nothing here touches React or the API. All dates are IST business dates
 * (`business_date()`, migration 001); `today` is computed once by the
 * route and passed in, which is what keeps this file testable.
 */
import type { CashHandover, ReconciliationStatus } from '@servgrid/shared';
import { formatMoneyEnIN, SEMANTIC } from '@servgrid/shared';
import { formatDateEnIN } from '../../components/ui';
import { sumMoney } from '../rep/money';

/** The declaration window: today back 7 days, inclusive (§T6). */
export const HANDOVER_WINDOW_DAYS = 7;

/** Today's IST business date — the same day the server's
 * `business_date()` stamps. `en-CA` formats as `YYYY-MM-DD`. */
export function istBusinessDate(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(now);
}

/** Calendar shift on plain ISO dates — no timezone hides in `YYYY-MM-DD`. */
export function shiftBusinessDate(iso: string, days: number): string {
  const [y = 1970, m = 1, d = 1] = iso.split('-').map(Number);
  const shifted = new Date(Date.UTC(y, m - 1, d));
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}

/** The picker refuses anything outside today → today − 7 (and the future). */
export function isWithinHandoverWindow(candidate: string, today: string): boolean {
  return candidate <= today && candidate >= shiftBusinessDate(today, -HANDOVER_WINDOW_DAYS);
}

/** The days the picker offers, today first. */
export function handoverWindow(today: string): string[] {
  const days: string[] = [];
  for (let back = 0; back <= HANDOVER_WINDOW_DAYS; back += 1) days.push(shiftBusinessDate(today, -back));
  return days;
}

/** The server's `reconciliation_status`, as the pill reads (§T6). */
export const STATUS_PILL: Record<ReconciliationStatus, { label: string; color: string }> = {
  submitted: { label: 'Submitted', color: SEMANTIC.feedback.warning },
  confirmed: { label: 'Confirmed', color: SEMANTIC.feedback.success },
  disputed: { label: 'Disputed', color: SEMANTIC.feedback.danger },
};

/** Why the day is read-only (§T6) — correctable until signed off, then
 * it takes a deliberate second action by someone else. */
export function lockedCopy(status: ReconciliationStatus): string {
  return status === 'disputed'
    ? 'The office has disputed this day. Ask the owner to reopen it.'
    : 'The office has confirmed this day. Ask the owner to reopen it.';
}

const AMOUNT_PATTERN = /^\d+(\.\d{1,2})?$/;

/** Mirrors the server's `moneyString` so the button never submits a body
 * the API would refuse. `0` is honest — some days no cash is collected. */
export function isValidAmount(raw: string): boolean {
  return AMOUNT_PATTERN.test(raw);
}

/** The screen's banner copy from a failed call — the server's `message`
 * verbatim when there is one (§X5), a plain fallback otherwise. */
export function handoverError(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  return message === '' ? 'The declaration could not be saved. Try again.' : message;
}

/** How one day reads in a list of days: `Today`, `Yesterday`, `Mon 14 Sep`. */
export function dateOptionLabel(iso: string, today: string): string {
  if (iso === today) return 'Today';
  if (iso === shiftBusinessDate(today, -1)) return 'Yesterday';
  return formatDateEnIN(iso, Number(today.slice(0, 4)));
}

/**
 * `declared − confirmed`, exactly — the signed figure the office's answer
 * differs by. Positive means it accepted less than he declared.
 *
 * Composed from `sumMoney` rather than re-deriving integer-paise
 * arithmetic: that function is the app's one money-sum implementation, and
 * a second one here is how two screens come to disagree about a rupee.
 */
export function differenceOf(declared: string, confirmed: string): string {
  return sumMoney([declared, `-${confirmed}`]);
}

/**
 * What the office did with a declaration, as one line — `null` while he
 * has not answered it.
 *
 * **Never the expectation.** The only difference on this line is
 * `declared − confirmed`: a figure the employee himself committed to, and
 * the figure the owner deliberately told him about. The queue's variance
 * is `declared − expected_cash` and is computed nowhere near here — that
 * subtraction would hand back the yardstick by arithmetic.
 */
export function officeAnswerOf(row: CashHandover): string | null {
  if (row.status === 'submitted') return null;
  if (row.confirmedAmount === null) {
    return row.status === 'disputed' ? 'The office did not accept this figure.' : null;
  }
  const accepted = `₹${formatMoneyEnIN(row.confirmedAmount)}`;
  const difference = differenceOf(row.declaredAmount, row.confirmedAmount);
  if (difference === '0') return `Office confirmed ${accepted}.`;
  const magnitude = formatMoneyEnIN(difference.replace('-', ''));
  return difference.startsWith('-')
    ? `Office confirmed ${accepted} — ₹${magnitude} more than declared.`
    : `Office confirmed ${accepted} — ₹${magnitude} less than declared.`;
}

/** Rupees, as the money screens print them. */
export function rupees(amount: string): string {
  return `₹${formatMoneyEnIN(amount)}`;
}
