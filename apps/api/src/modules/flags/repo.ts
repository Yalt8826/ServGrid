import type { QueryResult, QueryResultRow } from 'pg';
import type { FeatureFlag } from '@servgrid/shared';

/**
 * Flag override SQL (PLAN-BACKEND.md §2: each module is
 * routes/service/repo; hand-written queries). Executors are explicit —
 * the Pool for autocommit reads, a transaction's PoolClient for writes —
 * the same shape every other module's repo keeps.
 */
export interface Db {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<R>>;
}

export interface OverrideRecord {
  /** A known registry name for rows this codebase wrote; evaluation
   * ignores anything else, so a stale name can never crash a reader. */
  flag: FeatureFlag;
  enabled: boolean;
}

export async function listForEmployee(db: Db, employeeId: string): Promise<OverrideRecord[]> {
  const r = await db.query<{ flag: FeatureFlag; enabled: boolean }>(
    `SELECT flag, enabled FROM employee_flag_overrides WHERE employee_id = $1`,
    [employeeId],
  );
  return r.rows;
}

export interface EmployeeFlagsRow {
  employeeId: string;
  username: string;
  role: string;
  flag: FeatureFlag;
  enabled: boolean;
}

/** Every override joined to its employee, for the owner's console. */
export async function listAll(db: Db): Promise<EmployeeFlagsRow[]> {
  const r = await db.query<EmployeeFlagsRow>(
    `SELECT o.employee_id AS "employeeId", e.username::text AS username, e.role::text AS role,
            o.flag, o.enabled
     FROM employee_flag_overrides o
     JOIN employees e ON e.id = o.employee_id
     ORDER BY e.username, o.flag`,
  );
  return r.rows;
}

export async function employeeExists(db: Db, employeeId: string): Promise<boolean> {
  const r = await db.query(`SELECT 1 FROM employees WHERE id = $1 AND is_active`, [employeeId]);
  return r.rowCount !== 0;
}

export async function upsert(
  db: Db,
  employeeId: string,
  flag: FeatureFlag,
  enabled: boolean,
  updatedBy: string,
): Promise<void> {
  await db.query(
    `INSERT INTO employee_flag_overrides (employee_id, flag, enabled, updated_by)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (employee_id, flag)
     DO UPDATE SET enabled = excluded.enabled, updated_by = excluded.updated_by,
                   updated_at = now()`,
    [employeeId, flag, enabled, updatedBy],
  );
}
