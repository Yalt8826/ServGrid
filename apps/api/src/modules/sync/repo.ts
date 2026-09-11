import type { Db } from '../auth/repo.js';

/**
 * Sync SQL (PLAN-BACKEND.md §7, PLAN-DATA-MODEL.md §6). Every function
 * takes its executor explicitly — the snapshot client the service opened
 * (bootstrap and delta read one REPEATABLE READ snapshot so the five
 * collections and the cursor they return agree), or the Pool for the
 * batch's point reads.
 *
 * The working set is the bootstrap's window, not the world: the actor's
 * open jobs and his recently-closed ones, the customers those jobs touch,
 * their stacks, and the active catalogue. The delta's first scan is the
 * same set under `updated_at > cursor`; the tombstone scans are bounded by
 * the WINDOW alone, deliberately not by the cursor — scope exit is a
 * property of the working set, not of the row's timestamp, and a
 * cursor-bounded tombstone scan can lose entries across a multi-page
 * delta. Re-delivering a small tombstone set per poll is free; missing one
 * is the stale-job-on-the-dashboard bug §7 exists to kill.
 *
 * Every timestamp that crosses the wire as a cursor is rendered by
 * `iso_cursor()` — fixed-width UTC ISO-8601 with microseconds — so
 * lexicographic order IS chronological order and a returned cursor can be
 * clamped monotonically in JavaScript without a date parse.
 */

/** Fixed-width, sortable, zod-`isoDateTime`-clean: the one cursor spelling.
 * `to_char`'s format keeps its literal sections in double quotes inside a
 * `$$…$$` dollar-quoted literal. */
function isoCursor(expression: string): string {
  return `to_char(${expression} AT TIME ZONE 'UTC', $$YYYY-MM-DD"T"HH24:MI:SS.US"Z"$$)`;
}

/** The sync window — "open, or closed recently" (§7). [impl] 30 days. */
export const SYNC_WINDOW_DAYS = 30;

/** Safety caps. A page cut never splits a timestamp group (service.ts); the
 * largest single-transaction write set in this app is a completion (<10
 * rows), far under both numbers. */
export const DELTA_PAGE_LIMIT = 500;
export const TOMBSTONE_LIMIT = 1_000;

const WINDOW_CLAUSE = `(jc.closed_at IS NULL OR jc.closed_at > now() - ($2 * interval '1 day'))`;

/** The actor's in-window jobs reach every other working-set entity — the
 * one predicate customers, stacks and tombstone scans share. `customerRef`
 * is the entity's customer column (customers.id itself, or
 * customer_products.customer_id); `assignee` is the assignment predicate
 * against `jc.assigned_to` (the actor, or its negation for the scope-exit
 * scan). */
const HELD_JOB_EXISTS = (customerRef: string, assignee: string): string =>
  `EXISTS (
     SELECT 1 FROM job_cards jc
      WHERE jc.customer_id = ${customerRef}
        AND jc.assigned_to ${assignee}
        AND ${WINDOW_CLAUSE}
   )`;

const HIS = '= $1';
const NOT_HIS = '<> $1 AND jc.assigned_to IS NOT NULL';

// ── the cursor ──────────────────────────────────────────────────────────────

export interface CursorRow {
  cursor: string | null;
}

/**
 * The sync position: the newest `updated_at` anywhere in the five
 * syncable collections, computed INSIDE the caller's snapshot. A row
 * visible in that snapshot cannot be newer than this, so everything the
 * snapshot could see is delivered (or tombstoned) at this cursor. NULL
 * when the database is empty — the caller falls back to the snapshot's
 * own `now()`, so the very first bootstrap still hands out a real cursor.
 */
export async function universeCursor(db: Db): Promise<string | null> {
  const r = await db.query<CursorRow>(
    `SELECT ${isoCursor('max(u)')} AS cursor FROM (
       SELECT max(updated_at) AS u FROM job_cards
       UNION ALL SELECT max(updated_at) FROM customers
       UNION ALL SELECT max(updated_at) FROM customer_products
       UNION ALL SELECT max(updated_at) FROM products
       UNION ALL SELECT max(updated_at) FROM services
     ) m`,
  );
  return r.rows[0]?.cursor ?? null;
}

