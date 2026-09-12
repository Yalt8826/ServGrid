/**
 * The pure model behind the T5 cancel sheet (T1.20,
 * UI/plan-2/04-TECHNICIAN.md §T5, PLAN-BACKEND.md §6.3). No
 * react-native, no React — the same division as `completeSheet.ts` /
 * `jobView.ts`: the screen renders what these functions decide, and the
 * tests run the decisions without a device.
 *
 * This is where a wasted trip gets recorded: the technician standing at
 * a locked gate is the only person who knows whether the customer said
 * "come Thursday" or "don't bother" (§6.3), so the decisions encoded
 * here keep the decision HIS:
 *
 * - **Reason code as rows, never a dropdown.** Nine codes, verbatim from
 *   `jobCancelSchema` (packages/shared/src/schemas.ts) — the same enum
 *   the server accepts, so the sheet has no second source of truth.
 * - **A past date is refused, never clamped.** "Not silently clamped"
 *   (§T5 tests) is the whole rule: a clamp would move the visit to a day
 *   nobody agreed to. `rescheduleDateErrorOf` carries the refusal; the
 *   screen applies a date only when the refusal is null.
 * - **Skippable reschedule.** No `rescheduleTo` is an honest outcome —
 *   an ordinary job is simply cancelled; a contract visit becomes
 *   `skipped` and the customer has spent it (§6.3). Submit never demands
 *   a date.
 * - **The contract warning is Phase 2B, the slot is now.**
 *   `contractWarningOf` returns null without a contract — which pre-2B
 *   is every job — so the slot renders nothing. When 2B lands, the
 *   warning sits above the date picker in body weight: the one place the
 *   app warns a technician about a default rather than trusting him to
 *   know it, because the consequence (a spent visit) lands on the
 *   customer.
 * - **The `other` note is the server's rule, asked early.** The DB CHECK
 *   and `jobCancelSchema` both refuse an `other` without a note, so the
 *   sheet blocks submit with the why instead of failing the technician
 *   at the door of the drain.
 */
import type { JobView } from './jobView';

// ── shapes ───────────────────────────────────────────────────────────────────

/** The reason codes `jobCancelSchema` accepts — verbatim, all nine. */
export type CancelReasonCode =
  | 'customer_unavailable'
  | 'customer_cancelled'
  | 'duplicate'
  | 'wrong_details'
  | 'no_access'
  | 'parts_unavailable'
  | 'rescheduled_by_office'
  | 'contract_cancelled'
  | 'other';

/** One tappable reason row: the wire code plus the words he reads. */
export interface CancelReason {
  code: CancelReasonCode;
  label: string;
}

/** Doorstep reasons first, `other` last (it alone asks for more). */
export const CANCEL_REASONS: readonly CancelReason[] = [
  { code: 'customer_unavailable', label: 'Customer unavailable' },
  { code: 'no_access', label: 'No access' },
  { code: 'parts_unavailable', label: 'Parts unavailable' },
  { code: 'customer_cancelled', label: 'Customer cancelled' },
  { code: 'wrong_details', label: 'Wrong details' },
  { code: 'duplicate', label: 'Duplicate visit' },
  { code: 'rescheduled_by_office', label: 'Rescheduled by the office' },
  { code: 'contract_cancelled', label: 'Contract cancelled' },
  { code: 'other', label: 'Other' },
];

/**
 * The payload the sheet builds — field names verbatim from
 * `jobCancelSchema`, which the batch re-posts to
 * `POST /v1/jobs/:id/cancel` (§6.3). Absent keys are absent: no empty
 * `reasonNote`, no invented `rescheduleTo`.
 */
export interface CancelSheetPayload {
  reasonCode: CancelReasonCode;
  reasonNote?: string;
  rescheduleTo?: string;
}

// ── the contract warning (Phase 2B copy, Phase 1 slot) ───────────────────────

/**
 * The one warning about a default in the app (§T5). Null without a
 * contract — pre-2B that is every job, so the slot above the date picker
 * renders nothing. The count is the customer's remaining visits: the
 * number the technician's decision spends.
 */
