import {
  type SaleCreate,
  type SaleItem,
  type SalePatch,
  type SaleRecord,
  type Role,
} from '@servgrid/shared';
import { AppError } from '../../plugins/errors.js';
import { scopePredicate, type ScopePredicate } from '../../plugins/rbac.js';
import { getPool } from '../../db/pool.js';
import { withTransaction } from '../../db/tx.js';
import { allocateNumber } from '../../lib/sequences.js';
import * as repo from './repo.js';

/**
 * Sales cards service (PLAN-BACKEND.md §11, PLAN-DATA-MODEL.md §3.5,
 * PHASE-3-SALES-REP.md T3.3). The rules the task exists for:
 *
 * **The number is minted at CONFIRM, not at create.** A draft carries no
 * `sale_number` — the schema's CHECK (`sale_number_when_confirmed`,
 * migration 017) makes draft-and-no-number one condition — so a draft that
 * never confirms burns no number, and the rep's device shows "Draft", never
 * a fake local number. Confirm allocates from `next_in_sequence('sale:2627')`
 * inside the confirm's transaction and stamps `confirmed_at`: the instant
 * the company's balance moved.
 *
 * **The snapshot is stored, never re-derived.** A line's
 * `product_name`/`product_sku`/`unit_price` are exactly what the payload
 * carried — the picker copied them off the product at add time, the unit
 * price is the negotiated one, and a rename or repricing next quarter must
 * not rewrite this sale. `product_id` rides along for reporting joins and
 * is never read for display.
 *
 * **Reps create and confirm; only the owner voids.** A rep who needs a sale
 * reversed asks. Void is the door that moves a company's balance backwards,
 * so it is checked at the door (the companies /owner precedent — the matrix
 * cannot express "the cell that lets him confirm must not let him void"),
 * and a void carries a reason, because a balance that moved for nothing is
 * unreviewable at month end.
 *
 * **A confirmed card is corrected by void, never edited.** PATCH answers
 * drafts only — `409 ILLEGAL_TRANSITION` once confirmed, whoever asks.
 *
 * **Scoping:** the LIST composes the `sale` × `own` predicate
 * (`sales_rep_id = :actor`) into its WHERE, so pagination cannot un-scope
 * it; the point mutations take the row lock first and check the locked
 * row's `sales_rep_id` (the jobs module's transition precedent), so another
 * rep's card is 403 OUT_OF_SCOPE and a missing one 404 — never a merged
 * answer.
 */

const NOT_FOUND_MESSAGE = "We couldn't find that sale.";
const OUT_OF_SCOPE_MESSAGE = 'That sale is not one of yours.';
const NOT_DRAFT_MESSAGE = 'Only a draft can be edited — this sale was already confirmed.';
const EMPTY_CONFIRM_MESSAGE = 'Add at least one line before confirming.';
const DRAFT_VOID_MESSAGE = 'A draft has no number to reverse — discard it instead of voiding it.';
const ALREADY_VOID_MESSAGE = 'This sale is already void — that is final.';
const NO_COMPANY_MESSAGE = 'That account is not in the system — pick again.';

export interface Actor {
  id: string;
  role: Role;
}

function toSaleItem(item: repo.SaleItemRow): SaleItem {
  return {
    lineNo: item.line_no,
    productId: item.product_id,
    productName: item.product_name,
    productSku: item.product_sku,
    quantity: item.quantity,
    unitPrice: item.unit_price,
    lineTotal: item.line_total,
    serialNumbers: item.serial_numbers ?? [],
  };
}

function toSale(row: repo.SaleRow & { items: repo.SaleItemRow[] }): SaleRecord {
  return {
    id: row.id,
    saleNumber: row.sale_number,
    companyId: row.company_id,
    salesRepId: row.sales_rep_id,
    saleDate: row.sale_date,
    status: row.status as SaleRecord['status'],
    notes: row.notes,
    confirmedAt: row.confirmed_at?.toISOString() ?? null,
    voidedAt: row.voided_at?.toISOString() ?? null,
    voidReason: row.void_reason,
    total: row.total,
    items: row.items.map(toSaleItem),
    version: row.version,
  };
}

