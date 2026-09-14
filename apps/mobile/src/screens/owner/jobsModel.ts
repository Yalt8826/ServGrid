/**
 * The owner jobs screens' pure model (T4.11, UI/plan-2/07-OWNER.md §O4).
 * No react-native, no api, no hooks — the same layering as the
 * dashboard's `model.ts`, so the screens' tests assert these rules
 * directly without dragging the API client into the import graph.
 *
 * The rule that governs the screen lives here as a type, not a flag:
 * the job list is GENERIC over the card schema. `JobRow` carries a
 * `JobCardOwner` or a `JobCardDispatcher` and `carriesAmount` reads the
 * shape — the owner's schema has the completion money, the
 * dispatcher's does not — so the amount column's presence is a fact of
 * the response schema, and the same component renders a dispatcher's
 * table with no amount column because the schema it was handed has
 * nothing to put there (§O4: "from a different response schema … not
 * from an optional field on a shared one").
 */
import { formatMoneyEnIN } from '@servgrid/shared';
import type { JobCardDispatcher, JobCardOwner, JobStatus, JobTimelineEvent } from '@servgrid/shared';

/** The two card schemas the job surfaces serve, verbatim from shared. */
export type OwnerJobCard = JobCardOwner | JobCardDispatcher;

/** One list row: the card plus the technician's name, resolved by the hook from the roster read. */
export interface JobRow {
  card: OwnerJobCard;
  technicianName: string | null;
}

/**
 * True when the cards handed over are the OWNER schema. `in` reads the
 * object's shape — a `JobCardDispatcher` has no `amountCollected` field
 * at all, not a hidden one.
 */
export function carriesAmount(rows: readonly JobRow[]): boolean {
  return rows.some((r) => 'amountCollected' in r.card);
}

/** `₹14,500` — the job's collected money; `null` renders as `—`. */
export function amountLabelOf(card: OwnerJobCard): string | null {
  if (!('amountCollected' in card) || card.amountCollected === null) return null;
  return `₹${formatMoneyEnIN(card.amountCollected)}`;
}

/** Sort key for the amount column — uncollected jobs sort as if empty. */
export function amountSortValueOf(card: OwnerJobCard): number {
  return 'amountCollected' in card && card.amountCollected !== null ? Number(card.amountCollected) : -1;
}

/** Overdue rows lead, then the schedule ascending, undated jobs last. */
export function sortOwnerRows(rows: readonly JobRow[]): JobRow[] {
  return [...rows].sort((a, b) => {
    const ao = a.card.isOverdue ? 0 : 1;
    const bo = b.card.isOverdue ? 0 : 1;
    if (ao !== bo) return ao - bo;
    const as = a.card.scheduledFor ?? '9999';
    const bs = b.card.scheduledFor ?? '9999';
    return as < bs ? -1 : as > bs ? 1 : 0;
  });
}

/** The count line above the list — "24 jobs · 3 overdue". */
export function overdueCountOf(rows: readonly JobRow[]): number {
  return rows.filter((r) => r.card.isOverdue).length;
}

/** `2026-09-02T14:30:00+05:30` → `2 Sep · 14:30` (the IST wall clock the api sends). */
export function scheduledLabelOf(scheduledFor: string | null, nowYear: number): string {
  if (scheduledFor === null) return 'no date';
  const [date = '', time = ''] = scheduledFor.split('T');
  const [y = '', m = '', d = ''] = date.split('-');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const day = `${Number(d)} ${months[Number(m) - 1] ?? m}${Number(y) === nowYear ? '' : ` ${y}`}`;
  return time === '' ? day : `${day} · ${time.slice(0, 5)}`;
}

/** Status word — the pill's word without the pill (the rail carries the colour). */
export function statusWordOf(status: JobStatus): string {
  switch (status) {
    case 'completed':
      return 'Completed';
    case 'en_route':
      return 'En route';
    case 'in_progress':
      return 'In progress';
    case 'cancelled':
      return 'Cancelled';
    case 'unassigned':
      return 'Unassigned';
    default:
      return 'Assigned';
  }
}

// ── the amend comparison (§O4: current · new · the difference) ──────────────

