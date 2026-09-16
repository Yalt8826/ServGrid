import type { Db } from '../auth/repo.js';
import type { ScopePredicate } from '../../plugins/rbac.js';

/**
 * Customers SQL (PLAN-BACKEND.md §2 module shape, §6.4). Every function
 * takes its executor explicitly — the Pool for autocommit reads, or the
 * transaction client of a caller's `withTransaction`, the same rule
 * auth/repo.ts and jobs/repo.ts run under.
 *
 * The customer projection is two column lists, not one wide row the
 * service trims (§6.3's per-role principle, carried over): the
 * dispatcher's list never selects `company_id`, because company data is a
 * field he cannot read (PLAN.md §5) — the shape split is mirrored by the
 * query split, so nothing exists in his result set that his schema then
 * has to hide. There is no repo.dispatcher.ts here on purpose: customers
 * carry no money, and the lint rule guards the views the money lives in.
 *
 * Search `q` hits name and phone (§6.4). The name arm is written as the
 * exact expression the GIN index (customers_name_tsv_idx, migration 005)
 * was built over — two-argument `to_tsvector('simple', name::text)`, the
 * IMMUTABLE form — so the planner can use it; the EXPLAIN assertion in
 * test/integration/customers.test.ts pins this against the same SQL the
 * endpoint runs (buildCustomersPage, INLINE mode).
 *
 * BOTH arms are prefix matches since OW.6, and both are still indexed —
 * the condition the earlier design set for exactly this change. The name
 * arm asks the same GIN with a `lexeme:*` query, which is what tsquery
 * prefixes are for; the phone arm is `LIKE 'digits%'`, served by
 * `customers_phone_prefix_idx` (text_pattern_ops, migration 020) because
 * a plain btree cannot answer a byte-order pattern under en_US.utf8. The
 * EXPLAIN assertion still pins both: one unindexed arm would drag the
 * whole OR back to a sequential scan.
 */

/** The name-search expression — keep it byte-identical to the index expression or the GIN is dead weight (migration 005). */
export const NAME_TSV_SQL = "to_tsvector('simple', name::text)";


/**
 * `q` as a prefix tsquery: `ravi kum` → `ravi:* & kum:*` (OW.6).
 *
 * Built here rather than in SQL because `to_tsquery` is strict about its
 * operators — a stray `&`, `!` or quote in a search box would be a
 * syntax error from the database instead of a result. Tokens are letters
 * and digits only, which is also what `simple` would keep.
 */
export function tsqueryPrefix(q: string): string | null {
  const tokens = q.toLowerCase().match(/[\p{L}\p{N}]+/gu);
  if (tokens === null || tokens.length === 0) return null;
  return tokens.map((token) => `${token}:*`).join(' & ');
}

/**
 * The phone arm's prefix: the digits of `q`, or null when it carries
 * none. A name search never reaches the phone index, and a number typed
 * with spaces or a +91 still finds its site.
 */
export function phonePrefixOf(q: string): string | null {
  const digits = q.replace(/\D/g, '');
  return digits === '' ? null : digits;
}

/** Which of this file's customer projections to build. The dispatcher's omits `company_id`. */
export type CustomerVariant = 'full' | 'dispatcher';

const CUSTOMER_COLUMNS: Readonly<Record<CustomerVariant, string>> = {
  full: `c.id, c.name, c.phone, c.alt_phone, c.address_line1, c.address_line2,
    c.area, c.city, c.state, c.pincode, c.latitude, c.longitude, c.notes, c.company_id, c.version`,
  dispatcher: `c.id, c.name, c.phone, c.alt_phone, c.address_line1, c.address_line2,
    c.area, c.city, c.state, c.pincode, c.latitude, c.longitude, c.notes, c.version`,
};

interface CustomerRowBase {
  id: string;
  name: string;
  phone: string;
  alt_phone: string | null;
  address_line1: string | null;
  address_line2: string | null;
  /** The locality (migration 021). */
  area: string | null;
  city: string | null;
  state: string | null;
  pincode: string | null;
  latitude: number | null;
  longitude: number | null;
  notes: string | null;
  version: number;
}

export type CustomerRow = CustomerRowBase & { company_id: string | null };

/** True when the actor has or has had a job at this site — the technician's `assigned` scope, computed in the query (plugins/rbac.ts). */
const IN_SCOPE_SQL =
  'EXISTS (SELECT 1 FROM job_cards jc WHERE jc.customer_id = c.id AND jc.assigned_to = $1)';

