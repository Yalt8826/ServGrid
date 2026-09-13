import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import type { FastifyInstance } from 'fastify';
import {
  CompanyLedgerSchema,
  type CompanyBalance,
  type ErrorEnvelope,
  type LedgerEntry,
  type LoginResponse,
} from '@servgrid/shared';
import { loadConfig, type Config } from '../../src/config.js';
import { closePool } from '../../src/db/pool.js';
import { runMigrations } from '../../src/db/migrate.js';
import { hashPassword } from '../../src/lib/password.js';
import { buildServer } from '../../src/server.js';
import { ULID, validEnv } from '../helpers/env.js';

/**
 * Ledger and balances integration suite (PHASE-3-SALES-REP.md T3.5,
 * PLAN-BACKEND.md §11, PLAN-DATA-MODEL.md §4 v_company_balances). The
 * assertions the task exists for:
 *
 * - **The newest running balance equals `v_company_balances.balance`
 *   exactly, to the paisa, across a 200-row fixture** — the "Done when".
 *   The whole column is re-walked in the test from the oldest row up, so a
 *   ledger computing FORWARDS from zero instead of backwards from the
 *   current balance (T3.5 "If it fails") fails on every row, not just the
 *   last.
 * - **Voided rows appear in the ledger as voided and do not move the
 *   running balance** — the document existed; the ledger says so; the
 *   paisa is not moved twice.
 * - **The ledger is scoped by the account** — a rep cannot read another
 *   rep's account's ledger; house accounts are every rep's; the owner
 *   reads everything; the dispatcher holds no company cell at all; the
 *   `sales.payments` flag is the surface's T0 rollback.
 * - **The Pending tab reads the view** — `GET /v1/companies/balances`
 *   returns `v_company_balances` rows (dues, not payment rows), floored by
 *   `minBalance`, sorted by balance descending, scoped like the company
 *   list.
 *
 * Money arithmetic in this file is integer paisa — floating addition of
 * 200 two-decimal amounts drifts, and the whole point is the paisa.
 */

function databaseUrl(): string {
  return process.env.DATABASE_URL ?? 'postgres://servgrid:servgrid@localhost:5432/servgrid';
}

function adminUrlFor(url: string): string {
  const parsed = new URL(url);
  parsed.pathname = '/postgres';
  return parsed.toString();
}

const SCRATCH_DB = 'servgrid_ledger_test';
const PASSWORD = 'ledger-plain-copier-64';

interface Actor {
  username: string;
  id: string;
  token: string;
}

const OWNER: Actor = { username: '', id: '', token: '' };
const REP_A: Actor = { username: '', id: '', token: '' };
const REP_B: Actor = { username: '', id: '', token: '' };
const REP_NO_FLAG: Actor = { username: '', id: '', token: '' };
const DISPATCHER: Actor = { username: '', id: '', token: '' };

let admin: Pool;
let db: Pool;
let app: FastifyInstance;
let config: Config;

let houseId: string; // a HOUSE account (owner_rep_id NULL) — every rep's

