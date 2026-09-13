import {
  type PaymentCreate,
  type PaymentRecord,
  type Role,
} from '@servgrid/shared';
import { AppError } from '../../plugins/errors.js';
import { scopePredicate, type ScopePredicate } from '../../plugins/rbac.js';
import { getPool } from '../../db/pool.js';
import { withTransaction } from '../../db/tx.js';
import { allocateNumber } from '../../lib/sequences.js';
import * as repo from './repo.js';

/**
 * Payments service (PLAN-BACKEND.md §11, PLAN-DATA-MODEL.md §3.5,
 * PHASE-3-SALES-REP.md T3.4). The rules the task exists for:
 *
 * **There is no 'pending' payment.** Pending is a view of dues
 * (`v_company_balances WHERE balance > 0`), not a row — an intention to
 * collect ₹40,000 is not money (§3.5). POST writes a COLLECTED row and
 * allocates its `payment_number` at create: payments are not drafted, so
 * there is no pending state to allocate at — the exact opposite of the
 * sale number, and on purpose.
 *
 * **On-account is the ordinary case.** `sales_card_id` is nullable, and
 * NULL is how most collections actually land: money on the company
 * balance without pointing at one sale. A payload that DOES name a card
 * names a confirmed card of the same account — a draft never moved the
 * balance and a void was reversed, so a collection "against" either would
 * document a movement that did not happen.
 *
 * **`received_by` is whoever ACTUALLY took the money** (the completed_by
 * precedent, §3.2) — the server stamps it from the token and the payload
 * carries no rep field. This is why a rep may record a collection on an
 * account he does not own (a house account, another rep's): the row's
 * scope is receipt, not account ownership, and it is deliberately
 * stricter — `own` on company shows him the account, `own` on payment
 * still hides the other rep's money on it.
 *
 * **Reps capture; only the owner voids.** A rep who needs a payment
 * reversed asks (the sale-void precedent). Void is the door that moves a
 * company's balance backwards, so it is checked at the door, and a void
 * carries a reason, because a balance that moved for nothing is
 * unreviewable at month end. The reversal itself is the view's business:
 * `v_company_balances` subtracts collected payments only, and
 * `v_employee_expected_cash` filters `status = 'collected'` as well as
 * `mode = 'cash'`, so a voided cash payment stops creating the expectation
 * the rep can never satisfy.
 *
 * **Scoping:** the LIST composes the `payment` × `own` predicate
 * (`received_by = :actor`) into its WHERE, so pagination cannot un-scope
 * it. The void takes the row lock first (the jobs module's transition
 * precedent).
 */

const NOT_FOUND_MESSAGE = "We couldn't find that payment.";
const ALREADY_VOID_MESSAGE = 'This payment is already void — that is final.';
const NO_COMPANY_MESSAGE = 'That account is not in the system — pick again.';
const NO_SALE_MESSAGE = 'That sale is not in the system — pick again.';
const SALE_OTHER_COMPANY_MESSAGE = 'That sale belongs to a different account.';
const SALE_NOT_CONFIRMED_MESSAGE = 'Only a confirmed sale can take a payment — confirm the sale first.';

export interface Actor {
  id: string;
  role: Role;
}

function toPayment(row: repo.PaymentRow): PaymentRecord {
  return {
    id: row.id,
    paymentNumber: row.payment_number,
    companyId: row.company_id,
    salesCardId: row.sales_card_id,
    amount: row.amount,
    mode: row.mode as PaymentRecord['mode'],
    referenceNo: row.reference_no,
    receivedBy: row.received_by,
    receivedAt: row.received_at.toISOString(),
    businessDate: row.business_date,
    status: row.status as PaymentRecord['status'],
    voidedAt: row.voided_at?.toISOString() ?? null,
    voidedBy: row.voided_by,
    voidReason: row.void_reason,
    notes: row.notes,
    version: row.version,
  };
}

/**
 * The actor's row scope on payments, from the one matrix. `all` (the
 * owner) returns null, and a rep's `own` returns the receipt predicate the
 * repo composes into the list's WHERE. Exported for the route, which
 * builds the predicate against the query's own alias — the sales route's
 * shape, so scoping is built once at the door and handed in.
 */
export function paymentScope(actor: Actor): ScopePredicate | null {
  return scopePredicate({ role: actor.role, actorId: actor.id, resource: 'payment', action: 'read' });
}

