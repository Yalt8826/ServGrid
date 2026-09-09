import type { QueryResult, QueryResultRow } from 'pg';
import type { Role } from '@servgrid/shared';

/**
 * Auth SQL (PLAN-BACKEND.md §2: each module is routes/service/repo; no
 * ORM — hand-written queries). Every function takes its executor
 * explicitly: the Pool for autocommit reads, or the PoolClient of a
 * caller's transaction so multi-row writes (rotation, password change)
 * commit or roll back as one unit.
 */

/** Anything with `.query` — a `Pool` or the `PoolClient` of a transaction. */
export interface Db {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<R>>;
}

export interface EmployeeRecord {
  id: string;
  username: string;
  password_hash: string;
  full_name: string;
  phone: string | null;
  role: Role;
  is_active: boolean;
  must_change_password: boolean;
  last_login_at: Date | null;
}

const EMPLOYEE_COLUMNS = `id, username::text, password_hash, full_name, phone, role, is_active,
  must_change_password, last_login_at`;

export async function findEmployeeByUsername(db: Db, username: string): Promise<EmployeeRecord | null> {
  const r = await db.query<EmployeeRecord>(
    `SELECT ${EMPLOYEE_COLUMNS} FROM employees WHERE username = $1`,
    [username],
  );
  return r.rows[0] ?? null;
}

export async function findEmployeeById(db: Db, id: string): Promise<EmployeeRecord | null> {
  const r = await db.query<EmployeeRecord>(
    `SELECT ${EMPLOYEE_COLUMNS} FROM employees WHERE id = $1`,
    [id],
  );
  return r.rows[0] ?? null;
}

export interface DeviceUpsert {
  employeeId: string;
  installId: string;
  appVersion: string;
  osVersion: string;
  manufacturer: string;
  model: string;
}

/**
 * One row per install (PLAN-DATA-MODEL.md §3.1): a repeat `installId`
 * updates the diagnostics in place rather than adding a row. The login
 * payload's `platform` has no column here — migration 003 carries OS
 * version and manufacturer/model and deliberately nothing else; a
 * platform column would be an expand step when something reads it.
 */
