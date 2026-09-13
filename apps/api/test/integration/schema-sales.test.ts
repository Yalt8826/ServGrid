import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { runMigrations } from '../../src/db/migrate.js';

/**
 * Migration 017 integration suite (PHASE-3-SALES-REP.md T3.1): the sales
 * tables (PLAN-DATA-MODEL.md §3.5). Runs against the real Postgres 16
 * from `docker compose up db` — no mocked database anywhere
 * (PLAN-BACKEND.md §14). The suite builds its own scratch database from
 * the server's admin connection and drops it afterwards; a failed run
 * leaves nothing behind.
 *
 * The three rules the brief names are each proven by a FAILING statement,
 * not by reading the DDL — a constraint that exists but does not fire is
 * worse than one that was never written:
 *
 *  - a draft with a sale_number and a confirmed card without one are both
 *    unrepresentable (`sale_number_when_confirmed`, verbatim from §3.5);
 *  - `line_total` is generated, not writable — the one definition of what
 *    a line is worth cannot be overwritten by a client;
 *  - a payment of amount 0 (or less) is not a payment.
 *
 * The void-coherence constraints the migration adds are proven the same
 * way: a void without a reason does not exist.
 */

function databaseUrl(): string {
  // CI exports DATABASE_URL explicitly; locally the compose defaults are
  // the documented shape, so an unset variable falls back to them.
  return (
    process.env.DATABASE_URL ?? 'postgres://servgrid:servgrid@localhost:5432/servgrid'
  );
}

function adminUrlFor(url: string): string {
  const parsed = new URL(url);
  parsed.pathname = '/postgres';
  return parsed.toString();
}

const SCRATCH_DB = 'servgrid_sales_test';

let admin: Pool;
let db: Pool;

