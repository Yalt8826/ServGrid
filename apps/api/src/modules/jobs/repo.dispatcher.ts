import type { JobStatus } from '@servgrid/shared';
import type { Db } from '../auth/repo.js';

/**
 * Dispatcher job SQL (PLAN-BACKEND.md §5 rule 2, §6.3; PHASE-2-DISPATCHER.md
 * T2.2). A separate repository file, and that is the point: the lint rules
 * from T0.1 (`servgrid-rules/no-sql-money-tables`,
 * `no-sql-location-tables`) fire on this path specifically, so a dispatcher
 * query that reaches `job_completions`, `service_contracts`, `location_pings`
 * or `location_requests` fails the build before it can fail the customer's
 * confidentiality.
 *
 * Every read here selects FROM `v_job_cards_dispatcher` (migration 013) —
 * never from `job_cards`. The view is a money-free projection by
 * construction: the schema makes revenue absent, and the view makes the
 * query surface one reviewable object. `is_overdue` lives in the view and
 * nowhere else, so the list, the dashboard count and any later report
 * cannot disagree about what overdue means (§6.3: overdue is a filter, not
 * a state — nothing here advances a date).
 *
 * `q` searches job number, customer name and phone — what the dispatcher
 * is actually given on the phone (UI/plan-2/05-DISPATCHER.md §D2). The
 * customer join exists for that search; `customers` is a table the matrix
 * grants the dispatcher read.
 */

/** The dispatcher's card row, exactly the view's projection plus the customer name. */
export interface DispatcherCardRow {
  id: string;
  job_number: string;
  title: string;
  status: JobStatus;
  priority: 'low' | 'normal' | 'high' | 'urgent';
  scheduled_for: Date | null;
  customer_id: string;
  customer_name: string;
  assigned_to: string | null;
  /** Read from the view — computed beside its definition (migration 013). Never null on the wire. */
  is_overdue: boolean;
  is_contract_visit: boolean;
  version: number;
}

/** Explicit column list — no SELECT *: the projection IS the contract. */
const CARD_COLUMNS = `v.id, v.job_number, v.title, v.status, v.priority,
  v.scheduled_for, v.customer_id, v.assigned_to,
  COALESCE(v.is_overdue, false) AS is_overdue,
  v.is_contract_visit, v.version, c.name AS customer_name`;
// The COALESCE is load-bearing: the view computes is_overdue as
// `open AND scheduled_date < business_date(now())`, and an open job with
// no date yet — the normal state of a job being typed in — ANDs a NULL
// into NULL. On the wire that would be a null where JobCardDispatcher
// promises a boolean (the same NULL-ish trap Phase 1's repo.ts
// COALESCEd against). `false` is the honest reading: no promise made, no
// promise broken. The overdue FILTER still reads the bare column, so
// list, dashboard count and report keep agreeing on the definition.

/** `v` is the view; `c` the customer, joined for the name and the `q` search. */
const CARD_FROM = 'FROM v_job_cards_dispatcher v JOIN customers c ON c.id = v.customer_id';

/** GET /v1/jobs/:id as a dispatcher — one row of the view, nothing else. */
export async function findDispatcherCard(db: Db, jobId: string): Promise<DispatcherCardRow | null> {
  const r = await db.query<DispatcherCardRow>(
    `SELECT ${CARD_COLUMNS} ${CARD_FROM} WHERE v.id = $1`,
    [jobId],
  );
  return r.rows[0] ?? null;
}

// ── the assignment picker (§6.3 GET /v1/technicians/load) ───────────────────

export interface TechnicianLoadRow {
  employee_id: string;
  technician_name: string;
  open_today: string;
  done_today: string;
  open_total: string;
  active_since: Date | null;
}

/**
 * `v_technician_load` (migration 013) for the picker and the dashboard's
 * load list — the same object, so the picker and the count cannot
 * disagree about who is busy. One per ACTIVE technician, busiest first —
 * the order the picker renders. The counts arrive as Postgres `bigint`
 * text and are numbered in the service; `active_since` is the promised
 * start of the job he is currently ON. This file is under the
 * no-sql-money-tables lint rule on purpose: the view reads job_cards and
 * employees, and it must stay that way.
 */
export async function listTechnicianLoad(db: Db): Promise<TechnicianLoadRow[]> {
  const r = await db.query<TechnicianLoadRow>(
    `SELECT employee_id, technician_name, open_today, done_today, open_total, active_since
     FROM v_technician_load
     ORDER BY open_total DESC, technician_name`,
  );
  return r.rows;
}

// ── the dashboard figures (T2.7, §D1: GET /v1/jobs/summary) ─────────────────

export interface DispatcherSummaryCounts {
  overdue: number;
  unassigned: number;
  today: number;
  doneToday: number;
}

