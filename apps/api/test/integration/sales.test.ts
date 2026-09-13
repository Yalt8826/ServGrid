import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import type { FastifyInstance } from 'fastify';
import {
  errorEnvelopeSchema,
  SaleSchema,
  type ErrorEnvelope,
  type LoginResponse,
  type SaleRecord,
} from '@servgrid/shared';
import { loadConfig, type Config } from '../../src/config.js';
import { closePool } from '../../src/db/pool.js';
import { runMigrations } from '../../src/db/migrate.js';
import { hashPassword } from '../../src/lib/password.js';
import { buildServer } from '../../src/server.js';
import { ULID, validEnv } from '../helpers/env.js';

/**
 * Sales cards integration suite (PHASE-3-SALES-REP.md T3.3, PLAN-BACKEND.md
 * §11, PLAN-DATA-MODEL.md §3.5). The assertions the task exists for:
 *
 * - **A draft burns no number** — `sale_number` stays NULL and no balance
 *   moves until confirm; confirm allocates one (`SL-2627-#####`) and
 *   stamps `confirmed_at`, and the balance rises by exactly the card's
 *   `v_sales_card_totals` total.
 * - **PATCH answers drafts only** — a confirmed sale is refused
 *   ILLEGAL_TRANSITION; the correction path is the owner's void.
 * - **A void requires a reason and leaves the balance correct** —
 *   `v_company_balances` is asserted before and after, to the paisa.
 * - **The snapshot is stored, never re-derived** — renaming and repricing
 *   the product afterwards does not change a confirmed sale's line.
 * - **A rep cannot void; the owner can** — the door is the role, and a
 *   rep is refused even on his own confirmed card.
 */

function databaseUrl(): string {
  return process.env.DATABASE_URL ?? 'postgres://servgrid:servgrid@localhost:5432/servgrid';
}

function adminUrlFor(url: string): string {
  const parsed = new URL(url);
  parsed.pathname = '/postgres';
  return parsed.toString();
}

const SCRATCH_DB = 'servgrid_sales_test';
const PASSWORD = 'sales-plain-copier-73';

interface Actor {
  username: string;
  id: string;
  token: string;
}

const OWNER: Actor = { username: '', id: '', token: '' };
const REP_A: Actor = { username: '', id: '', token: '' };
const REP_B: Actor = { username: '', id: '', token: '' };
const REP_NO_FLAG: Actor = { username: '', id: '', token: '' };

let admin: Pool;
let db: Pool;
let app: FastifyInstance;
let config: Config;

/** The account REP_A sells to; created through the API so the row is exactly what T3.2 shipped. */
let companyId: string;
let product: { id: string; sku: string; name: string };

