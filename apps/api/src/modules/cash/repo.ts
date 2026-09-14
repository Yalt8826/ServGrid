import type { Db } from '../auth/repo.js';

/**
 * Cash handover SQL (PLAN-BACKEND.md §10, PLAN-DATA-MODEL.md §3.7). Every
 * function takes its executor explicitly — the Pool for autocommit reads,
 * or the transaction client of a caller's `withTransaction`, the same rule
 * the other repos run under.
 *
 * The EMPLOYEE-facing queries read the `cash_reconciliations` TABLE and
 * only the declaration-side columns (§3.7: only the declaration is
 * stored; what he *should* have handed over is derived). That split is
 * what keeps `expected_cash` out of his responses by construction —
 * T1.11's test asserts the key's absence on the serialised body. The
 * owner's half (Phase 4, T4.2, below) is where the split ends: the queue
 * reads `v_cash_reconciliation_queue`, whose whole point is the derived
 * figure beside the declared one.
 */

/** `reconciliation_status` (migration 002), as pg returns it. */
export type ReconciliationStatus = 'submitted' | 'confirmed' | 'disputed';

/**
 * The row as the employee endpoints read it. `business_date` and
 * `declared_amount` are cast to text here — a `date` parsed by pg becomes
 * a timezone-shifted JS Date, and money crosses the wire as a decimal
 * string (§3.4), so the cast happens once, in SQL, where both facts live.
 */
export interface HandoverRow {
  id: string;
  employee_id: string;
  business_date: string;
  declared_amount: string;
  employee_note: string | null;
  status: ReconciliationStatus;
  declared_at: Date;
  version: number;
}

/** The declaration-side column list every employee-facing query selects. */
const HANDOVER_COLUMNS = `id, employee_id, business_date::text AS business_date,
  declared_amount::text AS declared_amount, employee_note, status,
  declared_at, version`;

/**
 * The two bounds of `businessDate` (§10: not in the future, not more than
 * 7 days back), computed from `business_date(now())` — the same IST
 * definition the generated columns use — rather than the server's local
 * clock, which may be neither IST nor UTC-midnight-aligned.
 */
export async function businessDateBounds(db: Db): Promise<{ today: string; oldest: string }> {
  const r = await db.query<{ today: string; oldest: string }>(
    `SELECT business_date(now())::text AS today,
            (business_date(now()) - 7)::text AS oldest`,
  );
  return r.rows[0]!;
}

export interface DeclarationInsert {
  employeeId: string;
  businessDate: string;
  declaredAmount: string;
  note: string | null;
}

/**
 * The declaration itself. The UNIQUE (employee_id, business_date)
 * constraint is the idempotence backstop: the retry-after-offline path
 * leans on it rather than trusting a check-then-insert, and the loser of
 * a race surfaces as 23505 for the service to translate (§10).
 */
export async function insertDeclaration(db: Db, input: DeclarationInsert): Promise<HandoverRow> {
  const r = await db.query<HandoverRow>(
    `INSERT INTO cash_reconciliations (employee_id, business_date, declared_amount, declared_at, employee_note)
     VALUES ($1, $2::date, $3::numeric, now(), $4)
     RETURNING ${HANDOVER_COLUMNS}`,
    [input.employeeId, input.businessDate, input.declaredAmount, input.note],
  );
  return r.rows[0]!;
}

/** `SELECT … FOR UPDATE` — the lock every amendment holds to commit, so a
 * concurrent owner confirm and an employee amend serialise on the row. */
export async function lockById(db: Db, id: string): Promise<HandoverRow | null> {
  const r = await db.query<HandoverRow>(
    `SELECT ${HANDOVER_COLUMNS} FROM cash_reconciliations WHERE id = $1 FOR UPDATE`,
    [id],
  );
  return r.rows[0] ?? null;
}

/** The row as a reopen finds it, carrying the sign-off figures the audit
 * row must preserve. Same `FOR UPDATE` lock — a concurrent confirm and
 * reopen serialise here, so `previousStatus` cannot go stale between the
 * check and the reversal. */
export interface ReopenLock extends HandoverRow {
  confirmed_amount: string | null;
  owner_note: string | null;
}

export async function lockForReopen(db: Db, id: string): Promise<ReopenLock | null> {
  const r = await db.query<ReopenLock>(
    `SELECT ${HANDOVER_COLUMNS}, confirmed_amount::text AS confirmed_amount, owner_note
     FROM cash_reconciliations WHERE id = $1 FOR UPDATE`,
    [id],
  );
  return r.rows[0] ?? null;
}

export interface AmendmentPatch {
  declaredAmount?: string;
  note?: string;
}

