import type { PoolClient } from 'pg';
import type { TechnicianWork, TechnicianWorkJob } from '@servgrid/shared';
import { getPool } from '../../db/pool.js';
import * as repo from './repo.js';

/**
 * The technician's work read (PLAN-BACKEND.md §7). One online answer with
 * everything his screens render — jobs, the sites they are at, the units
 * standing there, and the catalogue — so the app never stores a copy.
 */

/**
 * One REPEATABLE READ READ ONLY transaction: the five collections read the
 * same snapshot, so a job never names a customer the same response lacks.
 */
async function withReadSnapshot<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    try {
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  } finally {
    client.release();
  }
}

// ── row → wire mappers; each returns exactly its schema's keys ──────────────

function toJob(row: repo.WorkJobRow): TechnicianWorkJob {
  return {
    id: row.id,
    jobNumber: row.job_number,
    title: row.title,
    status: row.status as TechnicianWorkJob['status'],
    priority: row.priority as TechnicianWorkJob['priority'],
    scheduledFor: row.scheduled_for === null ? null : row.scheduled_for.toISOString(),
    customerId: row.customer_id,
    contactName: row.contact_name,
    contactPhone: row.contact_phone,
    description: row.description,
    contract: row.contract_number === null || row.contract_end_date === null
      ? null
      : { number: row.contract_number, endDate: row.contract_end_date },
    version: row.version,
    closedAt: row.closed_at === null ? null : row.closed_at.toISOString(),
  };
}

function toCustomer(row: repo.WorkCustomerRow): TechnicianWork['customers'][number] {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    altPhone: row.alt_phone,
    addressLine1: row.address_line1,
    area: row.area,
    addressLine2: row.address_line2,
    city: row.city,
    state: row.state,
    pincode: row.pincode,
    latitude: row.latitude,
    longitude: row.longitude,
    notes: row.notes,
    companyId: row.company_id,
    version: row.version,
  };
}

function toCustomerProduct(row: repo.WorkCustomerProductRow): TechnicianWork['customerProducts'][number] {
  return {
    id: row.id,
    customerId: row.customer_id,
    productId: row.product_id,
    freeTextName: row.free_text_name,
    serialNumber: row.serial_number,
    quantity: row.quantity,
    installedOn: row.installed_on,
    warrantyExpiresOn: row.warranty_expires_on,
    notes: row.notes,
    version: row.version,
  };
}

function toProduct(row: repo.WorkProductRow): TechnicianWork['products'][number] {
  return {
    id: row.id,
    sku: row.sku,
    name: row.name,
    category: row.category as TechnicianWork['products'][number]['category'],
    brand: row.brand,
    modelNumber: row.model_number,
    capacityLabel: row.capacity_label,
    unit: row.unit,
    defaultPrice: row.default_price,
    warrantyMonths: row.warranty_months,
    version: row.version,
  };
}

function toService(row: repo.WorkServiceRow): TechnicianWork['services'][number] {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description,
    defaultCharge: row.default_charge,
    version: row.version,
  };
}

/** GET /v1/technician/work — his working set, one snapshot. */
export async function technicianWork(actorId: string): Promise<TechnicianWork> {
  return withReadSnapshot(async (client) => {
    // Sequential on purpose: one PoolClient runs one query at a time.
    const jobs = await repo.workJobs(client, actorId, repo.WORK_WINDOW_DAYS, repo.WORK_ENTITY_LIMIT);
    const customers = await repo.workCustomers(client, actorId, repo.WORK_WINDOW_DAYS, repo.WORK_ENTITY_LIMIT);
    const customerProducts = await repo.workCustomerProducts(client, actorId, repo.WORK_WINDOW_DAYS, repo.WORK_ENTITY_LIMIT);
    const products = await repo.workProducts(client, repo.WORK_ENTITY_LIMIT);
    const services = await repo.workServices(client, repo.WORK_ENTITY_LIMIT);
    return {
      jobs: jobs.map(toJob),
      customers: customers.map(toCustomer),
      customerProducts: customerProducts.map(toCustomerProduct),
      products: products.map(toProduct),
      services: services.map(toService),
    };
  });
}