async function seedEmployee(
  role: 'owner' | 'sales_rep' | 'dispatcher',
  who: Actor,
  withSalesFlag: boolean,
): Promise<void> {
  const username = `t33.${role}.${randomBytes(4).toString('hex')}`;
  const r = await db.query<{ id: string }>(
    `INSERT INTO employees (username, password_hash, full_name, role)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [username, await hashPassword(PASSWORD), `Test ${username}`, role],
  );
  who.id = r.rows[0]!.id;
  who.username = username;
  if (withSalesFlag) {
    // `sales.cards` is the T3.3 rollback tier and ships dark: the suite
    // turns it on for the people on the surface, the way the owner's flip
    // would — the flag mechanics themselves are flags.test.ts's subject.
    await db.query(
      `INSERT INTO employee_flag_overrides (employee_id, flag, enabled) VALUES ($1, 'sales.cards', true)`,
      [who.id],
    );
  }
  const res = await app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: {
      username,
      password: PASSWORD,
      device: {
        installId: `install-${username}`,
        platform: 'android',
        appVersion: '0.1.0',
        osVersion: '14',
        manufacturer: 'Xiaomi',
        model: 'Redmi Note 12',
      },
    },
  });
  expect(res.statusCode, res.body).toBe(200);
  who.token = res.json<LoginResponse>().accessToken;
}

function bearer(actor: Actor): Record<string, string> {
  return { authorization: `Bearer ${actor.token}` };
}

async function createCompany(actor: Actor, name: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/companies',
    headers: bearer(actor),
    payload: { name },
  });
  expect(res.statusCode, res.body).toBe(200);
  return (JSON.parse(res.body) as { id: string }).id;
}

async function createSale(
  actor: Actor,
  payload: Record<string, unknown>,
): Promise<{ statusCode: number; body: string }> {
  return app.inject({ method: 'POST', url: '/v1/sales', headers: bearer(actor), payload });
}

async function confirmSale(
  actor: Actor,
  saleId: string,
): Promise<{ statusCode: number; body: string }> {
  return app.inject({ method: 'POST', url: `/v1/sales/${saleId}/confirm`, headers: bearer(actor) });
}

async function voidSale(
  actor: Actor,
  saleId: string,
  payload: Record<string, unknown> | undefined,
): Promise<{ statusCode: number; body: string }> {
  return app.inject({
    method: 'POST',
    url: `/v1/sales/${saleId}/void`,
    headers: bearer(actor),
    payload,
  });
}

async function patchSale(
  actor: Actor,
  saleId: string,
  version: number,
  payload: Record<string, unknown>,
): Promise<{ statusCode: number; body: string }> {
  return app.inject({
    method: 'PATCH',
    url: `/v1/sales/${saleId}`,
    headers: { ...bearer(actor), 'if-match': String(version) },
    payload,
  });
}

async function listSales(actor: Actor): Promise<SaleRecord[]> {
  const res = await app.inject({ method: 'GET', url: '/v1/sales', headers: bearer(actor) });
  expect(res.statusCode, res.body).toBe(200);
  return (JSON.parse(res.body) as { items: SaleRecord[] }).items;
}

function parseSale(_status: number, body: string): SaleRecord {
  return SaleSchema.parse(JSON.parse(body)) as SaleRecord;
}

async function createSaleOk(actor: Actor, payload: Record<string, unknown>): Promise<SaleRecord> {
  const res = await createSale(actor, payload);
  expect(res.statusCode, res.body).toBe(200);
  return parseSale(res.statusCode, res.body);
}

async function confirmSaleOk(actor: Actor, saleId: string): Promise<SaleRecord> {
  const res = await confirmSale(actor, saleId);
  expect(res.statusCode, res.body).toBe(200);
  return parseSale(res.statusCode, res.body);
}

function errorOf(status: number, body: string): ErrorEnvelope['error'] {
  expect(status).toBeGreaterThanOrEqual(400);
  const error = (JSON.parse(body) as ErrorEnvelope).error;
  expect(error.requestId).toMatch(ULID);
  return error;
}

/** The company's derived balance — the number the whole task is about. */
async function balanceOf(companyId: string): Promise<string> {
  const r = await db.query<{ balance: string }>(
    'SELECT balance::text FROM v_company_balances WHERE company_id = $1',
    [companyId],
  );
  expect(r.rows.length, 'the balance view carries every company').toBe(1);
  return r.rows[0]!.balance;
}

async function seedProduct(
  sku: string,
  name: string,
  defaultPrice: string,
): Promise<{ id: string; sku: string; name: string }> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO products (sku, name, category, default_price) VALUES ($1, $2, 'ups', $3) RETURNING id`,
    [sku, name, defaultPrice],
  );
  return { id: r.rows[0]!.id, sku, name };
}

/**
 * A fresh account per balance story. `v_company_balances` is CUMULATIVE
 * per company — every confirmed card on the account is in the number — so
 * each describe that asserts a literal balance sells to its own company,
 * and the assertion reads the whole story and nothing else.
 */
async function newCompany(): Promise<string> {
  return createCompany(REP_A, `Integr Sales ${randomBytes(3).toString('hex')}`);
}

