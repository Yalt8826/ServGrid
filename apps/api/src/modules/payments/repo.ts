import type { Db } from '../auth/repo.js';
import type { ScopePredicate } from '../../plugins/rbac.js';

/**
 * Payments SQL (PLAN-BACKEND.md §11, PLAN-DATA-MODEL.md §3.5). Every
 * function takes its executor explicitly — the Pool for autocommit reads,
 * or the transaction client of a caller's `withTransaction` (the companies
 * and sales repos' rule).
 *
 * THE one rule this file exists to keep, same as sales/repo.ts: the rep's
 * scope is a WHERE fragment (`payment` × `own` — `received_by = $n`,
 * plugins/rbac.ts) composed into the LIST's query, so pagination composes
 * with scoping instead of competing with it. The void takes the row lock
 * first (the jobs module's transition precedent, §6.3); its WHO may act is
 * a door check at the route (owner only), not a scope on the query.
 *
 * Nothing here computes a balance: `v_company_balances` (migration 018)
 * subtracts `SUM(collected payments)` on its own, so a void is one UPDATE
 * and the reversal is the view's business — derived money is never stored.
 */

/** The one projection — §11 has no per-role split on payment rows (rep and owner read the same row; the dispatcher holds no cell at all). */
const PAYMENT_COLUMNS = `p.id, p.payment_number, p.company_id, p.sales_card_id,
  p.amount::text AS amount, p.mode::text AS mode, p.reference_no,
  p.received_by, p.received_at, p.business_date::text AS business_date,
  p.status::text AS status, p.voided_at, p.voided_by, p.void_reason, p.notes, p.version`;

export interface PaymentRow {
  id: string;
  payment_number: string;
  company_id: string;
  sales_card_id: string | null;
  amount: string;
  mode: string;
  reference_no: string | null;
  received_by: string;
  received_at: Date;
  business_date: string;
  status: string;
  voided_at: Date | null;
  voided_by: string | null;
  void_reason: string | null;
  notes: string | null;
  version: number;
}

export async function findPayment(db: Db, paymentId: string): Promise<PaymentRow | null> {
  const r = await db.query<PaymentRow>(
    `SELECT ${PAYMENT_COLUMNS} FROM payments p WHERE p.id = $1`,
    [paymentId],
  );
  return r.rows[0] ?? null;
}

/** The row lock a void holds — the status check and the write run under it (§6.3's shape). */
export async function lockPayment(db: Db, paymentId: string): Promise<PaymentRow | null> {
  const r = await db.query<PaymentRow>(
    `SELECT ${PAYMENT_COLUMNS} FROM payments p WHERE p.id = $1 FOR UPDATE OF p`,
    [paymentId],
  );
  return r.rows[0] ?? null;
}

/**
 * POST /v1/payments — the collected row. The number is allocated at CREATE
 * by the caller (`next_in_sequence('payment:2627')` inside the caller's
 * transaction — lib/sequences.ts), because payments are not drafted: there
 * is no pending state to allocate at (§3.5). `business_date` is the DB's
 * generated column — the server never derives an IST day in JavaScript.
 */
