import type { JobStatus } from '@servgrid/shared';
import type { Db } from '../auth/repo.js';

/**
 * Jobs SQL (PLAN-BACKEND.md §2 module shape, §6.1/§6.3). Every function
 * takes its executor explicitly — the Pool for autocommit reads, or the
 * transaction client of a caller's `withTransaction`, the same rule
 * auth/repo.ts and employees/repo.ts run under.
 *
 * The three card projections are three separate column lists, not one
 * wide row the service trims (§6.3: response shape by role is enforced
 * by three separate schemas — and the queries behind them mirror that
 * split, so a technician's read never even joins `job_completions`).
 * `job_cards` carries no money columns (migration 007's load-bearing
 * decision); money enters only through the owner variant's LEFT JOIN,
 * which is the one query with `job_completions` in it.
 */

/** Which of the three per-role card projections to build (§6.3). */
export type CardVariant = 'technician' | 'dispatcher' | 'owner';

interface VariantDef {
  columns: string;
  /** Extra joins the variant needs, ready to append after the base FROM. */
  joins: string;
}

/**
 * `is_overdue` is computed, not stored (§6.3: "overdue is a filter, not a
 * state"): an open job whose `scheduled_date` — the generated IST business
 * date — has passed. COALESCE keeps a job with no date yet honest (not
 * overdue) instead of NULL-ish. When `v_job_cards_dispatcher` lands with
 * the dispatcher phase it reads the same expression; until then the
 * definition lives here, once.
 */
const OVERDUE_SQL = `COALESCE(
  jc.status NOT IN ('completed', 'cancelled') AND jc.scheduled_date < business_date(now()),
  false)`;

const VARIANT_DEFS: Readonly<Record<CardVariant, VariantDef>> = {
  technician: {
    columns: `jc.id, jc.job_number, jc.title, jc.status, jc.priority,
      jc.scheduled_for, jc.customer_id, jc.assigned_to, jc.contact_name,
      jc.contact_phone, jc.description, jc.version`,
    joins: '',
  },
  dispatcher: {
    columns: `jc.id, jc.job_number, jc.title, jc.status, jc.priority,
      jc.scheduled_for, jc.customer_id, c.name AS customer_name,
      jc.assigned_to,
      ${OVERDUE_SQL} AS is_overdue,
      (jc.contract_visit_id IS NOT NULL) AS is_contract_visit,
      jc.version`,
    joins: '',
  },
  owner: {
    columns: `jc.id, jc.job_number, jc.title, jc.status, jc.priority,
      jc.scheduled_for, jc.customer_id, c.name AS customer_name,
      jc.assigned_to,
      ${OVERDUE_SQL} AS is_overdue,
      (jc.contract_visit_id IS NOT NULL) AS is_contract_visit,
      jc.version,
      done.cost::text AS cost,
      done.discount_amount::text AS discount_amount,
      done.discount_reason AS discount_reason,
      done.amount_collected::text AS amount_collected,
      done.collection_mode AS collection_mode`,
    joins: ' LEFT JOIN job_completions done ON done.job_card_id = jc.id',
  },
};

/** `FROM` for every card query — `jc`/`c` are the aliases the predicates and filters are written against. */
const CARD_FROM = 'FROM job_cards jc JOIN customers c ON c.id = jc.customer_id';

interface CardRowBase {
  id: string;
  job_number: string;
  title: string;
  status: JobStatus;
  priority: 'low' | 'normal' | 'high' | 'urgent';
  scheduled_for: Date | null;
  customer_id: string;
  version: number;
}

export type { CardRowBase };

export interface TechnicianCardRow extends CardRowBase {
  /** Read for the point-read scope check; the mapper never sends it. */
  assigned_to: string | null;
  contact_name: string | null;
  contact_phone: string | null;
  description: string | null;
}

export interface DispatcherCardRow extends CardRowBase {
  customer_name: string;
  assigned_to: string | null;
  is_overdue: boolean;
  is_contract_visit: boolean;
}

export interface OwnerCardRow extends DispatcherCardRow {
  cost: string | null;
  discount_amount: string | null;
  discount_reason: string | null;
  amount_collected: string | null;
  collection_mode: 'cash' | 'upi' | 'card' | 'bank_transfer' | 'none' | null;
}

/** The one card row for a job, in the variant's projection. */
export async function findCard(
  db: Db,
  variant: CardVariant,
  jobId: string,
): Promise<CardRowBase | null> {
  const def = VARIANT_DEFS[variant];
  const r = await db.query<CardRowBase>(
    `SELECT ${def.columns} ${CARD_FROM}${def.joins} WHERE jc.id = $1`,
    [jobId],
  );
  return r.rows[0] ?? null;
}

export interface JobLockRow {
  id: string;
  status: JobStatus;
  assigned_to: string | null;
}

/** `SELECT … FOR UPDATE` — the row lock every status move holds to commit (§6.2 step 1's shape). */
export async function lockJobById(db: Db, jobId: string): Promise<JobLockRow | null> {
  const r = await db.query<JobLockRow>(
    'SELECT id, status, assigned_to FROM job_cards WHERE id = $1 FOR UPDATE',
    [jobId],
  );
  return r.rows[0] ?? null;
}