/**
 * The correction (§10). Only the sent fields change; the touch trigger
 * stamps `updated_at` and bumps `version`, which is what the next
 * `If-Match` must carry. The caller has already locked the row, checked
 * `status = 'submitted'` and written the audit trail — this is the last
 * write in that transaction, not a decision.
 */
export async function amend(db: Db, id: string, patch: AmendmentPatch): Promise<HandoverRow> {
  const sets: string[] = [];
  const values: unknown[] = [id];
  if (patch.declaredAmount !== undefined) {
    values.push(patch.declaredAmount);
    sets.push(`declared_amount = $${values.length}::numeric`);
  }
  if (patch.note !== undefined) {
    values.push(patch.note);
    sets.push(`employee_note = $${values.length}`);
  }
  const r = await db.query<HandoverRow>(
    `UPDATE cash_reconciliations SET ${sets.join(', ')}
     WHERE id = $1
     RETURNING ${HANDOVER_COLUMNS}`,
    values,
  );
  return r.rows[0]!;
}

/**
 * Own history, newest day first (§10 GET /me). Keyed off the token's
 * employee id — there is no path here that takes an employee id from the
 * request, which is what makes "a technician cannot read another's
 * handovers" structural rather than a filter someone can forget.
 */
export async function listForEmployee(db: Db, employeeId: string): Promise<HandoverRow[]> {
  const r = await db.query<HandoverRow>(
    `SELECT ${HANDOVER_COLUMNS} FROM cash_reconciliations
     WHERE employee_id = $1
     ORDER BY business_date DESC, declared_at DESC`,
    [employeeId],
  );
  return r.rows;
}

/**
 * The audit trail of a self-correction (§10: the prior amount goes to the
 * audit trail — a self-corrected figure is exactly the kind of thing
 * someone will want to look at later). Append-only `audit_log`
 * (migration 005z), written inside the amendment's transaction so a
 * rolled-back amendment leaves no trace and a committed one leaves both
 * figures.
 */