/** The snapshot's own time, as the cursor spelling — the empty-database fallback. */
export async function snapshotCursor(db: Db): Promise<string> {
  const r = await db.query<CursorRow>(`SELECT ${isoCursor('now()')} AS cursor`);
  return r.rows[0]!.cursor!;
}

// ── bootstrap / delta rows — the in-scope half ──────────────────────────────

export interface SyncJobRow {
  id: string;
  job_number: string;
  title: string;
  status: string;
  priority: string;
  scheduled_for: Date | null;
  customer_id: string;
  contact_name: string | null;
  contact_phone: string | null;
  description: string | null;
  version: number;
  /** Sort key for the page cut — the fixed-width cursor spelling. */
  updated_at_text: string;
}

const JOB_COLUMNS = `jc.id, jc.job_number, jc.title, jc.status::text AS status, jc.priority::text AS priority,
   jc.scheduled_for, jc.customer_id, jc.contact_name, jc.contact_phone, jc.description, jc.version,
   ${isoCursor('jc.updated_at')} AS updated_at_text`;

/** His open and recently-closed jobs (§7); `cursor` absent for a cold start. */
export async function workingSetJobs(
  db: Db,
  actorId: string,
  windowDays: number,
  cursor: string | null,
  limit: number,
): Promise<SyncJobRow[]> {
  const r = await db.query<SyncJobRow>(
    `SELECT ${JOB_COLUMNS}
       FROM job_cards jc
      WHERE jc.assigned_to = $1
        AND ${WINDOW_CLAUSE}
        ${cursor === null ? '' : 'AND jc.updated_at > $3::timestamptz'}
      ORDER BY jc.updated_at, jc.id
      LIMIT $${cursor === null ? 3 : 4}`,
    cursor === null ? [actorId, windowDays, limit] : [actorId, windowDays, cursor, limit],
  );
  return r.rows;
}

export interface SyncCustomerRow {
  id: string;
  name: string;
  phone: string;
  alt_phone: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  state: string | null;
  pincode: string | null;
  latitude: number | null;
  longitude: number | null;
  notes: string | null;
  company_id: string | null;
  version: number;
  updated_at_text: string;
}

const CUSTOMER_COLUMNS = `c.id, c.name, c.phone, c.alt_phone, c.address_line1, c.address_line2,
   c.city, c.state, c.pincode, c.latitude, c.longitude, c.notes, c.company_id, c.version,
   ${isoCursor('c.updated_at')} AS updated_at_text`;

/** Active customers his in-window jobs touch. */
export async function workingSetCustomers(
  db: Db,
  actorId: string,
  windowDays: number,
  cursor: string | null,
  limit: number,
): Promise<SyncCustomerRow[]> {
  const r = await db.query<SyncCustomerRow>(
    `SELECT ${CUSTOMER_COLUMNS}
       FROM customers c
      WHERE c.is_active
        AND ${HELD_JOB_EXISTS('c.id', HIS)}
        ${cursor === null ? '' : 'AND c.updated_at > $3::timestamptz'}
      ORDER BY c.updated_at, c.id
      LIMIT $${cursor === null ? 3 : 4}`,
    cursor === null ? [actorId, windowDays, limit] : [actorId, windowDays, cursor, limit],
  );
  return r.rows;
}

export interface SyncCustomerProductRow {
  id: string;
  customer_id: string;
  product_id: string | null;
  free_text_name: string | null;
  serial_number: string;
  quantity: number;
  installed_on: string | null;
  warranty_expires_on: string | null;
  notes: string | null;
  version: number;
  updated_at_text: string;
}

const CUSTOMER_PRODUCT_COLUMNS = `cp.id, cp.customer_id, cp.product_id, cp.free_text_name,
   cp.serial_number, cp.quantity, cp.installed_on::text AS installed_on,
   cp.warranty_expires_on::text AS warranty_expires_on, cp.notes, cp.version,
   ${isoCursor('cp.updated_at')} AS updated_at_text`;

