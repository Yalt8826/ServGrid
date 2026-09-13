import type { Db } from '../auth/repo.js';
import type { ScopePredicate } from '../../plugins/rbac.js';

/**
 * Companies SQL (PLAN-BACKEND.md §11, PLAN-DATA-MODEL.md §3.2). Every
 * function takes its executor explicitly — the Pool for autocommit reads,
 * or the transaction client of a caller's `withTransaction`, the same rule
 * auth/repo.ts and customers/repo.ts run under.
 *
 * THE one rule this file exists to keep: the rep's scope is a WHERE
 * fragment (plugins/rbac.ts `company` × `own` —
 * `owner_rep_id = $n OR owner_rep_id IS NULL`), composed into every
 * scoped query here. It is never a filter over a fetched result set: the
 * two behave identically until someone adds pagination, and then the
 * second one starts returning short pages of nothing
 * (PHASE-3-SALES-REP.md T3.2 "If it fails"). The list is keyset-paginated
 * and the predicate sits inside the WHERE, so a page boundary cannot
 * un-scope it.
 *
 * `name` is citext (migration 005), so the active-name uniqueness the
 * service pre-checks for the offline-create refusal compares
 * case-insensitively for free.
 */

/** The one projection — every company-reading role gets the same shape (§11 has no per-role split on company rows; the dispatcher holds no cell at all). */
const COMPANY_COLUMNS = `c.id, c.name, c.contact_person, c.phone, c.email, c.address_line1,
  c.address_line2, c.city, c.state, c.pincode, c.gstin, c.notes, c.owner_rep_id, c.version`;

export interface CompanyRow {
  id: string;
  name: string;
  contact_person: string | null;
  phone: string | null;
  email: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  state: string | null;
  pincode: string | null;
  gstin: string | null;
  notes: string | null;
  owner_rep_id: string | null;
  version: number;
}

/**
 * One active company by id. With `scopeActorId` (a rep's point read) the
 * row also carries `in_scope` — the scope is COMPUTED here, in the query,
 * and the service turns a false into OUT_OF_SCOPE; a missing row stays
 * NOT_FOUND, never a merged answer (§6.3's point-read convention, the
 * customers service's same shape).
 */
export async function findCompany(
  db: Db,
  companyId: string,
  scopeActorId?: string,
): Promise<(CompanyRow & { in_scope?: boolean }) | null> {
  if (scopeActorId !== undefined) {
    const r = await db.query<CompanyRow & { in_scope: boolean }>(
      `SELECT ${COMPANY_COLUMNS},
         (c.owner_rep_id = $1 OR c.owner_rep_id IS NULL) AS in_scope
       FROM companies c WHERE c.id = $2 AND c.is_active`,
      [scopeActorId, companyId],
    );
    return r.rows[0] ?? null;
  }
  const r = await db.query<CompanyRow>(
    `SELECT ${COMPANY_COLUMNS} FROM companies c WHERE c.id = $1 AND c.is_active`,
    [companyId],
  );
  return r.rows[0] ?? null;
}

/**
 * The active company carrying this name, case-insensitively (citext
 * equality against `companies_active_name_unique`, migration 005) — the
 * read half of the offline-create refusal. The row itself goes back in
 * `details.existing`, because a rep told "already exists" must be able to
 * see WHICH account (the contracts 409's reasoning, §11.1).
 */
export async function findActiveByName(db: Db, name: string): Promise<CompanyRow | null> {
  const r = await db.query<CompanyRow>(
    `SELECT ${COMPANY_COLUMNS} FROM companies c WHERE c.name = $1 AND c.is_active`,
    [name],
  );
  return r.rows[0] ?? null;
}

export interface CompanyInsert {
  name: string;
  contactPerson: string | null;
  phone: string | null;
  email: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  state: string | null;
  pincode: string | null;
  gstin: string | null;
  notes: string | null;
  /** The creator's id for a rep (create stamps the owner), NULL for the owner — a house account (§3.2). Already role-decided by the service. */
  ownerRepId: string | null;
}