export async function insertAmendmentAudit(
  db: Db,
  e: {
    handoverId: string;
    employeeId: string;
    actorId: string;
    businessDate: string;
    previousAmount: string;
    declaredAmount?: string;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO audit_log (action, employee_id, actor, details)
     VALUES ('cash.declaration.amended', $1, $2, $3::jsonb)`,
    [
      e.employeeId,
      e.actorId,
      JSON.stringify({
        handoverId: e.handoverId,
        businessDate: e.businessDate,
        previousAmount: e.previousAmount,
        declaredAmount: e.declaredAmount,
      }),
    ],
  );
}

// ── the owner's half (Phase 4, T4.2) ────────────────────────────────────────

/** The flag `v_cash_reconciliation_queue` emits (PLAN-DATA-MODEL.md §4). */
export type QueueFlag = 'missing_submission' | 'no_expected_cash' | 'variance' | 'match';

/**
 * One row of the owner's queue as SQL returns it. Money and the date are
 * cast to text in SQL for the same reasons `HandoverRow` is — and
 * `variance` is signed (negative = short), which `moneyString` on the
 * wire would refuse.
 *
 * `declaration_id` is the `cash_reconciliations.id` the confirm/dispute/
 * reopen actions name. The view does not carry it, so the query LEFT
 * JOINs the table on the unique (employee, business_date) pair — LEFT,
 * because a `missing_submission` day has no declaration row, and dropping
 * that join's null side is exactly the defect the FULL OUTER JOIN exists
 * to prevent.
 */
export interface QueueRow {
  declaration_id: string | null;
  employee_id: string;
  employee_name: string;
  role: 'owner' | 'dispatcher' | 'technician' | 'sales_rep';
  business_date: string;
  expected_cash: string | null;
  declared_amount: string | null;
  declared_at: Date | null;
  declaration_status: ReconciliationStatus | null;
  employee_note: string | null;
  variance: string | null;
  flag: QueueFlag;
}

export interface QueueFilters {
  from: string;
  to: string;
  flags?: QueueFlag[];
  role?: 'technician' | 'sales_rep';
}

/** The queue's column list, shared by the range scan and the single-row read-back. */
const QUEUE_COLUMNS = `cr.id AS declaration_id,
  q.employee_id, q.employee_name, e.role,
  q.business_date::text AS business_date,
  q.expected_cash::text AS expected_cash,
  q.declared_amount::text AS declared_amount,
  q.declared_at, q.declaration_status, q.employee_note,
  q.variance::text AS variance, q.flag`;

/** The view LEFT JOINed back to the declaration table (see `QueueRow`). */
const QUEUE_FROM = `FROM v_cash_reconciliation_queue q
  JOIN employees e ON e.id = q.employee_id
  LEFT JOIN cash_reconciliations cr
    ON cr.employee_id = q.employee_id
   AND cr.business_date = q.business_date`;

/**
 * The queue read (§10 GET /v1/cash/queue). The date range drives the WHERE
 * clause and the FULL OUTER JOIN inside the view supplies the rows —
 * including `missing_submission` days that exist on the expected-cash side
 * alone. Filtering on anything declaration-shaped here (status, declared_at)
 * is the "If it fails" clause of the brief: it would silently hide the one
 * row the feature exists to catch.
 *
 * Order: `missing_submission` first regardless of date, then newest day,
 * then name — the scan order the owner's morning is.
 */
export async function queueRows(db: Db, f: QueueFilters): Promise<QueueRow[]> {
  const conditions = ['q.business_date BETWEEN $1 AND $2'];
  const values: unknown[] = [f.from, f.to];
  if (f.flags !== undefined) {
    values.push(f.flags);
    conditions.push(`q.flag = ANY($${values.length}::text[])`);
  }
  if (f.role !== undefined) {
    values.push(f.role);
    conditions.push(`e.role = $${values.length}`);
  }
  const r = await db.query<QueueRow>(
    `SELECT ${QUEUE_COLUMNS}
     ${QUEUE_FROM}
     WHERE ${conditions.join(' AND ')}
     ORDER BY (q.flag = 'missing_submission') DESC, q.business_date DESC, q.employee_name ASC`,
    values,
  );
  return r.rows;
}

/**
 * The queue row for one declaration's (employee, business_date), read back
 * after confirm/dispute/reopen so the owner's screen gets the refreshed
 * figures — the flag and variance recompute in the view, not here.
 */
export async function queueRowFor(
  db: Db,
  employeeId: string,
  businessDate: string,
): Promise<QueueRow | null> {
  const r = await db.query<QueueRow>(
    `SELECT ${QUEUE_COLUMNS}
     ${QUEUE_FROM}
     WHERE q.employee_id = $1 AND q.business_date = $2::date`,
    [employeeId, businessDate],
  );
  return r.rows[0] ?? null;
}

/**
 * The default range (T4.2): today, yesterday (the default `to`), and 14
 * days before yesterday (the default `from`) — computed from
 * `business_date(now())`, the same IST definition everything else in the
 * module leans on, never the server's local clock.
 */
export async function queueDateDefaults(db: Db): Promise<{ today: string; to: string; from: string }> {
  const r = await db.query<{ today: string; to: string; from: string }>(
    `SELECT business_date(now())::text AS today,
            (business_date(now()) - 1)::text AS "to",
            (business_date(now()) - 14)::text AS "from"`,
  );
  return r.rows[0]!;
}

/** Confirm (§10): status → confirmed, the owner's figure, who and when. */
export async function confirmDeclaration(
  db: Db,
  id: string,
  confirmedAmount: string,
  actorId: string,
): Promise<HandoverRow> {
  const r = await db.query<HandoverRow>(
    `UPDATE cash_reconciliations
     SET status = 'confirmed', confirmed_amount = $2::numeric,
         confirmed_by = $3, confirmed_at = now()
     WHERE id = $1
     RETURNING ${HANDOVER_COLUMNS}`,
    [id, confirmedAmount, actorId],
  );
  return r.rows[0]!;
}

/** Dispute (§10): status → disputed, the note the DB CHECK demands, who and when. */
export async function disputeDeclaration(
  db: Db,
  id: string,
  ownerNote: string,
  actorId: string,
): Promise<HandoverRow> {
  const r = await db.query<HandoverRow>(
    `UPDATE cash_reconciliations
     SET status = 'disputed', owner_note = $2, confirmed_by = $3, confirmed_at = now()
     WHERE id = $1
     RETURNING ${HANDOVER_COLUMNS}`,
    [id, ownerNote, actorId],
  );
  return r.rows[0]!;
}

/**
 * Reopen (§10): returns the row to submitted — the CHECK
 * `cash_submitted_means_unanswered` forces the confirmation timestamp out
 * with the status, and the sign-off's figures go with it. The reversal
 * itself is kept on the row (reopened_at/by/reason) and in the audit
 * trail, so undoing a sign-off never means losing what it said.
 */
export async function reopenDeclaration(
  db: Db,
  id: string,
  actorId: string,
  reason: string,
): Promise<HandoverRow> {
  const r = await db.query<HandoverRow>(
    `UPDATE cash_reconciliations
     SET status = 'submitted', confirmed_amount = NULL, confirmed_at = NULL,
         owner_note = NULL, reopened_at = now(), reopened_by = $2, reopen_reason = $3
     WHERE id = $1
     RETURNING ${HANDOVER_COLUMNS}`,
    [id, actorId, reason],
  );
  return r.rows[0]!;
}

// ── the day behind the expected figure (Phase 4, T4.9, §O2) ─────────────────

/**
 * "View the day" (UI/plan-2/07-OWNER.md §O2): the completions and cash
 * payments behind one queue row's expected figure. Both queries restate
 * exactly one side of `v_employee_expected_cash` (migration 018) for a
 * single (employee, business_date) — the filters must keep matching the
 * view's, or the day sheet's totals would not add up to the figure the
 * queue row shows and the owner would be reading two truths.
 *
 * CASH ONLY on both sides, for the reason the view gives: UPI, card,
 * cheque and transfer land in the company account and never pass through
 * anyone's hands, so they are not part of what the day's handover should
 * have contained.
 */

/** One cash completion, with the job that produced it. */
export interface DayCompletionRow {
  job_card_id: string;
  job_number: string;
  customer_name: string | null;
  work_summary: string;
  amount_collected: string;
  completed_at: Date;
}

/** One collected cash payment, with the account it came from. */
export interface DayPaymentRow {
  id: string;
  payment_number: string;
  company_name: string;
  amount: string;
  received_at: Date;
}

export async function dayCompletions(
  db: Db,
  employeeId: string,
  businessDate: string,
): Promise<DayCompletionRow[]> {
  const r = await db.query<DayCompletionRow>(
    `SELECT jc.job_card_id, j.job_number, c.name AS customer_name, jc.work_summary,
            jc.amount_collected::text AS amount_collected, jc.completed_at
     FROM job_completions jc
     JOIN job_cards j ON j.id = jc.job_card_id
     JOIN customers c ON c.id = j.customer_id
     WHERE jc.completed_by = $1 AND jc.business_date = $2::date AND jc.collection_mode = 'cash'
     ORDER BY jc.completed_at ASC, j.job_number ASC`,
    [employeeId, businessDate],
  );
  return r.rows;
}

export async function dayCashPayments(
  db: Db,
  employeeId: string,
  businessDate: string,
): Promise<DayPaymentRow[]> {
  const r = await db.query<DayPaymentRow>(
    `SELECT p.id, p.payment_number, co.name AS company_name,
            p.amount::text AS amount, p.received_at
     FROM payments p
     JOIN companies co ON co.id = p.company_id
     WHERE p.received_by = $1 AND p.business_date = $2::date
       AND p.mode = 'cash' AND p.status = 'collected'
     ORDER BY p.received_at ASC, p.payment_number ASC`,
    [employeeId, businessDate],
  );
  return r.rows;
}

/**
 * The two side totals, summed in SQL where the decimals live — the same
 * figures the view's GROUP BY produces, so sheet total and queue row
 * cannot disagree. Zero (not NULL) when a side is empty: a day made of
 * completions alone shows a payment total of 0.00, which is a fact, not
 * an absence.
 */
export async function dayTotals(
  db: Db,
  employeeId: string,
  businessDate: string,
): Promise<{ completionTotal: string; paymentTotal: string }> {
  const r = await db.query<{ completion_total: string; payment_total: string }>(
    `SELECT
       COALESCE((SELECT SUM(amount_collected) FROM job_completions
                 WHERE completed_by = $1 AND business_date = $2::date AND collection_mode = 'cash'),
                0::numeric(14,2))::text AS completion_total,
       COALESCE((SELECT SUM(amount) FROM payments
                 WHERE received_by = $1 AND business_date = $2::date
                   AND mode = 'cash' AND status = 'collected'),
                0::numeric(14,2))::text AS payment_total`,
    [employeeId, businessDate],
  );
  return { completionTotal: r.rows[0]!.completion_total, paymentTotal: r.rows[0]!.payment_total };
}

/** The employee's display name for the day sheet's header — or null when no such employee. */
export async function employeeNameOf(db: Db, employeeId: string): Promise<string | null> {
  const r = await db.query<{ full_name: string }>(
    `SELECT full_name FROM employees WHERE id = $1`,
    [employeeId],
  );
  return r.rows[0]?.full_name ?? null;
}

/**
 * The audit row the reopen is required to carry (§10: owner only, reason
 * required, audited). Same transaction as the reversal — a rolled-back
 * reopen leaves no trace, a committed one leaves both the decision and
 * what it reversed.
 */
export async function insertReopenAudit(
  db: Db,
  e: {
    handoverId: string;
    employeeId: string;
    actorId: string;
    businessDate: string;
    previousStatus: ReconciliationStatus;
    confirmedAmount: string | null;
    ownerNote: string | null;
    reason: string;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO audit_log (action, employee_id, actor, details)
     VALUES ('cash.reconciliation.reopened', $1, $2, $3::jsonb)`,
    [
      e.employeeId,
      e.actorId,
      JSON.stringify({
        handoverId: e.handoverId,
        businessDate: e.businessDate,
        previousStatus: e.previousStatus,
        confirmedAmount: e.confirmedAmount,
        ownerNote: e.ownerNote,
        reason: e.reason,
      }),
    ],
  );
}