/** The stored figures the amend sheet starts from. */
export interface AmendCurrent {
  cost: string | null;
  discountAmount: string | null;
  discountReason: string | null;
}

/** One row of the comparison: what it is, what it becomes, how far it moves. */
export interface AmendComparisonRow {
  key: 'cost' | 'discountAmount' | 'discountReason';
  label: string;
  current: string;
  next: string;
  difference: string;
}

function paiseOf(amount: string): number {
  const cleaned = amount.replace(/[^0-9.-]/g, '');
  if (cleaned === '' || cleaned === '-') return 0;
  return Math.round(Number(cleaned) * 100);
}

/** `next − current` as a signed display string: `+ ₹500` / `− ₹4,500` / `—`. */
export function diffMoney(next: string, current: string): string {
  const diff = paiseOf(next) - paiseOf(current);
  if (diff === 0) return '—';
  const sign = diff > 0 ? '+' : '−';
  const abs = Math.abs(diff);
  const int = String(Math.floor(abs / 100));
  const dec = String(abs % 100).padStart(2, '0');
  const grouped = formatMoneyEnIN(dec === '00' ? int : `${int}.${dec}`);
  return `${sign} ₹${grouped}`;
}

/**
 * The three comparison rows (§O4). Money rows show the size of the
 * correction in money; the reason row shows the words old → new, with
 * "unchanged" when the owner left it alone — the owner is correcting a
 * number, and needs to see the size of the correction before committing.
 */
export function amendComparisonRows(
  current: AmendCurrent,
  next: { cost: string; discountAmount: string; discountReason: string },
): AmendComparisonRow[] {
  const currentCost = current.cost ?? '0';
  const currentDiscount = current.discountAmount ?? '0';
  const reasonChanged = next.discountReason !== (current.discountReason ?? '');
  return [
    {
      key: 'cost',
      label: 'Amount',
      current: `₹${formatMoneyEnIN(currentCost)}`,
      next: `₹${formatMoneyEnIN(next.cost)}`,
      difference: diffMoney(next.cost, currentCost),
    },
    {
      key: 'discountAmount',
      label: 'Discount',
      current: `₹${formatMoneyEnIN(currentDiscount)}`,
      next: `₹${formatMoneyEnIN(next.discountAmount)}`,
      difference: diffMoney(next.discountAmount, currentDiscount),
    },
    {
      key: 'discountReason',
      label: 'Discount reason',
      current: current.discountReason ?? '—',
      next: next.discountReason === '' ? '—' : next.discountReason,
      difference: reasonChanged ? 'changed' : 'unchanged',
    },
  ];
}

// ── the timeline (§O4: the full job_events trail) ───────────────────────────

/** The event's word — what happened, in the language the trail reads in. */
export function eventWord(eventType: string): string {
  switch (eventType) {
    case 'created':
      return 'Raised';
    case 'assigned':
      return 'Assigned';
    case 'reassigned':
      return 'Reassigned';
    case 'status_changed':
      return 'Status';
    case 'rescheduled':
      return 'Rescheduled';
    case 'completed':
      return 'Completed';
    case 'completion_amended':
      return 'Completion amended';
    case 'cancelled':
      return 'Cancelled';
    default:
      return eventType;
  }
}

/**
 * The payload line an event renders under its word — the amendment's
 * reason and before/after pair (the money's audit trail), the clamp's
 * honest caption. Absent for events that carry nothing to read.
 */
export function eventPayloadLine(event: JobTimelineEvent): string | null {
  const payload = event.payload;
  if (payload === undefined || payload === null || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;
  if (event.eventType === 'completion_amended') {
    const parts: string[] = [];
    if (typeof p.reason === 'string' && p.reason !== '') parts.push(`“${p.reason}”`);
    const cost = p.cost as { from?: unknown; to?: unknown } | undefined;
    if (cost !== undefined && typeof cost.from === 'string' && typeof cost.to === 'string' && cost.from !== cost.to) {
      parts.push(`₹${formatMoneyEnIN(cost.from)} → ₹${formatMoneyEnIN(cost.to)}`);
    }
    return parts.length === 0 ? null : parts.join(' · ');
  }
  if (p.completedAtClamped !== undefined) {
    return 'the device clock was out of bounds — the server recorded its own bound';
  }
  return null;
}