beforeAll(async () => {
  admin = new Pool({ connectionString: adminUrlFor(databaseUrl()), max: 2 });
  await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${SCRATCH_DB}`);

  const scratchUrl = new URL(databaseUrl());
  scratchUrl.pathname = `/${SCRATCH_DB}`;
  process.env.DATABASE_URL = scratchUrl.toString();
  db = new Pool({ connectionString: scratchUrl.toString(), max: 5 });
  await runMigrations({ pool: db });

  config = loadConfig(validEnv({ DATABASE_URL: scratchUrl.toString() }));
  app = buildServer(config, { logger: false });
  await app.ready();

  await seedEmployee('owner', OWNER, true);
  await seedEmployee('sales_rep', REP_A, true);
  await seedEmployee('sales_rep', REP_B, true);
  await seedEmployee('sales_rep', REP_NO_FLAG, false); // the flag-off probe

  companyId = await createCompany(REP_A, `Integr Sales Co ${randomBytes(3).toString('hex')}`);
  product = await seedProduct(`T33-${randomBytes(4).toString('hex')}`, 'T33 UPS 850VA', '8400.00');
});

afterAll(async () => {
  await app?.close();
  await db?.end();
  // Detach the process pool from the database this suite is about to drop,
  // so a later suite in the same worker cannot inherit a dead connection.
  await closePool();
  if (admin) {
    await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
    await admin.end();
  }
});

describe('a draft burns no number; confirm allocates one', () => {
  it('create answers a draft — no number, no stamp, no balance movement', async () => {
    const sale = await createSaleOk(REP_A, {
      companyId,
      saleDate: '2026-09-13',
      notes: 'Standing order, September',
      items: [
        {
          productId: product.id,
          productName: product.name,
          productSku: product.sku,
          quantity: 2,
          unitPrice: '8400.00',
          serialNumbers: ['SN-001', 'SN-002'],
        },
      ],
    });
    expect(sale.saleNumber).toBeNull();
    expect(sale.status).toBe('draft');
    expect(sale.confirmedAt).toBeNull();
    expect(sale.total).toBe('16800.00'); // the draft's worth is displayed, not yet owed
    expect(sale.items).toHaveLength(1);
    expect(sale.items[0]!.lineTotal).toBe('16800.00');
    // The draft moved nothing: the rep's device shows "Draft", never a number.
    expect(await balanceOf(companyId)).toBe('0.00');
  });

  it('confirm allocates the number, stamps confirmed_at, and the balance rises by exactly the total', async () => {
    const draft = (await listSales(REP_A)).find((s) => s.companyId === companyId && s.status === 'draft');
    expect(draft).toBeDefined();

    const confirmed = await confirmSaleOk(REP_A, draft!.id);
    expect(confirmed.status).toBe('confirmed');
    expect(confirmed.saleNumber).toMatch(/^SL-\d{4}-\d{5,}$/);
    expect(confirmed.confirmedAt).not.toBeNull();

    // The view and the intent agree: one confirmed card, one total, one balance.
    expect(await balanceOf(companyId)).toBe('16800.00');
  });
});

describe('PATCH answers drafts only', () => {
  it('a draft PATCH rewrites its lines in full and bumps the version', async () => {
    const co = await newCompany();
    const created = await createSaleOk(REP_A, {
      companyId: co,
      saleDate: '2026-09-13',
      items: [{ productName: 'Third-party kit', quantity: 1, unitPrice: '1000.00' }],
    });
    const res = await patchSale(REP_A, created.id, created.version, {
      items: [
        { productName: 'Third-party kit', quantity: 3, unitPrice: '1100.00' },
        { productId: product.id, productName: product.name, productSku: product.sku, quantity: 1, unitPrice: '500.00' },
      ],
      notes: 'Recounted on site',
    });
    expect(res.statusCode, res.body).toBe(200);
    const patched = parseSale(res.statusCode, res.body);
    expect(patched.version).toBe(created.version + 1);
    expect(patched.items).toHaveLength(2);
    expect(patched.items[0]!.quantity).toBe('3.00'); // numeric(10,2) keeps the scale on the wire
    expect(patched.total).toBe('3800.00');
    expect(patched.saleNumber).toBeNull(); // still a draft: no number burnt
    expect(await balanceOf(co)).toBe('0.00'); // drafts move nothing

    // The rewrite was FULL: the discarded line no longer exists.
    const reread = (await listSales(REP_A)).find((s) => s.id === patched.id)!;
    expect(reread.items.map((i) => i.lineNo)).toEqual([1, 2]);
  });

  it('a PATCH on a confirmed sale is refused ILLEGAL_TRANSITION — the correction is a void, not an edit', async () => {
    const co = await newCompany();
    const created = await createSaleOk(REP_A, {
      companyId: co,
      saleDate: '2026-09-13',
      items: [
        { productName: 'Third-party kit', quantity: 3, unitPrice: '1100.00' },
        { productId: product.id, productName: product.name, productSku: product.sku, quantity: 1, unitPrice: '500.00' },
      ],
    });
    const confirmed = await confirmSaleOk(REP_A, created.id);

    const res = await patchSale(REP_A, confirmed.id, confirmed.version, { notes: 'one more box' });
    expect(res.statusCode, res.body).toBe(409);
    expect(errorOf(res.statusCode, res.body).code).toBe('ILLEGAL_TRANSITION');

    // The owner is refused it too: void is the only door after confirm.
    const ownerRes = await patchSale(OWNER, confirmed.id, confirmed.version, { notes: 'one more box' });
    expect(ownerRes.statusCode, ownerRes.body).toBe(409);
    expect(errorOf(ownerRes.statusCode, ownerRes.body).code).toBe('ILLEGAL_TRANSITION');
    // Both refusals left the balance exactly where the confirm put it.
    expect(await balanceOf(co)).toBe('3800.00');
  });

  it('a PATCH without If-Match is refused 422', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/sales/${(await listSales(REP_A))[0]!.id}`,
      headers: bearer(REP_A),
      payload: { notes: 'no version' },
    });
    expect(res.statusCode, res.body).toBe(422);
    expect(errorOf(res.statusCode, res.body).code).toBe('VALIDATION_FAILED');
  });
});