export function contractWarningOf(contract: JobView['job']['contract']): string | null {
  if (contract === null) return null;
  const visits = `${contract.visitsRemaining} visit${contract.visitsRemaining === 1 ? '' : 's'}`;
  return `Skipping without a date spends one of this customer's ${visits}.`;
}

// ── the reschedule date ──────────────────────────────────────────────────────

/** The days the picker offers: today and the next fortnight. A visit
 * pushed past a contract's end date is refused server-side (§6.3); the
 * contract term itself is a 2B bound the picker gains with the contract. */
export const RESCHEDULE_WINDOW_DAYS = 14;

/** Calendar shift on plain ISO dates — no timezone hides in `YYYY-MM-DD`
 * (the same UTC arithmetic as the handover window). */
export function shiftIsoDate(iso: string, days: number): string {
  const [y = 1970, m = 1, d = 1] = iso.split('-').map(Number);
  const shifted = new Date(Date.UTC(y, m - 1, d));
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}

/** The days the picker offers, today first — every one a legal choice. */
export function rescheduleWindow(today: string): string[] {
  const days: string[] = [];
  for (let ahead = 0; ahead < RESCHEDULE_WINDOW_DAYS; ahead += 1) days.push(shiftIsoDate(today, ahead));
  return days;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Why the date cannot be applied, or null when it can. A past date is
 * REFUSED here — never clamped to today, never silently dropped —
 * because a clamp would move the visit to a day nobody agreed to (§T5).
 * Today is not in the past: the visit can still happen this evening.
 */
export function rescheduleDateErrorOf(iso: string, today: string): string | null {
  if (!ISO_DATE.test(iso)) return 'Pick a date — day, month and year.';
  if (iso < today) return 'That date is in the past — pick a day that has not happened yet.';
  return null;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `22 Mar` this year, `22 Mar 2027` otherwise — the confirmation line's
 * date format (§T5: *"Visit moves to 22 Mar."*). */
export function rescheduleDateLabel(iso: string, nowYear: number): string {
  const [y = '', m = '', d = ''] = iso.split('-');
  const month = MONTHS[Number(m) - 1] ?? m;
  return Number(y) === nowYear ? `${Number(d)} ${month}` : `${Number(d)} ${month} ${y}`;
}

/** The one-line confirmation choosing a date reveals (§T5). */
export function rescheduleConfirmLine(iso: string, nowYear: number): string {
  return `Visit moves to ${rescheduleDateLabel(iso, nowYear)}.`;
}

// ── validation (on submit, never while typing) ───────────────────────────────

/**
 * Why submit cannot proceed yet, or null when it can. The date is not an
 * input here — an invalid date never reaches state (the entry guard
 * refuses it), and NO date is a valid choice (the reschedule is
 * skippable, §T5). There is deliberately no network-shaped input: submit
 * is never disabled for a network reason (§5).
 */
export function submitBlockerOf(input: {
  reasonCode: CancelReasonCode | null;
  note: string;
}): string | null {
  if (input.reasonCode === null) {
    return 'Pick the reason the visit did not go ahead.';
  }
  if (input.reasonCode === 'other' && input.note.trim() === '') {
    return '"Other" needs a note — say what happened.';
  }
  return null;
}

// ── the payload ──────────────────────────────────────────────────────────────

/**
 * The wire payload from the sheet's state. Strict-schema shape: only the
 * keys that exist, trimmed where free-text — the server's
 * `jobCancelSchema` is `.strict()`, and an empty note is not a note.
 */
export function cancelPayloadOf(input: {
  reasonCode: CancelReasonCode;
  note: string;
  rescheduleTo: string | null;
}): CancelSheetPayload {
  const note = input.note.trim();
  return {
    reasonCode: input.reasonCode,
    ...(note === '' ? {} : { reasonNote: note }),
    ...(input.rescheduleTo === null ? {} : { rescheduleTo: input.rescheduleTo }),
  };
}