/** Active stack units at his customers' sites. */
export async function workingSetCustomerProducts(
  db: Db,
  actorId: string,
  windowDays: number,
  cursor: string | null,
  limit: number,
): Promise<SyncCustomerProductRow[]> {
  const r = await db.query<SyncCustomerProductRow>(
    `SELECT ${CUSTOMER_PRODUCT_COLUMNS}
       FROM customer_products cp
      WHERE cp.is_active
        AND ${HELD_JOB_EXISTS('cp.customer_id', HIS)}
        ${cursor === null ? '' : 'AND cp.updated_at > $3::timestamptz'}
      ORDER BY cp.updated_at, cp.id
      LIMIT $${cursor === null ? 3 : 4}`,
    cursor === null ? [actorId, windowDays, limit] : [actorId, windowDays, cursor, limit],
  );
  return r.rows;
}

export interface SyncProductRow {
  id: string;
  sku: string;
  name: string;
  category: string;
  brand: string | null;
  model_number: string | null;
  capacity_label: string | null;
  unit: string | null;
  default_price: string | null;
  warranty_months: number | null;
  version: number;
  updated_at_text: string;
}

const PRODUCT_COLUMNS = `p.id, p.sku, p.name, p.category::text AS category, p.brand, p.model_number,
   p.capacity_label, p.unit, p.default_price::text AS default_price, p.warranty_months, p.version,
   ${isoCursor('p.updated_at')} AS updated_at_text`;

/** The active catalogue — the mirror holds all of it; the technician picks from it in the field. */
export async function workingSetProducts(db: Db, cursor: string | null, limit: number): Promise<SyncProductRow[]> {
  const r = await db.query<SyncProductRow>(
    `SELECT ${PRODUCT_COLUMNS}
       FROM products p
      WHERE p.is_active
        ${cursor === null ? '' : 'AND p.updated_at > $1::timestamptz'}
      ORDER BY p.updated_at, p.id
      LIMIT $${cursor === null ? 1 : 2}`,
    cursor === null ? [limit] : [cursor, limit],
  );
  return r.rows;
}

export interface SyncServiceRow {
  id: string;
  code: string;
  name: string;
  description: string | null;
  default_charge: string | null;
  version: number;
  updated_at_text: string;
}

const SERVICE_COLUMNS = `s.id, s.code, s.name, s.description, s.default_charge::text AS default_charge,
   s.version, ${isoCursor('s.updated_at')} AS updated_at_text`;

export async function workingSetServices(db: Db, cursor: string | null, limit: number): Promise<SyncServiceRow[]> {
  const r = await db.query<SyncServiceRow>(
    `SELECT ${SERVICE_COLUMNS}
       FROM services s
      WHERE s.is_active
        ${cursor === null ? '' : 'AND s.updated_at > $1::timestamptz'}
      ORDER BY s.updated_at, s.id
      LIMIT $${cursor === null ? 1 : 2}`,
    cursor === null ? [limit] : [cursor, limit],
  );
  return r.rows;
}

// ── tombstones — the scope-exit and soft-delete half ────────────────────────

export interface TombstoneRow {
  id: string;
}

/**
 * Job scope exit (§7, the case that bites). Spec-literal query: rows that
 * are NOT his any more — `assigned_to IS DISTINCT FROM :actor` — over jobs
 * inside the bootstrap window he could have seen, whether still open or
 * recently closed. The query runs with no cursor bound, so a reassignment
 * is reported on the very next poll and survives multi-page deltas. It
 * over-reports jobs he never held (a tombstone for a row the mirror does
 * not have is a no-op delete) and under-reports nothing: a job he held
 * that has since been reassigned to anyone — or to nobody — matches.
 * When the assignment endpoints land (T1.13's `assigned`/`reassigned`
 * job_events), the EXISTS can be narrowed to that evidence; the tombstone
 * contract does not change.
 */
export async function tombstoneJobsOutOfScope(
  db: Db,
  actorId: string,
  windowDays: number,
  limit: number,
): Promise<TombstoneRow[]> {
  const r = await db.query<TombstoneRow>(
    `SELECT jc.id
       FROM job_cards jc
      WHERE jc.assigned_to IS DISTINCT FROM $1
        AND jc.assigned_to IS NOT NULL -- an unassigned job was never anyone's
        AND ${WINDOW_CLAUSE}
      ORDER BY jc.updated_at DESC
      LIMIT $3`,
    [actorId, windowDays, limit],
  );
  return r.rows;
}