async function seedEmployee(role: 'owner' | 'sales_rep' | 'dispatcher', who: Actor, flags: string[]): Promise<void> {
  const username = `t35.${role}.${randomBytes(4).toString('hex')}`;
  const r = await db.query<{ id: string }>(
    `INSERT INTO employees (username, password_hash, full_name, role)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [username, await hashPassword(PASSWORD), `Test ${username}`, role],
  );
  who.id = r.rows[0]!.id;
  who.username = username;
  for (const flag of flags) {
    // The T0 rollback ships dark: the suite flips the flags for the people
    // on the surface, the way the owner's flip would.
    await db.query(`INSERT INTO employee_flag_overrides (employee_id, flag, enabled) VALUES ($1, $2, true)`, [
      who.id,
      flag,
    ]);
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

async function createSaleOk(actor: Actor, payload: Record<string, unknown>): Promise<{ id: string; total: string }> {
  const created = await app.inject({ method: 'POST', url: '/v1/sales', headers: bearer(actor), payload });
  expect(created.statusCode, created.body).toBe(200);
  const draft = JSON.parse(created.body) as { id: string };
  const confirmed = await app.inject({
    method: 'POST',
    url: `/v1/sales/${draft.id}/confirm`,
    headers: bearer(actor),
  });
  expect(confirmed.statusCode, confirmed.body).toBe(200);
  return JSON.parse(confirmed.body) as { id: string; total: string };
}

async function createDraftSale(actor: Actor, payload: Record<string, unknown>): Promise<string> {
  const created = await app.inject({ method: 'POST', url: '/v1/sales', headers: bearer(actor), payload });
  expect(created.statusCode, created.body).toBe(200);
  return (JSON.parse(created.body) as { id: string }).id;
}

async function createPaymentOk(actor: Actor, payload: Record<string, unknown>): Promise<{ id: string }> {
  const res = await app.inject({ method: 'POST', url: '/v1/payments', headers: bearer(actor), payload });
  expect(res.statusCode, res.body).toBe(200);
  return JSON.parse(res.body) as { id: string };
}

async function voidOk(actor: Actor, kind: 'sales' | 'payments', id: string, reason: string): Promise<void> {
  const res = await app.inject({
    method: 'POST',
    url: `/v1/${kind}/${id}/void`,
    headers: bearer(actor),
    payload: { reason },
  });
  expect(res.statusCode, res.body).toBe(200);
}

async function getLedger(actor: Actor, companyId: string): Promise<{ statusCode: number; body: string }> {
  return app.inject({
    method: 'GET',
    url: `/v1/companies/${companyId}/ledger`,
    headers: bearer(actor),
  });
}

async function getLedgerOk(
  actor: Actor,
  companyId: string,
): Promise<{ companyId: string; balance: string; entries: LedgerEntry[] }> {
  const res = await getLedger(actor, companyId);
  expect(res.statusCode, res.body).toBe(200);
  return CompanyLedgerSchema.parse(JSON.parse(res.body)) as {
    companyId: string;
    balance: string;
    entries: LedgerEntry[];
  };
}

async function getBalances(
  actor: Actor,
  query = '',
): Promise<{ statusCode: number; body: string }> {
  return app.inject({
    method: 'GET',
    url: `/v1/companies/balances${query}`,
    headers: bearer(actor),
  });
}

async function getBalancesOk(actor: Actor, query = ''): Promise<CompanyBalance[]> {
  const res = await getBalances(actor, query);
  expect(res.statusCode, res.body).toBe(200);
  return (JSON.parse(res.body) as { items: CompanyBalance[] }).items;
}

function errorOf(status: number, body: string): ErrorEnvelope['error'] {
  expect(status).toBeGreaterThanOrEqual(400);
  const error = (JSON.parse(body) as ErrorEnvelope).error;
  expect(error.requestId).toMatch(ULID);
  return error;
}

/** The company's derived balance — the number the whole task is about. */
async function balanceOf(company: string): Promise<string> {
  const r = await db.query<{ balance: string }>(
    'SELECT balance::text FROM v_company_balances WHERE company_id = $1',
    [company],
  );
  expect(r.rows.length, 'the balance view carries every company').toBe(1);
  return r.rows[0]!.balance;
}

/** Money as integer paisa — floating addition of two-decimal amounts drifts. */
function paisa(amount: string): number {
  return Math.round(Number(amount) * 100);
}

/** Paisa back to the wire format — '1234.50', '-800.00', '0.00'. */
function rupees(p: number): string {
  const sign = p < 0 ? '-' : '';
  const abs = Math.abs(p);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** A fresh account per story — v_company_balances is cumulative per company. */
async function newCompany(): Promise<string> {
  return createCompany(REP_A, `Integr Ledger ${randomBytes(3).toString('hex')}`);
}

// ── SQL seeders for the bulk fixture (real rows, real views — no mocks) ─────

interface SeededRow {
  id: string;
  kind: 'sale' | 'payment';
  amount: string;
  voided: boolean;
}

/**
 * One confirmed-or-voided sale with a single line, its movement pinned to
 * `at`. `sale_number` is a literal unique string — the fixture is about
 * the balance math across many rows, not confirm-time numbering, which
 * the API-driven stories below exercise through the real surface.
 */
async function seedSale(
  companyId: string,
  repId: string,
  index: number,
  amount: string,
  at: Date,
  voided: boolean,
): Promise<string> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO sales_cards
       (company_id, sales_rep_id, sale_number, sale_date, status, notes, confirmed_at,
        voided_at, voided_by, void_reason)
     VALUES ($1, $2, $3, ($4 AT TIME ZONE 'Asia/Kolkata')::date, $5, NULL, $4,
             $6, $7, $8)
     RETURNING id`,
    [
      companyId,
      repId,
      `SL-LG-FIX-${String(index).padStart(5, '0')}`,
      at,
      voided ? 'void' : 'confirmed',
      voided ? new Date(at.getTime() + 60_000) : null,
      voided ? OWNER.id : null,
      voided ? 'Fixture void' : null,
    ],
  );
  const saleId = r.rows[0]!.id;
  await db.query(
    `INSERT INTO sales_card_items (sales_card_id, line_no, product_name, quantity, unit_price)
     VALUES ($1, 1, 'Fixture line', 1, $2)`,
    [saleId, amount],
  );
  return saleId;
}

