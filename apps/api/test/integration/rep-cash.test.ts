import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import type { FastifyInstance } from 'fastify';
import {
  authMeResponseSchema,
  CashHandoverSchema,
  cashHandoverListResponseSchema,
  errorEnvelopeSchema,
  type ErrorEnvelope,
  type LoginResponse,
} from '@servgrid/shared';
import { loadConfig, type Config } from '../../src/config.js';
import { closePool } from '../../src/db/pool.js';
import { runMigrations } from '../../src/db/migrate.js';
import { hashPassword } from '../../src/lib/password.js';
import { buildServer } from '../../src/server.js';
import { ULID, validEnv } from '../helpers/env.js';

/**
 * Rep cash handover (PHASE-3-SALES-REP.md T3.6, PLAN-BACKEND.md §10).
 * No new endpoint and no new screen: `cash_reconciliations` is keyed on
 * `employee_id` and the technician's endpoints (T1.11) already accept a
 * sales rep, so this suite proves the rep path end to end — the
 * `sales.cash` gate (T0: flag off refuses the rep and only the rep),
 * the row keyed on his employee_id, the withheld figure, and the
 * amend-then-refuse cycle, the technician's rule at the rep's door.
 *
 * The `missing_submission` case is T3.1's payment-day fixture
 * (views-money.test.ts asserted it with a SQL-seeded declaration); here
 * the payment is seeded and the declaration is driven through
 * POST /v1/cash/handovers, and the flag is read from
 * `v_cash_reconciliation_queue` before and after — the row the endpoint
 * writes must be the one the queue joins on, which is the rep path
 * proven through the queue, not just through the table.
 */

function databaseUrl(): string {
  return process.env.DATABASE_URL ?? 'postgres://servgrid:servgrid@localhost:5432/servgrid';
}

function adminUrlFor(url: string): string {
  const parsed = new URL(url);
  parsed.pathname = '/postgres';
  return parsed.toString();
}

const SCRATCH_DB = 'servgrid_rep_cash_test';
const PASSWORD = 't36-plain-copier-47';

let admin: Pool;
let db: Pool;
let app: FastifyInstance;
let config: Config;

const OWNER = { username: '', id: '', token: '' };
const TECH = { username: '', id: '', token: '' };
const REP = { username: '', id: '', token: '' };
const REP_B = { username: '', id: '', token: '' };

