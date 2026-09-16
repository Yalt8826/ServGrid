import type { JobStatus } from '@servgrid/shared';
import type { Db } from '../auth/repo.js';
import type { DispatcherCardRow } from './repo.dispatcher.js';

/**
 * Jobs SQL (PLAN-BACKEND.md §2 module shape, §6.1/§6.3). Every function
 * takes its executor explicitly — the Pool for autocommit reads, or the
 * transaction client of a caller's `withTransaction`, the same rule
 * auth/repo.ts and employees/repo.ts run under.
 *
 * The card projections are separate column lists, not one wide row the
 * service trims (§6.3: response shape by role is enforced by separate
 * schemas — and the queries behind them mirror that split, so a
 * technician's read never even joins `job_completions`). `job_cards`
 * carries no money columns (migration 007's load-bearing decision);
 * money enters only through the owner variant's LEFT JOIN, which is the
 * one query with `job_completions` in it.
 *
 * The dispatcher's card is NOT here: since T2.2 his reads go through
 * repo.dispatcher.ts, which selects `v_job_cards_dispatcher` under the
 * no-money-tables lint rule (PLAN-BACKEND.md §5 rule 2) — a dispatcher
 * query that wandered to `job_completions` fails the build, not the
 * customer's confidentiality.
 */

/** Which of this file's per-role card projections to build (§6.3). The dispatcher reads repo.dispatcher.ts. */
export type CardVariant = 'technician' | 'owner';

interface VariantDef {
  columns: string;
  /** Extra joins the variant needs, ready to append after the base FROM. */
  joins: string;
}

/**
 * `is_overdue` is computed, not stored (§6.3: "overdue is a filter, not a
 * state"): an open job whose `scheduled_date` — the generated IST business
 * date — has passed. COALESCE keeps a job with no date yet honest (not
 * overdue) instead of NULL-ish. The dispatcher's definition of the same
 * expression moved into `v_job_cards_dispatcher` itself (migration 013);
 * this copy exists only for the owner variant, which reads `job_cards`
 * directly and may.
 */
const OVERDUE_SQL = `COALESCE(
  jc.status NOT IN ('completed', 'cancelled') AND jc.scheduled_date < business_date(now()),
  false)`;

