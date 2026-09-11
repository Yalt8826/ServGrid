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
  /** The event types the jobs module writes so far (§6.1–§6.3). */
  eventType: 'status_changed' | 'completed' | 'cancelled' | 'rescheduled' | 'created';
  actorId: string;
  /** The client's occurredAt, already clamped by the service (§6.3). */
  occurredAt: string;
  /** Null for an event that is not a status move (a successor's `created`). */
  fromStatus: JobStatus | null;
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

// ── completion (§6.2) ───────────────────────────────────────────────────────

export interface JobCompletionLockRow {
  id: string;
  status: JobStatus;
  assigned_to: string | null;
  /** Stack changes belong to the job's site (§6.2 step 5). */
  customer_id: string;
  /** Non-null only on a contract visit — Phase 2B flips the visit's status (§6.2 step 7). */
  contract_visit_id: string | null;
}

/**
 * §6.2 step 1 — the row lock the whole completion holds to commit. Every
 * later step of the transaction runs under it, so a status move racing
 * the completion waits instead of interleaving.
 */
export async function lockJobForCompletion(db: Db, jobId: string): Promise<JobCompletionLockRow | null> {
  const r = await db.query<JobCompletionLockRow>(
    `SELECT id, status, assigned_to, customer_id, contract_visit_id
     FROM job_cards WHERE id = $1 FOR UPDATE`,
    [jobId],
  );
  return r.rows[0] ?? null;
}

export interface CompletionInsert {
  jobCardId: string;
  completedBy: string;
  /** The client's completedAt, already clamped by the service (§6.2). */
  completedAt: string;
  workSummary: string;
  cost: string;
  discountAmount: string;
  discountReason: string | null;
  collectionMode: 'cash' | 'upi' | 'card' | 'bank_transfer' | 'none';
  paymentReference: string | null;
  customerSigned: boolean;
}

/**
 * §6.2 step 2 — the money row. The discount rule is the database's
 * (completion_discount_*, completion_mode_coherent); this INSERT only
 * carries the columns — the service maps a refused insert to a readable
 * 422 and never re-decides the rule. `amount_collected` is a generated
 * column: it is neither sent nor written, ever.
 */
export async function insertCompletion(db: Db, c: CompletionInsert): Promise<void> {
  await db.query(
    `INSERT INTO job_completions
       (job_card_id, completed_by, completed_at, work_summary, cost,
        discount_amount, discount_reason, collection_mode, payment_reference, customer_signed)
     VALUES ($1, $2, $3, $4, $5::numeric, $6::numeric, $7, $8, $9, $10)`,
    [
      c.jobCardId,
      c.completedBy,
      c.completedAt,
      c.workSummary,
      c.cost,
      c.discountAmount,
      c.discountReason,
      c.collectionMode,
      c.paymentReference,
      c.customerSigned,
    ],
  );
}

/**
 * §6.2 step 3 — close the card. `closed_at` is the client's clamped
 * completedAt, so the day the card shows as closed is the day the work
 * happened, not the day the handset synced (`job_closed_coherent` ties
 * the pair; the touch trigger bumps version).
 */
export async function completeJobCard(db: Db, jobId: string, closedAt: string): Promise<void> {
  await db.query(`UPDATE job_cards SET status = 'completed', closed_at = $2 WHERE id = $1`, [
    jobId,
    closedAt,
  ]);
}

export interface StackUnitRow {
  id: string;
  customer_id: string;
}

/**
 * The active unit with this serial, locked — the read half of §6.2 step
 * 5's upsert. A serial cannot stand at two sites at once
 * (customer_products_active_serial_unique); this pre-check turns the
 * cross-site case into a readable refusal, and the unique index stays as
 * the race backstop between two jobs at two sites.
 */
export async function lockActiveUnitBySerial(db: Db, serialNumber: string): Promise<StackUnitRow | null> {
  const r = await db.query<StackUnitRow>(
    `SELECT id, customer_id FROM customer_products
     WHERE lower(serial_number) = lower($1) AND is_active
     FOR UPDATE`,
    [serialNumber],
  );
  return r.rows[0] ?? null;
}

export interface StackChangeUpsert {
  customerId: string;
  sourceJobId: string;
  installedBy: string;
  productId: string | null;
  freeTextName: string | null;
  serialNumber: string;
  quantity: number;
  /** The client's date, or null to fall back to the completion's IST business date. */
  installedOn: string | null;
  completedAt: string;
  warrantyExpiresOn: string | null;
  notes: string | null;
}