beforeAll(async () => {
  admin = new Pool({ connectionString: adminUrlFor(databaseUrl()), max: 2 });
  await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${SCRATCH_DB}`);

  const url = new URL(databaseUrl());
  url.pathname = `/${SCRATCH_DB}`;
  db = new Pool({ connectionString: url.toString(), max: 5 });
  await runMigrations({ pool: db });

  repId = (
    await db.query<{ id: string }>(
      `INSERT INTO employees (username, password_hash, full_name, role)
       VALUES ('t17.rep', 'test-argon2id-hash', 'T17 Sales Rep', 'sales_rep')
       RETURNING id`,
    )
  ).rows[0]!.id;
  voiderId = (
    await db.query<{ id: string }>(
      `INSERT INTO employees (username, password_hash, full_name, role)
       VALUES ('t17.owner', 'test-argon2id-hash', 'T17 Owner', 'owner')
       RETURNING id`,
    )
  ).rows[0]!.id;
  companyId = (
    await db.query<{ id: string }>(
      `INSERT INTO companies (name) VALUES ('T17 Industries') RETURNING id`,
    )
  ).rows[0]!.id;
});

afterAll(async () => {
  await db?.end();
  if (admin) {
    // WITH (FORCE): the scratch pools are closed above, but a failed
    // test may have abandoned a client — never wedge the suite.
    await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
    await admin.end();
  }
});

let repId = '';
let voiderId = '';
let companyId = '';

/** Run a statement expected to fail; return the Postgres error's code
 * and constraint name (when the failure is a constraint). */
async function errorOf(
  query: Promise<unknown>,
): Promise<{ code: string; constraint?: string; message: string }> {
  try {
    await query;
  } catch (err) {
    const e = err as { code?: string; constraint?: string; message?: string };
    return { code: e.code ?? '', constraint: e.constraint, message: e.message ?? '' };
  }
  throw new Error('expected the query to fail, but it succeeded');
}

interface SaleOverrides {
  status?: string;
  saleNumber?: string | null;
  confirmedAt?: string | null;
  voidedAt?: string | null;
  voidedBy?: string | null;
  voidReason?: string | null;
}

/** Insert a sales card; every column it can get wrong is a parameter so
 * each test states exactly the shape it expects to be rejected. */
async function insertSale(overrides: SaleOverrides = {}): Promise<string> {
  const status = overrides.status ?? 'draft';
  const r = await db.query<{ id: string }>(
    `INSERT INTO sales_cards
       (company_id, sales_rep_id, sale_date, status, sale_number,
        confirmed_at, voided_at, voided_by, void_reason)
     VALUES ($1, $2, DATE '2026-03-16', $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    [
      companyId,
      repId,
      status,
      overrides.saleNumber ?? null,
      overrides.confirmedAt ?? null,
      overrides.voidedAt ?? null,
      overrides.voidedBy ?? null,
      overrides.voidReason ?? null,
    ],
  );
  return r.rows[0]!.id;
}

interface PaymentOverrides {
  amount?: string;
  status?: string;
  paymentNumber?: string;
  voidedAt?: string | null;
  voidedBy?: string | null;
  voidReason?: string | null;
}

async function insertPayment(overrides: PaymentOverrides = {}): Promise<string> {
  const status = overrides.status ?? 'collected';
  const r = await db.query<{ id: string }>(
    `INSERT INTO payments
       (payment_number, company_id, amount, mode, received_by, received_at,
        status, voided_at, voided_by, void_reason)
     VALUES ($1, $2, $3, 'cash', $4, '2026-03-16T10:00:00+05:30', $5, $6, $7, $8)
     RETURNING id`,
    [
      overrides.paymentNumber ?? `PM-T17-${Math.random().toString(36).slice(2, 10)}`,
      companyId,
      overrides.amount ?? '450.00',
      repId,
      status,
      overrides.voidedAt ?? null,
      overrides.voidedBy ?? null,
      overrides.voidReason ?? null,
    ],
  );
  return r.rows[0]!.id;
}

describe('migration 017 — sale_number allocated at confirm, not at create (§3.5)', () => {
  it('rejects a draft that carries a sale_number', async () => {
    // The number is allocated at confirm; a draft that already has one is
    // exactly the fake local number the device must never show.
    const err = await errorOf(
      insertSale({ status: 'draft', saleNumber: 'SC-2627-00001' }),
    );
    expect(err.code).toBe('23514');
    expect(err.constraint).toBe('sale_number_when_confirmed');
  });

  it('rejects a confirmed card without a sale_number', async () => {
    const err = await errorOf(
      insertSale({ status: 'confirmed', confirmedAt: '2026-03-16T10:00:00+05:30' }),
    );
    expect(err.code).toBe('23514');
    expect(err.constraint).toBe('sale_number_when_confirmed');
  });

  it('accepts a draft with no number and a confirmed card with one', async () => {
    const draft = await insertSale({ status: 'draft' });
    expect(draft).toBeTruthy();

    const confirmed = await insertSale({
      status: 'confirmed',
      saleNumber: 'SC-2627-00002',
      confirmedAt: '2026-03-16T10:00:00+05:30',
    });
    expect(confirmed).toBeTruthy();
  });

  it('a voided card keeps its number — void is a reversal, not an erasure', async () => {
    const id = await insertSale({
      status: 'void',
      saleNumber: 'SC-2627-00003',
      confirmedAt: '2026-03-16T10:00:00+05:30',
      voidedAt: '2026-03-17T10:00:00+05:30',
      voidedBy: voiderId,
      voidReason: 'Entered against the wrong company',
    });
    expect(id).toBeTruthy();
  });
});

describe('migration 017 — a void needs a reason (§3.5)', () => {
  it('rejects a voided sale with no reason', async () => {
    const err = await errorOf(
      insertSale({
        status: 'void',
        saleNumber: 'SC-2627-00004',
        confirmedAt: '2026-03-16T10:00:00+05:30',
        voidedAt: '2026-03-17T10:00:00+05:30',
        voidedBy: voiderId,
        voidReason: null,
      }),
    );
    expect(err.code).toBe('23514');
    expect(err.constraint).toBe('sales_cards_void_justified');
  });

  it('rejects a voided payment with no reason', async () => {
    const err = await errorOf(
      insertPayment({
        status: 'void',
        voidedAt: '2026-03-17T10:00:00+05:30',
        voidedBy: voiderId,
        voidReason: null,
      }),
    );
    expect(err.code).toBe('23514');
    expect(err.constraint).toBe('payments_void_justified');
  });

  it('accepts a voided payment with a reason', async () => {
    const id = await insertPayment({
      status: 'void',
      voidedAt: '2026-03-17T10:00:00+05:30',
      voidedBy: voiderId,
      voidReason: 'Cheque bounced',
    });
    expect(id).toBeTruthy();
  });
});

describe('migration 017 — line_total is generated, not writable (§3.5)', () => {
  let cardId = '';
  let itemId = 0;

  beforeAll(async () => {
    cardId = await insertSale({
      status: 'confirmed',
      saleNumber: 'SC-2627-00005',
      confirmedAt: '2026-03-16T10:00:00+05:30',
    });
    const r = await db.query<{ line_no: number }>(
      `INSERT INTO sales_card_items
         (sales_card_id, line_no, product_name, product_sku, quantity, unit_price)
       VALUES ($1, 1, 'Su-Kam 850VA', 'UPS-850', 3.33, 49.99) RETURNING line_no`,
      [cardId],
    );
    itemId = r.rows[0]!.line_no;
  });

  it('computes the line total as round(quantity × unit_price, 2)', async () => {
    // 3.33 × 49.99 = 166.4667 → 166.47. Money rounds to the paisa, once,
    // here.
    const r = await db.query<{ line_total: string }>(
      `SELECT line_total::text AS line_total FROM sales_card_items
       WHERE sales_card_id = $1 AND line_no = $2`,
      [cardId, itemId],
    );
    expect(r.rows[0]?.line_total).toBe('166.47');
  });

  it('refuses an INSERT that tries to write line_total', async () => {
    const err = await errorOf(
      db.query(
        `INSERT INTO sales_card_items
           (sales_card_id, line_no, product_name, quantity, unit_price, line_total)
         VALUES ($1, 2, 'Override line', 1, 1.00, 999.99)`,
        [cardId],
      ),
    );
    expect(err.message).toMatch(/line_total/);
    expect(err.message).toMatch(/generated column|non-DEFAULT/i);
  });

  it('refuses an UPDATE of line_total', async () => {
    const err = await errorOf(
      db.query(
        `UPDATE sales_card_items SET line_total = 0.01
         WHERE sales_card_id = $1 AND line_no = $2`,
        [cardId, itemId],
      ),
    );
    // Postgres's wording for writing a generated column.
    expect(err.message).toMatch(/line_total/);
    expect(err.message).toMatch(/can only be updated to DEFAULT/i);
    // And the stored definition still stands.
    const r = await db.query<{ line_total: string }>(
      `SELECT line_total::text AS line_total FROM sales_card_items
       WHERE sales_card_id = $1 AND line_no = $2`,
      [cardId, itemId],
    );
    expect(r.rows[0]?.line_total).toBe('166.47');
  });

  it('rejects a non-positive quantity and a negative unit price', async () => {
    const zero = await errorOf(
      db.query(
        `INSERT INTO sales_card_items
           (sales_card_id, line_no, product_name, quantity, unit_price)
         VALUES ($1, 3, 'Zero qty', 0, 10.00)`,
        [cardId],
      ),
    );
    expect(zero.code).toBe('23514');
    expect(zero.constraint).toBe('sales_card_items_quantity_positive');

    const negative = await errorOf(
      db.query(
        `INSERT INTO sales_card_items
           (sales_card_id, line_no, product_name, quantity, unit_price)
         VALUES ($1, 4, 'Negative price', 1, -5.00)`,
        [cardId],
      ),
    );
    expect(negative.code).toBe('23514');
    expect(negative.constraint).toBe('sales_card_items_price_non_negative');
  });
});

describe('migration 017 — payments: a payment of nothing is not a payment (§3.5)', () => {
  it('rejects amount = 0', async () => {
    const err = await errorOf(insertPayment({ amount: '0.00' }));
    expect(err.code).toBe('23514');
    expect(err.constraint).toBe('payments_amount_positive');
  });

  it('rejects a negative amount', async () => {
    const err = await errorOf(insertPayment({ amount: '-500.00' }));
    expect(err.code).toBe('23514');
    expect(err.constraint).toBe('payments_amount_positive');
  });

  it('accepts a positive amount, and generates business_date from received_at', async () => {
    const id = await insertPayment({ amount: '40000.00' });
    const r = await db.query<{ business_date: string }>(
      `SELECT business_date::text AS business_date FROM payments WHERE id = $1`,
      [id],
    );
    // 10:00 IST on 2026-03-16 — the IST business day, not the UTC date.
    expect(r.rows[0]?.business_date).toBe('2026-03-16');
  });

  it('allocates payment numbers at create: payment_number is NOT NULL and unique', async () => {
    // payments are not drafted — there is no shape for a numberless
    // payment the way there is for a draft sale.
    const missing = await errorOf(
      db.query(
        `INSERT INTO payments (company_id, amount, mode, received_by, received_at)
         VALUES ($1, 10.00, 'cash', $2, '2026-03-16T10:00:00+05:30')`,
        [companyId, repId],
      ),
    );
    expect(missing.code).toBe('23502'); // not_null_violation

    await insertPayment({ paymentNumber: 'PM-T17-DUP', amount: '11.00' });
    const dupe = await errorOf(
      insertPayment({ paymentNumber: 'PM-T17-DUP', amount: '12.00' }),
    );
    expect(dupe.code).toBe('23505'); // unique_violation
  });
});