export async function upsertDevice(db: Db, d: DeviceUpsert): Promise<string> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO devices (employee_id, install_id, app_version, os_version, manufacturer, model, last_seen_at)
     VALUES ($1, $2, $3, $4, $5, $6, now())
     ON CONFLICT (employee_id, install_id) DO UPDATE
       SET app_version = EXCLUDED.app_version,
           os_version = EXCLUDED.os_version,
           manufacturer = EXCLUDED.manufacturer,
           model = EXCLUDED.model,
           last_seen_at = now()
     RETURNING id`,
    [d.employeeId, d.installId, d.appVersion, d.osVersion, d.manufacturer, d.model],
  );
  return r.rows[0]!.id;
}

export interface RefreshTokenRecord {
  id: string;
  employee_id: string;
  device_id: string | null;
  issued_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
  replaced_by: string | null;
  /** From the join — the current role and active flag at refresh time. */
  role: Role;
  is_active: boolean;
}

/**
 * `FOR UPDATE OF rt` serialises two concurrent refreshes of the same
 * token: the second blocks until the first commits, then sees
 * `revoked_at` set — which is exactly the reuse-detection branch.
 */
export async function findRefreshTokenForUpdate(
  db: Db,
  tokenHash: string,
): Promise<RefreshTokenRecord | null> {
  const r = await db.query<RefreshTokenRecord>(
    `SELECT rt.id, rt.employee_id, rt.device_id, rt.issued_at, rt.expires_at, rt.revoked_at, rt.replaced_by,
            e.role, e.is_active
     FROM refresh_tokens rt
     JOIN employees e ON e.id = rt.employee_id
     WHERE rt.token_hash = $1
     FOR UPDATE OF rt`,
    [tokenHash],
  );
  return r.rows[0] ?? null;
}

export interface InsertRefreshToken {
  tokenHash: string;
  employeeId: string;
  deviceId: string | null;
  expiresAt: Date;
  userAgent: string | null;
}

export async function insertRefreshToken(db: Db, t: InsertRefreshToken): Promise<string> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO refresh_tokens (token_hash, employee_id, device_id, expires_at, user_agent)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [t.tokenHash, t.employeeId, t.deviceId, t.expiresAt, t.userAgent],
  );
  return r.rows[0]!.id;
}

/** Rotation's second half: the old row is revoked and points at its successor. */
export async function markReplaced(db: Db, oldId: string, newId: string): Promise<void> {
  await db.query(
    'UPDATE refresh_tokens SET revoked_at = now(), replaced_by = $2 WHERE id = $1',
    [oldId, newId],
  );
}

/**
 * Reuse detection (PLAN-BACKEND.md §4): presenting a revoked token
 * revokes the whole chain. One `WITH RECURSIVE` walk down `replaced_by`,
 * not a JS loop — a loop that died mid-way would leave live descendants
 * that *look* revoked, which is worse than an exception.
 *
 * The join direction is the subtle part: `c.replaced_by = rt.id` follows
 * the pointer to each successor. Written the other way round
 * (`rt.replaced_by = c.id`) it silently walks to the *predecessors* —
 * already revoked, so the reuse looks handled while every live
 * descendant survives. The three-deep chain test exists for exactly
 * this.
 *
 * Ancestors need no work: every row in the chain except the youngest was
 * already revoked at rotation time. Returns the rows this call revoked.
 */
export async function revokeChainFrom(db: Db, tokenId: string): Promise<string[]> {
  const r = await db.query<{ id: string }>(
    `WITH RECURSIVE chain AS (
       SELECT id, replaced_by FROM refresh_tokens WHERE id = $1
       UNION ALL
       SELECT rt.id, rt.replaced_by FROM refresh_tokens rt JOIN chain c ON c.replaced_by = rt.id
     )
     UPDATE refresh_tokens rt SET revoked_at = now()
     FROM chain
     WHERE rt.id = chain.id AND rt.revoked_at IS NULL
     RETURNING rt.id`,
    [tokenId],
  );
  return r.rows.map((row) => row.id);
}

/** Password change / deactivation (T0.8): every live token for the employee dies. */
export async function revokeAllForEmployee(db: Db, employeeId: string): Promise<number> {
  const r = await db.query<{ id: string }>(
    `UPDATE refresh_tokens SET revoked_at = now()
     WHERE employee_id = $1 AND revoked_at IS NULL
     RETURNING id`,
    [employeeId],
  );
  return r.rows.length;
}

/** Logout: revoke exactly the presented token if it is still live. */
export async function revokeByHash(db: Db, tokenHash: string): Promise<void> {
  await db.query(
    'UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL',
    [tokenHash],
  );
}

export async function touchLastLogin(db: Db, employeeId: string): Promise<void> {
  await db.query('UPDATE employees SET last_login_at = now() WHERE id = $1', [employeeId]);
}

export async function updatePassword(
  db: Db,
  employeeId: string,
  passwordHash: string,
): Promise<void> {
  await db.query(
    'UPDATE employees SET password_hash = $2, must_change_password = false WHERE id = $1',
    [employeeId, passwordHash],
  );
}

/** Consent state for login/me (§4): has this employee accepted `version` of the tracking consent? */
export async function hasAcceptedConsent(
  db: Db,
  employeeId: string,
  version: string,
  kind = 'location_tracking',
): Promise<boolean> {
  const r = await db.query<{ ok: boolean }>(
    'SELECT EXISTS (SELECT 1 FROM consents WHERE employee_id = $1 AND kind = $2::consent_kind AND version = $3) AS ok',
    [employeeId, kind, version],
  );
  return r.rows[0]?.ok === true;
}
