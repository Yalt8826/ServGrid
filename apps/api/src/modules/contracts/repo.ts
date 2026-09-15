import type { Db } from '../auth/repo.js';

/**
 * Contracts SQL (PHASE-2B-CONTRACTS.md T2B.2, PLAN-BACKEND.md §11.1).
 * Reads come off `v_contracts` — migration 015's derived view — so an AMC's
 * state, its reminder facts and the due/ending sorts are ONE definition the
 * tab, the detail and any report share; writes land on `service_contracts`.
 *
 * Every function takes its executor explicitly — the Pool for autocommit
 * reads, or the transaction client of a caller's `withTransaction`, the
 * same rule auth/repo.ts and companies/repo.ts run under. Date columns are
 * selected `::text` (a `date` is a plain `YYYY-MM-DD` on the wire, never a
 * JS timezone accident); timestamps come back as `Date`.
 *
 * THE one write rule: overlapping AMC terms at one customer are the
 * database's refusal (`service_contracts_no_overlap`, an exclusion
 * constraint), not a service check — the service only phrases the verdict.
 * The customer row lock (`lockCustomer`) serialises the check against the
 * INSERT so two concurrent creates cannot both pass it.
 */

/** The one projection — every allowed role reads the same shape (§11.1 has no per-role split on contract rows). */
const CONTRACT_COLUMNS = `
  v.id, v.contract_number, v.customer_id, v.customer_name,
  v.start_date::text AS start_date, v.end_date::text AS end_date,
  v.contract_value::text AS contract_value, v.notes,
  v.created_by, v.created_by_name, v.created_at,
  v.cancelled_at, v.cancel_reason, v.state,
  v.last_service_date::text AS last_service_date,
  v.next_visit_due::text AS next_visit_due,
  v.open_job_id, v.open_job_number, v.open_job_scheduled_for,
  v.days_to_end, v.is_visit_due, v.is_ending_soon, v.version`;

export type ContractStateRow = 'upcoming' | 'active' | 'expired' | 'cancelled';

export interface ContractRow {
  id: string;
  contract_number: string;
  customer_id: string;
  customer_name: string;
  start_date: string;
  end_date: string;
  contract_value: string;
  notes: string | null;
  created_by: string;
  created_by_name: string;
  created_at: Date;
  cancelled_at: Date | null;
  cancel_reason: string | null;
  state: ContractStateRow;
  last_service_date: string | null;
  next_visit_due: string;
  open_job_id: string | null;
  open_job_number: string | null;
  open_job_scheduled_for: Date | null;
  days_to_end: number;
  is_visit_due: boolean;
  is_ending_soon: boolean;
  version: number;
}

/** One AMC by id — the detail read and the read-back after every write. */
export async function findContract(db: Db, id: string): Promise<ContractRow | null> {
  const r = await db.query<ContractRow>(
    `SELECT ${CONTRACT_COLUMNS} FROM v_contracts v WHERE v.id = $1`,
    [id],
  );
  return r.rows[0] ?? null;
}

export type ContractListFilterRow = 'all' | 'due' | 'ending';

export interface ContractListArgs {
  filter: ContractListFilterRow;
  customerId?: string;
  state?: ContractStateRow;
  q?: string;
  limit: number;
  /** The DECODED offset-cursor value (base64url envelope handled by the service). 0 = first page. */
  offset: number;
}

export interface ContractListPage {
  rows: ContractRow[];
  /** True when `limit + 1` rows existed — the caller paginates. */
  hasMore: boolean;
}

/**
 * The list (§11.1 GET /v1/contracts). Filtered and sorted by the view's own
 * derived columns, so the tab can never disagree with the attention feed:
 *
 * - `due` — `v.is_visit_due` (four months since the customer's last
 *   completed job, no open job), most overdue first;
 * - `ending` — `v.is_ending_soon` (within 7 days of the end), fewest days
 *   first;
 * - `all` — active first, then upcoming, expired, cancelled; each block by
 *   end date then number, so the order is stable across pages.
 *
 * OFFSET pagination on purpose: the lists are tens of rows, and the
 * computed sort orders (`is_visit_due`, `days_to_end`, the state CASE)
 * have no stable keyset key a cursor could carry — keyset pagination would
 * fight the very sorts that make the tab read right. Only bound parameters
 * reach the WHERE; `q` is escaped for ILIKE so a `%` typed by the dispatcher
 * matches literally, never as a wildcard.
 */
