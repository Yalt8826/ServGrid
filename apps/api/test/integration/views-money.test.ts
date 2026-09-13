import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { runMigrations } from '../../src/db/migrate.js';

/**
 * Migrations 017–018 integration suite (PHASE-3-SALES-REP.md T3.1): the
 * four money views (PLAN-DATA-MODEL.md §4). Runs against a scratch
 * database built from the real migrations — no mocked database anywhere
 * (§14: the generated columns and the FULL OUTER JOIN are exactly the
 * parts a mock cannot be wrong about).
 *
 * Every figure below is hand-counted and stated in the assertion — the
 * fixtures ARE the hand count. The load-bearing case is
 * `missing_submission`: its row exists on ONE side of the reconciliation
 * join only, so a LEFT JOIN would silently drop the one row the feature
 * exists to catch while every other flag still worked. It is therefore
 * proven from BOTH sides — a completion-day and a payment-day.
 */

function databaseUrl(): string {
  return process.env.DATABASE_URL ?? 'postgres://servgrid:servgrid@localhost:5432/servgrid';
}

function adminUrlFor(url: string): string {
  const parsed = new URL(url);
  parsed.pathname = '/postgres';
  return parsed.toString();
}

const SCRATCH_DB = 'servgrid_views_money_test';

let admin: Pool;
let db: Pool;

// The hand-counted business day, fixed so the fixtures read the same on
// any calendar day the suite runs. All instants are IST noon of DAY —
// unambiguously inside that business day.
const DAY = '2026-03-16';
const NOON = '2026-03-16T12:00:00+05:30';

let customerId: string;
let serviceId: string;
let repId: string;
let seq = 0;

async function seedEmployee(role: 'technician' | 'sales_rep'): Promise<string> {
  seq += 1;
  const username = `t18.e${seq}.${randomBytes(3).toString('hex')}`;
  return (
    await db.query<{ id: string }>(
      `INSERT INTO employees (username, password_hash, full_name, role)
       VALUES ($1, 'test-argon2id-hash', $2, $3) RETURNING id`,
      [username, `T18 Employee ${seq}`, role],
    )
  ).rows[0]!.id;
}

async function seedCompany(name: string): Promise<string> {
  return (
    await db.query<{ id: string }>(
      `INSERT INTO companies (name) VALUES ($1) RETURNING id`,
      [name],
    )
  ).rows[0]!.id;
}

/** A completed job + its cash-bearing completion, in one step. */
async function seedCompletion(opts: {
  assignedTo: string;
  completedBy: string;
  completedAt?: string;
  cost: string;
  mode: string;
}): Promise<string> {
  const jobId = (
    await db.query<{ id: string }>(
      `INSERT INTO job_cards (job_number, customer_id, service_id, title, status,
                              assigned_to, assigned_at, scheduled_for, closed_at)
       VALUES ($1, $2, $3, 'T18 view job', 'completed', $4, $5, $5, $6)
       RETURNING id`,
      [
        `JC-T18-${randomBytes(4).toString('hex')}`,
        customerId,
        serviceId,
        opts.assignedTo,
        opts.completedAt ?? NOON,
        opts.completedAt ?? NOON,
      ],
    )
  ).rows[0]!.id;
  await db.query(
    `INSERT INTO job_completions
       (job_card_id, completed_by, completed_at, work_summary, cost, collection_mode)
     VALUES ($1, $2, $3, 'Replaced batteries', $4, $5)`,
    [jobId, opts.completedBy, opts.completedAt ?? NOON, opts.cost, opts.mode],
  );
  return jobId;
}

interface SaleOverrides {
  saleDate?: string;
  items?: Array<{ name: string; quantity: string; price: string }>;
  voidReason?: string;
}

/** A sale with its lines; status shapes the confirm/void columns so each
 * fixture reads as its status demands (and the coherence CHECKs hold). */
async function seedSale(
  companyId: string,
  status: 'draft' | 'confirmed' | 'void',
  overrides: SaleOverrides = {},
): Promise<string> {
  const id = (
    await db.query<{ id: string }>(
      `INSERT INTO sales_cards
         (company_id, sales_rep_id, sale_date, status, sale_number,
          confirmed_at, voided_at, voided_by, void_reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id`,
      [
        companyId,
        repId,
        overrides.saleDate ?? DAY,
        status,
        status === 'draft' ? null : `SC-T18-${randomBytes(4).toString('hex')}`,
        status === 'draft' ? null : '2026-03-16T11:00:00+05:30',
        status === 'void' ? '2026-03-17T11:00:00+05:30' : null,
        status === 'void' ? repId : null,
        status === 'void' ? (overrides.voidReason ?? 'Wrong company') : null,
      ],
    )
  ).rows[0]!.id;
  const items = overrides.items ?? [{ name: 'Exide 150Ah', quantity: '1', price: '100.00' }];
  let line = 0;
  for (const item of items) {
    line += 1;
    await db.query(
      `INSERT INTO sales_card_items
         (sales_card_id, line_no, product_name, product_sku, quantity, unit_price)
       VALUES ($1, $2, $3, 'SKU-T18', $4, $5)`,
      [id, line, item.name, item.quantity, item.price],
    );
  }
  return id;
}