/**
 * One customer by id, in the variant's projection. With `scopeActorId`
 * (the technician's point read) the row also carries `in_scope` — the
 * scope is COMPUTED here, and the service turns a false into
 * OUT_OF_SCOPE; a missing row stays NOT_FOUND, never a merged answer
 * (§6.3's point-read convention).
 */
export async function findCustomer(
  db: Db,
  variant: CustomerVariant,
  customerId: string,
  scopeActorId?: string,
): Promise<(CustomerRow & { in_scope?: boolean }) | null> {
  if (scopeActorId !== undefined) {
    const r = await db.query<CustomerRow & { in_scope: boolean }>(
      `SELECT ${CUSTOMER_COLUMNS.full}, ${IN_SCOPE_SQL} AS in_scope
       FROM customers c WHERE c.id = $2 AND c.is_active`,
      [scopeActorId, customerId],
    );
    return r.rows[0] ?? null;
  }
  const r = await db.query<CustomerRow>(
    `SELECT ${CUSTOMER_COLUMNS[variant]} FROM customers c WHERE c.id = $1 AND c.is_active`,
    [customerId],
  );
  return r.rows[0] ?? null;
}

/**
 * Does one site exist AND sit in the actor's scope? For a technician,
 * "the site he has or has had a job for" is part of the WHERE clause,
 * never filtered afterwards (plugins/rbac.ts). The scope's placeholders
 * bind first — the rbac contract's numbering (paramStart 1).
 */
export async function findCustomerScoped(
  db: Db,
  customerId: string,
  scope: ScopePredicate | null,
): Promise<boolean> {
  const values: unknown[] = [];
  const clauses: string[] = ['c.is_active'];
  if (scope !== null) {
    values.push(...scope.params);
    clauses.push(`(${scope.sql})`);
  }
  values.push(customerId);
  clauses.push(`c.id = $${values.length}`);
  const r = await db.query<{ id: string }>(
    `SELECT c.id FROM customers c WHERE ${clauses.join(' AND ')}`,
    values,
  );
  return r.rows.length > 0;
}

export interface CustomerInsert {
  name: string;
  phone: string;
  altPhone: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  area: string | null;
  city: string | null;
  pincode: string | null;
  notes: string | null;
  /** The site pin — both or neither, guaranteed by the schema before it gets here. */
  latitude: number | null;
  longitude: number | null;
  /** Already role-stripped: the service never receives a dispatcher's companyId (§5 rule 3). */
  companyId: string | null;
}