const VARIANT_DEFS: Readonly<Record<CardVariant, VariantDef>> = {
  technician: {
    columns: `jc.id, jc.job_number, jc.title, jc.status, jc.priority,
      jc.scheduled_for, jc.customer_id, jc.assigned_to, jc.contact_name,
      jc.contact_phone, jc.description, jc.version,
      amc.contract_number AS contract_number, amc.end_date::text AS contract_end_date`,
    // Only a live AMC reaches the phone: a job whose AMC was cancelled
    // afterwards shows no chip and no Free option (decision 9).
    joins: ' LEFT JOIN service_contracts amc ON amc.id = jc.contract_id AND amc.cancelled_at IS NULL',
  },
  owner: {
    columns: `jc.id, jc.job_number, jc.title, jc.status, jc.priority,
      jc.scheduled_for, jc.customer_id, c.name AS customer_name,
      jc.assigned_to,
      ${OVERDUE_SQL} AS is_overdue,
      (jc.contract_id IS NOT NULL) AS is_contract_visit,
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
  /** The live AMC's number and end (IST date text) — null when the job has none, or its AMC was cancelled. */
  contract_number: string | null;
  contract_end_date: string | null;
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
  eventType:
    | 'status_changed'
    | 'completed'
    | 'completion_amended'
    | 'cancelled'
    | 'rescheduled'
    | 'created'
    | 'assigned'
    | 'reassigned';
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

// ── timeline (§6.3 GET /v1/jobs/:id/events) ─────────────────────────────────

export interface TimelineEventRow {
  id: number;
  event_type: string;
  actor_id: string;
  actor_name: string | null;
  occurred_at: Date;
  from_status: JobStatus | null;
  to_status: JobStatus | null;
  source: 'mobile' | 'web' | 'system';
  /** The event's own jsonb, parsed by pg — the caller shapes it per role. */
  payload: unknown;
}

/**
 * The job's whole event trail, oldest first (a timeline reads in time
 * order — O3's trail rule). Actors are LEFT JOINed so every row names its
 * person: the owner's question is "is this right, and if not, who do I
 * ask". A deleted account leaves an honest null, not a dropped row.
 */
export async function listTimelineEvents(db: Db, jobId: string): Promise<TimelineEventRow[]> {
  const r = await db.query<TimelineEventRow>(
    `SELECT je.id, je.event_type, je.actor_id, e.full_name AS actor_name,
            je.occurred_at, je.from_status, je.to_status, je.source, je.payload
       FROM job_events je
       LEFT JOIN employees e ON e.id = je.actor_id
      WHERE je.job_card_id = $1
      ORDER BY je.occurred_at ASC, je.id ASC`,
    [jobId],
  );
  return r.rows;
}

export interface CompletionDetailRow {
  completed_at: Date;
  work_summary: string;
  cost: string | null;
  discount_amount: string | null;
  discount_reason: string | null;
  amount_collected: string | null;
  collection_mode: 'cash' | 'upi' | 'card' | 'bank_transfer' | 'none' | null;
}

/** The filed completion's own columns — the owner's detail and amend sheet read these. */
export async function findCompletionDetail(db: Db, jobId: string): Promise<CompletionDetailRow | null> {
  const r = await db.query<CompletionDetailRow>(
    `SELECT completed_at, work_summary, cost::text AS cost,
            discount_amount::text AS discount_amount, discount_reason,
            amount_collected::text AS amount_collected, collection_mode
       FROM job_completions
      WHERE job_card_id = $1`,
    [jobId],
  );
  return r.rows[0] ?? null;
}

export interface CompletionPartRowT {
  line_no: number;
  /** Catalogue name, or the technician's free text for off-catalogue kit. */
  name: string | null;
  quantity: string;
  unit_cost: string | null;
  serial_number: string | null;
  from_customer_stock: boolean;
}

/** The parts fitted, in line order — a record of what was fitted, read back for the owner (§O4). */
export async function listCompletionParts(db: Db, jobId: string): Promise<CompletionPartRowT[]> {
  const r = await db.query<CompletionPartRowT>(
    `SELECT p.line_no, COALESCE(pr.name, p.free_text_name) AS name,
            p.quantity::text AS quantity, p.unit_cost::text AS unit_cost,
            p.serial_number, p.from_customer_stock
       FROM job_completion_parts p
       LEFT JOIN products pr ON pr.id = p.product_id
      WHERE p.job_card_id = $1
      ORDER BY p.line_no ASC`,
    [jobId],
  );
  return r.rows;
}

// ── completion (§6.2) ───────────────────────────────────────────────────────

export interface JobCompletionLockRow {
  id: string;
  status: JobStatus;
  assigned_to: string | null;
  /** Stack changes belong to the job's site (§6.2 step 5). */
  customer_id: string;
}

/**
 * §6.2 step 1 — the row lock the whole completion holds to commit. Every
 * later step of the transaction runs under it, so a status move racing
 * the completion waits instead of interleaving.
 */
export async function lockJobForCompletion(db: Db, jobId: string): Promise<JobCompletionLockRow | null> {
  const r = await db.query<JobCompletionLockRow>(
    `SELECT id, status, assigned_to, customer_id
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
  /** Where the technician stood, when the device captured it (§6.4). Null when it did not. */
  latitude: number | null;
  longitude: number | null;
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
        discount_amount, discount_reason, collection_mode, payment_reference, customer_signed,
        latitude, longitude)
     VALUES ($1, $2, $3, $4, $5::numeric, $6::numeric, $7, $8, $9, $10, $11, $12)`,
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
      c.latitude,
      c.longitude,
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

// ── completion amendment (§6.2b) ────────────────────────────────────────────

export interface CompletionAmendLockRow {
  /** 1:1 with the job card — the completion's key IS the job id. */
  job_card_id: string;
  /** The employee whose day the covering reconciliation covers. */
  completed_by: string;
  /** The generated IST business date the completion landed on. */
  business_date: string;
  /** The stored figures, as the amendment's before values. Money crosses as decimal text (§3.4). */
  cost: string;
  discount_amount: string;
  discount_reason: string | null;
}

/**
 * §6.2b step 1 — the completion row locked (`FOR UPDATE`) before anything
 * reads or writes it, so a confirm racing this amendment serialises behind
 * it and the figure cannot move twice at once.
 */
export async function lockCompletionForAmend(db: Db, jobId: string): Promise<CompletionAmendLockRow | null> {
  const r = await db.query<CompletionAmendLockRow>(
    `SELECT job_card_id, completed_by, business_date::text AS business_date,
            cost::text AS cost, discount_amount::text AS discount_amount, discount_reason
     FROM job_completions WHERE job_card_id = $1
     FOR UPDATE`,
    [jobId],
  );
  return r.rows[0] ?? null;
}

export interface CoveringReconciliationRow {
  id: string;
  business_date: string;
  status: ReconciliationStatusValue;
}

/** `reconciliation_status` (migration 002) — mirrored here to avoid a cross-module type import. */
type ReconciliationStatusValue = 'submitted' | 'confirmed' | 'disputed';

/**
 * The covering `cash_reconciliations` row for the completion's
 * (completed_by, business_date) — the employee-day whose expected cash this
 * completion feeds — locked FOR UPDATE like the completion row, so a
 * concurrent confirm waits rather than signing a day whose figure is
 * mid-move (and vice versa: this read blocks behind a confirm's lock, then
 * sees `confirmed`). Null when the day has no declaration or it is not
 * confirmed — only `confirmed` blocks (§3.4 enums); `disputed` does not.
 */
export async function lockCoveringReconciliation(
  db: Db,
  employeeId: string,
  businessDate: string,
): Promise<CoveringReconciliationRow | null> {
  const r = await db.query<CoveringReconciliationRow>(
    `SELECT id, business_date::text AS business_date, status
     FROM cash_reconciliations
     WHERE employee_id = $1 AND business_date = $2::date AND status = 'confirmed'
     FOR UPDATE`,
    [employeeId, businessDate],
  );
  return r.rows[0] ?? null;
}

export interface CompletionAmendPatch {
  cost?: string;
  discountAmount?: string;
  discountReason?: string;
}

/**
 * §6.2b step 1's write — apply the new figures. Patch semantics: a field
 * the caller omitted is not in the SET list and keeps its stored value.
 * The constraints (`completion_discount_justified` and friends) judge the
 * FINAL row and are this query's authority; the service maps a refusal to
 * a readable 422 and never re-decides the rule (§6.2 step 2's shape). The
 * touch trigger bumps `version`/`updated_at`; the before/after pair goes
 * to `job_events` from the caller, who held both rows.
 */
export async function amendCompletion(db: Db, jobId: string, patch: CompletionAmendPatch): Promise<void> {
  const sets: string[] = [];
  const values: unknown[] = [jobId];
  if (patch.cost !== undefined) {
    values.push(patch.cost);
    sets.push(`cost = $${values.length}::numeric`);
  }
  if (patch.discountAmount !== undefined) {
    values.push(patch.discountAmount);
    sets.push(`discount_amount = $${values.length}::numeric`);
  }
  if (patch.discountReason !== undefined) {
    values.push(patch.discountReason);
    sets.push(`discount_reason = $${values.length}`);
  }
  if (sets.length === 0) return;
  await db.query(`UPDATE job_completions SET ${sets.join(', ')} WHERE job_card_id = $1`, values);
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
  /** The job's AMC, when it is linked to one — the successor inherits it if the AMC covers the new day (decision 2026-09-15). */
  contract_id: string | null;
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
    `SELECT id, status, assigned_to, contract_id, customer_id, service_id,
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

export interface JobCardInsert {
  jobNumber: string;
  customerId: string;
  serviceId: string;
  customerProductId: string | null;
  title: string;
  description: string | null;
  priority: 'low' | 'normal' | 'high' | 'urgent';
  /**
   * The card's IST instant — for a successor, the cancelled job's
   * `rescheduleTo` at IST midnight so `business_date` lands on the day
   * asked for; for a dispatcher's create, the form's datetime or null (a
   * job without a day is allowed — the dispatcher may not know yet).
   */
  scheduledFor: string | null;
  contactName: string | null;
  contactPhone: string | null;
  /** The raiser — a human raised this card, unlike the generator's system cards (§3.4). */
  createdBy: string;
  /** The customer's AMC behind the job, when raised under one (decision 2026-09-15). */
  contractId: string | null;
}

/**
 * The card insert (§6.3): same shape for the dispatcher's create door and
 * the cancellation's successor — same customer, same service,
 * `unassigned`, `job_assignment_coherent` holds because both sides of the
 * assignment pair start NULL. Returns the id the caller links
 * (`replacement_job_id`) or reads the card back from.
 */
export async function insertJobCard(db: Db, s: JobCardInsert): Promise<string> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO job_cards
       (job_number, customer_id, service_id, customer_product_id, title, description,
        priority, status, scheduled_for, contact_name, contact_phone, created_by, contract_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'unassigned', $8, $9, $10, $11, $12)
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
      s.contractId,
    ],
  );
  return r.rows[0]!.id;
}