/** §6.2 step 5, insert half — a unit the job put there. `source_job_id` IS the audit stamp (§3.3). */
export async function insertStackUnit(db: Db, s: StackChangeUpsert): Promise<void> {
  await db.query(
    `INSERT INTO customer_products
       (customer_id, product_id, free_text_name, serial_number, quantity,
        installed_on, warranty_expires_on, installed_by, source_job_id, notes)
     VALUES ($1, $2, $3, $4, $5, COALESCE($6::date, business_date($7::timestamptz)), $8, $9, $10, $11)`,
    [
      s.customerId,
      s.productId,
      s.freeTextName,
      s.serialNumber,
      s.quantity,
      s.installedOn,
      s.completedAt,
      s.warrantyExpiresOn,
      s.installedBy,
      s.sourceJobId,
      s.notes,
    ],
  );
}

/** §6.2 step 5, update half — the site's row for this serial already stands; the job refreshes it and re-stamps the source. */
export async function updateStackUnitFromJob(db: Db, id: string, s: StackChangeUpsert): Promise<void> {
  await db.query(
    `UPDATE customer_products SET
       product_id = $2, free_text_name = $3, quantity = $4,
       installed_on = COALESCE($5::date, business_date($6::timestamptz)),
       warranty_expires_on = $7, notes = $8, installed_by = $9, source_job_id = $10
     WHERE id = $1`,
    [
      id,
      s.productId,
      s.freeTextName,
      s.quantity,
      s.installedOn,
      s.completedAt,
      s.warrantyExpiresOn,
      s.notes,
      s.installedBy,
      s.sourceJobId,
    ],
  );
}

export interface CompletionPartInsert {
  lineNo: number;
  productId: string | null;
  freeTextName: string | null;
  quantity: number;
  unitCost: string | null;
  serialNumber: string | null;
  fromCustomerStock: boolean;
}

/**
 * §6.2 step 6 — the parts, one INSERT for all lines (`line_no` unique
 * within the completion). A record of what was fitted, never a bill:
 * nothing here reads or writes a money column (§3.4).
 */
export async function insertCompletionParts(
  db: Db,
  jobId: string,
  parts: readonly CompletionPartInsert[],
): Promise<void> {
  if (parts.length === 0) return;
  const values: unknown[] = [];
  const tuples = parts.map((p, i) => {
    const base = i * 8;
    values.push(jobId, p.lineNo, p.productId, p.freeTextName, p.quantity, p.unitCost, p.serialNumber, p.fromCustomerStock);
    return `($${base + 1}, $${base + 2}, $${base + 3}::uuid, $${base + 4}, $${base + 5}::numeric, $${base + 6}::numeric, $${base + 7}, $${base + 8})`;
  });
  await db.query(
    `INSERT INTO job_completion_parts
       (job_card_id, line_no, product_id, free_text_name, quantity, unit_cost, serial_number, from_customer_stock)
     VALUES ${tuples.join(', ')}`,
    values,
  );
}

export interface ClosureActor {
  kind: 'cancelled' | 'completed';
  fullName: string;
  at: Date;
}/**
 * Who already closed this job — the JOB_ALREADY_CLOSED message names the
 * person and the moment (§6.1: "naming who cancelled it and when"). A
 * job carries at most one closure row, so LIMIT 1 cannot hide a second.
 */
export async function findClosureActor(db: Db, jobId: string): Promise<ClosureActor | null> {
  const r = await db.query<ClosureActor>(
    `SELECT 'cancelled' AS kind, e.full_name AS "fullName", c.cancelled_at AS at
       FROM job_cancellations c JOIN employees e ON e.id = c.cancelled_by
      WHERE c.job_card_id = $1
     UNION ALL
     SELECT 'completed' AS kind, e.full_name AS "fullName", p.completed_at AS at
       FROM job_completions p JOIN employees e ON e.id = p.completed_by
      WHERE p.job_card_id = $1
     LIMIT 1`,
    [jobId],
  );
  return r.rows[0] ?? null;
}

// ── cancellation and rescheduling (§6.3) ────────────────────────────────────

export interface JobCancelLockRow {
  id: string;
  status: JobStatus;
  assigned_to: string | null;
  /** Non-null only on a contract visit — Phase 2B flips the visit's status instead (§6.3). */
  contract_visit_id: string | null;
  // The fields the successor card copies (§6.3: same customer, same service).
  customer_id: string;
  service_id: string;
  customer_product_id: string | null;
  title: string;
  description: string | null;
  priority: 'low' | 'normal' | 'high' | 'urgent';
  contact_name: string | null;
  contact_phone: string | null;
}