async function seedEmployee(
  role: 'owner' | 'technician' | 'sales_rep',
  who: { username: string; id: string; token: string },
): Promise<void> {
  const username = `t36.${role}.${randomBytes(4).toString('hex')}`;
  const r = await db.query<{ id: string }>(
    `INSERT INTO employees (username, password_hash, full_name, role)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [username, await hashPassword(PASSWORD), `Test ${username}`, role],
  );
  who.id = r.rows[0]!.id;
  who.username = username;
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

/** Business dates computed the way the service computes them — IST, not the CI machine's clock. */
async function businessDate(offsetDays: number): Promise<string> {
  const r = await db.query<{ d: string }>(
    `SELECT (business_date(now()) + $1::int)::text AS d`,
    [offsetDays],
  );
  return r.rows[0]!.d;
}

/** Noon IST of a business day — unambiguously inside it, wherever the server boots. */
function noonIst(day: string): string {
  return `${day}T12:00:00+05:30`;
}

/** `sales.cash` on, directly — the way the matrix suite rides its flag-gated probes. */
async function enableRepCash(employeeId: string): Promise<void> {
  await db.query(
    `INSERT INTO employee_flag_overrides (employee_id, flag, enabled)
     VALUES ($1, 'sales.cash', true)
     ON CONFLICT (employee_id, flag) DO UPDATE SET enabled = true`,
    [employeeId],
  );
}

/** T3.1's payment fixture: one collected cash payment received by the rep, on-account. */
async function seedCashPayment(
  companyName: string,
  receivedBy: string,
  amount: string,
  receivedAt: string,
): Promise<string> {
  const companyId = (
    await db.query<{ id: string }>(
      `INSERT INTO companies (name) VALUES ($1) RETURNING id`,
      [companyName],
    )
  ).rows[0]!.id;
  return (
    await db.query<{ id: string }>(
      `INSERT INTO payments
         (payment_number, company_id, sales_card_id, amount, mode, received_by, received_at, status)
       VALUES ($1, $2, NULL, $3, 'cash', $4, $5, 'collected')
       RETURNING id`,
      [`PM-T36-${randomBytes(4).toString('hex')}`, companyId, amount, receivedBy, receivedAt],
    )
  ).rows[0]!.id;
}

interface QueueRow {
  expected_cash: string | null;
  declared_amount: string | null;
  variance: string | null;
  flag: string;
}

/** The queue row for one employee-day — read from the view, never the table. */
async function queueRowFor(employeeId: string, day: string): Promise<QueueRow | undefined> {
  const r = await db.query<QueueRow>(
    `SELECT expected_cash::text AS expected_cash,
            declared_amount::text AS declared_amount,
            variance::text AS variance,
            flag
       FROM v_cash_reconciliation_queue
      WHERE employee_id = $1 AND business_date = $2::date`,
    [employeeId, day],
  );
  return r.rows[0];
}

/** Seed a confirmed row exactly as Phase 4's confirm (T4.2) would leave it. */
async function signOffConfirmed(handoverId: string): Promise<void> {
  await db.query(
    `UPDATE cash_reconciliations
     SET status = 'confirmed', confirmed_amount = declared_amount,
         confirmed_by = $2, confirmed_at = now()
     WHERE id = $1`,
    [handoverId, OWNER.id],
  );
}

function envelopeOf(status: number, body: string): ErrorEnvelope['error'] {
  expect(status).toBeGreaterThanOrEqual(400);
  const parsed = errorEnvelopeSchema.parse(JSON.parse(body)) as unknown as ErrorEnvelope;
  const error = parsed.error;
  expect(error.requestId).toMatch(ULID);
  return error;
}

function declareCash(token: string, body: Record<string, unknown>) {
  return app.inject({
    method: 'POST',
    url: '/v1/cash/handovers',
    headers: { authorization: `Bearer ${token}`, 'x-client-source': 'mobile' },
    payload: body,
  });
}

function amendCash(token: string, id: string, ifMatch: number, body: Record<string, unknown>) {
  return app.inject({
    method: 'PATCH',
    url: `/v1/cash/handovers/${id}`,
    headers: {
      authorization: `Bearer ${token}`,
      'x-client-source': 'mobile',
      'if-match': String(ifMatch),
    },
    payload: body,
  });
}

function myHandovers(token: string) {
  return app.inject({
    method: 'GET',
    url: '/v1/cash/handovers/me',
    headers: { authorization: `Bearer ${token}` },
  });
}

function authMe(token: string) {
  return app.inject({
    method: 'GET',
    url: '/v1/auth/me',
    headers: { authorization: `Bearer ${token}` },
  });
}

/** Every key in a decoded JSON body, at any depth — key absence is the assertion, not a null value. */
function keysOf(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) keysOf(item, out);
  } else if (typeof value === 'object' && value !== null) {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out.push(key);
      keysOf(child, out);
    }
  }
  return out;
}

beforeAll(async () => {
  admin = new Pool({ connectionString: adminUrlFor(databaseUrl()), max: 2 });
  await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${SCRATCH_DB}`);

  const scratchUrl = new URL(databaseUrl());
  scratchUrl.pathname = `/${SCRATCH_DB}`;
  // The cash service reads through the process-wide pool (db/pool.ts);
  // point it at the scratch database before the first request.
  process.env.DATABASE_URL = scratchUrl.toString();
  db = new Pool({ connectionString: scratchUrl.toString(), max: 5 });
  await runMigrations({ pool: db });

  config = loadConfig(validEnv({ DATABASE_URL: scratchUrl.toString() }));
  app = buildServer(config, { logger: false });
  await app.ready();

  await seedEmployee('owner', OWNER);
  await seedEmployee('technician', TECH);
  await seedEmployee('sales_rep', REP);
  await seedEmployee('sales_rep', REP_B);
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

describe('the sales.cash gate — the T0 rollback tier (T3.6)', () => {
  it('sales.cash off refuses the rep’s declaration with 409 FLAG_DISABLED, and no row is written', async () => {
    const res = await declareCash(REP.token, { businessDate: await businessDate(0), declaredAmount: '5000' });
    expect(res.statusCode, res.body).toBe(409);
    expect(envelopeOf(res.statusCode, res.body).code).toBe('FLAG_DISABLED');

    const r = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM cash_reconciliations WHERE employee_id = $1`,
      [REP.id],
    );
    expect(r.rows[0]!.n).toBe('0');
  });

  it('the gate is the rep’s alone — the technician declares on the same endpoint while the rep is dark', async () => {
    // The technician's handover is the technician phase's surface (T1.11);
    // `sales.cash` off must not darken it.
    const res = await declareCash(TECH.token, { businessDate: await businessDate(0), declaredAmount: '750' });
    expect(res.statusCode, res.body).toBe(200);
    expect(CashHandoverSchema.parse(res.json()).status).toBe('submitted');
  });

  it('the owner switches sales.cash on for the rep, and /auth/me answers with it', async () => {
    const flip = await app.inject({
      method: 'PUT',
      url: `/v1/employees/${REP.id}/flags`,
      headers: { authorization: `Bearer ${OWNER.token}` },
      payload: { flag: 'sales.cash', enabled: true },
    });
    expect(flip.statusCode, flip.body).toBe(200);
    expect(flip.json<{ flags: Record<string, boolean> }>().flags['sales.cash']).toBe(true);

    const me = await authMe(REP.token);
    expect(me.statusCode, me.body).toBe(200);
    expect(authMeResponseSchema.parse(me.json()).featureFlags['sales.cash']).toBe(true);
  });
});

describe('POST /v1/cash/handovers — a rep declares (§10)', () => {
  it('a rep declares, and the row is keyed on his employee_id', async () => {
    const day = await businessDate(0);
    const res = await declareCash(REP.token, { businessDate: day, declaredAmount: '5000' });
    expect(res.statusCode, res.body).toBe(200);

    const handover = CashHandoverSchema.parse(res.json());
    expect(handover.businessDate).toBe(day);
    expect(handover.declaredAmount).toBe('5000.00');
    expect(handover.status).toBe('submitted');

    const rows = await db.query<{ employee_id: string; business_date: string }>(
      `SELECT employee_id, business_date::text AS business_date
         FROM cash_reconciliations WHERE id = $1`,
      [handover.id],
    );
    expect(rows.rows).toHaveLength(1);
    // Keyed on the rep's own employee_id — the same table, the same key,
    // no technician-shaped column anywhere (PLAN-DATA-MODEL.md §3.7).
    expect(rows.rows[0]!.employee_id).toBe(REP.id);
    expect(rows.rows[0]!.business_date).toBe(day);
  });
});

describe('the withheld figure — the employee never sees the expectation (§10)', () => {
  it('a rep’s GET /me omits expected_cash — key absence on /auth/me and the handover history', async () => {
    // The profile endpoint the rep's app renders first.
    const me = await authMe(REP.token);
    expect(me.statusCode, me.body).toBe(200);
    authMeResponseSchema.parse(me.json());
    expect(keysOf(JSON.parse(me.body)).filter((k) => /expected/i.test(k))).toEqual([]);
    expect(me.body).not.toContain('expected_cash');
    expect(me.body).not.toContain('expectedCash');

    // His declaration history — the T1.11 rule, now asserted for the rep.
    const history = await myHandovers(REP.token);
    expect(history.statusCode, history.body).toBe(200);
    const items = cashHandoverListResponseSchema.parse(history.json());
    expect(items.length).toBeGreaterThan(0);
    expect(keysOf(JSON.parse(history.body)).filter((k) => /expected/i.test(k))).toEqual([]);
    expect(history.body).not.toContain('expected_cash');
    expect(history.body).not.toContain('expectedCash');
  });
});

describe('a rep-day with a cash payment — through the queue (T3.1’s fixture, from the endpoint)', () => {
  it('a rep-day with a cash payment and no declaration flags missing_submission; the endpoint’s declaration resolves it', async () => {
    // REP_B rides his flag enabled directly (the matrix's pattern) — the
    // gate's own switchable behaviour is asserted above on REP.
    await enableRepCash(REP_B.id);

    const day = await businessDate(-1);
    // T3.1's fixture: one cash payment collected from a company, no
    // declaration, no completion — only the payments side knows.
    await seedCashPayment('T36 Rep Collection Co', REP_B.id, '1200.00', noonIst(day));

    const before = await queueRowFor(REP_B.id, day);
    // The row the feature exists for, present for a rep-day: a LEFT JOIN
    // would drop it — it exists only on the expected side.
    expect(before).toBeDefined();
    expect(before?.flag).toBe('missing_submission');
    expect(before?.expected_cash).toBe('1200.00');
    expect(before?.declared_amount).toBeNull();
    expect(before?.variance).toBeNull();

    // The declaration arrives through the endpoint, not a SQL insert.
    const res = await declareCash(REP_B.token, { businessDate: day, declaredAmount: '1200.00' });
    expect(res.statusCode, res.body).toBe(200);
    expect(CashHandoverSchema.parse(res.json()).status).toBe('submitted');

    const after = await queueRowFor(REP_B.id, day);
    // The row the endpoint wrote is the row the queue joined on: keyed on
    // his employee_id and business_date, the flag resolves to a match —
    // the rep path proven through the queue, not just through the table.
    expect(after).toBeDefined();
    expect(after?.flag).toBe('match');
    expect(after?.declared_amount).toBe('1200.00');
    expect(after?.expected_cash).toBe('1200.00');
    expect(after?.variance).toBe('0.00');
  });
});

describe('PATCH /v1/cash/handovers/:id — the technician’s correction rule at the rep’s door (§10)', () => {
  it('amend while submitted succeeds — version bump and an audit row carrying the previous amount', async () => {
    const day = await businessDate(0);
    const row = (
      await db.query<{ id: string; version: number; declared_amount: string }>(
        `SELECT id, version, declared_amount::text AS declared_amount
           FROM cash_reconciliations
          WHERE employee_id = $1 AND business_date = $2::date`,
        [REP.id, day],
      )
    ).rows[0]!;
    expect(row.declared_amount).toBe('5000.00');

    // He cannot resubmit — the unique (employee, date) pair holds for the
    // rep too — so the correction path is the PATCH, exactly as §10 says.
    const resubmit = await declareCash(REP.token, { businessDate: day, declaredAmount: '6000' });
    expect(resubmit.statusCode, resubmit.body).toBe(409);
    expect(envelopeOf(resubmit.statusCode, resubmit.body).code).toBe('DUPLICATE_ENTITY');

    const res = await amendCash(REP.token, row.id, row.version, { declaredAmount: '12000.50' });
    expect(res.statusCode, res.body).toBe(200);

    const amended = CashHandoverSchema.parse(res.json());
    expect(amended.declaredAmount).toBe('12000.50');
    expect(amended.version).toBe(row.version + 1);
    expect(amended.status).toBe('submitted');

    const audit = await db.query<{
      action: string;
      employee_id: string;
      actor: string;
      details: Record<string, unknown>;
    }>(`SELECT action, employee_id, actor, details FROM audit_log ORDER BY id DESC LIMIT 1`);
    expect(audit.rows[0]!.action).toBe('cash.declaration.amended');
    expect(audit.rows[0]!.employee_id).toBe(REP.id);
    expect(audit.rows[0]!.actor).toBe(REP.id);
    expect(audit.rows[0]!.details).toMatchObject({
      handoverId: row.id,
      businessDate: day,
      previousAmount: '5000.00',
      declaredAmount: '12000.50',
    });
  });

  it('after the owner confirms, the rep’s PATCH is refused 409 RECONCILIATION_CONFIRMED and the figure stands', async () => {
    const day = await businessDate(0);
    const row = (
      await db.query<{ id: string; version: number; declared_amount: string; status: string }>(
        `SELECT id, version, declared_amount::text AS declared_amount, status
           FROM cash_reconciliations
          WHERE employee_id = $1 AND business_date = $2::date`,
        [REP.id, day],
      )
    ).rows[0]!;
    expect(row.status).toBe('submitted');
    await signOffConfirmed(row.id);

    const res = await amendCash(REP.token, row.id, row.version, { declaredAmount: '9999' });
    expect(res.statusCode, res.body).toBe(409);
    expect(envelopeOf(res.statusCode, res.body).code).toBe('RECONCILIATION_CONFIRMED');

    // The refusal is real: the confirmed figure is unchanged.
    const after = (
      await db.query<{ declared_amount: string; status: string }>(
        `SELECT declared_amount::text AS declared_amount, status
           FROM cash_reconciliations WHERE id = $1`,
        [row.id],
      )
    ).rows[0]!;
    expect(after.declared_amount).toBe('12000.50');
    expect(after.status).toBe('confirmed');
  });
});