/** POST /v1/companies — a soft-deleteable row, active from birth (§3.2). */
export async function insertCompany(db: Db, input: CompanyInsert): Promise<string> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO companies
       (name, contact_person, phone, email, address_line1, address_line2,
        city, state, pincode, gstin, notes, owner_rep_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING id`,
    [
      input.name,
      input.contactPerson,
      input.phone,
      input.email,
      input.addressLine1,
      input.addressLine2,
      input.city,
      input.state,
      input.pincode,
      input.gstin,
      input.notes,
      input.ownerRepId,
    ],
  );
  return r.rows[0]!.id;
}

export interface CompanyLockRow {
  id: string;
  name: string;
  owner_rep_id: string | null;
  version: number;
}

/** The row lock a PATCH holds — the If-Match compare and the write run under it (§6.3's shape). */
export async function lockCompany(db: Db, companyId: string): Promise<CompanyLockRow | null> {
  const r = await db.query<CompanyLockRow>(
    'SELECT id, name, owner_rep_id, version FROM companies WHERE id = $1 AND is_active FOR UPDATE',
    [companyId],
  );
  return r.rows[0] ?? null;
}

/** The PATCH fields, camelCase as the schema carries them, already undefined-filtered by the service. `owner_rep_id` is deliberately absent — it moves through the owner endpoint alone. */
export interface CompanyPatchFields {
  name?: string;
  contactPerson?: string | null;
  phone?: string | null;
  email?: string | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  state?: string | null;
  pincode?: string | null;
  gstin?: string | null;
  notes?: string | null;
}

const PATCH_COLUMNS: Readonly<Record<keyof CompanyPatchFields, string>> = {
  name: 'name',
  contactPerson: 'contact_person',
  phone: 'phone',
  email: 'email',
  addressLine1: 'address_line1',
  addressLine2: 'address_line2',
  city: 'city',
  state: 'state',
  pincode: 'pincode',
  gstin: 'gstin',
  notes: 'notes',
};

/**
 * PATCH /v1/companies/:id — only the sent columns move; the touch trigger
 * bumps version (migration 005). For a rep the scope predicate is part of
 * the WHERE clause: a zero-row update is OUT_OF_SCOPE, not silently
 * swallowed. Returns true when a row moved.
 */
export async function updateCompanyScoped(
  db: Db,
  companyId: string,
  fields: CompanyPatchFields,
  scope: ScopePredicate | null,
): Promise<boolean> {
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [key, value] of Object.entries(fields)) {
    values.push(value);
    sets.push(`${PATCH_COLUMNS[key as keyof CompanyPatchFields]} = $${values.length}`);
  }
  values.push(companyId);
  const idParam = values.length;
  let text = `UPDATE companies SET ${sets.join(', ')} WHERE id = $${idParam} AND is_active`;
  if (scope !== null) {
    values.push(...scope.params);
    const start = values.length - scope.params.length + 1;
    const scopeSql = scope.sql.replace(/\$\d+/g, (m) => `$${Number(m.slice(1)) + start - 1}`);
    text += ` AND (${scopeSql})`;
  }
  const r = await db.query(text, values);
  return (r.rowCount ?? 0) > 0;
}

/** The one column PATCH /v1/companies/:id/owner is allowed to move. The caller has already locked the row and written the audit trail. */
export async function updateOwner(db: Db, companyId: string, ownerRepId: string | null): Promise<void> {
  await db.query('UPDATE companies SET owner_rep_id = $1 WHERE id = $2', [ownerRepId, companyId]);
}

/**
 * The trail an ownership change leaves (§11: "the change leaves a trail").
 * Append-only `audit_log` (migration 005z), written inside the
 * reassignment's transaction so a rolled-back move leaves no trace and a
 * committed one leaves both owners. `employee_id` is the NEW owner (null
 * for a house account); the details carry the full before/after.
 */
export async function insertOwnerChangeAudit(
  db: Db,
  e: {
    companyId: string;
    companyName: string;
    previousOwnerRepId: string | null;
    newOwnerRepId: string | null;
    actorId: string;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO audit_log (action, employee_id, actor, details)
     VALUES ('company.owner.reassigned', $1, $2, $3::jsonb)`,
    [e.newOwnerRepId, e.actorId, JSON.stringify({
      companyId: e.companyId,
      companyName: e.companyName,
      previousOwnerRepId: e.previousOwnerRepId,
      newOwnerRepId: e.newOwnerRepId,
    })],
  );
}

/** The target of a reassignment must name a real, active employee — checked before the write so the FK never surfaces as a 500. */
export async function employeeExists(db: Db, employeeId: string): Promise<boolean> {
  const r = await db.query<{ id: string }>(
    'SELECT id FROM employees WHERE id = $1 AND is_active',
    [employeeId],
  );
  return r.rows.length > 0;
}

// ── the list (§11 GET /v1/companies) ────────────────────────────────────────

export interface CompanyListCursor {
  /** Full-precision `created_at` as ISO text (the keyset's left column). */
  createdAt: string;
  id: string;
}

export interface CompanyListPage {
  rows: Array<CompanyRow & { created_at_text: string }>;
  /** True when `limit + 1` rows existed — the caller paginates. */
  hasMore: boolean;
}

/**
 * Keyset page over `(created_at, id) DESC` — the same key as the customers
 * and jobs lists, for the same reasons: `created_at` never updates and the
 * uuid breaks ties. `scope` is the rbac predicate (`company` × `read`):
 * null for the owner, `owner_rep_id = :actor OR owner_rep_id IS NULL` for
 * a rep — INSIDE the WHERE, so pagination composes with scoping instead of
 * competing with it.
 */
export async function listCompanies(
  db: Db,
  scope: ScopePredicate | null,
  cursor: CompanyListCursor | null,
  limit: number,
): Promise<CompanyListPage> {
  const values: unknown[] = [];
  const clauses: string[] = ['c.is_active'];
  if (scope !== null) {
    values.push(...scope.params);
    clauses.push(`(${scope.sql})`);
  }
  if (cursor !== null) {
    values.push(cursor.createdAt);
    const atParam = values.length;
    values.push(cursor.id);
    const idParam = values.length;
    clauses.push(`(c.created_at, c.id) < ($${atParam}::timestamptz, $${idParam}::uuid)`);
  }
  values.push(limit + 1);
  const limitParam = values.length;

  const r = await db.query<CompanyRow & { created_at_text: string }>(
    `SELECT ${COMPANY_COLUMNS}, to_json(c.created_at)#>>'{}' AS created_at_text
     FROM companies c
     WHERE ${clauses.join(' AND ')}
     ORDER BY c.created_at DESC, c.id DESC
     LIMIT $${limitParam}`,
    values,
  );
  return { rows: r.rows, hasMore: r.rows.length > limit };
}
