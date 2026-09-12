import type { Db } from '../auth/repo.js';

/**
 * Catalogue SQL (PLAN-BACKEND.md §6.4): products and services, the small
 * slow-moving reference tables. No pagination and no search beyond a
 * client-side filter — the completion form and the sales line-item picker
 * read these whole. Money columns leave as text (`default_price::text`,
 * `default_charge::text`) — the same decimal-string rule every numeric
 * column obeys on the wire (§3: moneyString).
 *
 * Deactivation is an UPDATE of `is_active`, never a DELETE (§6.4) — a
 * product a sale or a completion cites must stay answerable.
 */

export interface ProductRow {
  id: string;
  sku: string;
  name: string;
  category: 'ups' | 'battery' | 'inverter' | 'accessory' | 'spare';
  brand: string | null;
  model_number: string | null;
  capacity_label: string | null;
  unit: string | null;
  default_price: string | null;
  warranty_months: number | null;
  version: number;
}

export interface ServiceRow {
  id: string;
  code: string;
  name: string;
  description: string | null;
  default_charge: string | null;
  version: number;
}

const PRODUCT_COLUMNS = `p.id, p.sku, p.name, p.category, p.brand, p.model_number,
  p.capacity_label, p.unit, p.default_price::text AS default_price, p.warranty_months, p.version`;

const SERVICE_COLUMNS = `s.id, s.code, s.name, s.description,
  s.default_charge::text AS default_charge, s.version`;

/** GET /v1/products (§6.4) — active rows, ordered for a picker. */
export async function listProducts(db: Db): Promise<ProductRow[]> {
  const r = await db.query<ProductRow>(
    `SELECT ${PRODUCT_COLUMNS} FROM products p WHERE p.is_active ORDER BY p.name, p.sku`,
  );
  return r.rows;
}

/** GET /v1/services (§6.4) — active rows, ordered for a picker. */
export async function listServices(db: Db): Promise<ServiceRow[]> {
  const r = await db.query<ServiceRow>(
    `SELECT ${SERVICE_COLUMNS} FROM services s WHERE s.is_active ORDER BY s.name, s.code`,
  );
  return r.rows;
}

export interface CatalogLockRow {
  id: string;
  version: number;
}

/** The row lock the PATCH holds — the If-Match compare and the write run under it. */
export async function lockProduct(db: Db, id: string): Promise<CatalogLockRow | null> {
  const r = await db.query<CatalogLockRow>(
    'SELECT id, version FROM products WHERE id = $1 AND is_active FOR UPDATE',
    [id],
  );
  return r.rows[0] ?? null;
}

export async function lockService(db: Db, id: string): Promise<CatalogLockRow | null> {
  const r = await db.query<CatalogLockRow>(
    'SELECT id, version FROM services WHERE id = $1 AND is_active FOR UPDATE',
    [id],
  );
  return r.rows[0] ?? null;
}

export interface ProductInsert {
  sku: string;
  name: string;
  category: ProductRow['category'];
  brand: string | null;
  modelNumber: string | null;
  capacityLabel: string | null;
  unit: string | null;
  defaultPrice: string | null;
  warrantyMonths: number | null;
}

export async function insertProduct(db: Db, input: ProductInsert): Promise<string> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO products (sku, name, category, brand, model_number, capacity_label, unit, default_price, warranty_months)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::numeric, $9)
     RETURNING id`,
    [
      input.sku,
      input.name,
      input.category,
      input.brand,
      input.modelNumber,
      input.capacityLabel,
      input.unit,
      input.defaultPrice,
      input.warrantyMonths,
    ],
  );
  return r.rows[0]!.id;
}

export interface ServiceInsert {
  code: string;
  name: string;
  description: string | null;
  defaultCharge: string | null;
}

export async function insertService(db: Db, input: ServiceInsert): Promise<string> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO services (code, name, description, default_charge)
     VALUES ($1, $2, $3, $4::numeric)
     RETURNING id`,
    [input.code, input.name, input.description, input.defaultCharge],
  );
  return r.rows[0]!.id;
}

const PRODUCT_PATCH_COLUMNS = {
  name: 'name',
  brand: 'brand',
  modelNumber: 'model_number',
  capacityLabel: 'capacity_label',
  unit: 'unit',
  defaultPrice: 'default_price',
  warrantyMonths: 'warranty_months',
  isActive: 'is_active',
} as const;

export type ProductPatchFields = Partial<Record<keyof typeof PRODUCT_PATCH_COLUMNS, string | number | boolean | null>>;

/** PATCH /v1/products/:id — only the sent columns move; `isActive: false` is the deactivation (§6.4). */
export async function patchProduct(db: Db, id: string, fields: ProductPatchFields): Promise<void> {
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [key, value] of Object.entries(fields)) {
    values.push(value);
    const column = PRODUCT_PATCH_COLUMNS[key as keyof typeof PRODUCT_PATCH_COLUMNS];
    sets.push(`${column} = $${values.length}${column === 'default_price' ? '::numeric' : ''}`);
  }
  values.push(id);
  await db.query(`UPDATE products SET ${sets.join(', ')} WHERE id = $${values.length}`, values);
}

const SERVICE_PATCH_COLUMNS = {
  name: 'name',
  description: 'description',
  defaultCharge: 'default_charge',
  isActive: 'is_active',
} as const;

export type ServicePatchFields = Partial<Record<keyof typeof SERVICE_PATCH_COLUMNS, string | number | boolean | null>>;

export async function patchService(db: Db, id: string, fields: ServicePatchFields): Promise<void> {
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [key, value] of Object.entries(fields)) {
    values.push(value);
    const column = SERVICE_PATCH_COLUMNS[key as keyof typeof SERVICE_PATCH_COLUMNS];
    sets.push(`${column} = $${values.length}${column === 'default_charge' ? '::numeric' : ''}`);
  }
  values.push(id);
  await db.query(`UPDATE services SET ${sets.join(', ')} WHERE id = $${values.length}`, values);
}

/**
 * One row for the PATCH read-back — deliberately NOT filtered on
 * `is_active`: deactivation is a legitimate PATCH (§6.4) and its response
 * must still come back.
 */
export async function findProduct(db: Db, id: string): Promise<ProductRow | null> {
  const r = await db.query<ProductRow>(`SELECT ${PRODUCT_COLUMNS} FROM products p WHERE p.id = $1`, [id]);
  return r.rows[0] ?? null;
}

export async function findService(db: Db, id: string): Promise<ServiceRow | null> {
  const r = await db.query<ServiceRow>(`SELECT ${SERVICE_COLUMNS} FROM services s WHERE s.id = $1`, [id]);
  return r.rows[0] ?? null;
}