describe('a void requires a reason and leaves the balance correct', () => {
  let saleId: string;
  let co: string;
  const TOTAL = '5250.75';

  it('confirm lifts the balance to the card total — asserted through the view before the void', async () => {
    co = await newCompany();
    const created = await createSaleOk(REP_A, {
      companyId: co,
      saleDate: '2026-09-13',
      items: [{ productName: 'Servo stabiliser', quantity: 1, unitPrice: TOTAL }],
    });
    const confirmed = await confirmSaleOk(REP_A, created.id);
    saleId = confirmed.id;
    expect(await balanceOf(co)).toBe(TOTAL);
  });

  it('a rep cannot void — even his own confirmed card', async () => {
    const res = await voidSale(REP_A, saleId, { reason: 'Wrong amount' });
    expect(res.statusCode, res.body).toBe(403);
    expect(errorOf(res.statusCode, res.body).code).toBe('FORBIDDEN');
    expect(await balanceOf(co)).toBe(TOTAL); // the balance did not move
  });

  it('a void without a reason is refused 422 and the balance stands', async () => {
    const noReason = await voidSale(OWNER, saleId, undefined);
    expect(noReason.statusCode, noReason.body).toBe(422);
    expect(errorOf(noReason.statusCode, noReason.body).code).toBe('VALIDATION_FAILED');

    const emptyReason = await voidSale(OWNER, saleId, { reason: '' });
    expect(emptyReason.statusCode, emptyReason.body).toBe(422);

    expect(await balanceOf(co)).toBe(TOTAL);
  });

  it("the owner's void keeps the number and the reason, and the balance returns to the paisa", async () => {
    const before = (await listSales(OWNER)).find((s) => s.id === saleId)!;
    expect(before.saleNumber).toMatch(/^SL-\d{4}-\d{5,}$/);

    const res = await voidSale(OWNER, saleId, { reason: 'Entered against the wrong account' });
    expect(res.statusCode, res.body).toBe(200);
    const voided = parseSale(res.statusCode, res.body);
    expect(voided.status).toBe('void');
    expect(voided.voidedAt).not.toBeNull();
    expect(voided.voidReason).toBe('Entered against the wrong account');
    // A void KEEPS its number: the document existed, the ledger says so.
    expect(voided.saleNumber).toBe(before.saleNumber);

    expect(await balanceOf(co)).toBe('0.00');
  });

  it('a void of a draft is refused — a draft never moved the balance and has no number to reverse', async () => {
    const draft = await createSaleOk(REP_A, {
      companyId: co,
      saleDate: '2026-09-13',
      items: [{ productName: 'Never confirmed', quantity: 1, unitPrice: '10.00' }],
    });
    const res = await voidSale(OWNER, draft.id, { reason: 'Owner tidying up' });
    expect(res.statusCode, res.body).toBe(409);
    expect(errorOf(res.statusCode, res.body).code).toBe('ILLEGAL_TRANSITION');
  });

  it('a second void of the same card is refused — that is final', async () => {
    const res = await voidSale(OWNER, saleId, { reason: 'Trying twice' });
    expect(res.statusCode, res.body).toBe(409);
    expect(errorOf(res.statusCode, res.body).code).toBe('ILLEGAL_TRANSITION');
  });
});

