/**
 * The AMC screens' pure model (T2B.4, UI/plan-2/05-DISPATCHER.md §D5,
 * 07-OWNER.md §O6). Plain-date arithmetic, the form's drafts, the submit
 * validation and the line copy the tab renders — no react-native, no api,
 * no hooks — the same layering as the rep's `model.ts`, so the screens'
 * tests assert these rules directly.
 *
 * The state and the reminders are the SERVER's (`v_contracts`, decision
 * 2026-09-15: "state is derived from dates, not stored — nothing needs a
 * cron to expire"). Nothing here recomputes "due" or "ending" — the wire
 * already decided (`isVisitDue`, `isEndingSoon`, `daysToEnd`); the only
 * transformation is wire dates and money becoming display copy.
 *
 * **Plain-date arithmetic in UTC** — no timezone hides in `YYYY-MM-DD`;
 * routing a plain date through `new Date('2026-09-15')` hands it to the
 * device's zone, and a UTC-negative phone reads the day before.
 */
import type { Contract } from '@servgrid/shared';
import { CONTRACT_TERM_MONTHS } from '@servgrid/shared';
import { formatDateEnIN, formatDateWithYear } from '../../components/ui';

/** `2026-09-15` + 1 → `2026-09-16`; −1 walks back across month and year. */
export function addDays(iso: string, days: number): string {
  const [y = 1970, m = 1, d = 1] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) + days * 86_400_000).toISOString().slice(0, 10);
}

/** Calendar months, clamped to the month's last day: 31 Jan + 1 month = 28/29 Feb. */
export function addMonths(iso: string, months: number): string {
  const [y = 1970, m = 1, d = 1] = iso.split('-').map(Number);
  const anchor = new Date(Date.UTC(y, m - 1 + months, 1));
  const lastDay = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() + 1, 0)).getUTCDate();
  return new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), Math.min(d, lastDay)))
    .toISOString()
    .slice(0, 10);
}

/** The form's default end: start + 12 months − 1 day (15 Sep 2026 → 14 Sep 2027).
 * The day comes off BEFORE the months so a leap-day start keeps its full
 * term: 29 Feb 2028 − 1 day = 28 Feb, + 12 months = 28 Feb 2029 — the
 * clamped anniversary minus a day (27 Feb) would be a day short. */
export function defaultEndFor(startIso: string): string {
  return addMonths(addDays(startIso, -1), CONTRACT_TERM_MONTHS);
}

/**
 * The end after the picker hands the form a new start: it moves to the
 * new default ONLY while it still equals the default the form proposed
 * for the old start — a hand-edited end is never overwritten. In `edit`
 * mode the term is never silently moved: the dispatcher changes it
 * deliberately, through the End field.
 */
export function endAfterStartChange(draft: AmcDraft, nextStart: string, mode: 'new' | 'renew' | 'edit'): string {
  if (mode === 'edit') return draft.endDate;
  if (draft.endDate !== defaultEndFor(draft.startDate)) return draft.endDate;
  return defaultEndFor(nextStart);
}

// ── the form's draft ───────────────────────────────────────────────────────

/** What the AMC form holds while it is being edited — raw field strings,
 * exactly as the pickers and inputs carry them. */
export interface AmcDraft {
  customerId: string | null;
  customerName: string | null;
  startDate: string;
  endDate: string;
  contractValue: string;
  notes: string;
}

/** A blank form: start today, the 12-month default end, nothing typed yet. */
export function newDraft(todayIso: string): AmcDraft {
  return {
    customerId: null,
    customerName: null,
    startDate: todayIso,
    endDate: defaultEndFor(todayIso),
    contractValue: '',
    notes: '',
  };
}

/** A renewal prefills from the AMC it renews: start the day AFTER its
 * end, 12 months, the same customer, the same price (§D5). A renewal can
 * be recorded before the old term ends because the two ranges do not
 * overlap (decision 2026-09-15). */
export function renewalDraftOf(c: Contract): AmcDraft {
  const startDate = addDays(c.endDate, 1);
  return {
    customerId: c.customerId,
    customerName: c.customerName,
    startDate,
    endDate: defaultEndFor(startDate),
    contractValue: c.contractValue,
    notes: '',
  };
}