/** POST /v1/customers — a soft-deleteable row, active from birth (§3.2). */
export async function insertCustomer(db: Db, input: CustomerInsert): Promise<string> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO customers (name, phone, alt_phone, address_line1, address_line2, area, city, pincode,
                            notes, latitude, longitude, company_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING id`,
    [
      input.name,
      input.phone,
      input.altPhone,
      input.addressLine1,
      input.addressLine2,
      input.area,
      input.city,
      input.pincode,
      input.notes,
      input.latitude,
      input.longitude,
      input.companyId,
    ],
  );
  return r.rows[0]!.id;
}

/** The PATCH fields, camelCase as the schema carries them, already undefined-filtered by the service. */
export interface CustomerPatchFields {
  name?: string;
  phone?: string;
  altPhone?: string | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  area?: string | null;
  city?: string | null;
  pincode?: string | null;
  notes?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  companyId?: string | null;
}

const PATCH_COLUMNS: Readonly<Record<keyof CustomerPatchFields, string>> = {
  name: 'name',
  phone: 'phone',
  altPhone: 'alt_phone',
  addressLine1: 'address_line1',
  addressLine2: 'address_line2',
  area: 'area',
  city: 'city',
  pincode: 'pincode',
  notes: 'notes',
  latitude: 'latitude',
  longitude: 'longitude',
  companyId: 'company_id',
};

/** PATCH /v1/customers/:id — only the sent columns move; the touch trigger bumps version (migration 005). */
export async function updateCustomer(db: Db, customerId: string, fields: CustomerPatchFields): Promise<void> {
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [key, value] of Object.entries(fields)) {
    values.push(value);
    sets.push(`${PATCH_COLUMNS[key as keyof CustomerPatchFields]} = $${values.length}`);
  }
  values.push(customerId);
  await db.query(`UPDATE customers SET ${sets.join(', ')} WHERE id = $${values.length}`, values);
}

/**
 * The site pin, written by the technician's on-site completion instead of
 * by anyone editing the customer.
 *
 * It lives here — in the module that owns `customers`' columns — rather
 * than in the jobs repo that calls it, so the customer's write rules stay
 * in one file. It is deliberately NOT `updateCustomer`: that path exists
 * for a person editing a record and takes a version lock and an If-Match,
 * while this is a fact the job produced, arriving inside the completion's
 * own transaction. It touches exactly two columns and never the version
 * (the touch trigger bumps that).
 *
 * Both coordinates are required — the table's paired CHECK would refuse
 * half a point, and the caller only has a fix when the device captured
 * one.
 */
export async function setSitePin(
  db: Db,
  customerId: string,
  latitude: number,
  longitude: number,
): Promise<void> {
  await db.query('UPDATE customers SET latitude = $2, longitude = $3 WHERE id = $1', [
    customerId,
    latitude,
    longitude,
  ]);
}

export interface CustomerLockRow {
  id: string;
  version: number;
}

/** The row lock the PATCH holds — the If-Match compare and the write run under it (§6.3's shape). */
export async function lockCustomer(db: Db, customerId: string): Promise<CustomerLockRow | null> {
  const r = await db.query<CustomerLockRow>(
    'SELECT id, version FROM customers WHERE id = $1 AND is_active FOR UPDATE',
    [customerId],
  );
  return r.rows[0] ?? null;
}

// ── the list (§6.4 GET /v1/customers) ───────────────────────────────────────

export interface CustomerListFilter {
  /** Search over name (full-text, the GIN arm) and phone (exact, the btree arm). */
  q?: string;
}

export interface CustomerListCursor {
  /** Full-precision `created_at` as ISO text (the keyset's left column). */
  createdAt: string;
  id: string;
}

export interface CustomerListPage {
  rows: Array<CustomerRow & { created_at_text: string }>;
  /** True when `limit + 1` rows existed — the caller paginates. */
  hasMore: boolean;
}

type ParamMode = 'numbered' | 'inline';

/**
 * The page query, built ONCE for both callers: `listCustomers` renders
 * numbered placeholders ($1, $2 …) for execution, and the EXPLAIN
 * assertion in test/integration/customers.test.ts renders the identical
 * text with the values inlined as literals — so the plan being asserted
 * is the plan the endpoint runs, not a hand-copied twin. Clause order and
 * the rbac numbering contract (the scope's placeholders first) live only
 * here.
 */
function buildCustomersPage(args: {
  mode: ParamMode;
  variant?: CustomerVariant;
  scope: ScopePredicate | null;
  filter: CustomerListFilter;
  cursor: CustomerListCursor | null;
  limit: number;
}): { text: string; values: unknown[] } {
  const { mode, scope, filter, cursor, limit } = args;
  const variant = args.variant ?? 'full';
  const values: unknown[] = [];
  let next = 1;

  const bind = (value: unknown): string => {
    if (mode === 'numbered') {
      values.push(value);
      return `$${next++}`;
    }
    if (typeof value === 'number') return String(value);
    return `'${String(value).replace(/'/g, "''")}'`;
  };

  const clauses: string[] = ['c.is_active'];
  if (scope !== null) {
    if (mode === 'inline') {
      // The EXPLAIN assertion runs the unscoped (owner/dispatcher) query.
      throw new Error('buildCustomersPage: the scope predicate cannot be inlined');
    }
    values.push(...scope.params);
    next += scope.params.length;
    clauses.push(`(${scope.sql})`);
  }
  if (filter.q !== undefined) {
    // Both arms are PREFIX matches (OW.6): a search box answers while the
    // word is still being typed, or it is not a search box. Both stay
    // indexed — the GIN serves `lexeme:*` as it stands, and migration 020
    // adds the text_pattern_ops index the phone's LIKE needs.
    const arms: string[] = [];
    const prefix = tsqueryPrefix(filter.q);
    if (prefix !== null) {
      arms.push(`${NAME_TSV_SQL} @@ to_tsquery('simple', ${bind(prefix)}::text)`);
    }
    const digits = phonePrefixOf(filter.q);
    if (digits !== null) {
      arms.push(`c.phone LIKE ${bind(`${digits}%`)}`);
    }
    // A query of punctuation alone matches nothing rather than everything.
    clauses.push(arms.length === 0 ? 'false' : `(${arms.join(' OR ')})`);
  }
  if (cursor !== null) {
    const at = bind(cursor.createdAt);
    const id = bind(cursor.id);
    clauses.push(`(c.created_at, c.id) < (${at}::timestamptz, ${id}::uuid)`);
  }

  const text = `SELECT ${CUSTOMER_COLUMNS[variant]}, to_json(c.created_at)#>>'{}' AS created_at_text
     FROM customers c
     WHERE ${clauses.join(' AND ')}
     ORDER BY c.created_at DESC, c.id DESC
     LIMIT ${bind(limit + 1)}`;
  return { text, values };
}

