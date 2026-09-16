import {
  type CustomerDispatcher,
  type CustomerDetail,
  type CustomerDetailDispatcher,
  type CustomerRecord,
  type CustomerStackItem,
  type JobStackChange,
  type Role,
} from '@servgrid/shared';
import { AppError } from '../../plugins/errors.js';
import { scopePredicate, type ScopePredicate } from '../../plugins/rbac.js';
import { getPool } from '../../db/pool.js';
import { withTransaction } from '../../db/tx.js';
import * as repo from './repo.js';

/**
 * Customers service (PLAN-BACKEND.md §6.4). Two rules from the spec shape
 * everything here:
 *
 * **`company_id` is a write the dispatcher cannot make.** His payload is
 * stripped at the SCHEMA (DispatcherCustomerCreateSchema /
 * dispatcherCustomerPatchSchema — a zod transform, so the field cannot
 * survive any future handler); his row never SELECTs the column either.
 * This service receives no companyId the caller was not proved entitled
 * to send.
 *
 * **A technician's scope on the stack is `assigned`, not `all`.** The
 * predicate (plugins/rbac.ts `customer.stack` × `assigned`) is composed
 * into the UPDATE/DELETE itself for the two row-keyed doors, and the
 * site lookup is scoped for the add door — never a read-then-filter.
 *
 * The stack's two doors are deliberate (§6.4): the completion payload
 * (T1.6) stamps `source_job_id` because the work caused the change; the
 * standalone doors here are the CORRECTION case — repo.insertStackUnit
 * carries no `source_job_id` column at all, a standalone add stamps no
 * source job, and that absence is the audit signal that the change did
 * not come from work done.
 */


const OUT_OF_SCOPE_MESSAGE = 'That site is not one of your jobs.';
const NOT_FOUND_MESSAGE = "We couldn't find that customer.";
const NOT_FOUND_ITEM_MESSAGE = "We couldn't find that equipment.";

/** §3.3: the serial rule's sentence — the same words the completion door uses. */
const SERIAL_AT_ANOTHER_SITE_MESSAGE =
  'That serial is already recorded at another site — remove it there before installing it here.';

interface PgViolation {
  code: string;
  constraint?: string;
}

function isPgViolation(error: unknown): error is PgViolation {
  return typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string';
}

/** The database's rules, translated — this service never re-decides one. */
function mapDbRefusal(error: unknown): Error {
  if (!isPgViolation(error)) return error instanceof Error ? error : new Error(String(error));
  if (error.code === '23514') {
    return new AppError(
      'VALIDATION_FAILED',
      'One of the details conflicts with a business rule — check the form and try again.',
    );
  }
  if (error.code === '23505') {
    // customer_products_active_serial_unique: the pre-check should have
    // caught it; the index is the race backstop (§3.3).
    return new AppError('VALIDATION_FAILED', SERIAL_AT_ANOTHER_SITE_MESSAGE);
  }
  if (error.code === '23503') {
    return new AppError(
      'VALIDATION_FAILED',
      'Something this refers to is no longer in the system — refresh and try again.',
    );
  }
  return error instanceof Error ? error : new Error(String(error));
}

export interface Actor {
  id: string;
  role: Role;
}

/** The variant whose columns (and therefore wire shape) this role reads. The dispatcher's has no `company_id` in it. */
function variantForRole(role: Role): repo.CustomerVariant {
  return role === 'dispatcher' ? 'dispatcher' : 'full';
}

function toCustomer(variant: repo.CustomerVariant, row: repo.CustomerRow): CustomerRecord | CustomerDispatcher {
  if (variant === 'dispatcher') {
    const customer: CustomerDispatcher = {
      id: row.id,
      name: row.name,
      phone: row.phone,
      altPhone: row.alt_phone,
      addressLine1: row.address_line1,
      addressLine2: row.address_line2,
      area: row.area,
      city: row.city,
      state: row.state,
      pincode: row.pincode,
      latitude: row.latitude,
      longitude: row.longitude,
      notes: row.notes,
      version: row.version,
    };
    return customer;
  }
  const customer: CustomerRecord = {
    id: row.id,
    name: row.name,
    phone: row.phone,
    altPhone: row.alt_phone,
    addressLine1: row.address_line1,
    addressLine2: row.address_line2,
    area: row.area,
    city: row.city,
    state: row.state,
    pincode: row.pincode,
    latitude: row.latitude,
    longitude: row.longitude,
    notes: row.notes,
    companyId: row.company_id,
    version: row.version,
  };
  return customer;
}

