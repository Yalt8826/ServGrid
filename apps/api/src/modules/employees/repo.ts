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