/** The exact list SQL, values inlined — the EXPLAIN half of the search assertion (§6.4). */
export function customersPageSqlForExplain(args: {
  filter: CustomerListFilter;
  cursor?: CustomerListCursor | null;
  limit: number;
}): string {
  return buildCustomersPage({
    mode: 'inline',
    scope: null,
    filter: args.filter,
    cursor: args.cursor ?? null,
    limit: args.limit,
  }).text;
}

/**
 * Keyset page over `(created_at, id) DESC` — same key as the jobs list,
 * for the same reasons: `created_at` never updates and the uuid breaks
 * ties. `scope` is the rbac predicate (`customer` × `read`): null for
 * owner and dispatcher, the through-a-job EXISTS for a technician.
 */
export async function listCustomers(
  db: Db,
  variant: CustomerVariant,
  scope: ScopePredicate | null,
  filter: CustomerListFilter,
  cursor: CustomerListCursor | null,
  limit: number,
): Promise<CustomerListPage> {
  const { text, values } = buildCustomersPage({
    mode: 'numbered',
    variant,
    scope,
    filter,
    cursor,
    limit,
  });
  const r = await db.query<CustomerRow & { created_at_text: string }>(text, values);
  return { rows: r.rows, hasMore: r.rows.length > limit };
}

// ── the product stack (§6.4, PLAN-DATA-MODEL.md §3.3) ───────────────────────

/**
 * One stack row as the wire carries it. `installed_on`/`warranty_expires_on`
 * are DATEs and leave the database as text (`::text` → `YYYY-MM-DD`) — a
 * JS Date would be parsed in the server's timezone and a negative offset
 * would shift the day (the sync repo's same decision).
 */
export interface StackItemRow {
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
  is_active: boolean;
}

const STACK_COLUMNS = `cp.id, cp.customer_id, cp.product_id, cp.free_text_name, cp.serial_number,
  cp.quantity, cp.installed_on::text AS installed_on,
  cp.warranty_expires_on::text AS warranty_expires_on, cp.notes, cp.version, cp.is_active`;

/** The site's active stack (§6.4) — read as one list (`customer_products_customer_active_idx`). */
export async function listStackItems(db: Db, customerId: string): Promise<StackItemRow[]> {
  const r = await db.query<StackItemRow>(
    `SELECT ${STACK_COLUMNS} FROM customer_products cp
     WHERE cp.customer_id = $1 AND cp.is_active
     ORDER BY cp.created_at, cp.id`,
    [customerId],
  );
  return r.rows;
}

/** One stack row, active or not — the PATCH/DELETE path reads it to tell 404 from OUT_OF_SCOPE. */
export async function findStackItem(db: Db, itemId: string): Promise<StackItemRow | null> {
  const r = await db.query<StackItemRow>(
    `SELECT ${STACK_COLUMNS} FROM customer_products cp WHERE cp.id = $1`,
    [itemId],
  );
  return r.rows[0] ?? null;
}

export interface StackItemLockRow {
  id: string;
  customer_id: string;
  serial_number: string;
  version: number;
  is_active: boolean;
}

/** The row lock a stack correction holds — the If-Match compare and the write run under it. */
export async function lockStackItem(db: Db, itemId: string): Promise<StackItemLockRow | null> {
  const r = await db.query<StackItemLockRow>(
    `SELECT id, customer_id, serial_number, version, is_active
     FROM customer_products WHERE id = $1 FOR UPDATE`,
    [itemId],
  );
  return r.rows[0] ?? null;
}

/**
 * The active unit carrying this serial, locked — the read half of the
 * serial rule. A serial cannot stand at two sites at once
 * (`customer_products_active_serial_unique`); this pre-check turns the
 * cross-site case into a readable refusal and the partial unique index
 * stays as the race backstop (§6.2 step 5's shape, shared door).
 */
export async function lockActiveUnitBySerial(db: Db, serialNumber: string): Promise<StackItemRow | null> {
  const r = await db.query<StackItemRow>(
    `SELECT ${STACK_COLUMNS} FROM customer_products cp
     WHERE lower(cp.serial_number) = lower($1) AND cp.is_active
     FOR UPDATE`,
    [serialNumber],
  );
  return r.rows[0] ?? null;
}

export interface StackUnitInsert {
  customerId: string;
  installedBy: string;
  productId: string | null;
  freeTextName: string | null;
  serialNumber: string;
  quantity: number;
  /** The sent date, or null to fall back to today's IST business date. */
  installedOn: string | null;
  warrantyExpiresOn: string | null;
  notes: string | null;
}