interface PaymentOverrides {
  salesCardId?: string | null;
  mode?: string;
  status?: 'collected' | 'void';
  receivedAt?: string;
}

async function seedPayment(
  companyId: string,
  receivedBy: string,
  amount: string,
  overrides: PaymentOverrides = {},
): Promise<string> {
  const status = overrides.status ?? 'collected';
  return (
    await db.query<{ id: string }>(
      `INSERT INTO payments
         (payment_number, company_id, sales_card_id, amount, mode,
          received_by, received_at, status, voided_at, voided_by, void_reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING id`,
      [
        `PM-T18-${randomBytes(4).toString('hex')}`,
        companyId,
        overrides.salesCardId ?? null, // NULL = on-account
        amount,
        overrides.mode ?? 'cash',
        receivedBy,
        overrides.receivedAt ?? '2026-03-16T10:00:00+05:30',
        status,
        status === 'void' ? '2026-03-17T11:00:00+05:30' : null,
        status === 'void' ? repId : null,
        status === 'void' ? 'Entered twice' : null,
      ],
    )
  ).rows[0]!.id;
}

async function seedDeclaration(employeeId: string, amount: string): Promise<void> {
  await db.query(
    `INSERT INTO cash_reconciliations
       (employee_id, business_date, declared_amount, declared_at)
     VALUES ($1, $2, $3, '2026-03-16T18:00:00+05:30')`,
    [employeeId, DAY, amount],
  );
}

interface QueueRow {
  expected_cash: string | null;
  declared_amount: string | null;
  variance: string | null;
  flag: string;
}

/** The queue row for one employee-day, with numerics as text. */
async function queueRowFor(employeeId: string): Promise<QueueRow | undefined> {
  const r = await db.query<QueueRow>(
    `SELECT expected_cash::text AS expected_cash,
            declared_amount::text AS declared_amount,
            variance::text AS variance,
            flag
       FROM v_cash_reconciliation_queue
      WHERE employee_id = $1 AND business_date = $2::date`,
    [employeeId, DAY],
  );
  return r.rows[0];
}

