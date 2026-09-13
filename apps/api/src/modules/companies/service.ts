import {
  type CompanyBalance,
  type CompanyCreate,
  type CompanyLedger,
  type CompanyOwnerPatch,
  type CompanyPatch,
  type CompanyRecord,
  type LedgerEntry,
  type Role,
} from '@servgrid/shared';
import { AppError } from '../../plugins/errors.js';
import { scopePredicate, type ScopePredicate } from '../../plugins/rbac.js';
import { getPool } from '../../db/pool.js';
import { withTransaction } from '../../db/tx.js';
import * as repo from './repo.js';

/**
 * Companies service (PLAN-BACKEND.md §11, §5 `own` on company,
 * PLAN-DATA-MODEL.md §3.2). The rules the task exists for:
 *
 * **`own` on company is a predicate, not a filter.** Every scoped read and
 * write composes `owner_rep_id = :actor OR owner_rep_id IS NULL` (from the
 * one matrix, via plugins/rbac.ts) into the SQL WHERE clause. A NULL owner
 * is a house account visible to every rep — the nullable case is doing
 * real work: it is where a company the OWNER creates lands, and the shape
 * for "both reps handle this one".
 *
 * **Ownership moves through one door.** `PATCH /v1/companies/:id/owner` is
 * owner only; `ownerRepId` is not a field of create or patch, so a rep
 * cannot claim another rep's account or hand one off — his own included.
 * That door is also how leave is covered, and it writes the audit trail
 * that makes the cover reviewable.
 *
 * **A rep who creates a company becomes its owner.** The server stamps
 * that at INSERT; the owner creating lands the row as a house account.
 *
 * **A duplicate name is a verdict, not a crash.** Two reps creating the
 * same account offline is the ordinary collision of a shared territory:
 * the pre-check returns 409 DUPLICATE_ENTITY with `details.existing`
 * carrying the server's row, and the partial unique index stays as the
 * race backstop (§11.1's contracts reasoning applied to accounts).
 */

const NOT_FOUND_MESSAGE = "We couldn't find that company.";
const OUT_OF_SCOPE_MESSAGE = 'That account is not one of your accounts.';
const DUPLICATE_MESSAGE =
  'An account with that name already exists — open it instead of creating a new one.';

interface PgViolation {
  code: string;
  constraint?: string;
}

function isPgViolation(error: unknown): error is PgViolation {
  return typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string';
}

export interface Actor {
  id: string;
  role: Role;
}

function toCompany(row: repo.CompanyRow): CompanyRecord {
  return {
    id: row.id,
    name: row.name,
    contactPerson: row.contact_person,
    phone: row.phone,
    email: row.email,
    addressLine1: row.address_line1,
    addressLine2: row.address_line2,
    city: row.city,
    state: row.state,
    pincode: row.pincode,
    gstin: row.gstin,
    notes: row.notes,
    ownerRepId: row.owner_rep_id,
    version: row.version,
  };
}

/**
 * The actor's row scope on companies, from the one matrix. The route's
 * requirePermission has already 403'd every scope of `none`; `all` (the
 * owner) returns null, and a rep's `own` returns the house-account
 * predicate the repo composes into the query.
 */
function companyScope(actor: Actor, action: 'read' | 'create' | 'update'): ScopePredicate | null {
  return scopePredicate({ role: actor.role, actorId: actor.id, resource: 'company', action });
}

/** base64url is URL-safe and opaque; the payload is the keyset key, not a secret (§6.3's cursor). */
function encodeCursor(row: { created_at_text: string; id: string }): string {
  return Buffer.from(JSON.stringify([row.created_at_text, row.id]), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): repo.CompanyListCursor {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      typeof parsed[0] === 'string' &&
      typeof parsed[1] === 'string'
    ) {
      return { createdAt: parsed[0], id: parsed[1] };
    }
  } catch {
    // fall through: a cursor this app did not mint is a stale list, not a crash
  }
  throw new AppError('VALIDATION_FAILED', 'That page reference is stale — reload the list.');
}

export interface CompanyListQuery {
  limit?: number;
  cursor?: string;
}

export interface CompanyListPage {
  items: CompanyRecord[];
  nextCursor: string | null;
}

const DEFAULT_PAGE_SIZE = 50;