/**
 * POST /v1/customers/:id/stack — a unit the correction door put there.
 * `source_job_id` is DELIBERATELY absent from the column list (§6.4): a
 * standalone change stamps no source job, and that absence is the audit
 * signal that the change did not come from work done.
 */
export async function insertStackUnit(db: Db, u: StackUnitInsert): Promise<string> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO customer_products
       (customer_id, product_id, free_text_name, serial_number, quantity,
        installed_on, warranty_expires_on, installed_by, notes)
     VALUES ($1, $2, $3, $4, $5, COALESCE($6::date, business_date(now())), $7, $8, $9)
     RETURNING id`,
    [
      u.customerId,
      u.productId,
      u.freeTextName,
      u.serialNumber,
      u.quantity,
      u.installedOn,
      u.warrantyExpiresOn,
      u.installedBy,
      u.notes,
    ],
  );
  return r.rows[0]!.id;
}

/**
 * The refresh half of the idempotent add: the serial already stands at
 * THIS site, so the add corrects it in place. `source_job_id` is left
 * exactly as it was — if the unit came from a job, that trail stays true
 * even after a correction.
 */
export async function refreshStackUnit(db: Db, itemId: string, u: StackUnitInsert): Promise<void> {
  await db.query(
    `UPDATE customer_products SET
       product_id = $2, free_text_name = $3, quantity = $4,
       installed_on = COALESCE($5::date, installed_on),
       warranty_expires_on = $6, notes = $7, installed_by = $8
     WHERE id = $1`,
    [itemId, u.productId, u.freeTextName, u.quantity, u.installedOn, u.warrantyExpiresOn, u.notes, u.installedBy],
  );
}

/** The correction's fields, already undefined-filtered by the service. */
export interface StackItemPatchFields {
  serialNumber?: string;
  quantity?: number;
  warrantyExpiresOn?: string | null;
}

/**
 * PATCH /v1/customers/:id/stack/:itemId — only the sent columns move, and
 * for a technician the row-scope predicate is part of the WHERE clause: a
 * zero-row update is OUT_OF_SCOPE (the service distinguishes it from
 * 404, which the pre-lock already answered). Returns true when a row
 * moved. The predicate arrives numbered from 1 and is renumbered to sit
 * after the field and id placeholders — its own params are appended in
 * the same order it numbered them.
 */
export async function patchStackItemScoped(
  db: Db,
  itemId: string,
  fields: StackItemPatchFields,
  scope: ScopePredicate | null,
): Promise<boolean> {
  const sets: string[] = [];
  const values: unknown[] = [];
  if (fields.serialNumber !== undefined) {
    values.push(fields.serialNumber);
    sets.push(`serial_number = $${values.length}`);
  }
  if (fields.quantity !== undefined) {
    values.push(fields.quantity);
    sets.push(`quantity = $${values.length}`);
  }
  if (fields.warrantyExpiresOn !== undefined) {
    values.push(fields.warrantyExpiresOn);
    sets.push(`warranty_expires_on = $${values.length}::date`);
  }
  values.push(itemId);
  const idParam = values.length;
  let text = `UPDATE customer_products SET ${sets.join(', ')} WHERE id = $${idParam} AND is_active`;
  if (scope !== null) {
    values.push(...scope.params);
    const start = values.length - scope.params.length + 1;
    const scopeSql = scope.sql.replace(/\$\d+/g, (m) => `$${Number(m.slice(1)) + start - 1}`);
    text += ` AND (${scopeSql})`;
  }
  const r = await db.query(text, values);
  return (r.rowCount ?? 0) > 0;
}

/**
 * DELETE /v1/customers/:id/stack/:itemId — soft only (§6.4): `is_active =
 * false`, which is what releases the serial back into circulation. Same
 * scoped-update shape as the PATCH. Returns true when a row moved.
 */
export async function deactivateStackItemScoped(
  db: Db,
  itemId: string,
  scope: ScopePredicate | null,
): Promise<boolean> {
  const values: unknown[] = [itemId];
  let text = 'UPDATE customer_products SET is_active = false WHERE id = $1 AND is_active';
  if (scope !== null) {
    values.push(...scope.params);
    const start = values.length - scope.params.length + 1;
    const scopeSql = scope.sql.replace(/\$\d+/g, (m) => `$${Number(m.slice(1)) + start - 1}`);
    text += ` AND (${scopeSql})`;
  }
  const r = await db.query(text, values);
  return (r.rowCount ?? 0) > 0;
}