beforeAll(async () => {
  admin = new Pool({ connectionString: adminUrlFor(databaseUrl()), max: 2 });
  await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${SCRATCH_DB}`);

  const url = new URL(databaseUrl());
  url.pathname = `/${SCRATCH_DB}`;
  db = new Pool({ connectionString: url.toString(), max: 5 });
  await runMigrations({ pool: db });

  customerId = (
    await db.query<{ id: string }>(
      `INSERT INTO customers (name, phone) VALUES ('T18 Customer', '9840000018') RETURNING id`,
    )
  ).rows[0]!.id;
  serviceId = (
    await db.query<{ id: string }>(
      `INSERT INTO services (code, name) VALUES ('T18-SVC', 'T18 suite service') RETURNING id`,
    )
  ).rows[0]!.id;
  repId = await seedEmployee('sales_rep');
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

describe('v_company_balances — drafts and voids excluded on both sides', () => {
  it('counts confirmed sales and collected payments only', async () => {
    const co = await seedCompany('T18 Counted Industries');
    // Confirmed: two lines, 600 + 400 = 1000 — the total comes from the
    // generated line totals through v_sales_card_totals.
    await seedSale(co, 'confirmed', {
      items: [
        { name: 'Luminous UPS', quantity: '1', price: '600.00' },
        { name: 'Exide 150Ah', quantity: '1', price: '400.00' },
      ],
    });
    // A draft and a void move NOTHING: dated LATER than the confirmed
    // sale so a wrong MAX(last_sale_date) would give them away too.
    await seedSale(co, 'draft', {
      saleDate: '2026-03-17',
      items: [{ name: 'Draft line', quantity: '1', price: '500.00' }],
    });
    await seedSale(co, 'void', {
      saleDate: '2026-03-18',
      items: [{ name: 'Void line', quantity: '1', price: '700.00' }],
    });
    // Collected 300 at 10:00; a VOIDED 200 at 15:00 must not count as a
    // payment — and must not win MAX(last_payment_at).
    await seedPayment(co, repId, '300.00', { receivedAt: '2026-03-16T10:00:00+05:30' });
    const voidPayment = await seedPayment(co, repId, '200.00', {
      status: 'void',
      receivedAt: '2026-03-16T15:00:00+05:30',
    });
    expect(voidPayment).toBeTruthy();

    const r = await db.query<{
      balance: string;
      last_sale_date: string | null;
      last_payment_at: Date | null;
    }>(
      `SELECT balance::text AS balance, last_sale_date::text AS last_sale_date,
              last_payment_at
         FROM v_company_balances WHERE company_id = $1`,
      [co],
    );
    const row = r.rows[0]!;
    // Hand count: 1000 confirmed − 300 collected = 700. The 500 draft,
    // the 700 void and the 200 voided payment are all absent.
    expect(row.balance).toBe('700.00');
    expect(row.last_sale_date).toBe(DAY); // the draft (17th) and void (18th) excluded
    expect(row.last_payment_at).not.toBeNull();
    expect(new Date(row.last_payment_at!).toISOString()).toBe(
      new Date('2026-03-16T10:00:00+05:30').toISOString(),
    );
  });

  it('carries status through v_sales_card_totals — the one definition of a sale’s worth', async () => {
    // The balances view reads v_sales_card_totals; this pins that the
    // totals view itself keeps drafts and voids visible but separable.
    const co = await seedCompany('T18 Totals Industries');
    await seedSale(co, 'confirmed', {
      items: [{ name: 'A', quantity: '2', price: '250.50' }],
    });
    await seedSale(co, 'draft', {
      items: [{ name: 'B', quantity: '1', price: '500.00' }],
    });
    await seedSale(co, 'void', {
      items: [{ name: 'C', quantity: '1', price: '700.00' }],
    });

    const r = await db.query<{ status: string; total: string }>(
      `SELECT status, total::text AS total FROM v_sales_card_totals
       WHERE company_id = $1 ORDER BY status::text`,
      [co],
    );
    expect(r.rows).toEqual([
      { status: 'confirmed', total: '501.00' }, // 2 × 250.50
      { status: 'draft', total: '500.00' },
      { status: 'void', total: '700.00' },
    ]);
  });

  it('an overpayment produces a NEGATIVE balance, and the view does not clamp it', async () => {
    const ov = await seedCompany('T18 Overpaid Industries');
    await seedSale(ov, 'confirmed');
    await seedPayment(ov, repId, '250.00');

    const r = await db.query<{ balance: string }>(
      `SELECT balance::text AS balance FROM v_company_balances WHERE company_id = $1`,
      [ov],
    );
    // Hand count: 100 − 250 = −150. A credit is a real state; the UI
    // renders it as "Credit", and the view must hand it through intact.
    expect(r.rows[0]?.balance).toBe('-150.00');
  });

  it('a company with no activity balances to zero, not NULL', async () => {
    const empty = await seedCompany('T18 Dormant Industries');
    const r = await db.query<{ balance: string; last_sale_date: string | null }>(
      `SELECT balance::text AS balance, last_sale_date::text AS last_sale_date
         FROM v_company_balances WHERE company_id = $1`,
      [empty],
    );
    // The Pending tab filters balance > 0 — the zero row must exist to be
    // filtered, not be absent by construction.
    expect(r.rows[0]?.balance).toBe('0.00');
    expect(r.rows[0]?.last_sale_date).toBeNull();
  });
});

describe('v_employee_expected_cash — both sources, one employee-day', () => {
  it('sums a completion AND a payment for the same employee-day into one row', async () => {
    const e1 = await seedEmployee('technician');
    await seedCompletion({ assignedTo: e1, completedBy: e1, cost: '800.00', mode: 'cash' });
    await seedPayment(await seedCompany('T18 Cash Co'), e1, '450.00', {
      receivedAt: '2026-03-16T16:00:00+05:30',
    });

    const r = await db.query<{ expected_cash: string }>(
      `SELECT expected_cash::text AS expected_cash FROM v_employee_expected_cash
       WHERE employee_id = $1 AND business_date = $2::date`,
      [e1, DAY],
    );
    // ONE row — not two — and the hand count is 800 + 450 = 1250.
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]?.expected_cash).toBe('1250.00');
  });

  it('attributes cash to completed_by, NOT assigned_to, on a job reassigned mid-day', async () => {
    const assigned = await seedEmployee('technician');
    const closer = await seedEmployee('technician');
    // Dispatched to `assigned`, reassigned, closed by `closer` — the cash
    // is in the closer's hands.
    await seedCompletion({
      assignedTo: assigned,
      completedBy: closer,
      cost: '300.00',
      mode: 'cash',
    });

    const rows = await db.query<{ employee_id: string; expected_cash: string }>(
      `SELECT employee_id, expected_cash::text AS expected_cash
         FROM v_employee_expected_cash WHERE business_date = $1::date`,
      [DAY],
    );
    const closerRow = rows.rows.find((r) => r.employee_id === closer);
    expect(closerRow).toBeDefined();
    expect(closerRow?.expected_cash).toBe('300.00');
    expect(rows.rows.find((r) => r.employee_id === assigned)).toBeUndefined();
  });

  it('non-cash modes contribute nothing — upi completions, cheque payments, voided cash', async () => {
    const e2 = await seedEmployee('technician');
    const e7 = await seedEmployee('technician');
    // A UPI completion and a cheque payment never pass through hands.
    await seedCompletion({ assignedTo: e2, completedBy: e2, cost: '999.00', mode: 'upi' });
    await seedPayment(await seedCompany('T18 NonCash Co'), e2, '888.00', { mode: 'cheque' });
    // A VOIDED cash payment must not create an expectation either —
    // otherwise the rep is asked at handover for money he never took.
    await seedPayment(await seedCompany('T18 VoidCash Co'), e7, '200.00', {
      status: 'void',
    });

    for (const employee of [e2, e7]) {
      const r = await db.query(
        `SELECT 1 FROM v_employee_expected_cash
         WHERE employee_id = $1 AND business_date = $2::date`,
        [employee, DAY],
      );
      expect(r.rows, `employee ${employee} must have no expected cash`).toHaveLength(0);
    }
  });
});

describe('v_cash_reconciliation_queue — the four flags, hand-counted', () => {
  it('emits missing_submission for a COMPLETION day with collections and no declaration', async () => {
    const e3 = await seedEmployee('technician');
    await seedCompletion({ assignedTo: e3, completedBy: e3, cost: '600.00', mode: 'cash' });

    const row = await queueRowFor(e3);
    // The row the feature exists for: collected cash, no declaration.
    // A LEFT JOIN would silently drop this row — it exists only on the
    // expected side — which is why the join must be FULL OUTER.
    expect(row).toBeDefined();
    expect(row?.flag).toBe('missing_submission');
    expect(row?.expected_cash).toBe('600.00');
    expect(row?.declared_amount).toBeNull();
    expect(row?.variance).toBeNull(); // no variance against nothing
  });

  it('emits missing_submission for a PAYMENT day too — the join proven from both sides', async () => {
    // A rep-day: one cash payment collected from a company, no
    // declaration, no completion. The completions side of the view is
    // empty for him; only the payments side knows.
    const rep = await seedEmployee('sales_rep');
    const rp = await seedCompany('T18 Rep Collection Co');
    await seedPayment(rp, rep, '1200.00', {
      receivedAt: '2026-03-16T16:00:00+05:30',
    });

    const row = await queueRowFor(rep);
    expect(row).toBeDefined();
    expect(row?.flag).toBe('missing_submission');
    expect(row?.expected_cash).toBe('1200.00');
    expect(row?.declared_amount).toBeNull();
  });

  it('emits match when the declaration equals the hand count exactly', async () => {
    const e4 = await seedEmployee('technician');
    await seedCompletion({ assignedTo: e4, completedBy: e4, cost: '800.00', mode: 'cash' });
    await seedDeclaration(e4, '800.00');

    const row = await queueRowFor(e4);
    expect(row?.flag).toBe('match');
    expect(row?.expected_cash).toBe('800.00');
    expect(row?.declared_amount).toBe('800.00');
    expect(row?.variance).toBe('0.00');
  });

  it('emits variance as declared − expected when the figures disagree', async () => {
    const e5 = await seedEmployee('technician');
    await seedCompletion({ assignedTo: e5, completedBy: e5, cost: '800.00', mode: 'cash' });
    await seedDeclaration(e5, '750.00');

    const row = await queueRowFor(e5);
    expect(row?.flag).toBe('variance');
    // Declared 750, expected 800: short by 50, and the sign says which
    // way — negative is short.
    expect(row?.variance).toBe('-50.00');
  });

  it('emits no_expected_cash for declared money the system did not expect', async () => {
    const e6 = await seedEmployee('technician'); // no cash activity at all
    await seedDeclaration(e6, '500.00');

    const row = await queueRowFor(e6);
    expect(row?.flag).toBe('no_expected_cash');
    expect(row?.expected_cash).toBeNull();
    expect(row?.declared_amount).toBe('500.00');
    expect(row?.variance).toBeNull();
  });

  it('names the employee for the owner — the queue joins employees for the name', async () => {
    const e8 = await seedEmployee('technician');
    await seedCompletion({ assignedTo: e8, completedBy: e8, cost: '10.00', mode: 'cash' });
    const r = await db.query<{ employee_name: string | null }>(
      `SELECT employee_name FROM v_cash_reconciliation_queue
       WHERE employee_id = $1 AND business_date = $2::date`,
      [e8, DAY],
    );
    expect(r.rows[0]?.employee_name).toBe(`T18 Employee ${seq}`);
  });
});