/**
 * Soft-deleted customer (§7: `deleted`). He holds a site through his jobs,
 * so the tombstone is addressed only where he plausibly holds it — an
 * in-window job of his there — and only for recent deactivations (the
 * window, again not the cursor: multi-page-safe).
 */
export async function tombstoneCustomersDeleted(
  db: Db,
  actorId: string,
  windowDays: number,
  limit: number,
): Promise<TombstoneRow[]> {
  const r = await db.query<TombstoneRow>(
    `SELECT c.id
       FROM customers c
      WHERE NOT c.is_active
        AND c.updated_at > now() - ($2 * interval '1 day')
        AND ${HELD_JOB_EXISTS('c.id', HIS)}
      ORDER BY c.updated_at DESC
      LIMIT $3`,
    [actorId, windowDays, limit],
  );
  return r.rows;
}

/**
 * Customer scope exit: still active, but his last in-window job there has
 * gone (the reassignment companion of the job scan — a customer row the
 * mirror holds through a job must leave with it). Guarded by a non-his
 * in-window job at the site, so it stays bounded by the same window.
 */
export async function tombstoneCustomersOutOfScope(
  db: Db,
  actorId: string,
  windowDays: number,
  limit: number,
): Promise<TombstoneRow[]> {
  const r = await db.query<TombstoneRow>(
    `SELECT c.id
       FROM customers c
      WHERE c.is_active
        AND ${HELD_JOB_EXISTS('c.id', NOT_HIS)}
        AND NOT ${HELD_JOB_EXISTS('c.id', HIS)}
      ORDER BY c.updated_at DESC
      LIMIT $3`,
    [actorId, windowDays, limit],
  );
  return r.rows;
}

/** A released serial (§3.3 de-install / site move) leaves the mirror the same way. */
export async function tombstoneCustomerProductsDeleted(
  db: Db,
  actorId: string,
  windowDays: number,
  limit: number,
): Promise<TombstoneRow[]> {
  const r = await db.query<TombstoneRow>(
    `SELECT cp.id
       FROM customer_products cp
      WHERE NOT cp.is_active
        AND cp.updated_at > now() - ($2 * interval '1 day')
        AND ${HELD_JOB_EXISTS('cp.customer_id', HIS)}
      ORDER BY cp.updated_at DESC
      LIMIT $3`,
    [actorId, windowDays, limit],
  );
  return r.rows;
}

/** Catalogue deactivations — the mirror holds the whole active catalogue, so `deleted` is broadcast, window-bounded. */
export async function tombstoneProductsDeleted(db: Db, windowDays: number, limit: number): Promise<TombstoneRow[]> {
  const r = await db.query<TombstoneRow>(
    `SELECT p.id FROM products p
      WHERE NOT p.is_active AND p.updated_at > now() - ($1 * interval '1 day')
      ORDER BY p.updated_at DESC LIMIT $2`,
    [windowDays, limit],
  );
  return r.rows;
}

export async function tombstoneServicesDeleted(db: Db, windowDays: number, limit: number): Promise<TombstoneRow[]> {
  const r = await db.query<TombstoneRow>(
    `SELECT s.id FROM services s
      WHERE NOT s.is_active AND s.updated_at > now() - ($1 * interval '1 day')
      ORDER BY s.updated_at DESC LIMIT $2`,
    [windowDays, limit],
  );
  return r.rows;
}

// ── the batch's duplicate short-circuit ─────────────────────────────────────

export interface StoredIdempotentResponse {
  response_status: number;
  response_text: string;
}

/**
 * The stored response for a drained key, if one exists (§3.2 path 3). The
 * batch replays it as a `duplicate` outcome WITHOUT re-executing — the
 * reconnect case of the ordinary endpoints, applied to the outbox drain.
 */
export async function findStoredIdempotentResponse(
  db: Db,
  employeeId: string,
  key: string,
): Promise<StoredIdempotentResponse | null> {
  const r = await db.query<StoredIdempotentResponse>(
    `SELECT response_status, response_body #>> '{}' AS response_text
       FROM idempotency_keys
      WHERE employee_id = $1 AND key = $2 AND response_status IS NOT NULL`,
    [employeeId, key],
  );
  return r.rows[0] ?? null;
}
