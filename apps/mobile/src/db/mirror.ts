/**
 * The local SQLite mirror of the role's working set (T1.13,
 * PLAN-FRONTEND.md §4 "Local mirror", PLAN-DATA-MODEL.md §6).
 *
 * Five collections, exactly the ones `GET /v1/sync/bootstrap` sends a
 * technician: jobs, customers, customer_products, products, services.
 * The schema mirrors the server's shape but carries only what the role
 * needs — a job row here has no money columns because the API never sent
 * any (the technician's job card is money-free by construction). The two
 * catalogue price fields (`products.default_price`, `services.default_charge`)
 * are not job money: the server includes them in the working set itself
 * (`SyncProductSchema` / `SyncServiceSchema`), so the mirror keeps them.
 *
 * **Dispatchers and owners get no SQLite at all.** `openMirror` is the one
 * door, and it checks `ROLE_CAPABILITIES[role].offline` — once, at provider
 * setup — before it dynamically imports `./sqliteMirror`, the only module
 * that touches `expo-sqlite`. For an online-only role the module is never
 * even initialised: no database file, no schema, nothing. Their failure
 * mode is a clear error state, not a queue.
 *
 * Delta application is atomic by construction: the page's upserts, its
 * tombstones and the cursor advance all run inside ONE transaction, and
 * the cursor update is the last statement in it. A failure mid-page rolls
 * the whole page back — a partially-applied page with an advanced cursor
 * would be silent, permanent data loss on that device, because the rows it
 * skipped would never be requested again (the cursor is the server's
 * `updated_at`; the server never resends below it).
 *
 * The mirror is cleared on user switch (`clearMirror`). The outbox
 * (T1.14's table, same database) is deliberately untouched here — it is
 * filtered by `employee_id`, not wiped, and T1.14 resolves that tension.
 */
import type {
  SyncBootstrapResponse,
  SyncDeltaResponse,
  SyncTombstone,
  SyncWorkingSet,
} from '@servgrid/shared';

import type { Role } from '../lib/types';
import { ROLE_CAPABILITIES } from '../lib/types';

/**
 * The row shapes the mirror holds, derived from the working set itself —
 * the mirror carries exactly what `GET /v1/sync/bootstrap` sent, so the
 * types come from `SyncWorkingSet` rather than a parallel definition that
 * could drift. (`shared` exports the row schemas without inferred-type
 * aliases; the working set is the exported contract.)
 */
export type MirrorJob = SyncWorkingSet['jobs'][number];
export type MirrorCustomer = SyncWorkingSet['customers'][number];
export type MirrorCustomerProduct = SyncWorkingSet['customerProducts'][number];
export type MirrorProduct = SyncWorkingSet['products'][number];
export type MirrorService = SyncWorkingSet['services'][number];

/** The entity names the sync contract's tombstones use (§6 / §7). */
export type MirrorEntity = SyncTombstone['entity'];

export const MIRROR_ENTITIES = [
  'job',
  'customer',
  'customer_product',
  'product',
  'service',
] as const satisfies readonly MirrorEntity[];

/** Tombstone entity name → mirror table. */
const TABLE_FOR: Record<MirrorEntity, string> = {
  job: 'jobs',
  customer: 'customers',
  customer_product: 'customer_products',
  product: 'products',
  service: 'services',
};

/** Meta keys in `mirror_meta`. */
const CURSOR_KEY = 'delta_cursor';

/**
 * The narrow slice of expo-sqlite's `SQLiteDatabase` the mirror uses —
 * the synchronous variants, because a delta page must apply inside one
 * transaction whose commit and cursor move are a single step, not a
 * promise chain a background task can interleave with. Structural: any
 * `SQLiteDatabase` satisfies it, which keeps `expo-sqlite` out of this
 * module's imports entirely.
 */
export type MirrorBindValue = string | number | boolean | null | Uint8Array;

export interface MirrorDatabase {
  execSync(source: string): void;
  runSync(source: string, ...params: MirrorBindValue[]): { changes: number; lastInsertRowId: number };
  getAllSync<T>(source: string, ...params: MirrorBindValue[]): T[];
  getFirstSync<T>(source: string, ...params: MirrorBindValue[]): T | null;
  withTransactionSync(task: () => void): void;
}

/** An opened mirror. Everything else takes one of these. */
export interface Mirror {
  readonly database: MirrorDatabase;
}

/** Thrown for online-only roles — the spec's "clear error state, not a queue". */
export class MirrorUnavailableError extends Error {
  readonly role: Role;

  constructor(role: Role) {
    super(
      `No local mirror for the ${role} role — dispatchers and owners are online-only; their failure mode is a clear error state, not a queue (PLAN-FRONTEND.md §4).`,
    );
    this.name = 'MirrorUnavailableError';
    this.role = role;
  }
}

/** The capability check itself, exported for provider setup to branch on. */
export function roleHasMirror(role: Role): boolean {
  return ROLE_CAPABILITIES[role].offline;
}

