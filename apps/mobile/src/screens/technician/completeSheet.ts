/**
 * The pure model behind the T4 complete sheet (T1.19,
 * UI/plan-2/04-TECHNICIAN.md §T4, PLAN-FRONTEND.md §9). No react-native,
 * no React — the same division as `jobView.ts` / `jobDetail.ts`: the
 * screen renders what these functions decide, and the tests run the
 * decisions without a device.
 *
 * This is the highest-stakes screen in the product, so every rule below
 * is a decision someone already argued (§T4 "If it fails"). The ones
 * encoded here:
 *
 * - **Three segments, not five.** `collection_mode` carries
 *   `cash | upi | card | bank_transfer | none`; `bank_transfer` does not
 *   happen at a doorstep (it is the rep's payments flow) and is not
 *   offered. `none` is never a segment — it is a **consequence**
 *   (§T4): when the amount after discount is zero or empty the sheet
 *   submits `collection_mode: 'none'` and shows "No payment taken" in
 *   the segments' place, so a warranty job is never asked how he was
 *   paid for work that was free.
 * - **AMC job — two segments, Free under AMC and Charge (decision 9,
 *   2026-09-15).** The sheet OPENS on Free under AMC, where the visit is
 *   covered and no money fields exist at all; the technician switches to
 *   Charge for extra work the customer pays for, which brings the
 *   ordinary money fields back. The choice is the technician's alone —
 *   the server never guesses an AMC job's charge from the amount field.
 * - **One parts list, two server arrays.** Every line becomes a
 *   `parts[]` row (consumed on this job); every TICKED line *also*
 *   becomes a `stackChanges[]` entry (standing at that site). The
 *   equipment checkbox defaults from the product's category — on for
 *   `ups`/`battery`/`inverter`, off for `accessory`/`spare` and free
 *   text — because a technician fitting a battery should get the right
 *   answer without touching it, and so should one fitting a filter.
 * - **Never a subtotal.** No function here computes a total for display.
 *   The only derived figure is the amount after discount, which decides
 *   the Paid-by branch — it is never rendered as a figure.
 * - **No `amountCollected` in the payload.** The column is generated
 *   (cost − discount) server-side; accepting it would store derived
 *   money (jobs/service.ts §6.2). The sheet's amount field is `cost`.
 * - **The in-warranty confirmation is a prompt, not a block** — and the
 *   only dialog on the sheet. `warrantyConfirmMessageOf` carries the
 *   expiry date, which is the fact the technician is overriding.
 */
import type { JobCompletionPart, JobStackChange } from '@servgrid/shared';

import { istDateKey, type JobView } from './jobView';

/** What a retry keys on — see `bodyKeyedWriters` at the bottom. */
import type { IntentWriter } from '../../lib/intentWrite';

// ── shapes ───────────────────────────────────────────────────────────────────

/** The product categories the sync contract carries (schemas.ts). */
export type ProductCategory = 'ups' | 'battery' | 'inverter' | 'accessory' | 'spare';

/** One catalogue row the parts picker offers. From the work read's `products`. */
export interface PartProduct {
  id: string;
  name: string;
  category: ProductCategory;
}

/** The five collection modes the server accepts; the sheet offers three. */
export type CollectionMode = 'cash' | 'upi' | 'card' | 'bank_transfer' | 'none';

/** The three doorstep segments (§T4: three, not five). */
export const PAYMENT_SEGMENTS: readonly { mode: Exclude<CollectionMode, 'bank_transfer' | 'none'>; label: string }[] = [
  { mode: 'cash', label: 'Cash' },
  { mode: 'upi', label: 'UPI' },
  { mode: 'card', label: 'Card' },
];

// ── the AMC job's choice (decision 9, 2026-09-15) ────────────────────────────

/** Decision 9 (2026-09-15): on an AMC job the technician chooses; Free is where the sheet opens. */
export type AmcChoice = 'free' | 'charge';
export const DEFAULT_AMC_CHOICE: AmcChoice = 'free';

/** The two segments above the money on an AMC job (§T4). */
export const AMC_SEGMENTS: readonly { choice: AmcChoice; label: string }[] = [
  { choice: 'free', label: 'Free under AMC' },
  { choice: 'charge', label: 'Charge' },
];

/** A job under a live AMC — the one condition the sheet branches on. */
export function isAmcJob(view: JobView): boolean {
  return view.job.contract !== null;
}

/** Free under AMC means no money fields at all: nothing to type, nothing sent. */
export function isFreeUnderAmc(view: JobView, choice: AmcChoice): boolean {
  return isAmcJob(view) && choice === 'free';
}

/** One line of the unified Parts & equipment list (§T4: one list, not two). */
export interface PartLine {
  /** Stable list key — local only, never sent. */
  localId: string;
  /** The catalogue product, when the line has one; free text otherwise. */
  productId: string | null;
  /** Product name, or the technician's description of the item. */
  name: string;
  /** Raw field text; parsed on submit. */
  quantity: string;
  /** Serial of the fitted unit — what a ticked line must carry. */
  serial: string;
  /** "Add to this site's equipment" — the one extra question per line. */
  addToEquipment: boolean;
}