/**
 * The actor's row scope on sales, from the one matrix. `all` (the owner)
 * returns null, and a rep's `own` returns the authorship predicate the
 * repo composes into the list's WHERE. Exported for the route, which
 * builds the predicate against the query's own alias — the companies
 * route's shape, so scoping is built once at the door and handed in.
 */
export function saleScope(actor: Actor): ScopePredicate | null {
  return scopePredicate({ role: actor.role, actorId: actor.id, resource: 'sale', action: 'read' });
}

/**
 * The rep check on a LOCKED row (the jobs module's transition precedent):
 * under FOR UPDATE the check reads the pinned truth, so the guarantee is
 * the predicate's — another rep's card never moves — without re-deriving
 * the row's identity outside the transaction that holds it.
 */
function assertInScope(actor: Actor, row: repo.SaleRow): void {
  if (actor.role === 'sales_rep' && row.sales_rep_id !== actor.id) {
    throw new AppError('OUT_OF_SCOPE', OUT_OF_SCOPE_MESSAGE);
  }
}

/** base64url is URL-safe and opaque; the payload is the keyset key, not a secret (§6.3's cursor). */
function encodeCursor(row: { created_at_text: string; id: string }): string {
  return Buffer.from(JSON.stringify([row.created_at_text, row.id]), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): repo.SaleListCursor {
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

export interface SaleListQuery {
  limit?: number;
  cursor?: string;
}

export interface SaleListPage {
  items: SaleRecord[];
  nextCursor: string | null;
}

const DEFAULT_PAGE_SIZE = 50;

export function createSalesService() {
  /** GET /v1/sales (§11) — the rep's own cards, the owner sees all. The scope predicate comes from the route, built once at the door. */
  async function listSales(scope: ScopePredicate | null, query: SaleListQuery): Promise<SaleListPage> {
    const limit = query.limit ?? DEFAULT_PAGE_SIZE;
    const cursor = query.cursor === undefined ? null : decodeCursor(query.cursor);
    const page = await repo.listSales(getPool(), scope, cursor, limit);
    const rows = page.hasMore ? page.rows.slice(0, limit) : page.rows;
    return {
      items: rows.map(toSale),
      nextCursor: page.hasMore ? encodeCursor(rows[rows.length - 1]!) : null,
    };
  }

  /**
   * POST /v1/sales (§11) — a DRAFT, whoever creates it: no number, no
   * stamp, no balance. `sales_rep_id` is the actor (the record says who
   * made the sale); the payload carries no rep field, the server decides.
   * The account must exist so the FK never surfaces as a 500.
   */
  async function createSale(actor: Actor, input: SaleCreate): Promise<SaleRecord> {
    return withTransaction(async (client) => {
      if (!(await repo.companyExists(client, input.companyId))) {
        throw new AppError('VALIDATION_FAILED', NO_COMPANY_MESSAGE);
      }
      const id = await repo.insertSale(client, {
        companyId: input.companyId,
        salesRepId: actor.id,
        saleDate: input.saleDate,
        notes: input.notes ?? null,
      });
      await repo.insertSaleItems(client, id, input.items);
      const row = await repo.findSale(client, id);
      if (row === null) {
        throw new AppError('INTERNAL', 'The sale could not be read back — nothing was lost, try again.');
      }
      return toSale(row);
    });
  }

  /**
   * PATCH /v1/sales/:id (§11: rep own, DRAFT only) — under `If-Match` (the
   * reference-data precedent, §6.4). `items` rewrites the draft's lines in
   * full (migration 017's shape); absent leaves them alone. A confirmed
   * card is refused ILLEGAL_TRANSITION before anything is read for the
   * write, and the owner is refused it too: the correction path for a
   * confirmed card is the owner's void, not an edit.
   */
  async function patchSale(actor: Actor, saleId: string, ifMatch: number, fields: SalePatch): Promise<SaleRecord> {
    return withTransaction(async (client) => {
      const locked = await repo.lockSale(client, saleId);
      if (locked === null) throw new AppError('NOT_FOUND', NOT_FOUND_MESSAGE);
      assertInScope(actor, locked);
      if (locked.version !== ifMatch) {
        throw new AppError(
          'VERSION_CONFLICT',
          'This sale changed after you opened it — reload it and try again.',
          { currentVersion: locked.version },
        );
      }
      if (locked.status !== 'draft') {
        throw new AppError('ILLEGAL_TRANSITION', NOT_DRAFT_MESSAGE);
      }
      const patchFields: repo.SalePatchFields = {};
      if (fields.saleDate !== undefined) patchFields.saleDate = fields.saleDate;
      if (fields.notes !== undefined) patchFields.notes = fields.notes ?? null;
      await repo.updateSaleFields(client, saleId, patchFields);
      if (fields.items !== undefined) {
        await repo.deleteSaleItems(client, saleId);
        await repo.insertSaleItems(client, saleId, fields.items);
      }
      const row = await repo.findSale(client, saleId);
      if (row === null) {
        throw new AppError('INTERNAL', 'The sale could not be read back — nothing was lost, try again.');
      }
      return toSale(row);
    });
  }

  /**
   * POST /v1/sales/:id/confirm (§11) — draft → confirmed, the move that
   * mints the number and lifts the balance. The allocation runs inside the
   * transaction, so a refusal after allocation rolls the number back with
   * the stamp; `next_in_sequence` is atomic, so two confirms of two drafts
   * never share one. Confirming an empty card is refused: a zero-worth
   * document with a burnt number is noise in the ledger.
   */
  async function confirmSale(actor: Actor, saleId: string): Promise<SaleRecord> {
    return withTransaction(async (client) => {
      const locked = await repo.lockSale(client, saleId);
      if (locked === null) throw new AppError('NOT_FOUND', NOT_FOUND_MESSAGE);
      assertInScope(actor, locked);
      if (locked.status !== 'draft') {
        throw new AppError('ILLEGAL_TRANSITION', NOT_DRAFT_MESSAGE);
      }
      if ((await repo.countSaleItems(client, saleId)) === 0) {
        throw new AppError('VALIDATION_FAILED', EMPTY_CONFIRM_MESSAGE);
      }
      const saleNumber = await allocateNumber('sale', { db: client });
      await repo.confirmSale(client, saleId, saleNumber);
      const row = await repo.findSale(client, saleId);
      if (row === null) {
        throw new AppError('INTERNAL', 'The sale could not be read back — nothing was lost, try again.');
      }
      return toSale(row);
    });
  }

  /**
   * POST /v1/sales/:id/void (§11: OWNER ONLY — the route's door check has
   * already refused every rep). Reason required; the refusal to void a
   * draft names the real rule: a draft never moved the balance and carries
   * no number, so there is nothing to reverse — the schema's
   * `sale_number_when_confirmed` CHECK would refuse it too, but the API
   * says why instead of letting the constraint surface as a 500.
   */
  async function voidSale(actor: Actor, saleId: string, reason: string): Promise<SaleRecord> {
    return withTransaction(async (client) => {
      const locked = await repo.lockSale(client, saleId);
      if (locked === null) throw new AppError('NOT_FOUND', NOT_FOUND_MESSAGE);
      if (locked.status === 'draft') {
        throw new AppError('ILLEGAL_TRANSITION', DRAFT_VOID_MESSAGE);
      }
      if (locked.status === 'void') {
        throw new AppError('ILLEGAL_TRANSITION', ALREADY_VOID_MESSAGE);
      }
      await repo.voidSale(client, saleId, actor.id, reason);
      const row = await repo.findSale(client, saleId);
      if (row === null) {
        throw new AppError('INTERNAL', 'The sale could not be read back — nothing was lost, try again.');
      }
      return toSale(row);
    });
  }

  return {
    listSales,
    createSale,
    patchSale,
    confirmSale,
    voidSale,
  };
}

export type SalesService = ReturnType<typeof createSalesService>;