/**
 * Open the mirror for a role. The capability gate runs BEFORE the dynamic
 * import, so for a dispatcher or owner session `./sqliteMirror` — and with
 * it `expo-sqlite` — is never even imported, let alone opened.
 */
export async function openMirror(role: Role): Promise<Mirror> {
  if (!roleHasMirror(role)) {
    throw new MirrorUnavailableError(role);
  }
  const { openSqliteMirror } = await import('./sqliteMirror');
  return openSqliteMirror();
}

// ── schema ──────────────────────────────────────────────────────────────────
//
// Column names are the payload's camelCase flattened to snake_case. No
// foreign keys: the mirror is a read cache of the server's working set, and
// a delta page may carry a customer_product whose customer row sits later
// in the same page — the server guarantees the set is coherent as a whole.

export const MIRROR_SCHEMA_VERSION = '1';

export const MIRROR_DDL = `
CREATE TABLE IF NOT EXISTS mirror_meta (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY NOT NULL,
  job_number TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  priority TEXT NOT NULL,
  scheduled_for TEXT,
  customer_id TEXT NOT NULL,
  contact_name TEXT,
  contact_phone TEXT,
  description TEXT,
  contract_number TEXT,
  contract_billing TEXT,
  contract_visits_remaining INTEGER,
  version INTEGER NOT NULL CHECK (version >= 0)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS customers (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  alt_phone TEXT,
  address_line1 TEXT,
  address_line2 TEXT,
  city TEXT,
  state TEXT,
  pincode TEXT,
  latitude REAL,
  longitude REAL,
  notes TEXT,
  company_id TEXT,
  version INTEGER NOT NULL CHECK (version >= 0)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS customer_products (
  id TEXT PRIMARY KEY NOT NULL,
  customer_id TEXT NOT NULL,
  product_id TEXT,
  free_text_name TEXT,
  serial_number TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity >= 0),
  installed_on TEXT,
  warranty_expires_on TEXT,
  notes TEXT,
  version INTEGER NOT NULL CHECK (version >= 0)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY NOT NULL,
  sku TEXT NOT NULL,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  brand TEXT,
  model_number TEXT,
  capacity_label TEXT,
  unit TEXT,
  default_price TEXT,
  warranty_months INTEGER,
  version INTEGER NOT NULL CHECK (version >= 0)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS services (
  id TEXT PRIMARY KEY NOT NULL,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  default_charge TEXT,
  version INTEGER NOT NULL CHECK (version >= 0)
) WITHOUT ROWID;
`;

/** One upsert statement per table, generated once from the column lists. */
function upsertSql(table: string, columns: readonly string[]): string {
  const placeholders = columns.map(() => '?').join(', ');
  const updates = columns
    .slice(1) // id stays the conflict target
    .map((column) => `${column} = excluded.${column}`)
    .join(', ');
  return `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders}) ON CONFLICT(id) DO UPDATE SET ${updates}`;
}

const JOB_COLUMNS = [
  'id',
  'job_number',
  'title',
  'status',
  'priority',
  'scheduled_for',
  'customer_id',
  'contact_name',
  'contact_phone',
  'description',
  'contract_number',
  'contract_billing',
  'contract_visits_remaining',
  'version',
];

const CUSTOMER_COLUMNS = [
  'id',
  'name',
  'phone',
  'alt_phone',
  'address_line1',
  'address_line2',
  'city',
  'state',
  'pincode',
  'latitude',
  'longitude',
  'notes',
  'company_id',
  'version',
];

const CUSTOMER_PRODUCT_COLUMNS = [
  'id',
  'customer_id',
  'product_id',
  'free_text_name',
  'serial_number',
  'quantity',
  'installed_on',
  'warranty_expires_on',
  'notes',
  'version',
];

const PRODUCT_COLUMNS = [
  'id',
  'sku',
  'name',
  'category',
  'brand',
  'model_number',
  'capacity_label',
  'unit',
  'default_price',
  'warranty_months',
  'version',
];

const SERVICE_COLUMNS = ['id', 'code', 'name', 'description', 'default_charge', 'version'];