/**
 * The payload the sheet builds — field names verbatim from
 * `jobCompleteSchema` (packages/shared/src/schemas.ts), which the route
 * posts to `POST /v1/jobs/:id/complete`. Deliberately NO
 * `amountCollected` (generated server-side) and no photos (attachments
 * upload as their own requests after the completion; §5).
 */
export interface CompleteSheetPayload {
  completedAt: string;
  workSummary: string;
  cost?: string;
  discountAmount?: string;
  discountReason?: string;
  collectionMode?: CollectionMode;
  customerSigned?: boolean;
  stackChanges?: JobStackChange[];
  parts?: JobCompletionPart[];
}

// ── the conditional branches ─────────────────────────────────────────────────

/**
 * The amount after discount, as a number — or null when the amount
 * field is empty. The ONLY derived figure in the sheet, and it decides
 * the Paid-by branch; it is never rendered (never a subtotal, §T4).
 */
export function amountAfterDiscountOf(amount: string, discount: string): number | null {
  if (amount.trim() === '') return null;
  const after = Number(amount) - (discount.trim() === '' ? 0 : Number(discount));
  return Number.isFinite(after) ? after : null;
}

/**
 * Whether this completion carries a charge: the amount after discount is
 * a positive figure. Zero or empty means **no payment taken** —
 * `collection_mode: 'none'` is submitted, and a warranty job is never
 * asked how he was paid for work that was free (§T4). On an AMC job the
 * Free/Charge choice decides the branch before this is consulted — see
 * `isFreeUnderAmc` (decision 2026-09-15).
 */
export function chargeApplies(amount: string, discount: string): boolean {
  const after = amountAfterDiscountOf(amount, discount);
  return after !== null && after > 0;
}

/** Is the unit still covered today (IST)? No unit or no expiry is not. */
export function inWarranty(view: JobView, now: Date): boolean {
  const expiry = view.unit?.warrantyExpiresOn ?? null;
  return expiry !== null && expiry >= istDateKey(now);
}

/** `14 Mar 2027` from `YYYY-MM-DD` — the warranty chip's date format. */
export function warrantyDateLabel(expiry: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${expiry}T00:00:00Z`));
}

/**
 * The sheet's one dialog (§T4: the only one, which is what keeps it
 * meaningful). In-warranty unit, a charge entered — the technician is
 * about to charge for covered work, so he is asked once, with the date.
 * A prompt, not a block. The dialog only opens when `inWarranty` is
 * true, but this string is built on every render of the sheet — with no
 * unit or no expiry there is no date to name, so the question stands
 * alone rather than formatting an empty one.
 */
export function warrantyConfirmMessageOf(view: JobView): string {
  const expiry = view.unit?.warrantyExpiresOn ?? null;
  if (expiry === null) return 'Charge anyway?';
  return `This unit is under warranty until ${warrantyDateLabel(expiry)}. Charge anyway?`;
}

// ── the parts list ───────────────────────────────────────────────────────────

let lineSeq = 0;

/** A fresh line with the category's default answer to the extra question
 * (§T4): equipment-style products default ON, consumables and free text
 * default OFF — a suggestion he can override, not a rule. */
export function partLineOf(product: PartProduct | null, name: string): PartLine {
  lineSeq += 1;
  return {
    localId: `line-${lineSeq}`,
    productId: product?.id ?? null,
    name: product?.name ?? name,
    quantity: '1',
    serial: '',
    addToEquipment: equipmentDefaultFor(product?.category ?? null),
  };
}

/** The checkbox default from the product's category (§T4). */
export function equipmentDefaultFor(category: ProductCategory | null): boolean {
  return category === 'ups' || category === 'battery' || category === 'inverter';
}

function quantityOf(line: PartLine): number | null {
  const parsed = Number(line.quantity.trim());
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

// ── validation (on submit, never while typing) ───────────────────────────────

/**
 * Why submit cannot proceed yet, or null when it can. Every reason is a
 * validation fact — there is deliberately NO network-shaped input here:
 * the sheet cannot disable submit for a network reason (§T4 Never).
 *
 * On an AMC job the sheet passes `amount: ''` and `discountAmount: ''`
 * when the choice is Free, so a half-typed discount left behind on the
 * Charge side can never block a free completion.
 */
export function submitBlockerOf(input: {
  workSummary: string;
  amount: string;
  discountAmount: string;
  discountReason: string;
  lines: readonly PartLine[];
}): string | null {
  if (input.workSummary.trim() === '') {
    return 'Say what work was done.';
  }
  const amount = input.amount.trim();
  const discount = input.discountAmount.trim();
  const discountEntered = discount !== '' && Number(discount) > 0;
  if (discountEntered && input.discountReason.trim() === '') {
    return 'A discount needs a reason — say why the amount was reduced.';
  }
  // An empty amount is a zero charge (the server's absent-means-0, §3.4),
  // so a discount on it is already larger than what is owed.
  if (discountEntered && Number(discount) > (amount === '' ? 0 : Number(amount))) {
    return 'The discount is larger than the amount — a discount reduces what is owed, it cannot exceed it.';
  }
  for (const line of input.lines) {
    if (line.name.trim() === '') {
      return 'Name the part — pick a product or type what it is.';
    }
    if (quantityOf(line) === null) {
      return 'A part quantity must be more than zero.';
    }
    // A ticked line becomes a `stackChanges[]` entry — the site's stack
    // is tracked by serial (customer_products.serial_number NOT NULL),
    // so "add to equipment" without a serial cannot be submitted.
    if (line.addToEquipment && line.serial.trim() === '') {
      return `Add a serial for “${line.name.trim()}”, or untick “Add to this site's equipment”.`;
    }
  }
  return null;
}

