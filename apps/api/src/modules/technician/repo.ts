import type { Db } from '../auth/repo.js';

/**
 * The technician's working set, read online (PLAN-BACKEND.md §7,
 * decision 2026-09-15). Every function takes its executor explicitly: the
 * service reads all five collections inside one REPEATABLE READ snapshot,
 * so a job and the customer it names can never disagree.
 *
 * The set is a window, not the world: his open jobs and the ones closed in
 * the last `WORK_WINDOW_DAYS`, the active customers those jobs touch,
 * their active stacks, and the active catalogue. A job reassigned away is
 * simply absent from the next read — the scope-exit tombstones the
 * offline mirror needed have nothing left to describe.
 */

/** "Open, or closed recently" (§7). [impl] 30 days — the mirror's window, unchanged. */
export const WORK_WINDOW_DAYS = 30;

/** A sanity bound, not pagination: a technician's set is tens of rows. */
export const WORK_ENTITY_LIMIT = 10_000;

const WINDOW_CLAUSE = `(jc.closed_at IS NULL OR jc.closed_at > now() - ($2 * interval '1 day'))`;

/** One of his in-window jobs is at this customer — the predicate customers and stacks share. */
const HIS_JOB_AT = (customerRef: string): string =>
  `EXISTS (
     SELECT 1 FROM job_cards jc
      WHERE jc.customer_id = ${customerRef}
        AND jc.assigned_to = $1
        AND ${WINDOW_CLAUSE}
   )`;

export interface WorkJobRow {
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
  /** When the job was completed or cancelled — dates "done today" on his dashboard. */
  closed_at: Date | null;
}

export async function workJobs(db: Db, actorId: string, windowDays: number, limit: number): Promise<WorkJobRow[]> {
  const r = await db.query<WorkJobRow>(
    `SELECT jc.id, jc.job_number, jc.title, jc.status::text AS status, jc.priority::text AS priority,
            jc.scheduled_for, jc.customer_id, jc.contact_name, jc.contact_phone, jc.description, jc.version,
            jc.closed_at
       FROM job_cards jc
      WHERE jc.assigned_to = $1
        AND ${WINDOW_CLAUSE}
      ORDER BY jc.job_number
      LIMIT $3`,
    [actorId, windowDays, limit],
  );
  return r.rows;
}

export interface WorkCustomerRow {
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
}

export async function workCustomers(db: Db, actorId: string, windowDays: number, limit: number): Promise<WorkCustomerRow[]> {
  const r = await db.query<WorkCustomerRow>(
    `SELECT c.id, c.name, c.phone, c.alt_phone, c.address_line1, c.address_line2,
            c.city, c.state, c.pincode, c.latitude, c.longitude, c.notes, c.company_id, c.version
       FROM customers c
      WHERE c.is_active
        AND ${HIS_JOB_AT('c.id')}
      ORDER BY c.name, c.id
      LIMIT $3`,
    [actorId, windowDays, limit],
  );
  return r.rows;
}

export interface WorkCustomerProductRow {
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
}

export async function workCustomerProducts(
  db: Db,
  actorId: string,
  windowDays: number,
  limit: number,
): Promise<WorkCustomerProductRow[]> {
  const r = await db.query<WorkCustomerProductRow>(
    `SELECT cp.id, cp.customer_id, cp.product_id, cp.free_text_name, cp.serial_number, cp.quantity,
            cp.installed_on::text AS installed_on, cp.warranty_expires_on::text AS warranty_expires_on,
            cp.notes, cp.version
       FROM customer_products cp
      WHERE cp.is_active
        AND ${HIS_JOB_AT('cp.customer_id')}
      ORDER BY cp.customer_id, cp.id
      LIMIT $3`,
    [actorId, windowDays, limit],
  );
  return r.rows;
}

export interface WorkProductRow {
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
}

/** The active catalogue — the complete sheet's parts picker offers all of it. */
export async function workProducts(db: Db, limit: number): Promise<WorkProductRow[]> {
  const r = await db.query<WorkProductRow>(
    `SELECT p.id, p.sku, p.name, p.category::text AS category, p.brand, p.model_number,
            p.capacity_label, p.unit, p.default_price::text AS default_price, p.warranty_months, p.version
       FROM products p
      WHERE p.is_active
      ORDER BY p.name, p.id
      LIMIT $1`,
    [limit],
  );
  return r.rows;
}

export interface WorkServiceRow {
  id: string;
  code: string;
  name: string;
  description: string | null;
  default_charge: string | null;
  version: number;
}

export async function workServices(db: Db, limit: number): Promise<WorkServiceRow[]> {
  const r = await db.query<WorkServiceRow>(
    `SELECT s.id, s.code, s.name, s.description, s.default_charge::text AS default_charge, s.version
       FROM services s
      WHERE s.is_active
      ORDER BY s.name, s.id
      LIMIT $1`,
    [limit],
  );
  return r.rows;
}
