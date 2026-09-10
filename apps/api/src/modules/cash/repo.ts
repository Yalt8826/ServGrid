import type { Db } from '../auth/repo.js';

/**
 * Cash handover SQL (PLAN-BACKEND.md §10, PLAN-DATA-MODEL.md §3.7). Every
 * function takes its executor explicitly — the Pool for autocommit reads,
 * or the transaction client of a caller's `withTransaction`, the same rule
 * the other repos run under.
 *
 * The queries read the `cash_reconciliations` TABLE and only the
 * declaration-side columns (§3.7: only the declaration is stored; what he
 * *should* have handed over is derived — the queue view is the owner's,
 * Phase 4). No join to `v_cash_reconciliation_queue` exists here, so the
 * employee-facing response cannot leak `expected_cash` by construction —
 * T1.11's test asserts the key's absence on the serialised body, and this
 * column list is why it never appears in the first place.
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