// ── the payload ──────────────────────────────────────────────────────────────

/**
 * The wire payload from the sheet's state. One UI list, two arrays
 * (§T4): every line lands in `parts[]`, only ticked lines *also* land in
 * `stackChanges[]` — consumed on this job and standing at that site are
 * different facts, and only the second survives the job. Parts and stack
 * changes are sent in BOTH branches — a free AMC visit still fits parts.
 */
export function payloadOf(input: {
  view: JobView;
  workSummary: string;
  amount: string;
  discountAmount: string;
  discountReason: string;
  selectedMode: Exclude<CollectionMode, 'bank_transfer' | 'none'>;
  /** The AMC job's Free/Charge choice (decision 9) — Free sends no money at all. */
  amcChoice: AmcChoice;
  lines: readonly PartLine[];
  customerConfirmed: boolean;
  now: Date;
  /** The submit instant — the completion's `completed_at`. */
  completedAt: string;
}): CompleteSheetPayload {
  const free = isFreeUnderAmc(input.view, input.amcChoice);
  const charged = !free && chargeApplies(input.amount, input.discountAmount);
  const amount = input.amount.trim();
  const discount = input.discountAmount.trim();
  const workSummary = input.workSummary.trim();

  const parts: JobCompletionPart[] = [];
  const stackChanges: JobStackChange[] = [];
  const installedOn = istDateKey(input.now);

  for (const line of input.lines) {
    const quantity = quantityOf(line);
    if (quantity === null || line.name.trim() === '') continue; // submitBlockerOf already refused
    const named: JobCompletionPart =
      line.productId !== null
        ? { productId: line.productId, quantity, ...(line.serial.trim() === '' ? {} : { serialNumber: line.serial.trim() }) }
        : { freeTextName: line.name.trim(), quantity, ...(line.serial.trim() === '' ? {} : { serialNumber: line.serial.trim() }) };
    parts.push(named);

    if (line.addToEquipment) {
      const change: JobStackChange = {
        ...(line.productId !== null ? { productId: line.productId } : { freeTextName: line.name.trim() }),
        serialNumber: line.serial.trim(),
        installedOn,
      };
      // `stackChanges[].quantity` is a whole unit count (int); a fractional
      // consumption stays a parts fact only, and the server defaults the
      // stack quantity to 1 — one fitted unit.
      if (Number.isInteger(quantity) && quantity !== 1) change.quantity = quantity;
      stackChanges.push(change);
    }
  }

  return {
    completedAt: input.completedAt,
    workSummary,
    // Absent money fields are the server's honest zeros (§3.4) — a free
    // job sends no money at all, and a Free-under-AMC visit is the purest
    // case: nothing typed, nothing sent, whatever was left on the Charge
    // side before the technician switched back.
    ...(free || amount === '' ? {} : { cost: amount }),
    ...(free || discount === '' || Number(discount) <= 0 ? {} : { discountAmount: discount, discountReason: input.discountReason.trim() }),
    // `none` is a consequence, not a choice (§T4): no charge → none,
    // whatever the segments showed before the amount emptied. On an AMC
    // job, Free is always none — the choice, not the amount, decides.
    collectionMode: charged ? input.selectedMode : 'none',
    ...(input.customerConfirmed ? { customerSigned: true } : {}),
    ...(parts.length > 0 ? { parts } : {}),
    ...(stackChanges.length > 0 ? { stackChanges } : {}),
  };
}

// ── the retry's intent (decision 9: the choice can change between attempts) ──

/**
 * One submit intent, one idempotency key — **keyed by the body**. The
 * complete route used to pin one writer for the whole sheet, which was
 * safe while the body could not change between attempts; switching Free ↔
 * Charge changes the body, and the server refuses a changed body under an
 * old key (422 `IDEMPOTENCY_KEY_REUSED`). A retry with an edited form is
 * a NEW intent, so a body that differs from the last attempt's starts a
 * new writer (and a new key); the same body replays the pinned one — the
 * ambiguous-failure case the key exists for. `completedAt` is pinned by
 * the sheet itself, so the same form state still produces the same body
 * across retries.
 *
 * The route calls `writerFor(JSON.stringify(payload))` per attempt.
 */
export function bodyKeyedWriters(createWriter: () => IntentWriter): { writerFor(body: string): IntentWriter } {
  let current: IntentWriter | null = null;
  let currentBody: string | null = null;
  return {
    writerFor(body: string): IntentWriter {
      if (current === null || currentBody !== body) {
        current = createWriter();
        currentBody = body;
      }
      return current;
    },
  };
}
