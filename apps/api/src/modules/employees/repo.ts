import type { Role } from '@servgrid/shared';
import type { Db } from '../auth/repo.js';

/**
 * Employee-admin SQL (PLAN-BACKEND.md §2 module shape, §4.1 endpoints).
 * Every function takes its executor explicitly — the Pool for autocommit
 * reads, or the transaction client of a caller's `withTransaction` — the
 * same rule auth/repo.ts runs under. Employee primitives that auth already
 * owns (find-by-username/id, revoke-all-tokens) are imported from there,
 * never duplicated.
 */

export interface EmployeeAdminRecord {
  id: string;
  username: string;
  full_name: string;
  phone: string | null;
  role: Role;
  is_active: boolean;
  must_change_password: boolean;
  last_login_at: Date | null;
  created_at: Date;
  version: number;
}

/**
 * No `password_hash` in this projection: the admin endpoints never verify
 * a password, and a hash a query did not fetch is a hash that cannot leak.
 */
const ADMIN_COLUMNS = `id, username::text, full_name, phone, role, is_active,
  must_change_password, last_login_at, created_at, version`;

export interface EmployeeListFilter {
  roles?: Role[];
  isActive?: boolean;
}

/** The roster (§4.1 GET /v1/employees) — newest not interesting; username order is the phone-book order the owner scrolls. */
export async function listEmployees(db: Db, filter: EmployeeListFilter): Promise<EmployeeAdminRecord[]> {
  const clauses: string[] = [];
  const values: unknown[] = [];
  if (filter.roles && filter.roles.length > 0) {
    values.push(filter.roles);
    clauses.push(`role = ANY($${values.length}::employee_role[])`);
  }
  if (filter.isActive !== undefined) {
    values.push(filter.isActive);
    clauses.push(`is_active = $${values.length}`);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const r = await db.query<EmployeeAdminRecord>(
    `SELECT ${ADMIN_COLUMNS} FROM employees ${where} ORDER BY username`,
    values,
  );
  return r.rows;
}

export async function findEmployeeAdminById(db: Db, id: string): Promise<EmployeeAdminRecord | null> {
  const r = await db.query<EmployeeAdminRecord>(
    `SELECT ${ADMIN_COLUMNS} FROM employees WHERE id = $1`,
    [id],
  );
  return r.rows[0] ?? null;
}

export interface InsertEmployee {
  username: string;
  passwordHash: string;
  fullName: string;
  phone: string | null;
  role: Role;
  createdBy: string;
}

/**
 * Owner-created account (§4.1 POST). `must_change_password` relies on the
 * schema default (true) — a temporary credential is the only kind an
 * owner can hand out, so the column is not parameterised here.
 */
export async function insertEmployee(db: Db, e: InsertEmployee): Promise<EmployeeAdminRecord> {
  const r = await db.query<EmployeeAdminRecord>(
    `INSERT INTO employees (username, password_hash, full_name, phone, role, created_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING ${ADMIN_COLUMNS}`,
    [e.username, e.passwordHash, e.fullName, e.phone, e.role, e.createdBy],
  );
  return r.rows[0]!;
}

export interface UpdateEmployeeFields {
  fullName?: string;
  /** `undefined` leaves the column alone; `null` clears it — a PATCH that omits the field is not a PATCH that clears it. */
  phone?: string | null;
  role?: Role;
  isActive?: boolean;
}

/** Field update under the caller's If-Match check; the touch trigger bumps `version`. */
export async function updateEmployeeFields(
  db: Db,
  id: string,
  fields: UpdateEmployeeFields,
): Promise<EmployeeAdminRecord> {
  const sets: string[] = [];
  const values: unknown[] = [];
  if (fields.fullName !== undefined) {
    values.push(fields.fullName);
    sets.push(`full_name = $${values.length}`);
  }
  if (fields.phone !== undefined) {
    values.push(fields.phone);
    sets.push(`phone = $${values.length}`);
  }
  if (fields.role !== undefined) {
    values.push(fields.role);
    sets.push(`role = $${values.length}`);
  }
  if (fields.isActive !== undefined) {
    values.push(fields.isActive);
    sets.push(`is_active = $${values.length}`);
  }
  values.push(id);
  const r = await db.query<EmployeeAdminRecord>(
    `UPDATE employees SET ${sets.join(', ')} WHERE id = $${values.length}
     RETURNING ${ADMIN_COLUMNS}`,
    values,
  );
  return r.rows[0]!;
}

/**
 * Owner reset (POST /v1/employees/:id/password) and the break-glass CLI:
 * the new hash lands with `must_change_password = true` — the opposite of
 * auth/repo.updatePassword, where the employee just proved knowledge of
 * the current secret and the flag must clear.
 */
export async function updatePasswordForReset(db: Db, employeeId: string, passwordHash: string): Promise<void> {
  await db.query(
    'UPDATE employees SET password_hash = $2, must_change_password = true WHERE id = $1',
    [employeeId, passwordHash],
  );
}

export interface DeviceDiagnosticRecord {
  id: string;
  install_id: string;
  manufacturer: string | null;
  model: string | null;
  os_version: string | null;
  app_version: string | null;
  location_permission: 'none' | 'foreground' | 'background';
  battery_opt_exempt: boolean;
  autostart_confirmed: boolean;
  notifications_enabled: boolean;
  last_seen_at: Date | null;
  is_active: boolean;
}

const DEVICE_COLUMNS = `id, install_id, manufacturer, model, os_version, app_version,
  location_permission, battery_opt_exempt, autostart_confirmed, notifications_enabled,
  last_seen_at, is_active`;

/** Device diagnostics for the owner's detail view (§4.1 GET /v1/employees/:id). */
export async function listDevices(db: Db, employeeId: string): Promise<DeviceDiagnosticRecord[]> {
  const r = await db.query<DeviceDiagnosticRecord>(
    `SELECT ${DEVICE_COLUMNS} FROM devices WHERE employee_id = $1 ORDER BY last_seen_at DESC NULLS LAST`,
    [employeeId],
  );
  return r.rows;
}

// ── deactivation preconditions (T4.5, PLAN-BACKEND.md §4.1, PLAN.md §5, PLAN-GAPS.md G15) ──
//
// One query per blocking condition, each returning the rows the 409 must
// name — the owner's screen renders `details` as the list of things to
// reassign or clear, so a row that cannot be named cannot be cleared.
// Every function takes its executor explicitly and runs inside the
// caller's transaction, so the check and the write it guards read one
// database state.

/** An open job held by the employee — condition 1. Anything not yet completed or cancelled. */
export interface OpenJobRow {
  id: string;
  job_number: string;
  title: string;
  status: string;
}

export async function listOpenJobs(db: Db, employeeId: string): Promise<OpenJobRow[]> {
  const r = await db.query<OpenJobRow>(
    `SELECT id::text, job_number, title, status::text
     FROM job_cards
     WHERE assigned_to = $1 AND status NOT IN ('completed', 'cancelled')
     ORDER BY job_number`,
    [employeeId],
  );
  return r.rows;
}

/** A company he owns — condition 2. Reassignment is `owner_rep_id = NULL` (house account) or another rep. */
export interface OwnedCompanyRow {
  id: string;
  name: string;
}

export async function listOwnedCompanies(db: Db, employeeId: string): Promise<OwnedCompanyRow[]> {
  const r = await db.query<OwnedCompanyRow>(
    `SELECT id::text, name::text
     FROM companies
     WHERE owner_rep_id = $1
     ORDER BY name`,
    [employeeId],
  );
  return r.rows;
}

/** A cash reconciliation the owner has not confirmed — condition 3, the easy one to omit. */
export interface UnconfirmedCashRow {
  id: string;
  business_date: string;
  status: string;
  declared_amount: string;
}

export async function listUnconfirmedCash(db: Db, employeeId: string): Promise<UnconfirmedCashRow[]> {
  const r = await db.query<UnconfirmedCashRow>(
    `SELECT id::text, business_date::text, status::text, declared_amount::text
     FROM cash_reconciliations
     WHERE employee_id = $1 AND status IN ('submitted', 'disputed')
     ORDER BY business_date`,
    [employeeId],
  );
  return r.rows;
}

/**
 * A drain claim with no stored verdict — the fourth condition, role
 * changes only. The outbox itself lives on the handset and nothing
 * server-side can count its queued rows; what the server CAN see is the
 * drain ledger: while `POST /v1/sync/batch` works through an operation,
 * the idempotency middleware holds a claim row with `response_status`
 * NULL, and a drain that died mid-flight leaves exactly that row behind
 * for the retry. Either way the queue is not empty and the role must not
 * flip — §4.1's client-side drain-first rule stays the primary
 * guarantee; this is the server's backstop against the one state it can
 * actually observe.
 */
export interface UndrainedOperationRow {
  key: string;
  endpoint: string;
  created_at: Date;
}

export async function listUndrainedOperations(db: Db, employeeId: string): Promise<UndrainedOperationRow[]> {
  const r = await db.query<UndrainedOperationRow>(
    `SELECT key, endpoint, created_at
     FROM idempotency_keys
     WHERE employee_id = $1 AND response_status IS NULL
     ORDER BY created_at`,
    [employeeId],
  );
  return r.rows;
}

/**
 * The deactivation consequence chain (G15): his handsets drop out of
 * device diagnostics and any future locate-now. A `completed`/`cancelled`
 * style soft flip — the rows stay, `is_active` was never a delete. The
 * touch trigger keeps `updated_at` honest for the sync cursor.
 */
export async function deactivateDevices(db: Db, employeeId: string): Promise<number> {
  const r = await db.query<{ id: string }>(
    `UPDATE devices SET is_active = false
     WHERE employee_id = $1 AND is_active
     RETURNING id`,
    [employeeId],
  );
  return r.rows.length;
}

export interface AuditInsert {
  action: string;
  employeeId: string | null;
  actor: string;
  details?: unknown;
}

/**
 * Append-only audit row (migration 005a). The one writer today is the
 * break-glass reset; later security-relevant paths extend `action`, never
 * the shape — nothing updates these rows once written.
 */
export async function insertAuditRow(db: Db, a: AuditInsert): Promise<string> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO audit_log (action, employee_id, actor, details)
     VALUES ($1, $2, $3, $4::jsonb)
     RETURNING id`,
    [a.action, a.employeeId, a.actor, a.details === undefined ? null : JSON.stringify(a.details)],
  );
  return r.rows[0]!.id;
}