/** base64url is URL-safe and opaque; the payload is the keyset key, not a secret (§6.3's cursor). */
function encodeCursor(row: { created_at_text: string; id: string }): string {
  return Buffer.from(JSON.stringify([row.created_at_text, row.id]), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): repo.PaymentListCursor {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      typeof parsed[0] === 'string' &&
      typeof parsed[1] === 'string'
    ) {
      return { createdAt: parsed[0], id: parsed[1] };
    }
  } catch {
    // fall through: a cursor this app did not mint is a stale list, not a crash
  }
  throw new AppError('VALIDATION_FAILED', 'That page reference is stale — reload the list.');
}

export interface PaymentListQuery {
  limit?: number;
  cursor?: string;
}

export interface PaymentListPage {
  items: PaymentRecord[];
  nextCursor: string | null;
}

const DEFAULT_PAGE_SIZE = 50;

export function createPaymentsService() {
  /** GET /v1/payments (§11) — the Collected tab: a rep's own receipts, the owner sees all. The scope predicate comes from the route, built once at the door. */
  async function listPayments(scope: ScopePredicate | null, query: PaymentListQuery): Promise<PaymentListPage> {
    const limit = query.limit ?? DEFAULT_PAGE_SIZE;
    const cursor = query.cursor === undefined ? null : decodeCursor(query.cursor);
    const page = await repo.listPayments(getPool(), scope, cursor, limit);
    const rows = page.hasMore ? page.rows.slice(0, limit) : page.rows;
    return {
      items: rows.map(toPayment),
      nextCursor: page.hasMore ? encodeCursor(rows[rows.length - 1]!) : null,
    };
  }

  /**
   * POST /v1/payments (§11) — a COLLECTED row: the number is minted here,
   * not at some later confirm, because a payment is a fact the moment it
   * happens. `received_by` is the actor; the account must exist so the FK
   * never surfaces as a 500. The allocation runs inside the transaction,
   * so a refusal after allocation rolls the number back with the row.
   */
  async function createPayment(actor: Actor, input: PaymentCreate): Promise<PaymentRecord> {
    return withTransaction(async (client) => {
      if (!(await repo.companyExists(client, input.companyId))) {
        throw new AppError('VALIDATION_FAILED', NO_COMPANY_MESSAGE);
      }
      if (input.salesCardId !== undefined) {
        const card = await repo.findSalesCardForPayment(client, input.salesCardId);
        if (card === null) {
          throw new AppError('VALIDATION_FAILED', NO_SALE_MESSAGE);
        }
        if (card.company_id !== input.companyId) {
          throw new AppError('VALIDATION_FAILED', SALE_OTHER_COMPANY_MESSAGE);
        }
        if (card.status !== 'confirmed') {
          throw new AppError('VALIDATION_FAILED', SALE_NOT_CONFIRMED_MESSAGE);
        }
      }
      const paymentNumber = await allocateNumber('payment', { db: client });
      const id = await repo.insertPayment(client, {
        paymentNumber,
        companyId: input.companyId,
        salesCardId: input.salesCardId ?? null,
        amount: input.amount,
        mode: input.mode,
        referenceNo: input.referenceNo ?? null,
        receivedBy: actor.id,
        receivedAt: input.receivedAt,
        notes: input.notes ?? null,
      });
      const row = await repo.findPayment(client, id);
      if (row === null) {
        throw new AppError('INTERNAL', 'The payment could not be read back — nothing was lost, try again.');
      }
      return toPayment(row);
    });
  }

  /**
   * POST /v1/payments/:id/void (§11: OWNER ONLY — the route's door check
   * has already refused every rep). Reason required; void, never delete,
   * and the number stays — the document existed, the ledger says so. The
   * balance reversal is derived: v_company_balances stops subtracting the
   * row the moment its status leaves 'collected', and a CASH payment also
   * leaves v_employee_expected_cash the same way — the view filters
   * status as well as mode, so a void never leaves the rep an expectation
   * he cannot satisfy.
   */
  async function voidPayment(actor: Actor, paymentId: string, reason: string): Promise<PaymentRecord> {
    return withTransaction(async (client) => {
      const locked = await repo.lockPayment(client, paymentId);
      if (locked === null) throw new AppError('NOT_FOUND', NOT_FOUND_MESSAGE);
      if (locked.status === 'void') {
        throw new AppError('ILLEGAL_TRANSITION', ALREADY_VOID_MESSAGE);
      }
      await repo.voidPayment(client, paymentId, actor.id, reason);
      const row = await repo.findPayment(client, paymentId);
      if (row === null) {
        throw new AppError('INTERNAL', 'The payment could not be read back — nothing was lost, try again.');
      }
      return toPayment(row);
    });
  }

  return {
    listPayments,
    createPayment,
    voidPayment,
  };
}

export type PaymentsService = ReturnType<typeof createPaymentsService>;
