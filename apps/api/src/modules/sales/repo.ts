import type { Db } from '../auth/repo.js';
import type { ScopePredicate } from '../../plugins/rbac.js';
import type { SaleItemInput } from '@servgrid/shared';

/**
 * Sales cards SQL (PLAN-BACKEND.md §11, PLAN-DATA-MODEL.md §3.5). Every
 * function takes its executor explicitly — the Pool for autocommit reads,
 * or the transaction client of a caller's `withTransaction` (the companies
 * and auth repos' rule).
 *
 * THE one rule this file exists to keep, same as companies/repo.ts: the
 * rep's scope is a WHERE fragment (`sale` × `own` —
 * `sales_rep_id = $n`, plugins/rbac.ts) composed into the LIST's query, so
 * pagination composes with scoping instead of competing with it. The point
 * mutations (PATCH/confirm/void) take the row lock first and check the
 * locked row's `sales_rep_id` in the service — the jobs module's
 * transition precedent (§6.3): under FOR UPDATE the check reads the pinned
 * truth, so a concurrent edit cannot slip between the check and the write.
 *
 * A card's `total` is read from `v_sales_card_totals` (migration 018) and
 * never recomputed here: "what is a sale worth" has one definition and
 * every reader joins the view.
 */

/** The one projection — §11 has no per-role split on sale rows (rep and owner read the same card; the dispatcher holds no cell at all). */
const SALE_COLUMNS = `sc.id, sc.sale_number, sc.company_id, sc.sales_rep_id,
  sc.sale_date::text AS sale_date, sc.status::text AS status, sc.notes,
  sc.confirmed_at, sc.voided_at, sc.void_reason, sc.version, v.total::text AS total`;

export interface SaleRow {
  id: string;
  sale_number: string | null;
  company_id: string;
  sales_rep_id: string;
  sale_date: string;
  status: string;
  notes: string | null;
  confirmed_at: Date | null;
  voided_at: Date | null;
  void_reason: string | null;
  version: number;
  total: string;
}

export interface SaleItemRow {
  line_no: number;
  product_id: string | null;
  product_name: string;
  product_sku: string | null;
  quantity: string;
  unit_price: string;
  line_total: string;
  serial_numbers: string[] | null;
}

/** One card with its lines; the lines are the card's body, read in line order. */
export async function findSale(db: Db, saleId: string): Promise<(SaleRow & { items: SaleItemRow[] }) | null> {
  const card = await db.query<SaleRow>(
    `SELECT ${SALE_COLUMNS}
     FROM sales_cards sc
     JOIN v_sales_card_totals v ON v.sales_card_id = sc.id
     WHERE sc.id = $1`,
    [saleId],
  );
  if (card.rows.length === 0) return null;
  const items = await db.query<SaleItemRow>(
    `SELECT line_no, product_id, product_name, product_sku,
            quantity::text AS quantity, unit_price::text AS unit_price,
            line_total::text AS line_total, serial_numbers
     FROM sales_card_items
     WHERE sales_card_id = $1
     ORDER BY line_no`,
    [saleId],
  );
  return { ...card.rows[0]!, items: items.rows };
}

/**
 * POST /v1/sales — the draft row. `sale_number` stays NULL and `status`
 * stays 'draft' by the column defaults: the number is allocated at CONFIRM
 * (§11), never here, so a draft that never confirms burns no number.
 */
export async function insertSale(
  db: Db,
  input: { companyId: string; salesRepId: string; saleDate: string; notes: string | null },
): Promise<string> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO sales_cards (company_id, sales_rep_id, sale_date, notes)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [input.companyId, input.salesRepId, input.saleDate, input.notes],
  );
  return r.rows[0]!.id;
}

/**
 * The lines, written in payload order. The SNAPSHOT columns are written
 * exactly as the payload carried them — the server never re-derives a
 * line's name or price from `products`, because the snapshot records what
 * was actually agreed (§3.5). `line_total` is the DB's generated column;
 * nothing here computes money.
 */