// ── create (§6.3 POST /v1/jobs) ─────────────────────────────────────────────

/** The active service the form named — the title the card carries is its name. */
export async function findActiveService(db: Db, serviceId: string): Promise<{ id: string; name: string } | null> {
  const r = await db.query<{ id: string; name: string }>(
    'SELECT id, name FROM services WHERE id = $1 AND is_active',
    [serviceId],
  );
  return r.rows[0] ?? null;
}

/** The active customer the job is raised for. */
export async function findActiveCustomer(db: Db, customerId: string): Promise<{ id: string } | null> {
  const r = await db.query<{ id: string }>(
    'SELECT id FROM customers WHERE id = $1 AND is_active',
    [customerId],
  );
  return r.rows[0] ?? null;
}

/** Does the named unit stand at this customer's site — active, so the soft-deleted ones cannot be attached to? */
export async function unitBelongsTo(db: Db, unitId: string, customerId: string): Promise<boolean> {
  const r = await db.query<{ ok: number }>(
    'SELECT 1 AS ok FROM customer_products WHERE id = $1 AND customer_id = $2 AND is_active',
    [unitId, customerId],
  );
  return r.rows.length > 0;
}

/** The AMC a `contractId` names — the service checks customer, cancellation and term against it. */
export interface ContractForJobRow {
  id: string;
  customer_id: string;
  start_date: string;
  end_date: string;
  cancelled_at: Date | null;
}

