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

// ── the ledger (§11 GET /v1/companies/:id/ledger) ───────────────────────────

export interface LedgerEntryRow {
  kind: 'sale' | 'payment';
  id: string;
  number: string;
  date: string;
  recorded_at: Date;
  mode: string | null;
  amount: string;
  voided: boolean;
  void_reason: string | null;
  running_balance: string;
}

export interface CompanyLedgerResult {
  rows: LedgerEntryRow[];
  /** `v_company_balances.balance`, read in the same statement — the header figure the newest runningBalance must equal. */
  balance: string;
}

/**
 * The interleaved ledger, newest first, with the running balance computed
 * in the SAME statement that reads the rows — one snapshot, so the column
 * cannot tear against the rows it sums.
 *
 * THE one rule this query exists to keep (T3.5 "If it fails"): the running
 * balance must equal `v_company_balances.balance` exactly, to the paisa.
 * It does because it is the SAME SUM over the SAME rows — the window walks
 * backwards from the account's total rather than forwards from zero:
 *
 *   running(row) = SUM(effect) OVER (ORDER BY moved_at DESC, id DESC
 *                                    ROWS CURRENT ROW .. UNBOUNDED FOLLOWING)
 *
 * — this row plus everything OLDER, which is the balance after this row's
 * movement. The newest row's value is the whole sum, and the row set is
 * exactly the view's: sales status IN ('confirmed','void') with effect
 * `v_sales_card_totals.total` only when confirmed (a draft is not money
 * yet; a void is a reversal), payments status IN ('collected','void') with
 * effect `amount` only when collected — signed negative. A voided row
 * APPEARS with its document amount but contributes 0, so the column still
 * reconciles with the view to the paisa. The totals are read through
 * `v_sales_card_totals`, the one definition of a card's worth — the same
 * view the balance reads.
 *
 * `balance` comes from `v_company_balances` in the same statement, so the
 * header figure and the newest running balance are computed against one
 * snapshot of the rows — a confirm racing this read moves both or neither.
 * (An account with NO entries returns zero rows here, so the service's
 * fallback reads the view alone.) Unpaginated on purpose: the running
 * balance column is only meaningful across the whole history, and the
 * largest book here is a few thousand rows (migration 018).
 */
export async function findCompanyLedger(db: Db, companyId: string): Promise<CompanyLedgerResult> {
  const r = await db.query<LedgerEntryRow & { balance: string }>(
    `WITH entries AS (
       SELECT
         'sale'::text            AS kind,
         sc.id                   AS id,
         sc.sale_number          AS number,
         sc.sale_date::text      AS date,
         sc.confirmed_at         AS recorded_at,
         NULL::text              AS mode,
         v.total::text           AS amount,
         (sc.status = 'void')    AS voided,
         sc.void_reason          AS void_reason,
         CASE WHEN sc.status = 'void' THEN 0::numeric(14,2) ELSE v.total END AS effect
       FROM sales_cards sc
       JOIN v_sales_card_totals v ON v.sales_card_id = sc.id
       WHERE sc.company_id = $1 AND sc.status IN ('confirmed', 'void')
       UNION ALL
       SELECT
         'payment'::text         AS kind,
         p.id                    AS id,
         p.payment_number        AS number,
         p.business_date::text   AS date,
         p.received_at           AS recorded_at,
         p.mode::text            AS mode,
         (-p.amount)::text       AS amount,
         (p.status = 'void')     AS voided,
         p.void_reason           AS void_reason,
         CASE WHEN p.status = 'void' THEN 0::numeric(14,2) ELSE -p.amount END AS effect
       FROM payments p
       WHERE p.company_id = $1 AND p.status IN ('collected', 'void')
     )
     SELECT
       e.kind, e.id, e.number, e.date, e.recorded_at, e.mode,
       e.amount, e.voided, e.void_reason,
       SUM(e.effect) OVER (
         ORDER BY e.recorded_at DESC, e.id DESC
         ROWS BETWEEN CURRENT ROW AND UNBOUNDED FOLLOWING
       )::text AS running_balance,
       COALESCE(vb.balance, 0::numeric(14,2))::text AS balance
     FROM entries e
     LEFT JOIN (SELECT v_company_balances.balance
                FROM v_company_balances
                WHERE v_company_balances.company_id = $1) vb ON true
     ORDER BY e.recorded_at DESC, e.id DESC`,
    [companyId],
  );
  if (r.rows.length === 0) {
    // No entries: the LEFT JOIN had no entry row to carry the balance in —
    // read it alone (the account exists; the caller has already
    // 404'd/out-of-scoped a missing one, and the view carries every
    // company).
    const b = await db.query<{ balance: string }>(
      `SELECT COALESCE((SELECT balance FROM v_company_balances WHERE company_id = $1), 0::numeric(14,2))::text AS balance`,
      [companyId],
    );
    return { rows: [], balance: b.rows[0]!.balance };
  }
  return { rows: r.rows, balance: r.rows[0]!.balance };
}

// ── the Pending tab (§11 GET /v1/companies/balances) ────────────────────────

export interface CompanyBalanceRow {
  company_id: string;
  name: string;
  balance: string;
  last_sale_date: string | null;
  last_payment_at: Date | null;
}

/**
 * The Pending tab — `v_company_balances`, never a payments table: pending
 * is a view of dues, not a row (T3.5). `minBalance` is the tab's floor
 * (`balance >= minBalance`, the spec's `?minBalance=0.01`); the scope
 * predicate (`company` × `read` — a rep's own accounts plus the house
 * accounts, the owner everything) lands INSIDE the WHERE, the list's rule.
 * Sorted by balance descending (§S4's list anatomy), name breaking ties so
 * the order is stable across pages and devices.
 */
export async function listCompanyBalances(
  db: Db,
  scope: ScopePredicate | null,
  minBalance: string,
): Promise<CompanyBalanceRow[]> {
  // The scope's params come FIRST — its placeholders are numbered from $1
  // (plugins/rbac.ts paramStart), the module list queries' rule — and the
  // floor binds after them.
  const values: unknown[] = [];
  const clauses: string[] = [];
  if (scope !== null) {
    values.push(...scope.params);
    clauses.push(`(${scope.sql})`);
  }
  values.push(minBalance);
  const minParam = values.length;
  clauses.push(`vb.balance >= $${minParam}::numeric`);
  const r = await db.query<CompanyBalanceRow>(
    `SELECT c.id AS company_id, c.name,
            vb.balance::text AS balance,
            vb.last_sale_date::text AS last_sale_date,
            vb.last_payment_at
     FROM v_company_balances vb
     JOIN companies c ON c.id = vb.company_id AND c.is_active
     WHERE ${clauses.join(' AND ')}
     ORDER BY vb.balance DESC, c.name ASC`,
    values,
  );
  return r.rows;
}