const UPSERT_FOR: Record<MirrorEntity, { table: string; sql: string; binds: (row: never) => MirrorBindValue[] }> = {
  job: {
    table: 'jobs',
    sql: upsertSql('jobs', JOB_COLUMNS),
    binds: (job: MirrorJob) => [
      job.id,
      job.jobNumber,
      job.title,
      job.status,
      job.priority,
      job.scheduledFor,
      job.customerId,
      job.contactName,
      job.contactPhone,
      job.description,
      job.contract?.number ?? null,
      job.contract?.billing ?? null,
      job.contract?.visitsRemaining ?? null,
      job.version,
    ],
  },
  customer: {
    table: 'customers',
    sql: upsertSql('customers', CUSTOMER_COLUMNS),
    binds: (customer: MirrorCustomer) => [
      customer.id,
      customer.name,
      customer.phone,
      customer.altPhone,
      customer.addressLine1,
      customer.addressLine2,
      customer.city,
      customer.state,
      customer.pincode,
      customer.latitude,
      customer.longitude,
      customer.notes,
      customer.companyId,
      customer.version,
    ],
  },
  customer_product: {
    table: 'customer_products',
    sql: upsertSql('customer_products', CUSTOMER_PRODUCT_COLUMNS),
    binds: (customerProduct: MirrorCustomerProduct) => [
      customerProduct.id,
      customerProduct.customerId,
      customerProduct.productId,
      customerProduct.freeTextName,
      customerProduct.serialNumber,
      customerProduct.quantity,
      customerProduct.installedOn,
      customerProduct.warrantyExpiresOn,
      customerProduct.notes,
      customerProduct.version,
    ],
  },
  product: {
    table: 'products',
    sql: upsertSql('products', PRODUCT_COLUMNS),
    binds: (product: MirrorProduct) => [
      product.id,
      product.sku,
      product.name,
      product.category,
      product.brand,
      product.modelNumber,
      product.capacityLabel,
      product.unit,
      product.defaultPrice,
      product.warrantyMonths,
      product.version,
    ],
  },
  service: {
    table: 'services',
    sql: upsertSql('services', SERVICE_COLUMNS),
    binds: (service: MirrorService) => [
      service.id,
      service.code,
      service.name,
      service.description,
      service.defaultCharge,
      service.version,
    ],
  },
};

function upsertRows<T>(database: MirrorDatabase, entity: MirrorEntity, rows: readonly T[]): void {
  if (rows.length === 0) return;
  const { sql, binds } = UPSERT_FOR[entity];
  for (const row of rows) {
    const values = (binds as (row: T) => MirrorBindValue[])(row);
    database.runSync(sql, ...values);
  }
}

/** Tombstones: both reasons (`deleted`, `out_of_scope`) remove the row. */
function applyTombstones(database: MirrorDatabase, tombstones: readonly SyncTombstone[]): void {
  for (const tombstone of tombstones) {
    database.runSync(`DELETE FROM ${TABLE_FOR[tombstone.entity]} WHERE id = ?`, tombstone.id);
  }
}

function setCursor(database: MirrorDatabase, cursor: string): void {
  database.runSync(
    `INSERT INTO mirror_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    CURSOR_KEY,
    cursor,
  );
}

function applyWorkingSet(database: MirrorDatabase, data: SyncWorkingSet): void {
  upsertRows(database, 'job', data.jobs);
  upsertRows(database, 'customer', data.customers);
  upsertRows(database, 'customer_product', data.customerProducts);
  upsertRows(database, 'product', data.products);
  upsertRows(database, 'service', data.services);
}

// ── the three operations the sync loop makes ────────────────────────────────

/**
 * `GET /v1/sync/bootstrap` result: the cold-start working set plus the
 * cursor to delta from. One transaction — upserts, then the cursor last.
 */
export function applyBootstrap(mirror: Mirror, bootstrap: SyncBootstrapResponse): void {
  const { database } = mirror;
  database.withTransactionSync(() => {
    applyWorkingSet(database, bootstrap.data);
    setCursor(database, bootstrap.cursor);
  });
}

/**
 * One `GET /v1/sync/delta` page. ATOMIC: every upsert, every tombstone and
 * the cursor advance run in one transaction, and the cursor update is the
 * LAST statement in it. A row that fails mid-page rolls the whole page
 * back — cursor included — so the next poll re-requests everything. The
 * caller pages on `hasMore`; each page commits (or dies) whole.
 */
export function applyDeltaPage(mirror: Mirror, page: SyncDeltaResponse): void {
  const { database } = mirror;
  database.withTransactionSync(() => {
    applyWorkingSet(database, page.data);
    applyTombstones(database, page.tombstones);
    setCursor(database, page.cursor); // only reachable if the whole page applied
  });
}

/** The stored cursor, or null before the first bootstrap. */
export function readCursor(mirror: Mirror): string | null {
  const row = mirror.database.getFirstSync<{ value: string }>(
    'SELECT value FROM mirror_meta WHERE key = ?',
    CURSOR_KEY,
  );
  return row?.value ?? null;
}

/**
 * User switch (PLAN-FRONTEND.md §5): the mirror is cleared — working set
 * AND cursor, so the next user's first delta starts from the server's
 * bootstrap, never from the previous user's position. The outbox table is
 * NOT touched: it is filtered by `employee_id`, not wiped (T1.14 owns that
 * table and resolves the disagreement with "until drained").
 */
export function clearMirror(mirror: Mirror): void {
  const { database } = mirror;
  database.withTransactionSync(() => {
    for (const entity of MIRROR_ENTITIES) {
      database.runSync(`DELETE FROM ${TABLE_FOR[entity]}`);
    }
    database.runSync('DELETE FROM mirror_meta WHERE key = ?', CURSOR_KEY);
  });
}

/** Raw rows of one mirror table, ordered by id — diagnostics and tests. */
export function readRows(mirror: Mirror, entity: MirrorEntity): Array<Record<string, unknown>> {
  return mirror.database.getAllSync<Record<string, unknown>>(
    `SELECT * FROM ${TABLE_FOR[entity]} ORDER BY id`,
  );
}