export function createCompaniesService() {
  /** GET /v1/companies (§11) — the rep's accounts plus the house accounts; the owner sees all. The scope predicate carries the whole role story. */
  async function listCompanies(
    scope: ScopePredicate | null,
    query: CompanyListQuery,
  ): Promise<CompanyListPage> {
    const limit = query.limit ?? DEFAULT_PAGE_SIZE;
    const cursor = query.cursor === undefined ? null : decodeCursor(query.cursor);
    const page = await repo.listCompanies(getPool(), scope, cursor, limit);
    const rows = page.hasMore ? page.rows.slice(0, limit) : page.rows;
    return {
      items: rows.map(toCompany),
      nextCursor: page.hasMore ? encodeCursor(rows[rows.length - 1]!) : null,
    };
  }

  /** GET /v1/companies/:id (§11) — a missing row is 404; another rep's account is 403 OUT_OF_SCOPE, never a merged answer. */
  async function getCompany(actor: Actor, companyId: string): Promise<CompanyRecord> {
    const row = await repo.findCompany(getPool(), companyId, actor.role === 'sales_rep' ? actor.id : undefined);
    if (row === null) throw new AppError('NOT_FOUND', NOT_FOUND_MESSAGE);
    if (row.in_scope === false) throw new AppError('OUT_OF_SCOPE', OUT_OF_SCOPE_MESSAGE);
    return toCompany(row);
  }

  /** The refusal details carry the server's row, so the rep can see WHICH account beat him there. */
  function duplicateError(existing: repo.CompanyRow): AppError {
    return new AppError('DUPLICATE_ENTITY', DUPLICATE_MESSAGE, { existing: toCompany(existing) });
  }

  /**
   * POST /v1/companies (§11) — the creator becomes the owner: a rep gets
   * `owner_rep_id = himself`, the owner's own create lands a house account
   * (NULL). The name pre-check runs before the INSERT so the offline
   * collision returns the existing row; the unique index backstops the
   * race and re-reads the winner for the same verdict.
   */
  async function createCompany(actor: Actor, input: CompanyCreate): Promise<CompanyRecord> {
    const existing = await repo.findActiveByName(getPool(), input.name);
    if (existing !== null) throw duplicateError(existing);

    const ownerRepId = actor.role === 'sales_rep' ? actor.id : null;
    let id: string;
    try {
      id = await repo.insertCompany(getPool(), {
        name: input.name,
        contactPerson: input.contactPerson ?? null,
        phone: input.phone ?? null,
        email: input.email ?? null,
        addressLine1: input.addressLine1 ?? null,
        addressLine2: input.addressLine2 ?? null,
        city: input.city ?? null,
        state: input.state ?? null,
        pincode: input.pincode ?? null,
        gstin: input.gstin ?? null,
        notes: input.notes ?? null,
        ownerRepId,
      });
    } catch (error) {
      // companies_active_name_unique: two creates raced; the pre-check's
      // verdict stands, with the row that won read back for details.
      if (isPgViolation(error) && error.code === '23505') {
        const winner = await repo.findActiveByName(getPool(), input.name);
        if (winner !== null) throw duplicateError(winner);
      }
      throw error;
    }
    const row = await repo.findCompany(getPool(), id);
    if (row === null) {
      throw new AppError('INTERNAL', 'The company could not be read back — nothing was lost, try again.');
    }
    return toCompany(row);
  }

  /**
   * PATCH /v1/companies/:id (§11) — under `If-Match` (the reference-data
   * precedent, §6.4). For a rep the scope predicate is part of the
   * UPDATE's WHERE clause: another rep's account is a zero-row update and
   * comes back OUT_OF_SCOPE, never "not found" and never applied.
   * `ownerRepId` is not in the payload schema, so ownership cannot move
   * through this door even for the owner — it has the one door below.
   */
  async function patchCompany(
    actor: Actor,
    companyId: string,
    ifMatch: number,
    fields: CompanyPatch,
  ): Promise<CompanyRecord> {
    return withTransaction(async (client) => {
      const locked = await repo.lockCompany(client, companyId);
      if (locked === null) throw new AppError('NOT_FOUND', NOT_FOUND_MESSAGE);
      if (locked.version !== ifMatch) {
        throw new AppError(
          'VERSION_CONFLICT',
          'This company changed after you opened it — reload it and try again.',
          { currentVersion: locked.version },
        );
      }
      let updated = false;
      try {
        updated = await repo.updateCompanyScoped(
          client,
          companyId,
          fields,
          companyScope(actor, 'update'),
        );
      } catch (error) {
        // A rename onto an existing active name raced another create; the
        // create door's verdict stands, with the row that won read back.
        if (isPgViolation(error) && error.code === '23505' && fields.name !== undefined) {
          const winner = await repo.findActiveByName(client, fields.name);
          if (winner !== null && winner.id !== companyId) throw duplicateError(winner);
        }
        throw error;
      }
      if (!updated) throw new AppError('OUT_OF_SCOPE', OUT_OF_SCOPE_MESSAGE);
      const row = await repo.findCompany(client, companyId);
      if (row === null) {
        throw new AppError('INTERNAL', 'The company could not be read back — nothing was lost, try again.');
      }
      return toCompany(row);
    });
  }

  /**
   * PATCH /v1/companies/:id/owner (§11) — OWNER ONLY, the one door that
   * moves `owner_rep_id`: reassignment, or `null` for the leave cover
   * (a house account both reps work). The change leaves a trail — an
   * append-only audit_log row written inside the same transaction, so a
   * rolled-back move leaves no trace and a committed one leaves both
   * owners.
   */
  async function patchOwner(actor: Actor, companyId: string, body: CompanyOwnerPatch): Promise<CompanyRecord> {
    return withTransaction(async (client) => {
      const locked = await repo.lockCompany(client, companyId);
      if (locked === null) throw new AppError('NOT_FOUND', NOT_FOUND_MESSAGE);
      if (body.ownerRepId !== null && !(await repo.employeeExists(client, body.ownerRepId))) {
        throw new AppError('VALIDATION_FAILED', 'That employee is not in the system — pick again.');
      }
      await repo.updateOwner(client, companyId, body.ownerRepId);
      await repo.insertOwnerChangeAudit(client, {
        companyId: locked.id,
        companyName: locked.name,
        previousOwnerRepId: locked.owner_rep_id,
        newOwnerRepId: body.ownerRepId,
        actorId: actor.id,
      });
      const row = await repo.findCompany(client, companyId);
      if (row === null) {
        throw new AppError('INTERNAL', 'The company could not be read back — nothing was lost, try again.');
      }
      return toCompany(row);
    });
  }

  /**
   * GET /v1/companies/:id/ledger (§11) — the account's interleaved history.
   * Scoping is the account's, not the documents': a rep reads the ledger of
   * his accounts and the house accounts exactly as GET /v1/companies/:id
   * draws the line (the same findCompany with the same in_scope verdict) —
   * another rep's account's ledger is OUT_OF_SCOPE even though some
   * payments ON it might carry his `received_by`, because the ledger is
   * the account's story and the account is not his.
   */
  async function getCompanyLedger(actor: Actor, companyId: string): Promise<CompanyLedger> {
    const company = await repo.findCompany(getPool(), companyId, actor.role === 'sales_rep' ? actor.id : undefined);
    if (company === null) throw new AppError('NOT_FOUND', NOT_FOUND_MESSAGE);
    if (company.in_scope === false) throw new AppError('OUT_OF_SCOPE', OUT_OF_SCOPE_MESSAGE);
    const result = await repo.findCompanyLedger(getPool(), companyId);
    const entries: LedgerEntry[] = result.rows.map((row) => ({
      kind: row.kind,
      id: row.id,
      number: row.number,
      date: row.date,
      recordedAt: row.recorded_at.toISOString(),
      mode: row.mode as LedgerEntry['mode'],
      amount: row.amount,
      voided: row.voided,
      voidReason: row.void_reason,
      runningBalance: row.running_balance,
    }));
    return { companyId, balance: result.balance, entries };
  }

  /**
   * GET /v1/companies/balances (§11) — the Pending tab. A view of dues
   * (`v_company_balances`), never a payments table, so what a rep owes
   * about an account is one derived truth shared with the ledger. The
   * scope predicate comes from the route (the list's shape): a rep's own
   * accounts plus the house accounts, the owner everything — `minBalance`
   * defaults to one paisa, the floor that makes "pending" mean owes
   * something; a lower floor is how the owner scans credit balances.
   */
  async function listCompanyBalances(
    scope: ScopePredicate | null,
    query: { minBalance?: string },
  ): Promise<{ items: CompanyBalance[] }> {
    const rows = await repo.listCompanyBalances(getPool(), scope, query.minBalance ?? '0.01');
    return {
      items: rows.map((row) => ({
        companyId: row.company_id,
        name: row.name,
        balance: row.balance,
        lastSaleDate: row.last_sale_date,
        lastPaymentAt: row.last_payment_at?.toISOString() ?? null,
      })),
    };
  }

  return {
    listCompanies,
    getCompany,
    createCompany,
    patchCompany,
    patchOwner,
    getCompanyLedger,
    listCompanyBalances,
  };
}

export type CompaniesService = ReturnType<typeof createCompaniesService>;