/** An edit prefills every field from the AMC as the server holds it. */
export function editDraftOf(c: Contract): AmcDraft {
  return {
    customerId: c.customerId,
    customerName: c.customerName,
    startDate: c.startDate,
    endDate: c.endDate,
    contractValue: c.contractValue,
    notes: c.notes ?? '',
  };
}

export type AmcPatch = Partial<{ startDate: string; endDate: string; contractValue: string; notes: string | null }>;

/** The PATCH body: only the keys the draft actually changed; notes ''
 * means "clear the notes" and goes over as null. An untouched field is
 * ABSENT, never re-sent. */
export function patchOf(original: Contract, draft: AmcDraft): AmcPatch {
  const patch: AmcPatch = {};
  if (draft.startDate !== original.startDate) patch.startDate = draft.startDate;
  if (draft.endDate !== original.endDate) patch.endDate = draft.endDate;
  if (draft.contractValue !== original.contractValue) patch.contractValue = draft.contractValue;
  const notes = draft.notes === '' ? null : draft.notes;
  if (notes !== original.notes) patch.notes = notes;
  return patch;
}

// ── submit validation ──────────────────────────────────────────────────────

/** Which field the submit refused, worded for the dispatcher mid-call. */
export type AmcFormProblems = Partial<Record<'customer' | 'startDate' | 'endDate' | 'contractValue', string>>;

/**
 * Submit-time validation (03-COMPONENTS.md: no inline validation while
 * typing). The customer and the price are the two things the server
 * cannot record an AMC without; the term order is a schema refinement
 * server-side, checked here so the sentence sits under the field.
 */
export function validateAmcDraft(d: AmcDraft): AmcFormProblems {
  const problems: AmcFormProblems = {};
  if (d.customerId === null) problems.customer = 'Who is the AMC for? Pick a customer.';
  if (d.endDate < d.startDate) problems.endDate = 'The end date cannot be before the start date.';
  if (!/^\d+(\.\d{1,2})?$/.test(d.contractValue)) {
    problems.contractValue = 'Enter the AMC price, for example 18000.';
  }
  return problems;
}

// ── the tab's and the detail's line copy ───────────────────────────────────

/** The state word the owner reads: `Active` | `Starts later` | `Ended` | `Cancelled`. */
export function stateLabel(state: Contract['state']): string {
  switch (state) {
    case 'active':
      return 'Active';
    case 'upcoming':
      return 'Starts later';
    case 'expired':
      return 'Ended';
    case 'cancelled':
      return 'Cancelled';
  }
}

/** `last service 3 May 2026 · due since 3 Sep 2026` — the reminder IS a
 * gap since the last completed job, any job (decision 4). No service yet:
 * `no job yet · due since …`. */
export function dueLine(c: Contract): string {
  const last =
    c.lastServiceDate === null ? 'no job yet' : `last service ${formatDateWithYear(c.lastServiceDate)}`;
  return `${last} · due since ${formatDateWithYear(c.nextVisitDue)}`;
}

/** `ends today` | `ends tomorrow` | `ends in 4 days` — urgency is the
 * point, not a date. */
export function endingLine(c: Contract): string {
  if (c.daysToEnd <= 0) return 'ends today';
  if (c.daysToEnd === 1) return 'ends tomorrow';
  return `ends in ${c.daysToEnd} days`;
}

/** `JC-2627-00044 booked for 12 Oct` while the customer still waits on
 * it; null when nothing is booked under the AMC. */
export function openJobLine(c: Contract): string | null {
  if (c.openJob === null) return null;
  if (c.openJob.scheduledFor === null) return `${c.openJob.jobNumber} booked`;
  const day = formatDateEnIN(c.openJob.scheduledFor.slice(0, 10), new Date().getFullYear());
  return `${c.openJob.jobNumber} booked for ${day}`;
}

/** `AMC job · AMC-2627-00031 · until 14 Sep 2027` — the dispatch form's
 * checkbox label (decision 2). The year stays on: an AMC term spans
 * years, so the year is the fact. */
export function amcOptionLabel(c: Pick<Contract, 'contractNumber' | 'endDate'>): string {
  return `AMC job · ${c.contractNumber} · until ${formatDateWithYear(c.endDate)}`;
}
