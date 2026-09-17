import type { Db } from '../auth/repo.js';
import type { ServiceCallOutcome } from '@servgrid/shared';

/**
 * Service calls SQL (migration 023's `v_service_calls`). The cycle — due
 * six months after the last completed job — is derived there, and so is
 * the push-back's effect, so this module never recomputes a date and never
 * compares a phone clock to a business day.
 *
 * Only the follow-up is written, and it is an INSERT: the calls are a
 * history, and "the latest one wins" is the view's read, not an UPDATE
 * that loses what the previous dispatcher was told.
 */
const SERVICE_CALL_COLUMNS = `
  v.customer_id, v.customer_name, v.phone, v.area,
  v.last_service_on::text AS last_service_on,
  v.last_job_number, v.last_job_title,
  v.due_on::text AS due_on, v.pushed_to::text AS pushed_to,
  v.remind_on::text AS remind_on, v.days_due, v.open_jobs,
  v.last_outcome, v.last_note, v.last_called_by`;

export interface ServiceCallRow {
  customer_id: string;
  customer_name: string;
  phone: string;
  area: string | null;
  last_service_on: string;
  last_job_number: string | null;
  last_job_title: string | null;
  due_on: string;
  pushed_to: string | null;
  remind_on: string;
  days_due: number;
  open_jobs: number;
  last_outcome: ServiceCallOutcome | null;
  last_note: string | null;
  last_called_by: string | null;
}

/**
 * The two lists, in one round trip each. `due` is everybody the view calls
 * due — most overdue first. `pushed` is everybody whose latest call moved
 * the reminder into the future, soonest first; a reminder pushed out is
 * still worth seeing, because "I said I would ring them in December" is a
 * promise the office has to keep.
 */
export async function listDue(db: Db): Promise<ServiceCallRow[]> {
  const r = await db.query<ServiceCallRow>(
    `SELECT ${SERVICE_CALL_COLUMNS} FROM v_service_calls v
      WHERE v.is_due
      ORDER BY v.days_due DESC, v.customer_name`,
  );
  return r.rows;
}

export async function listPushed(db: Db): Promise<ServiceCallRow[]> {
  const r = await db.query<ServiceCallRow>(
    // `pushed_to >= due_on` is what makes the call GOVERN the reminder: the
    // view takes the later of the two dates, so a call that asked to ring
    // sooner than the cycle says changes nothing and is not a promise the
    // office owes anybody (it was still recorded — the history keeps it).
    `SELECT ${SERVICE_CALL_COLUMNS} FROM v_service_calls v
      WHERE NOT v.is_due
        AND v.pushed_to IS NOT NULL
        AND v.pushed_to >= v.due_on
      ORDER BY v.pushed_to, v.customer_name`,
  );
  return r.rows;
}

/** The row a write answers with — the only read that locks nothing. */
export async function serviceCallForCustomer(db: Db, customerId: string): Promise<ServiceCallRow | null> {
  const r = await db.query<ServiceCallRow>(
    `SELECT ${SERVICE_CALL_COLUMNS} FROM v_service_calls v WHERE v.customer_id = $1`,
    [customerId],
  );
  return r.rows[0] ?? null;
}

export interface FollowUpInput {
  outcome: ServiceCallOutcome;
  note: string | null;
  nextCallOn: string | null;
}

/**
 * One call, recorded. `created_at` is the server's clock and every read
 * compares that instant against the last completion — never the business
 * date, which would tie "is this call newer than the job" to IST midnight.
 */
export async function insertFollowUp(
  db: Db,
  customerId: string,
  createdBy: string,
  input: FollowUpInput,
): Promise<void> {
  await db.query(
    `INSERT INTO customer_follow_ups (customer_id, outcome, note, next_call_on, created_by)
     VALUES ($1, $2, $3, $4, $5)`,
    [customerId, input.outcome, input.note, input.nextCallOn, createdBy],
  );
}