/**
 * The row lock the whole cancellation holds to commit — the successor
 * card, the cancellation row, the close and the event all run under it,
 * so a completion or a status move racing the cancellation waits instead
 * of interleaving (§6.2 step 1's shape, carried over).
 */
export async function lockJobForCancellation(db: Db, jobId: string): Promise<JobCancelLockRow | null> {
  const r = await db.query<JobCancelLockRow>(
    `SELECT id, status, assigned_to, contract_visit_id, customer_id, service_id,
            customer_product_id, title, description, priority, contact_name, contact_phone
     FROM job_cards WHERE id = $1 FOR UPDATE`,
    [jobId],
  );
  return r.rows[0] ?? null;
}

export interface CancellationInsert {
  jobCardId: string;
  cancelledBy: string;
  cancelledAt: string;
  reasonCode: string;
  reasonNote: string | null;
  /** Set when the transaction raised a successor card (§6.3). */
  replacementJobId: string | null;
}

/**
 * The 1:1 closure row (§3.4). `job_cancellations_other_justified` is the
 * database's rule — 'other' without a note is refused HERE even if a
 * caller skipped the schema; the service maps the violation to a
 * readable 422 and never re-decides the rule.
 */
export async function insertCancellation(db: Db, c: CancellationInsert): Promise<void> {
  await db.query(
    `INSERT INTO job_cancellations
       (job_card_id, cancelled_by, cancelled_at, reason_code, reason_note, replacement_job_id)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [c.jobCardId, c.cancelledBy, c.cancelledAt, c.reasonCode, c.reasonNote, c.replacementJobId],
  );
}

/**
 * Close the card at the moment of cancellation (`job_closed_coherent`
 * ties the pair; the touch trigger bumps version). Same shape as
 * completeJobCard — the endpoints that close jobs own `closed_at`.
 */
export async function cancelJobCard(db: Db, jobId: string, closedAt: string): Promise<void> {
  await db.query(`UPDATE job_cards SET status = 'cancelled', closed_at = $2 WHERE id = $1`, [
    jobId,
    closedAt,
  ]);
}

export interface SuccessorJobInsert {
  jobNumber: string;
  customerId: string;
  serviceId: string;
  customerProductId: string | null;
  title: string;
  description: string | null;
  priority: 'low' | 'normal' | 'high' | 'urgent';
  /** The cancelled job's `rescheduleTo`, at IST midnight so `business_date` lands on the day asked for. */
  scheduledFor: string;
  contactName: string | null;
  contactPhone: string | null;
  /** The canceller — a human raised this card, unlike the generator's system cards (§3.4). */
  createdBy: string;
}

/**
 * The successor card (§6.3): same customer, same service, new date,
 * `unassigned` — `job_assignment_coherent` holds because both sides of
 * the assignment pair start NULL. Returns the id the cancellation row
 * links as `replacement_job_id`.
 */
export async function insertSuccessorJob(db: Db, s: SuccessorJobInsert): Promise<string> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO job_cards
       (job_number, customer_id, service_id, customer_product_id, title, description,
        priority, status, scheduled_for, contact_name, contact_phone, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'unassigned', $8, $9, $10, $11)
     RETURNING id`,
    [
      s.jobNumber,
      s.customerId,
      s.serviceId,
      s.customerProductId,
      s.title,
      s.description,
      s.priority,
      s.scheduledFor,
      s.contactName,
      s.contactPhone,
      s.createdBy,
    ],
  );
  return r.rows[0]!.id;
}

export interface JobRescheduleLockRow {
  id: string;
  status: JobStatus;
  /** The version the `If-Match` precondition is checked against. */
  version: number;
  scheduled_for: Date | null;
}

/**
 * The row lock the reschedule holds. Status is read so the event's
 * from/to can record that the card did NOT move — rescheduling leaves
 * status alone (§6.3).
 */
export async function lockJobForReschedule(db: Db, jobId: string): Promise<JobRescheduleLockRow | null> {
  const r = await db.query<JobRescheduleLockRow>(
    'SELECT id, status, version, scheduled_for FROM job_cards WHERE id = $1 FOR UPDATE',
    [jobId],
  );
  return r.rows[0] ?? null;
}

/**
 * The reschedule itself — a write to `scheduled_for` and nothing else
 * (§6.3: "It is not a cancellation"). No `closed_at`, no status; the
 * touch trigger bumps `version` under the caller's If-Match.
 */
export async function rescheduleJobCard(db: Db, jobId: string, scheduledFor: string): Promise<void> {
  await db.query('UPDATE job_cards SET scheduled_for = $2 WHERE id = $1', [jobId, scheduledFor]);
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