describe('the snapshot is stored, never re-derived', () => {
  it('renaming and repricing the product afterwards does not change a confirmed sale’s line', async () => {
    const co = await newCompany();
    const negotiated = '9000.00'; // the negotiated price, below the catalogue's 10000
    const snapProduct = await seedProduct(
      `T33SNAP-${randomBytes(3).toString('hex')}`,
      'Snapshot UPS 1kVA',
      '10000.00',
    );
    const created = await createSaleOk(REP_A, {
      companyId: co,
      saleDate: '2026-09-13',
      items: [
        {
          productId: snapProduct.id,
          productName: snapProduct.name,
          productSku: snapProduct.sku,
          quantity: 1,
          unitPrice: negotiated,
        },
      ],
    });
    const confirmed = await confirmSaleOk(REP_A, created.id);

    // Next quarter: the catalogue renames and reprices the product.
    await db.query(`UPDATE products SET name = 'Renamed UPS 2027', default_price = '12345.00' WHERE id = $1`, [
      snapProduct.id,
    ]);

    const reread = (await listSales(OWNER)).find((s) => s.id === confirmed.id)!;
    expect(reread.items[0]!.productName).toBe(snapProduct.name); // NOT 'Renamed UPS 2027'
    expect(reread.items[0]!.productSku).toBe(snapProduct.sku);
    expect(reread.items[0]!.unitPrice).toBe(negotiated); // NOT the catalogue's new price
    expect(reread.items[0]!.lineTotal).toBe(negotiated);
    expect(reread.total).toBe(negotiated);
    // product_id survives, for the reporting join — it is never read for display.
    expect(reread.items[0]!.productId).toBe(snapProduct.id);
    expect(await balanceOf(co)).toBe('9000.00'); // the balance did not hear about the repricing
  });
});

describe('scoping and the doors', () => {
  it("the rep's list is his own cards — REP_B never sees REP_A's", async () => {
    const aIds = new Set((await listSales(REP_A)).map((s) => s.id));
    expect(aIds.size).toBeGreaterThan(0);
    // REP_B made no sales this suite, so his list is EMPTY — not a filtered
    // subset, and never one of REP_A's rows wearing another rep's token.
    expect((await listSales(REP_B)).map((s) => s.id)).toHaveLength(0);
    // The owner sees the whole book.
    const ownerIds = (await listSales(OWNER)).map((s) => s.id);
    for (const id of aIds) expect(ownerIds).toContain(id);
  });

  it('another rep’s draft is OUT_OF_SCOPE to patch and to confirm', async () => {
    const sale = await createSaleOk(REP_A, {
      companyId,
      saleDate: '2026-09-13',
      items: [{ productName: 'Rep A card', quantity: 1, unitPrice: '10.00' }],
    });

    const patched = await patchSale(REP_B, sale.id, sale.version, { notes: 'mine now?' });
    expect(patched.statusCode, patched.body).toBe(403);
    expect(errorOf(patched.statusCode, patched.body).code).toBe('OUT_OF_SCOPE');

    const confirmed = await confirmSale(REP_B, sale.id);
    expect(confirmed.statusCode, confirmed.body).toBe(403);
    expect(errorOf(confirmed.statusCode, confirmed.body).code).toBe('OUT_OF_SCOPE');
    // Nothing moved: still a draft, still REP_A's.
    const reread = (await listSales(REP_A)).find((s) => s.id === sale.id)!;
    expect(reread.status).toBe('draft');
  });

  it('the dispatcher holds no cell on sale at all', async () => {
    const dispatcher: Actor = { username: '', id: '', token: '' };
    await seedEmployee('dispatcher', dispatcher, true);
    const res = await app.inject({ method: 'GET', url: '/v1/sales', headers: bearer(dispatcher) });
    expect(res.statusCode, res.body).toBe(403);
    expect(errorOf(res.statusCode, res.body).code).toBe('FORBIDDEN');
  });

  it('the flag is the surface’s rollback tier — a rep without sales.cards gets 409 FLAG_DISABLED', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/sales', headers: bearer(REP_NO_FLAG) });
    expect(res.statusCode, res.body).toBe(409);
    expect(errorOf(res.statusCode, res.body).code).toBe('FLAG_DISABLED');
  });
});

describe('the envelope stays honest', () => {
  it('the confirm of an empty card is refused, not silently zero', async () => {
    // The payload schema demands at least one line, so the empty card can
    // only exist through SQL — the same state a client bug could produce.
    const r = await db.query<{ id: string }>(
      `INSERT INTO sales_cards (company_id, sales_rep_id, sale_date) VALUES ($1, $2, '2026-09-13') RETURNING id`,
      [companyId, REP_A.id],
    );
    const res = await confirmSale(REP_A, r.rows[0]!.id);
    expect(res.statusCode, res.body).toBe(422);
    expect(errorEnvelopeSchema.parse(JSON.parse(res.body))).toBeTruthy();
  });
});