/**
 * The dashboard's four figures in one pass over the view. Each FILTER
 * clause names its definition once, here, beside the view it reads:
 *
 * - `overdue` IS the view's `is_overdue` column, un-coalesced — the same
 *   predicate the `?overdue=true` list filter runs, so the figure and
 *   the rows under it cannot disagree (an open job with no date was
 *   never promised, so it is never late).
 * - `today` is today's scheduled work **plus an open job with no date**
 *   (2026-09-19). `scheduled_date` is generated from `scheduled_for`, so
 *   an undated job used to count in NEITHER figure — a dispatcher who
 *   raised a job and left the time as "No time" (a real choice the form
 *   offers) watched the dashboard report zero work while the job stood
 *   open. The app's own technician side has always counted it as
 *   actionable now (`bucketOf`: "actionable now; sorts last"), and this
 *   figure now agrees with that rule. The status guard keeps a
 *   long-closed undated job out of it.
 * - `done_today` mirrors `v_technician_load`'s `done_today` word for
 *   word (`completed` AND its `closed_at` is today's business date), so
 *   the dashboard figure is exactly the sum of the load bars' days.
 *
 * Counts come back as Postgres `bigint` text and are numbered by the
 * service, as in listTechnicianLoad.
 */
export async function summarizeDispatcherJobs(db: Db): Promise<DispatcherSummaryCounts> {
  const r = await db.query<{ overdue: string; unassigned: string; today: string; done_today: string }>(
    `SELECT
       count(*) FILTER (WHERE v.is_overdue)                                            AS overdue,
       count(*) FILTER (WHERE v.status = 'unassigned')                                 AS unassigned,
       count(*) FILTER (WHERE v.scheduled_date = business_date(now())
                          OR (v.scheduled_date IS NULL
                              AND v.status NOT IN ('completed', 'cancelled')))        AS today,
       count(*) FILTER (WHERE v.status = 'completed'
                          AND business_date(v.closed_at) = business_date(now()))       AS done_today
     FROM v_job_cards_dispatcher v`,
  );
  const row = r.rows[0]!;
  return {
    overdue: Number(row.overdue),
    unassigned: Number(row.unassigned),
    today: Number(row.today),
    doneToday: Number(row.done_today),
  };
}

export interface DispatcherListFilter {
  statuses?: JobStatus[];
  technicianId?: string;
  customerId?: string;
  /** Inclusive `scheduled_date` (the IST business date) bounds. */
  from?: string;
  to?: string;
  /** Reads `is_overdue` from the view — never recomputed here. */
  overdue?: boolean;
  /** Substring match over job number, customer name and customer phone. */
  q?: string;
}

export interface DispatcherListCursor {
  /** Full-precision `created_at` as ISO text (the keyset's left column). */
  createdAt: string;
  id: string;
}

export interface DispatcherListPage {
  rows: Array<DispatcherCardRow & { created_at_text: string }>;
  /** True when `limit + 1` rows existed — the caller paginates. */
  hasMore: boolean;
}

/**
 * Keyset page over `(created_at, id) DESC` — the same ordering the shared
 * list runs under, so both projections page identically. `scope` is the
 * rbac predicate (`job` × `read`): null for a dispatcher (scope `all`),
 * composed into the WHERE clause here, never filtered in JavaScript
 * (plugins/rbac.ts).
 */
export async function listDispatcherCards(
  db: Db,
  scope: { sql: string; params: readonly unknown[] } | null,
  filter: DispatcherListFilter,
  cursor: DispatcherListCursor | null,
  limit: number,
): Promise<DispatcherListPage> {
  const values: unknown[] = [];
  const clauses: string[] = [];

  // The scope's placeholders are numbered from 1; it goes first so its
  // params line up (plugins/rbac.ts ScopePredicateOptions.paramStart).
  if (scope) {
    values.push(...scope.params);
    clauses.push(`(${scope.sql})`);
  }
  if (filter.statuses && filter.statuses.length > 0) {
    values.push(filter.statuses);
    clauses.push(`v.status = ANY($${values.length}::job_status[])`);
  }
  if (filter.technicianId !== undefined) {
    values.push(filter.technicianId);
    clauses.push(`v.assigned_to = $${values.length}`);
  }
  if (filter.customerId !== undefined) {
    values.push(filter.customerId);
    clauses.push(`v.customer_id = $${values.length}`);
  }
  if (filter.from !== undefined) {
    values.push(filter.from);
    clauses.push(`v.scheduled_date >= $${values.length}::date`);
  }
  if (filter.to !== undefined) {
    values.push(filter.to);
    clauses.push(`v.scheduled_date <= $${values.length}::date`);
  }
  if (filter.overdue === true) {
    // The filter IS the view's column — the definition is not duplicated
    // here. An open job with no date yet is NULL in the view and counts
    // as not overdue: no promise was made, so none was broken.
    clauses.push('v.is_overdue');
  }
  if (filter.q !== undefined) {
    // ILIKE's default escape character is the backslash.
    const needle = `%${filter.q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
    values.push(needle);
    const n = values.length;
    clauses.push(`(v.job_number ILIKE $${n} OR c.name ILIKE $${n} OR c.phone ILIKE $${n})`);
  }
  if (cursor) {
    values.push(cursor.createdAt, cursor.id);
    const a = values.length - 1;
    const b = values.length;
    clauses.push(`(v.created_at, v.id) < ($${a}::timestamptz, $${b}::uuid)`);
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  values.push(limit + 1); // one extra row answers "is there a next page"
  const r = await db.query<DispatcherCardRow & { created_at_text: string }>(
    `SELECT ${CARD_COLUMNS}, to_json(v.created_at)#>>'{}' AS created_at_text
     ${CARD_FROM}
     ${where}
     ORDER BY v.created_at DESC, v.id DESC
     LIMIT $${values.length}`,
    values,
  );
  return { rows: r.rows, hasMore: r.rows.length > limit };
}