export async function findContractForJob(db: Db, contractId: string): Promise<ContractForJobRow | null> {
  const r = await db.query<ContractForJobRow>(
    `SELECT id, customer_id, start_date::text, end_date::text, cancelled_at
     FROM service_contracts WHERE id = $1`,
    [contractId],
  );
  return r.rows[0] ?? null;
}

/** The IST business date of the job's slot — or of now, when the form sent no date. */
export async function businessDateOf(db: Db, at: string | null): Promise<string> {
  const r = await db.query<{ d: string }>(
    'SELECT business_date(COALESCE($1::timestamptz, now()))::text AS d',
    [at],
  );
  return r.rows[0]!.d;
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

// ── assignment and reassignment (§6.3) ──────────────────────────────────────

export interface JobAssignLockRow {
  id: string;
  /** The number a bulk refusal names (the picker's "JC-…0044 failed"). */
  job_number: string;
  status: JobStatus;
  assigned_to: string | null;
  /** When the current assignment was made — the "20 seconds ago" of the lost-race message. */
  assigned_at: Date | null;
  /** The version the `If-Match` precondition is checked against. */
  version: number;
}

/**
 * §6.3 — the row lock the assignment holds, taken BEFORE the version is
 * compared (the "If it fails" rule: a lock taken after the read is a race
 * three dispatchers will find on their first Monday). Two concurrent
 * assigns serialise here: the second waits on this lock, re-reads the
 * version the first bumped, and loses with 409 instead of overwriting.
 */
export async function lockJobForAssign(db: Db, jobId: string): Promise<JobAssignLockRow | null> {
  const r = await db.query<JobAssignLockRow>(
    `SELECT id, job_number, status, assigned_to, assigned_at, version
     FROM job_cards WHERE id = $1 FOR UPDATE`,
    [jobId],
  );
  return r.rows[0] ?? null;
}

export interface ActiveTechnicianRow {
  id: string;
  full_name: string;
}

/**
 * The assignee the picker named — an ACTIVE technician. Checked inside
 * the assign transaction so a technician deactivated between the picker
 * and the tap is refused here, not discovered by the database's FK.
 */
export async function findActiveTechnician(db: Db, technicianId: string): Promise<ActiveTechnicianRow | null> {
  const r = await db.query<ActiveTechnicianRow>(
    `SELECT id, full_name FROM employees
     WHERE id = $1 AND role = 'technician' AND is_active`,
    [technicianId],
  );
  return r.rows[0] ?? null;
}

/**
 * The assignment write (§6.1): the card lands on the technician at
 * `assigned` — from `unassigned` (first assignment), from `assigned`
 * (reassign), or from `en_route`, where the reset IS the point: the new
 * technician has not set off. `assigned_by`/`assigned_at` name the
 * dispatcher who made it; the touch trigger bumps `version`.
 */
export async function assignJobCard(
  db: Db,
  jobId: string,
  technicianId: string,
  assignedBy: string,
  assignedAt: string,
): Promise<void> {
  await db.query(
    `UPDATE job_cards
     SET status = 'assigned', assigned_to = $2, assigned_by = $3, assigned_at = $4
     WHERE id = $1`,
    [jobId, technicianId, assignedBy, assignedAt],
  );
}

/** The name the refusal messages carry (§6.3: a 409 that names a person). */
export async function findEmployeeName(db: Db, employeeId: string): Promise<string | null> {
  const r = await db.query<{ full_name: string }>(
    'SELECT full_name FROM employees WHERE id = $1',
    [employeeId],
  );
  return r.rows[0]?.full_name ?? null;
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