export async function insertPayment(
  db: Db,
  input: {
    paymentNumber: string;
    companyId: string;
    salesCardId: string | null;
    amount: string;
    mode: string;
    referenceNo: string | null;
    receivedBy: string;
    receivedAt: string;
    notes: string | null;
  },
): Promise<string> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO payments
       (payment_number, company_id, sales_card_id, amount, mode, reference_no,
        received_by, received_at, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id`,
    [
      input.paymentNumber,
      input.companyId,
      input.salesCardId,
      input.amount,
      input.mode,
      input.referenceNo,
      input.receivedBy,
      input.receivedAt,
      input.notes,
    ],
  );
  return r.rows[0]!.id;
}

/**
 * POST /v1/payments/:id/void — the reversal. Void, never DELETE: the row
 * and its number stay, the reason and who stay, and v_company_balances
 * (which subtracts only status = 'collected') stops counting it on its
 * own. A voided CASH payment also drops out of v_employee_expected_cash,
 * which filters `status = 'collected'` as well as `mode = 'cash'` — a void
 * must not leave the rep an expectation he can never satisfy.
 */
export async function voidPayment(db: Db, paymentId: string, voidedBy: string, reason: string): Promise<void> {
  await db.query(
    `UPDATE payments
     SET status = 'void', voided_at = now(), voided_by = $2, void_reason = $3
     WHERE id = $1`,
    [paymentId, voidedBy, reason],
  );
}

// ── the list (§11 GET /v1/payments — the Collected tab) ─────────────────────

export interface PaymentListCursor {
  /** Full-precision `created_at` as ISO text (the keyset's left column). */
  createdAt: string;
  id: string;
}

export interface PaymentListPage {
  rows: Array<PaymentRow & { created_at_text: string }>;
  /** True when `limit + 1` rows existed — the caller paginates. */
  hasMore: boolean;
}

/**
 * Keyset page over `(created_at, id) DESC` — the sales and companies
 * lists' key, for the same reasons: `created_at` never updates and the
 * uuid breaks ties. `scope` is the rbac predicate (`payment` × `read`):
 * null for the owner, `received_by = :actor` for a rep — INSIDE the WHERE,
 * so pagination composes with scoping instead of competing with it.
 */
export async function listPayments(
  db: Db,
  scope: ScopePredicate | null,
  cursor: PaymentListCursor | null,
  limit: number,
): Promise<PaymentListPage> {
  const values: unknown[] = [];
  if (scope !== null) {
    values.push(...scope.params);
  }
  const scopeClause = scope === null ? '' : ` AND (${scope.sql})`;
  if (cursor !== null) {
    values.push(cursor.createdAt);
    const atParam = values.length;
    values.push(cursor.id);
    const idParam = values.length;
    values.push(limit + 1);
    const limitParam = values.length;
    const r = await db.query<PaymentRow & { created_at_text: string }>(
      `SELECT ${PAYMENT_COLUMNS}, to_json(p.created_at)#>>'{}' AS created_at_text
       FROM payments p
       WHERE (p.created_at, p.id) < ($${atParam}::timestamptz, $${idParam}::uuid)${scopeClause}
       ORDER BY p.created_at DESC, p.id DESC
       LIMIT $${limitParam}`,
      values,
    );
    return { rows: r.rows, hasMore: r.rows.length > limit };
  }
  values.push(limit + 1);
  const limitParam = values.length;
  const r = await db.query<PaymentRow & { created_at_text: string }>(
    `SELECT ${PAYMENT_COLUMNS}, to_json(p.created_at)#>>'{}' AS created_at_text
     FROM payments p
     WHERE true${scopeClause}
     ORDER BY p.created_at DESC, p.id DESC
     LIMIT $${limitParam}`,
    values,
  );
  return { rows: r.rows, hasMore: r.rows.length > limit };
}

/** The account must exist and be active before the INSERT, so the FK never surfaces as a 500 (the sales repo's shape). */
export async function companyExists(db: Db, companyId: string): Promise<boolean> {
  const r = await db.query<{ id: string }>('SELECT id FROM companies WHERE id = $1 AND is_active', [companyId]);
  return r.rows.length > 0;
}

/**
 * The sale a payload points at, if any. The payment's `sales_card_id` is
 * optional (NULL = on-account), and a payload that does name one must name
 * a CONFIRMED card of the SAME account: a draft never moved the balance
 * and a void was reversed, so a collection "against" either would misstate
 * the ledger it documents.
 */
export async function findSalesCardForPayment(
  db: Db,
  salesCardId: string,
): Promise<{ company_id: string; status: string } | null> {
  const r = await db.query<{ company_id: string; status: string }>(
    'SELECT company_id, status::text AS status FROM sales_cards WHERE id = $1',
    [salesCardId],
  );
  return r.rows[0] ?? null;
}