export async function listContracts(db: Db, args: ContractListArgs): Promise<ContractListPage> {
  const values: unknown[] = [];
  const clauses: string[] = [];

  if (args.filter === 'due') {
    clauses.push('v.is_visit_due');
  } else if (args.filter === 'ending') {
    clauses.push('v.is_ending_soon');
  }

  if (args.customerId !== undefined) {
    values.push(args.customerId);
    clauses.push(`v.customer_id = $${values.length}`);
  }
  if (args.state !== undefined) {
    values.push(args.state);
    clauses.push(`v.state = $${values.length}`);
  }
  if (args.q !== undefined) {
    // ILIKE's default escape character is the backslash (the jobs repo's
    // `?q=` escape, followed exactly): %, _ and \ lose their special meaning.
    const needle = `%${args.q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
    values.push(needle);
    const n = values.length;
    clauses.push(`(v.customer_name ILIKE $${n} OR v.contract_number ILIKE $${n})`);
  }

  let order: string;
  if (args.filter === 'due') {
    order = 'v.next_visit_due ASC, v.customer_name ASC, v.id ASC';
  } else if (args.filter === 'ending') {
    order = 'v.days_to_end ASC, v.customer_name ASC, v.id ASC';
  } else {
    order =
      "CASE v.state WHEN 'active' THEN 0 WHEN 'upcoming' THEN 1 WHEN 'expired' THEN 2 ELSE 3 END, " +
      'v.end_date ASC, v.contract_number ASC, v.id ASC';
  }

  values.push(args.limit + 1);
  const limitParam = values.length;
  values.push(args.offset);
  const offsetParam = values.length;

  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const r = await db.query<ContractRow>(
    `SELECT ${CONTRACT_COLUMNS}
     FROM v_contracts v
     ${where}
     ORDER BY ${order}
     LIMIT $${limitParam} OFFSET $${offsetParam}`,
    values,
  );
  return { rows: r.rows, hasMore: r.rows.length > args.limit };
}

export interface ContractJobRow {
  id: string;
  job_number: string;
  title: string;
  status: string;
  scheduled_for: Date | null;
  closed_at: Date | null;
  assigned_to_name: string | null;
}

/**
 * Every job linked to the AMC, newest first. THE one rule (§11.1, the
 * revenue rule narrowed by decision 8 of 2026-09-15): this read joins
 * employees for a name and NOTHING ELSE — never `job_completions`. The
 * AMC detail carries no money key but the AMC's own price; job revenue
 * stays forbidden here exactly as everywhere else on the desk.
 */
export async function listContractJobs(db: Db, contractId: string): Promise<ContractJobRow[]> {
  const r = await db.query<ContractJobRow>(
    `SELECT j.id, j.job_number, j.title, j.status, j.scheduled_for, j.closed_at,
            e.full_name AS assigned_to_name
     FROM job_cards j
     LEFT JOIN employees e ON e.id = j.assigned_to
     WHERE j.contract_id = $1
     ORDER BY j.scheduled_for DESC NULLS LAST, j.job_number DESC`,
    [contractId],
  );
  return r.rows;
}

/**
 * The customer row lock taken at the top of EVERY contract write for that
 * customer. Holding it serialises create and date-changing patches for the
 * site, so the overlap verdict cannot race another create — the check runs
 * while every other writer for the same customer is queued behind the lock.
 */
export async function lockCustomer(db: Db, customerId: string): Promise<{ id: string; is_active: boolean } | null> {
  const r = await db.query<{ id: string; is_active: boolean }>(
    'SELECT id, is_active FROM customers WHERE id = $1 FOR UPDATE',
    [customerId],
  );
  return r.rows[0] ?? null;
}

export interface OverlappingRow {
  id: string;
  contract_number: string;
  start_date: string;
  end_date: string;
}

/**
 * An uncancelled AMC of this customer whose inclusive date range intersects
 * the proposed one. `excludeId` keeps a PATCH from colliding with itself.
 * Inclusive ranges (`'[]'`) mean a renewal starting the day after the old
 * term ends never collides — the renewal path of §11.1.
 */
export async function findOverlapping(
  db: Db,
  args: { customerId: string; startDate: string; endDate: string; excludeId: string | null },
): Promise<OverlappingRow | null> {
  const r = await db.query<OverlappingRow>(
    `SELECT id, contract_number, start_date::text AS start_date, end_date::text AS end_date
     FROM service_contracts
     WHERE customer_id = $1
       AND cancelled_at IS NULL
       AND daterange(start_date, end_date, '[]') && daterange($2::date, $3::date, '[]')
       AND ($4::uuid IS NULL OR id <> $4)
     ORDER BY start_date
     LIMIT 1`,
    [args.customerId, args.startDate, args.endDate, args.excludeId],
  );
  return r.rows[0] ?? null;
}

export interface ContractLockRow {
  id: string;
  customer_id: string;
  start_date: string;
  end_date: string;
  cancelled_at: Date | null;
  version: number;
}

/** The row lock a PATCH or cancel holds — the If-Match compare and the write run under it (§6.3's shape). */
export async function lockContract(db: Db, id: string): Promise<ContractLockRow | null> {
  const r = await db.query<ContractLockRow>(
    `SELECT id, customer_id, start_date::text AS start_date, end_date::text AS end_date,
            cancelled_at, version
     FROM service_contracts WHERE id = $1 FOR UPDATE`,
    [id],
  );
  return r.rows[0] ?? null;
}

export interface ContractInsert {
  contractNumber: string;
  customerId: string;
  startDate: string;
  endDate: string;
  contractValue: string;
  notes: string | null;
  createdBy: string;
}

/** POST /v1/contracts — the number is allocated before this runs, inside the same transaction. */
export async function insertContract(db: Db, input: ContractInsert): Promise<string> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO service_contracts
       (contract_number, customer_id, start_date, end_date, contract_value, notes, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [input.contractNumber, input.customerId, input.startDate, input.endDate, input.contractValue, input.notes, input.createdBy],
  );
  return r.rows[0]!.id;
}

/** The PATCH fields, camelCase as the schema carries them, already undefined-filtered by the service. */
export interface ContractPatchFields {
  startDate?: string;
  endDate?: string;
  contractValue?: string;
  notes?: string | null;
}

const PATCH_COLUMNS: Readonly<Record<keyof ContractPatchFields, string>> = {
  startDate: 'start_date',
  endDate: 'end_date',
  contractValue: 'contract_value',
  notes: 'notes',
};

/**
 * PATCH /v1/contracts/:id — only the sent columns move; `notes` may be set
 * to NULL (an erasure is an edit). The touch trigger bumps `version`
 * (migration 015).
 */
export async function updateContract(db: Db, id: string, fields: ContractPatchFields): Promise<void> {
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [key, value] of Object.entries(fields)) {
    values.push(value);
    sets.push(`${PATCH_COLUMNS[key as keyof ContractPatchFields]} = $${values.length}`);
  }
  values.push(id);
  const idParam = values.length;
  await db.query(`UPDATE service_contracts SET ${sets.join(', ')} WHERE id = $${idParam}`, values);
}

/** POST /v1/contracts/:id/cancel — the trio lands together; the coherence CHECK is the backstop. */
export async function cancelContract(
  db: Db,
  id: string,
  fields: { cancelledBy: string; reason: string },
): Promise<void> {
  await db.query(
    'UPDATE service_contracts SET cancelled_at = now(), cancelled_by = $2, cancel_reason = $3 WHERE id = $1',
    [id, fields.cancelledBy, fields.reason],
  );
}