export async function insertSaleItems(db: Db, saleId: string, items: SaleItemInput[]): Promise<void> {
  let line = 0;
  for (const item of items) {
    line += 1;
    await db.query(
      `INSERT INTO sales_card_items
         (sales_card_id, line_no, product_id, product_name, product_sku, quantity, unit_price, serial_numbers)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        saleId,
        line,
        item.productId ?? null,
        item.productName,
        item.productSku ?? null,
        item.quantity,
        item.unitPrice,
        item.serialNumbers ?? null,
      ],
    );
  }
}

/** A draft's PATCH rewrites its lines in full (migration 017's shape); a confirmed card's lines are never touched. */
export async function deleteSaleItems(db: Db, saleId: string): Promise<void> {
  await db.query('DELETE FROM sales_card_items WHERE sales_card_id = $1', [saleId]);
}

/** The row lock a PATCH/confirm/void holds — the status check and the write run under it (§6.3's shape). */
export async function lockSale(db: Db, saleId: string): Promise<SaleRow | null> {
  const r = await db.query<SaleRow & { created_at_text?: string }>(
    `SELECT ${SALE_COLUMNS}
     FROM sales_cards sc
     JOIN v_sales_card_totals v ON v.sales_card_id = sc.id
     WHERE sc.id = $1
     FOR UPDATE OF sc`,
    [saleId],
  );
  return r.rows[0] ?? null;
}

/** Confirm's non-empty rule reads the line count under the same row lock the confirm itself holds. */
export async function countSaleItems(db: Db, saleId: string): Promise<number> {
  const r = await db.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM sales_card_items WHERE sales_card_id = $1',
    [saleId],
  );
  return Number(r.rows[0]?.count ?? '0');
}

const PATCH_COLUMNS = { saleDate: 'sale_date', notes: 'notes' } as const;
export type SalePatchFields = Partial<Record<keyof typeof PATCH_COLUMNS, string | null>>;

/** PATCH on a draft — only the sent columns move; the touch trigger bumps `updated_at`/`version` (migration 017). */
export async function updateSaleFields(db: Db, saleId: string, fields: SalePatchFields): Promise<void> {
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [key, value] of Object.entries(fields)) {
    values.push(value);
    sets.push(`${PATCH_COLUMNS[key as keyof typeof PATCH_COLUMNS]} = $${values.length}`);
  }
  if (sets.length === 0) return;
  values.push(saleId);
  await db.query(`UPDATE sales_cards SET ${sets.join(', ')} WHERE id = $${values.length}`, values);
}

/**
 * POST /v1/sales/:id/confirm — the one move that mints a number. The value
 * comes from `next_in_sequence('sale:2627')` inside the caller's
 * transaction (lib/sequences.ts), so a rolled-back confirm leaves no
 * number and no stamp, and `confirmed_at` is the server's instant — the
 * moment the balance moved.
 */
export async function confirmSale(db: Db, saleId: string, saleNumber: string): Promise<void> {
  await db.query(
    `UPDATE sales_cards
     SET status = 'confirmed', sale_number = $2, confirmed_at = now()
     WHERE id = $1`,
    [saleId, saleNumber],
  );
}

/**
 * POST /v1/sales/:id/void — the reversal. Void, never DELETE: the row and
 * its number stay, the reason and who stay, and v_company_balances (which
 * reads only status = 'confirmed') drops the card on its own.
 */
export async function voidSale(db: Db, saleId: string, voidedBy: string, reason: string): Promise<void> {
  await db.query(
    `UPDATE sales_cards
     SET status = 'void', voided_at = now(), voided_by = $2, void_reason = $3
     WHERE id = $1`,
    [saleId, voidedBy, reason],
  );
}

// ── the list (§11 GET /v1/sales) ────────────────────────────────────────────

export interface SaleListCursor {
  /** Full-precision `created_at` as ISO text (the keyset's left column). */
  createdAt: string;
  id: string;
}

export interface SaleListPage {
  rows: Array<SaleRow & { created_at_text: string; items: SaleItemRow[] }>;
  /** True when `limit + 1` rows existed — the caller paginates. */
  hasMore: boolean;
}

/**
 * Keyset page over `(created_at, id) DESC` — the companies and customers
 * lists' key, for the same reasons: `created_at` never updates and the
 * uuid breaks ties. `scope` is the rbac predicate (`sale` × `read`): null
 * for the owner, `sales_rep_id = :actor` for a rep — INSIDE the WHERE, so
 * pagination composes with scoping instead of competing with it.
 *
 * The page's lines are fetched per card in one `= ANY($n)` sweep, so a
 * page costs two statements however many cards it carries.
 */
export async function listSales(
  db: Db,
  scope: ScopePredicate | null,
  cursor: SaleListCursor | null,
  limit: number,
): Promise<SaleListPage> {
  const values: unknown[] = [];
  if (scope !== null) {
    values.push(...scope.params);
  }
  const scopeClause = scope === null ? '' : ` AND (${scope.sql})`;
  if (cursor !== null) {
    values.push(cursor.createdAt);
    const atParam = values.length;
    values.push(cursor.id);
    const idParam = values.length;
    values.push(limit + 1);
    const limitParam = values.length;
    const r = await db.query<SaleRow & { created_at_text: string }>(
      `SELECT ${SALE_COLUMNS}, to_json(sc.created_at)#>>'{}' AS created_at_text
       FROM sales_cards sc
       JOIN v_sales_card_totals v ON v.sales_card_id = sc.id
       WHERE (sc.created_at, sc.id) < ($${atParam}::timestamptz, $${idParam}::uuid)${scopeClause}
       ORDER BY sc.created_at DESC, sc.id DESC
       LIMIT $${limitParam}`,
      values,
    );
    return { rows: await withItems(db, r.rows), hasMore: r.rows.length > limit };
  }
  values.push(limit + 1);
  const limitParam = values.length;
  const r = await db.query<SaleRow & { created_at_text: string }>(
    `SELECT ${SALE_COLUMNS}, to_json(sc.created_at)#>>'{}' AS created_at_text
     FROM sales_cards sc
     JOIN v_sales_card_totals v ON v.sales_card_id = sc.id
     WHERE true${scopeClause}
     ORDER BY sc.created_at DESC, sc.id DESC
     LIMIT $${limitParam}`,
    values,
  );
  return { rows: await withItems(db, r.rows), hasMore: r.rows.length > limit };
}

/** The lines for a page of cards, one query, in `(card, line)` order. */
async function withItems<T extends SaleRow>(db: Db, rows: T[]): Promise<Array<T & { items: SaleItemRow[] }>> {
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);
  const items = await db.query<SaleItemRow & { sales_card_id: string }>(
    `SELECT sales_card_id, line_no, product_id, product_name, product_sku,
            quantity::text AS quantity, unit_price::text AS unit_price,
            line_total::text AS line_total, serial_numbers
     FROM sales_card_items
     WHERE sales_card_id = ANY($1::uuid[])
     ORDER BY sales_card_id, line_no`,
    [ids],
  );
  const byCard = new Map<string, SaleItemRow[]>();
  for (const item of items.rows) {
    const list = byCard.get(item.sales_card_id);
    if (list) list.push(item);
    else byCard.set(item.sales_card_id, [item]);
  }
  return rows.map((row) => ({ ...row, items: byCard.get(row.id) ?? [] }));
}

/** The sale's account must exist before the INSERT, so the FK never surfaces as a 500 (the companies `employeeExists` shape). */
export async function companyExists(db: Db, companyId: string): Promise<boolean> {
  const r = await db.query<{ id: string }>('SELECT id FROM companies WHERE id = $1 AND is_active', [companyId]);
  return r.rows.length > 0;
}