/** One collected-or-voided payment, its movement pinned to `at`. */
async function seedPayment(
  companyId: string,
  repId: string,
  index: number,
  amount: string,
  at: Date,
  voided: boolean,
): Promise<string> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO payments
       (payment_number, company_id, amount, mode, received_by, received_at, status,
        voided_at, voided_by, void_reason)
     VALUES ($1, $2, $3, 'upi', $4, $5, $6, $7, $8, $9)
     RETURNING id`,
    [
      `PM-LG-FIX-${String(index).padStart(5, '0')}`,
      companyId,
      amount,
      repId,
      at,
      voided ? 'void' : 'collected',
      voided ? new Date(at.getTime() + 60_000) : null,
      voided ? OWNER.id : null,
      voided ? 'Fixture void' : null,
    ],
  );
  return r.rows[0]!.id;
}

/**
 * The 200-row fixture: interleaved sales and payments, one minute apart,
 * every 17th row voided, amounts carrying paisa. Row i's movement is
 * `now − (201 − i) minutes`, so row 200 is the newest.
 */
async function seedFixture(companyId: string): Promise<SeededRow[]> {
  const rows: SeededRow[] = [];
  for (let i = 1; i <= 200; i++) {
    const amount = `${50 + (i % 73)}.${String((i * 7) % 100).padStart(2, '0')}`;
    const at = new Date(Date.now() - (201 - i) * 60_000);
    const voided = i % 17 === 0;
    const id =
      i % 2 === 1
        ? await seedSale(companyId, REP_A.id, i, amount, at, voided)
        : await seedPayment(companyId, REP_A.id, i, amount, at, voided);
    rows.push({ id, kind: i % 2 === 1 ? 'sale' : 'payment', amount, voided });
  }
  return rows;
}

/** The balance the fixture MUST produce — the same sum the view defines. */
function expectedBalance(rows: SeededRow[]): string {
  let p = 0;
  for (const row of rows) {
    if (row.voided) continue;
    p += row.kind === 'sale' ? paisa(row.amount) : -paisa(row.amount);
  }
  return rupees(p);
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

  await seedEmployee('owner', OWNER, ['sales.payments', 'sales.cards']);
  // The reps carry `sales.cards` too: the fixtures confirm real sales and
  // capture real payments through the API so the ledger stories settle
  // against live balances — T3.3's and T3.4's surfaces, not this task's.
  await seedEmployee('sales_rep', REP_A, ['sales.payments', 'sales.cards']);
  await seedEmployee('sales_rep', REP_B, ['sales.payments', 'sales.cards']);
  await seedEmployee('sales_rep', REP_NO_FLAG, []);
  await seedEmployee('dispatcher', DISPATCHER, ['sales.payments']);

  houseId = await createCompany(REP_A, `Integr House Ledger Co ${randomBytes(3).toString('hex')}`);
  await db.query(`UPDATE companies SET owner_rep_id = NULL WHERE id = $1`, [houseId]);
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

describe('the newest running balance equals v_company_balances to the paisa (the 200-row fixture)', () => {
  it('reconciles the whole column, not just the last row, across 200 interleaved rows with voids', async () => {
    const co = await newCompany();
    const seeded = await seedFixture(co);
    const view = await balanceOf(co);
    expect(seeded).toHaveLength(200);
    expect(view).toBe(expectedBalance(seeded)); // the fixture itself is honest

    const ledger = await getLedgerOk(REP_A, co);
    expect(ledger.entries).toHaveLength(200); // voids included, drafts never existed here
    expect(ledger.balance).toBe(view); // the header figure IS the view

    // THE Done-when: the newest row's running balance equals the view exactly.
    expect(ledger.entries[0]!.runningBalance).toBe(view);

    // The ledger came back newest first — the order key is the movement
    // instant, and the whole column must agree with it.
    for (let i = 1; i < ledger.entries.length; i++) {
      const previous = ledger.entries[i - 1]!;
      const current = ledger.entries[i]!;
      expect(new Date(previous.recordedAt).getTime()).toBeGreaterThanOrEqual(new Date(current.recordedAt).getTime());
    }
    expect(ledger.entries[0]!.id).toBe(seeded[seeded.length - 1]!.id);

    // The "If it fails" guard, on every row: walking from the OLDEST row
    // up, adding each row's effect (voids add nothing), reproduces the
    // running balance the server printed. A ledger computed forwards from
    // zero disagrees here — the walk meets it at the wrong paisa midway.
    let walked = 0;
    const byId = new Map(seeded.map((s) => [s.id, s]));
    for (let i = ledger.entries.length - 1; i >= 0; i--) {
      const entry = ledger.entries[i]!;
      const seed = byId.get(entry.id)!;
      expect(seed).toBeDefined();
      expect(entry.kind).toBe(seed.kind);
      expect(paisa(entry.amount)).toBe(seed.kind === 'sale' ? paisa(seed.amount) : -paisa(seed.amount));
      expect(entry.voided).toBe(seed.voided);
      if (!entry.voided) {
        walked += seed.kind === 'sale' ? paisa(seed.amount) : -paisa(seed.amount);
      }
      expect(entry.runningBalance).toBe(rupees(walked));
    }
    expect(rupees(walked)).toBe(view);
  });

  it('an account with no entries reads as a flat ledger with the view balance', async () => {
    const co = await newCompany();
    const ledger = await getLedgerOk(OWNER, co);
    expect(ledger.companyId).toBe(co);
    expect(ledger.balance).toBe('0.00');
    expect(ledger.entries).toEqual([]);
  });
});

describe('voided rows appear in the ledger as voided and do not move the running balance', () => {
  it('keeps the document, drops the paisa, and drafts never appear at all', async () => {
    const co = await newCompany();
    const saleOld = await createSaleOk(REP_A, {
      companyId: co,
      saleDate: '2026-09-01',
      items: [{ productName: 'Line interactive UPS', quantity: 1, unitPrice: '8000.00' }],
    });
    const saleVoided = await createSaleOk(REP_A, {
      companyId: co,
      saleDate: '2026-09-02',
      items: [{ productName: 'Battery 150Ah', quantity: 2, unitPrice: '4200.00' }],
    });
    const paymentVoided = await createPaymentOk(REP_A, {
      companyId: co,
      amount: '1500.25',
      mode: 'cheque',
      referenceNo: 'CH-88120',
      receivedAt: '2026-09-03T11:00:00+05:30',
    });
    const paymentKept = await createPaymentOk(REP_A, {
      companyId: co,
      amount: '600.00',
      mode: 'upi',
      referenceNo: 'UPI-77120',
      receivedAt: '2026-09-03T12:00:00+05:30',
    });
    const draftId = await createDraftSale(REP_A, {
      companyId: co,
      saleDate: '2026-09-03',
      items: [{ productName: 'Never confirmed', quantity: 1, unitPrice: '999.00' }],
    });

    await voidOk(OWNER, 'sales', saleVoided.id, 'Priced wrong — re-entering');
    await voidOk(OWNER, 'payments', paymentVoided.id, 'Cheque bounced');

    const view = await balanceOf(co);
    expect(view).toBe(rupees(paisa('8000.00') - paisa('600.00'))); // voids and the draft moved nothing

    const ledger = await getLedgerOk(REP_A, co);
    expect(ledger.balance).toBe(view);
    expect(ledger.entries).toHaveLength(4); // 2 sales + 2 payments; the VOIDED stay, the DRAFT never was
    expect(ledger.entries.map((e) => e.id)).not.toContain(draftId);

    // Newest first. The sales were confirmed NOW (confirm_at is the
    // server's instant); the payments carry their September received_at —
    // so the confirmed sales lead, and the two payments follow in
    // received order. Movement instants order documents across kinds.
    expect(ledger.entries.map((e) => e.id)).toEqual([
      saleVoided.id,
      saleOld.id,
      paymentKept.id,
      paymentVoided.id,
    ]);

    const byId = new Map(ledger.entries.map((e) => [e.id, e]));

    // The kept documents carry their signed amounts — a sale positive, a
    // payment negative (§S4's column) — with mode for the payment only.
    const keptPayment = byId.get(paymentKept.id)!;
    expect(keptPayment.kind).toBe('payment');
    expect(keptPayment.amount).toBe('-600.00');
    expect(keptPayment.mode).toBe('upi');
    expect(keptPayment.voided).toBe(false);
    expect(keptPayment.voidReason).toBeNull();
    expect(keptPayment.date).toBe('2026-09-03');
    expect(keptPayment.runningBalance).toBe('-600.00'); // itself plus the voided payment's nothing

    const keptSale = byId.get(saleOld.id)!;
    expect(keptSale.kind).toBe('sale');
    expect(keptSale.amount).toBe('8000.00');
    expect(keptSale.mode).toBeNull();
    expect(keptSale.date).toBe('2026-09-01');
    expect(keptSale.runningBalance).toBe(view); // 8000 − 600, the voids contributing nothing

    // The voids APPEAR — number, amount, reason intact — but the running
    // balance steps over them: each void's balance equals its next-older
    // entry's, because a void contributed nothing.
    const voidedPayment = byId.get(paymentVoided.id)!;
    expect(voidedPayment.voided).toBe(true);
    expect(voidedPayment.voidReason).toBe('Cheque bounced');
    expect(voidedPayment.amount).toBe('-1500.25'); // the document amount, signed, preserved
    expect(voidedPayment.mode).toBe('cheque');
    expect(voidedPayment.runningBalance).toBe('0.00'); // the oldest row, and it moved nothing
    const voidedSale = byId.get(saleVoided.id)!;
    expect(voidedSale.voided).toBe(true);
    expect(voidedSale.voidReason).toBe('Priced wrong — re-entering');
    expect(voidedSale.amount).toBe('8400.00');
    expect(voidedSale.runningBalance).toBe(view); // the newest row IS the view, void and all
    for (const [voidedId, older] of [
      [saleVoided.id, saleOld.id],
    ] as const) {
      expect(byId.get(voidedId)!.runningBalance).toBe(byId.get(older)!.runningBalance);
    }

    // The independent walk still reconciles the column to the view.
    let walked = 0;
    for (let i = ledger.entries.length - 1; i >= 0; i--) {
      const entry = ledger.entries[i]!;
      if (!entry.voided) walked += paisa(entry.amount);
      expect(entry.runningBalance).toBe(rupees(walked));
    }
    expect(rupees(walked)).toBe(view);
  });
});

describe('the ledger is scoped: a rep cannot read another rep’s account’s ledger', () => {
  let coA: string;
  let coB: string;

  it('REP_A and REP_B each own an account; the owner and the house account answer to everyone', async () => {
    coA = await newCompany();
    coB = await createCompany(REP_B, `Integr Other Rep ${randomBytes(3).toString('hex')}`);
    await createSaleOk(REP_A, {
      companyId: coA,
      saleDate: '2026-09-01',
      items: [{ productName: 'Servo stabiliser', quantity: 1, unitPrice: '1200.00' }],
    });
    await createPaymentOk(REP_B, {
      companyId: coB,
      amount: '100.00',
      mode: 'cash',
      receivedAt: '2026-09-01T10:00:00+05:30',
    });

    // The owner reads both books.
    expect((await getLedgerOk(OWNER, coA)).entries).toHaveLength(1);
    expect((await getLedgerOk(OWNER, coB)).entries).toHaveLength(1);
    // The house account is every rep's — the nullable floor of `own`.
    expect((await getLedgerOk(REP_A, houseId)).entries).toHaveLength(0);
    expect((await getLedgerOk(REP_B, houseId)).entries).toHaveLength(0);
  });

  it('the other rep’s account is OUT_OF_SCOPE — his own included nothing of it', async () => {
    const res = await getLedger(REP_A, coB);
    expect(res.statusCode, res.body).toBe(403);
    expect(errorOf(res.statusCode, res.body).code).toBe('OUT_OF_SCOPE');
  });

  it('the dispatcher holds no company cell at all', async () => {
    const res = await getLedger(DISPATCHER, coA);
    expect(res.statusCode, res.body).toBe(403);
    expect(errorOf(res.statusCode, res.body).code).toBe('FORBIDDEN');
  });

  it('the flag is the surface’s rollback tier — without sales.payments the ledger and the tab are dark', async () => {
    const ledger = await getLedger(REP_NO_FLAG, coA);
    expect(ledger.statusCode, ledger.body).toBe(409);
    expect(errorOf(ledger.statusCode, ledger.body).code).toBe('FLAG_DISABLED');

    const balances = await getBalances(REP_NO_FLAG);
    expect(balances.statusCode, balances.body).toBe(409);
    expect(errorOf(balances.statusCode, balances.body).code).toBe('FLAG_DISABLED');
  });

  it('a missing or malformed id reads as 404, never a 500', async () => {
    const missing = await getLedger(OWNER, randomUUID());
    expect(missing.statusCode, missing.body).toBe(404);
    expect(errorOf(missing.statusCode, missing.body).code).toBe('NOT_FOUND');
    const malformed = await getLedger(OWNER, 'not-a-uuid');
    expect(malformed.statusCode, malformed.body).toBe(404);
  });
});

describe('the Pending tab reads v_company_balances — dues, not payment rows', () => {
  it('returns the view’s balances floored by minBalance, sorted descending, scoped to the rep', async () => {
    const due = await newCompany(); // REP_A's — owes money
    const settled = await newCompany(); // REP_A's — flat zero
    const credit = await newCompany(); // REP_A's — overpaid, NEGATIVE
    await createSaleOk(REP_A, {
      companyId: due,
      saleDate: '2026-09-01',
      items: [{ productName: 'UPS installation', quantity: 2, unitPrice: '4500.50' }],
    });
    await createSaleOk(REP_A, {
      companyId: settled,
      saleDate: '2026-09-01',
      items: [{ productName: 'Battery tray', quantity: 1, unitPrice: '350.00' }],
    });
    await createPaymentOk(REP_A, {
      companyId: settled,
      amount: '350.00',
      mode: 'upi',
      referenceNo: 'UPI-61001',
      receivedAt: '2026-09-01T15:00:00+05:30',
    });
    await createSaleOk(REP_A, {
      companyId: credit,
      saleDate: '2026-09-02',
      items: [{ productName: 'Trolley', quantity: 1, unitPrice: '900.00' }],
    });
    await createPaymentOk(REP_A, {
      companyId: credit,
      amount: '1200.00',
      mode: 'cash',
      receivedAt: '2026-09-02T15:00:00+05:30',
    });
    // The house account owes too — so the default tab has a house row to
    // show (a flat house account is not pending, and must not appear).
    await createSaleOk(REP_B, {
      companyId: houseId,
      saleDate: '2026-09-04',
      items: [{ productName: 'House AMC visit', quantity: 1, unitPrice: '2000.00' }],
    });

    // Sanity: the views behind the tab say what the stories above say.
    expect(await balanceOf(due)).toBe('9001.00');
    expect(await balanceOf(settled)).toBe('0.00');
    expect(await balanceOf(credit)).toBe('-300.00');

    // The default tab (`?minBalance=0.01` is the spec's example): the dues
    // only — a zero balance is not pending, and a credit is not either.
    const defaultTab = await getBalancesOk(REP_A);
    const ids = defaultTab.map((row) => row.companyId);
    expect(ids).toContain(due);
    expect(ids).not.toContain(settled);
    expect(ids).not.toContain(credit);
    expect(ids).toContain(houseId); // house accounts are the rep's too
    for (let i = 1; i < defaultTab.length; i++) {
      expect(paisa(defaultTab[i - 1]!.balance)).toBeGreaterThanOrEqual(paisa(defaultTab[i]!.balance));
    }
    const dueRow = defaultTab.find((row) => row.companyId === due)!;
    expect(dueRow.balance).toBe('9001.00');
    expect(dueRow.name).toBeTruthy();
    expect(dueRow.lastSaleDate).toBe('2026-09-01');
    expect(dueRow.lastPaymentAt).toBeNull();
    expect(defaultTab.find((row) => row.companyId === houseId)!.balance).toBe('2000.00');

    // A floor of zero admits the flat accounts but still not the credit —
    // only a floor BELOW zero scans overpayments, the owner's legitimate
    // read of the same view.
    const zeroFloor = await getBalancesOk(OWNER, '?minBalance=0');
    const zeroIds = zeroFloor.map((row) => row.companyId);
    expect(zeroIds).toContain(due);
    expect(zeroIds).toContain(settled);
    expect(zeroIds).not.toContain(credit);
    expect(zeroIds).toContain(houseId);

    const withCredits = await getBalancesOk(OWNER, '?minBalance=-99999999.99');
    const allIds = withCredits.map((row) => row.companyId);
    expect(allIds).toContain(due);
    expect(allIds).toContain(settled);
    expect(allIds).toContain(credit);
    expect(allIds).toContain(houseId);
    const creditRow = withCredits.find((row) => row.companyId === credit)!;
    expect(creditRow.balance).toBe('-300.00');
    expect(creditRow.lastPaymentAt).not.toBeNull();

    // A higher floor narrows the tab.
    const big = await getBalancesOk(OWNER, '?minBalance=9001.01');
    expect(big.map((row) => row.companyId)).not.toContain(due);

    // Scoping is the account's: REP_B sees neither of REP_A's accounts,
    // the owner sees both.
    const bTab = await getBalancesOk(REP_B);
    expect(bTab.map((row) => row.companyId)).not.toContain(due);
    expect(bTab.map((row) => row.companyId)).not.toContain(credit);
    expect(bTab.map((row) => row.companyId)).toContain(houseId);
  });

  it('the tab’s every row equals the view, to the paisa, for the whole scope', async () => {
    // Not a count — the rows themselves: the tab is exactly
    // v_company_balances WHERE balance >= floor AND <scope>, nothing else.
    const tab = await getBalancesOk(OWNER, '?minBalance=-99999999.99');
    const view = await db.query<{ company_id: string; balance: string }>(
      `SELECT vb.company_id, vb.balance::text FROM v_company_balances vb
       JOIN companies c ON c.id = vb.company_id AND c.is_active
       WHERE vb.balance >= (-99999999.99)::numeric
       ORDER BY vb.balance DESC, c.name ASC`,
    );
    expect(tab.map((r) => r.companyId)).toEqual(view.rows.map((r) => r.company_id));
    for (let i = 0; i < tab.length; i++) {
      expect(tab[i]!.balance).toBe(view.rows[i]!.balance);
    }
  });

  it('a malformed minBalance is refused 422, and the dispatcher is 403 at the door', async () => {
    const bad = await getBalances(REP_A, '?minBalance=5.005'); // money carries at most two decimals
    expect(bad.statusCode, bad.body).toBe(422);
    expect(errorOf(bad.statusCode, bad.body).code).toBe('VALIDATION_FAILED');

    const junk = await getBalances(REP_A, '?minBalance=abc');
    expect(junk.statusCode, junk.body).toBe(422);

    const res = await getBalances(DISPATCHER);
    expect(res.statusCode, res.body).toBe(403);
    expect(errorOf(res.statusCode, res.body).code).toBe('FORBIDDEN');
  });
});