/**
 * The status move itself. `closed_at` is deliberately absent: the moves
 * this endpoint serves never leave a non-terminal state, and the
 * `job_closed_coherent` CHECK ties `closed_at` to exactly the terminal
 * statuses — the endpoints that close jobs (complete, cancel) own it.
 * The touch trigger bumps `updated_at`/`version`.
 */
export async function updateJobStatus(db: Db, jobId: string, to: JobStatus): Promise<void> {
  await db.query('UPDATE job_cards SET status = $2 WHERE id = $1', [jobId, to]);
}

export interface JobEventInsert {
  jobCardId: string;
  eventType: 'status_changed';
  actorId: string;
  /** The client's occurredAt, already clamped by the service (§6.3). */
  occurredAt: string;
  fromStatus: JobStatus;
  toStatus: JobStatus;
  source: 'mobile' | 'web' | 'system';
  /** Set only when a clamp happened — the payload IS the clamp record. */
  payload?: unknown;
}

export async function insertJobEvent(db: Db, e: JobEventInsert): Promise<void> {
  await db.query(
    `INSERT INTO job_events
       (job_card_id, event_type, actor_id, occurred_at, from_status, to_status, source, payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
    [
      e.jobCardId,
      e.eventType,
      e.actorId,
      e.occurredAt,
      e.fromStatus,
      e.toStatus,
      e.source,
      e.payload === undefined ? null : JSON.stringify(e.payload),
    ],
  );
}

// ── the list (§6.3 GET /v1/jobs) ────────────────────────────────────────────

export interface JobListFilter {
  statuses?: JobStatus[];
  technicianId?: string;
  customerId?: string;
  /** Inclusive `scheduled_date` (the IST business date) bounds. */
  from?: string;
  to?: string;
  overdue?: boolean;
  /** Substring match over job number, title and customer name. */
  q?: string;
}

export interface ListCursor {
  /** Full-precision `created_at` as ISO text (the keyset's left column). */
  createdAt: string;
  id: string;
}

export interface ListPage {
  rows: Array<CardRowBase & { created_at_text: string }>;
  /** True when `limit + 1` rows existed — the caller paginates. */
  hasMore: boolean;
}

/**
 * Keyset page over `(created_at, id) DESC` — `created_at` never updates,
 * so the order is stable, and the uuid breaks ties inside one transaction
 * (rows of a batch share `now()`). `to_json(created_at)#>>'{}'` carries
 * microsecond precision through the cursor text; a millisecond ISO
 * round-trip could strand rows created within the same millisecond.
 *
 * `scope` is the rbac predicate (`job` × `read`): null for owner and
 * dispatcher (no restriction), `assigned_to = $1` for a technician —
 * composed into the WHERE clause here, never filtered in JavaScript
 * (plugins/rbac.ts).
 */
export async function listCards(
  db: Db,
  variant: CardVariant,
  scope: { sql: string; params: readonly unknown[] } | null,
  filter: JobListFilter,
  cursor: ListCursor | null,
  limit: number,
): Promise<ListPage> {
  const def = VARIANT_DEFS[variant];
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
    clauses.push(`jc.status = ANY($${values.length}::job_status[])`);
  }
  if (filter.technicianId !== undefined) {
    values.push(filter.technicianId);
    clauses.push(`jc.assigned_to = $${values.length}`);
  }
  if (filter.customerId !== undefined) {
    values.push(filter.customerId);
    clauses.push(`jc.customer_id = $${values.length}`);
  }
  if (filter.from !== undefined) {
    values.push(filter.from);
    clauses.push(`jc.scheduled_date >= $${values.length}::date`);
  }
  if (filter.to !== undefined) {
    values.push(filter.to);
    clauses.push(`jc.scheduled_date <= $${values.length}::date`);
  }
  if (filter.overdue === true) {
    clauses.push(`(jc.status NOT IN ('completed', 'cancelled') AND jc.scheduled_date < business_date(now()))`);
  }
  if (filter.q !== undefined) {
    // ILIKE's default escape character is the backslash.
    const needle = `%${filter.q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
    values.push(needle);
    const n = values.length;
    clauses.push(`(jc.job_number ILIKE $${n} OR jc.title ILIKE $${n} OR c.name ILIKE $${n})`);
  }
  if (cursor) {
    values.push(cursor.createdAt, cursor.id);
    const a = values.length - 1;
    const b = values.length;
    clauses.push(`(jc.created_at, jc.id) < ($${a}::timestamptz, $${b}::uuid)`);
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  values.push(limit + 1); // one extra row answers "is there a next page"
  const r = await db.query<CardRowBase & { created_at_text: string }>(
    `SELECT ${def.columns}, to_json(jc.created_at)#>>'{}' AS created_at_text
     ${CARD_FROM}${def.joins}
     ${where}
     ORDER BY jc.created_at DESC, jc.id DESC
     LIMIT $${values.length}`,
    values,
  );
  return { rows: r.rows, hasMore: r.rows.length > limit };
}