function toStackItem(row: repo.StackItemRow): CustomerStackItem {
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

/**
 * The actor's row scope on the stack, from the one matrix. The route's
 * requirePermission has already 403'd every scope of `none`; `all` (the
 * owner) returns null, and the technician's `assigned` returns the
 * predicate the repo composes into the query.
 */
function stackScope(actor: Actor, action: 'update' | 'delete'): ScopePredicate | null {
  return scopePredicate({ role: actor.role, actorId: actor.id, resource: 'customer.stack', action });
}

/** base64url is URL-safe and opaque; the payload is the keyset key, not a secret (§6.3's cursor). */
function encodeCursor(row: { created_at_text: string; id: string }): string {
  return Buffer.from(JSON.stringify([row.created_at_text, row.id]), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): repo.CustomerListCursor {
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

export interface CustomerListQuery {
  q?: string;
  limit?: number;
  cursor?: string;
}

export interface CustomerListPage {
  items: Array<CustomerRecord | CustomerDispatcher>;
  nextCursor: string | null;
}

const DEFAULT_PAGE_SIZE = 50;

export function createCustomersService() {
  /** GET /v1/customers (§6.4) — one role-shaped page; search `q` hits name and phone. */
  async function listCustomers(
    actor: Actor,
    scope: ScopePredicate | null,
    query: CustomerListQuery,
  ): Promise<CustomerListPage> {
    const limit = query.limit ?? DEFAULT_PAGE_SIZE;
    const cursor = query.cursor === undefined ? null : decodeCursor(query.cursor);
    const variant = variantForRole(actor.role);
    const page = await repo.listCustomers(getPool(), variant, scope, { q: query.q }, cursor, limit);
    const rows = page.hasMore ? page.rows.slice(0, limit) : page.rows;
    return {
      items: rows.map((row) => toCustomer(variant, row)),
      nextCursor: page.hasMore ? encodeCursor(rows[rows.length - 1]!) : null,
    };
  }

  /** GET /v1/customers/:id (§6.4) — the site plus its active stack, in the actor's shape. */
  async function getCustomerDetail(
    actor: Actor,
    customerId: string,
  ): Promise<CustomerDetail | CustomerDetailDispatcher> {
    const variant = variantForRole(actor.role);
    const row = await repo.findCustomer(
      getPool(),
      variant,
      customerId,
      actor.role === 'technician' ? actor.id : undefined,
    );
    if (row === null) throw new AppError('NOT_FOUND', NOT_FOUND_MESSAGE);
    if (row.in_scope === false) throw new AppError('OUT_OF_SCOPE', OUT_OF_SCOPE_MESSAGE);
    const stack = (await repo.listStackItems(getPool(), customerId)).map(toStackItem);
    if (actor.role === 'dispatcher') {
      const detail: CustomerDetailDispatcher = {
        ...(toCustomer('dispatcher', row)  as CustomerDispatcher),
        stack,
      };
      return detail;
    }
    const detail: CustomerDetail = { ...(toCustomer('full', row) as CustomerRecord), stack };
    return detail;
  }

  /**
   * GET /v1/customers/:id/stack (§6.4) — the site's active units, same
   * scope as the site read ("scoped"): the stack rides the customer's
   * permission, which is how the dispatcher's read-only stack view (UI
   * plan-2 §D4) and the technician's site reads are served.
   */
  async function getStack(actor: Actor, customerId: string): Promise<CustomerStackItem[]> {
    const row = await repo.findCustomer(
      getPool(),
      variantForRole(actor.role),
      customerId,
      actor.role === 'technician' ? actor.id : undefined,
    );
    if (row === null) throw new AppError('NOT_FOUND', NOT_FOUND_MESSAGE);
    if (row.in_scope === false) throw new AppError('OUT_OF_SCOPE', OUT_OF_SCOPE_MESSAGE);
    return (await repo.listStackItems(getPool(), customerId)).map(toStackItem);
  }

  /**
   * POST /v1/customers (§6.4) — the body has already been through the
   * actor's schema: the dispatcher's was stripped of `companyId` by the
   * zod transform, so what reaches here is exactly what may be stored.
   * The test asserts the ROW, not the response (T2.4).
   */
  async function createCustomer(
    actor: Actor,
    input: {
      name: string;
      phone: string;
      altPhone?: string;
      addressLine1?: string;
      addressLine2?: string;
      area?: string;
      city?: string;
      pincode?: string;
      notes?: string;
      latitude?: number;
      longitude?: number;
      companyId?: string | null;
    },
  ): Promise<CustomerRecord | CustomerDispatcher> {
    const variant = variantForRole(actor.role);
    let id: string;
    try {
      id = await repo.insertCustomer(getPool(), {
        name: input.name,
        phone: input.phone,
        altPhone: input.altPhone ?? null,
        addressLine1: input.addressLine1 ?? null,
        addressLine2: input.addressLine2 ?? null,
        area: input.area ?? null,
        city: input.city ?? null,
        pincode: input.pincode ?? null,
        notes: input.notes ?? null,
        latitude: input.latitude ?? null,
        longitude: input.longitude ?? null,
        companyId: input.companyId ?? null,
      });
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw mapDbRefusal(error);
    }
    const row = await repo.findCustomer(getPool(), variant, id);
    if (row === null) {
      throw new AppError('INTERNAL', 'The customer could not be read back — nothing was lost, try again.');
    }
    return toCustomer(variant, row);
  }

  /**
   * PATCH /v1/customers/:id (§6.4) — under `If-Match`; a stale version is
   * 409 naming the current one. The dispatcher's body was stripped of
   * `companyId` at the schema, so the column can only move for an owner.
   */
  async function patchCustomer(
    actor: Actor,
    customerId: string,
    ifMatch: number,
    fields: repo.CustomerPatchFields,
  ): Promise<CustomerRecord | CustomerDispatcher> {
    const variant = variantForRole(actor.role);
    return withTransaction(async (client) => {
      const locked = await repo.lockCustomer(client, customerId);
      if (locked === null) throw new AppError('NOT_FOUND', NOT_FOUND_MESSAGE);
      if (locked.version !== ifMatch) {
        throw new AppError(
          'VERSION_CONFLICT',
          'This customer changed after you opened it — reload it and try again.',
          { currentVersion: locked.version },
        );
      }
      try {
        await repo.updateCustomer(client, customerId, fields);
      } catch (error) {
        if (error instanceof AppError) throw error;
        throw mapDbRefusal(error);
      }
      const row = await repo.findCustomer(client, variant, customerId);
      if (row === null) {
        throw new AppError('INTERNAL', 'The customer could not be read back — nothing was lost, try again.');
      }
      return toCustomer(variant, row);
    });
  }

  /** The add-a-unit payload is the shape a completion's `stackChanges[]` line already carries (§6.2 step 5). */
  function unitInsertOf(
    customerId: string,
    installedBy: string,
    change: JobStackChange,
  ): repo.StackUnitInsert {
    return {
      customerId,
      installedBy,
      productId: change.productId ?? null,
      freeTextName: change.freeTextName ?? null,
      serialNumber: change.serialNumber,
      quantity: change.quantity ?? 1,
      installedOn: change.installedOn ?? null,
      warrantyExpiresOn: change.warrantyExpiresOn ?? null,
      notes: change.notes ?? null,
    };
  }

  /**
   * POST /v1/customers/:id/stack (§6.4) — "add a unit; idempotent": the
   * upsert-by-serial the completion door uses, minus the stamp. Same
   * serial at THIS site refreshes the row in place; at ANOTHER site it is
   * the refusal the partial unique index would raise, said in a sentence.
   */
  async function addStackItem(
    actor: Actor,
    customerId: string,
    change: JobStackChange,
    siteScope: ScopePredicate | null,
  ): Promise<CustomerStackItem> {
    return withTransaction(async (client) => {
      // The site must exist, be active, and (for a technician) be his —
      // the scope is in the WHERE clause, never a read-then-filter.
      const inScope = await repo.findCustomerScoped(client, customerId, siteScope);
      if (!inScope) {
        const exists = await repo.findCustomer(client, 'full', customerId);
        if (exists === null) throw new AppError('NOT_FOUND', NOT_FOUND_MESSAGE);
        throw new AppError('OUT_OF_SCOPE', OUT_OF_SCOPE_MESSAGE);
      }

      try {
        const insert = unitInsertOf(customerId, actor.id, change);
        const existing = await repo.lockActiveUnitBySerial(client, change.serialNumber);
        if (existing !== null && existing.customer_id !== customerId) {
          throw new AppError('VALIDATION_FAILED', SERIAL_AT_ANOTHER_SITE_MESSAGE);
        }
        if (existing !== null) {
          await repo.refreshStackUnit(client, existing.id, insert);
          const row = await repo.findStackItem(client, existing.id);
          if (row === null) {
            throw new AppError('INTERNAL', 'The equipment could not be read back — nothing was lost, try again.');
          }
          return toStackItem(row);
        }
        const id = await repo.insertStackUnit(client, insert);
        const row = await repo.findStackItem(client, id);
        if (row === null) {
          throw new AppError('INTERNAL', 'The equipment could not be read back — nothing was lost, try again.');
        }
        return toStackItem(row);
      } catch (error) {
        if (error instanceof AppError) throw error;
        throw mapDbRefusal(error);
      }
    });
  }

  /**
   * PATCH /v1/customers/:id/stack/:itemId (§6.4) — the correction case,
   * under `If-Match`: serial, warranty, quantity, and nothing else. For a
   * technician the row-scope predicate is part of the UPDATE's WHERE
   * clause; a zero-row update is OUT_OF_SCOPE, and only a missing,
   * foreign or already-inactive row is 404.
   */
  async function patchStackItem(
    actor: Actor,
    customerId: string,
    itemId: string,
    ifMatch: number,
    fields: repo.StackItemPatchFields,
  ): Promise<CustomerStackItem> {
    return withTransaction(async (client) => {
      const locked = await repo.lockStackItem(client, itemId);
      if (locked === null || !locked.is_active || locked.customer_id !== customerId) {
        throw new AppError('NOT_FOUND', NOT_FOUND_ITEM_MESSAGE);
      }
      if (locked.version !== ifMatch) {
        throw new AppError(
          'VERSION_CONFLICT',
          'This equipment changed after you opened it — reload it and try again.',
          { currentVersion: locked.version },
        );
      }
      if (fields.serialNumber !== undefined && fields.serialNumber !== locked.serial_number) {
        const holder = await repo.lockActiveUnitBySerial(client, fields.serialNumber);
        if (holder !== null && holder.id !== itemId) {
          throw new AppError('VALIDATION_FAILED', SERIAL_AT_ANOTHER_SITE_MESSAGE);
        }
      }
      let updated = false;
      try {
        updated = await repo.patchStackItemScoped(client, itemId, fields, stackScope(actor, 'update'));
      } catch (error) {
        if (error instanceof AppError) throw error;
        throw mapDbRefusal(error);
      }
      if (!updated) throw new AppError('OUT_OF_SCOPE', OUT_OF_SCOPE_MESSAGE);
      const row = await repo.findStackItem(client, itemId);
      if (row === null) {
        throw new AppError('INTERNAL', 'The equipment could not be read back — nothing was lost, try again.');
      }
      return toStackItem(row);
    });
  }

  /**
   * DELETE /v1/customers/:id/stack/:itemId (§6.4) — soft: `is_active =
   * false`, which is what releases the serial for another site. Same
   * scoped UPDATE, same 403/404 split as the PATCH.
   */
  async function deleteStackItem(
    actor: Actor,
    customerId: string,
    itemId: string,
  ): Promise<{ ok: boolean }> {
    return withTransaction(async (client) => {
      const locked = await repo.lockStackItem(client, itemId);
      if (locked === null || locked.customer_id !== customerId) {
        throw new AppError('NOT_FOUND', NOT_FOUND_ITEM_MESSAGE);
      }
      if (!locked.is_active) {
        throw new AppError('NOT_FOUND', NOT_FOUND_ITEM_MESSAGE);
      }
      let updated = false;
      try {
        updated = await repo.deactivateStackItemScoped(client, itemId, stackScope(actor, 'delete'));
      } catch (error) {
        if (error instanceof AppError) throw error;
        throw mapDbRefusal(error);
      }
      // The row exists, is active and at this site — a zero-row update can
      // only mean the scope predicate refused it.
      if (!updated) throw new AppError('OUT_OF_SCOPE', OUT_OF_SCOPE_MESSAGE);
      return { ok: true };
    });
  }

  return {
    listCustomers,
    getCustomerDetail,
    getStack,
    createCustomer,
    patchCustomer,
    addStackItem,
    patchStackItem,
    deleteStackItem,
  };
}

export type CustomersService = ReturnType<typeof createCustomersService>;
