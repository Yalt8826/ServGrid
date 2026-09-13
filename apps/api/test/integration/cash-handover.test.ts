import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import type { FastifyInstance } from 'fastify';
import {
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
import { BUSINESS_DATE_MAX_AGE_DAYS } from '../../src/modules/cash/service.js';
import { ULID, validEnv } from '../helpers/env.js';

/**
 * Cash handover (PHASE-1-TECHNICIAN.md T1.11, PLAN-BACKEND.md §10).
 * Runs against a scratch database built from the real migrations (§14:
 * no mocked database anywhere) and drives the endpoints over HTTP,
 * because the things worth proving are exactly what a mock cannot prove:
 * the (employee, business_date) uniqueness behind the idempotent declare,
 * the IST date window, the amend-then-refuse cycle across both signed-off
 * statuses, and the *absence* of `expected_cash` from the serialised body
 * — the brief's own sentence, asserted on the bytes the handset parses,
 * not on a type.
 */

function databaseUrl(): string {
  return process.env.DATABASE_URL ?? 'postgres://servgrid:servgrid@localhost:5432/servgrid';
}

function adminUrlFor(url: string): string {
  const parsed = new URL(url);
  parsed.pathname = '/postgres';
  return parsed.toString();
}

const SCRATCH_DB = 'servgrid_cash_handover_test';
const PASSWORD = 'ch-plain-copier-63';

let admin: Pool;
let db: Pool;
let app: FastifyInstance;
let config: Config;

const OWNER = { username: '', id: '', token: '' };
const TECH_A = { username: '', id: '', token: '' };
const TECH_B = { username: '', id: '', token: '' };
const SALES_REP = { username: '', id: '', token: '' };

async function seedEmployee(
  role: 'owner' | 'technician' | 'sales_rep',
  who: { username: string; id: string; token: string },
): Promise<void> {
  const username = `t111.${role}.${randomBytes(4).toString('hex')}`;
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

interface HandoverRow {
  id: string;
  employee_id: string;
  business_date: string;
  declared_amount: string;
  status: string;
  version: number;
}

async function handoversOf(employeeId: string): Promise<HandoverRow[]> {
  const r = await db.query<HandoverRow>(
    `SELECT id, employee_id, business_date::text AS business_date,
            declared_amount::text AS declared_amount, status, version
     FROM cash_reconciliations WHERE employee_id = $1
     ORDER BY business_date`,
    [employeeId],
  );
  return r.rows;
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

/** Seed a signed-off row exactly as Phase 4's confirm (or dispute) would leave it. */
async function signOff(
  handoverId: string,
  kind: 'confirmed' | 'disputed',
): Promise<void> {
  await db.query(
    `UPDATE cash_reconciliations
     SET status = $2::reconciliation_status,
         confirmed_amount = CASE WHEN $2::text = 'confirmed' THEN declared_amount ELSE NULL END,
         confirmed_by = $3,
         confirmed_at = now(),
         owner_note = CASE WHEN $2::text = 'disputed' THEN 'figures do not match the completions' ELSE NULL END
     WHERE id = $1`,
    [handoverId, kind, OWNER.id],
  );
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
  await seedEmployee('technician', TECH_A);
  await seedEmployee('technician', TECH_B);
  await seedEmployee('sales_rep', SALES_REP);

  // The rep's half of this surface rides `sales.cash` (T3.6, defaulted
  // off like every flag); these suites exercise the declaration and
  // amendment rules themselves, so the rep's flag rides enabled — the
  // flag's own switchable behaviour is integration/rep-cash.test.ts's
  // subject.
  await db.query(
    `INSERT INTO employee_flag_overrides (employee_id, flag, enabled)
     VALUES ($1, 'sales.cash', true)`,
    [SALES_REP.id],
  );
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

describe('POST /v1/cash/handovers — the declaration (§10)', () => {
  it('a technician declares today and the row is his, submitted, without expected cash', async () => {
    const res = await declareCash(TECH_A.token, { businessDate: await businessDate(0), declaredAmount: '4500' });
    expect(res.statusCode, res.body).toBe(200);

    const handover = CashHandoverSchema.parse(res.json());
    expect(handover.businessDate).toBe(await businessDate(0));
    expect(handover.declaredAmount).toBe('4500.00');
    expect(handover.status).toBe('submitted');
    // The response is the declaration, and only the declaration —
    // asserted on the raw body too, camelCase and snake_case.
    expect(res.json()).not.toHaveProperty('expected_cash');
    expect(res.json()).not.toHaveProperty('expectedCash');
  });

  it('a sales rep declares too — keyed on employee, not technician (§3.7)', async () => {
    const res = await declareCash(SALES_REP.token, { businessDate: await businessDate(0), declaredAmount: '12000.50' });
    expect(res.statusCode, res.body).toBe(200);
    expect(CashHandoverSchema.parse(res.json()).declaredAmount).toBe('12000.50');
  });

  it('a second declaration for the same day is 409, not a duplicate row', async () => {
    const day = await businessDate(-6); // a day TECH_A has not declared yet
    const first = await declareCash(TECH_A.token, { businessDate: day, declaredAmount: '4500' });
    expect(first.statusCode, first.body).toBe(200);

    const second = await declareCash(TECH_A.token, { businessDate: day, declaredAmount: '9999' });
    expect(second.statusCode, second.body).toBe(409);
    expect(envelopeOf(second.statusCode, second.body).code).toBe('DUPLICATE_ENTITY');

    // Exactly one row, carrying the first declaration.
    const rows = await handoversOf(TECH_A.id);
    expect(rows.filter((r) => r.business_date === day)).toHaveLength(1);
    expect(rows.find((r) => r.business_date === day)!.declared_amount).toBe('4500.00');
  });

  it('businessDate tomorrow → 422', async () => {
    const res = await declareCash(TECH_A.token, { businessDate: await businessDate(1), declaredAmount: '100' });
    expect(res.statusCode, res.body).toBe(422);
    expect(envelopeOf(res.statusCode, res.body).code).toBe('VALIDATION_FAILED');
    // No row was written for the refused day.
    const refusedDay = await businessDate(1);
    expect((await handoversOf(TECH_A.id)).some((r) => r.business_date === refusedDay)).toBe(false);
  });

  it(`businessDate ${BUSINESS_DATE_MAX_AGE_DAYS + 1} days ago → 422`, async () => {
    const res = await declareCash(TECH_A.token, {
      businessDate: await businessDate(-(BUSINESS_DATE_MAX_AGE_DAYS + 1)),
      declaredAmount: '100',
    });
    expect(res.statusCode, res.body).toBe(422);
    expect(envelopeOf(res.statusCode, res.body).code).toBe('VALIDATION_FAILED');
  });

  it(`businessDate ${BUSINESS_DATE_MAX_AGE_DAYS} days ago → accepted (the window is inclusive)`, async () => {
    const res = await declareCash(TECH_A.token, {
      businessDate: await businessDate(-BUSINESS_DATE_MAX_AGE_DAYS),
      declaredAmount: '750',
      note: 'basement job on Tuesday',
    });
    expect(res.statusCode, res.body).toBe(200);
    const handover = CashHandoverSchema.parse(res.json());
    expect(handover.businessDate).toBe(await businessDate(-BUSINESS_DATE_MAX_AGE_DAYS));
    expect(handover.note).toBe('basement job on Tuesday');
  });

  it('the owner cannot declare — his cash.declare create cell is `none` (he confirms, §5)', async () => {
    const res = await declareCash(OWNER.token, { businessDate: await businessDate(0), declaredAmount: '1' });
    expect(res.statusCode, res.body).toBe(403);
    expect(envelopeOf(res.statusCode, res.body).code).toBe('FORBIDDEN');
  });
});

describe('PATCH /v1/cash/handovers/:id — the correction path (§10)', () => {
  it('while submitted it succeeds, bumps the version, and writes an audit row carrying the previous amount', async () => {
    const day = await businessDate(-1);
    const created = await declareCash(TECH_A.token, { businessDate: day, declaredAmount: '4500' });
    expect(created.statusCode, created.body).toBe(200);
    const declared = CashHandoverSchema.parse(created.json());

    // The typo repair the brief describes: ₹4,500 declared for ₹45,000.
    const res = await amendCash(TECH_A.token, declared.id, declared.version, { declaredAmount: '45000' });
    expect(res.statusCode, res.body).toBe(200);

    const amended = CashHandoverSchema.parse(res.json());
    expect(amended.declaredAmount).toBe('45000.00');
    expect(amended.version).toBe(declared.version + 1);
    expect(amended.status).toBe('submitted');

    const row = (await handoversOf(TECH_A.id)).find((r) => r.id === declared.id)!;
    expect(row.declared_amount).toBe('45000.00');

    // The prior amount is in the audit trail, inside the same commit.
    const audit = await db.query<{
      action: string;
      employee_id: string;
      actor: string;
      details: Record<string, unknown>;
    }>(`SELECT action, employee_id, actor, details FROM audit_log ORDER BY id DESC LIMIT 1`);
    expect(audit.rows[0]!.action).toBe('cash.declaration.amended');
    expect(audit.rows[0]!.employee_id).toBe(TECH_A.id);
    expect(audit.rows[0]!.actor).toBe(TECH_A.id);
    expect(audit.rows[0]!.details).toMatchObject({
      handoverId: declared.id,
      businessDate: day,
      previousAmount: '4500.00',
      declaredAmount: '45000',
    });
  });

  it('after the owner confirms, the PATCH is refused 409 RECONCILIATION_CONFIRMED and the figure stands', async () => {
    const created = await declareCash(TECH_B.token, { businessDate: await businessDate(-2), declaredAmount: '3000' });
    const declared = CashHandoverSchema.parse(created.json());
    await signOff(declared.id, 'confirmed');

    const res = await amendCash(TECH_B.token, declared.id, declared.version, { declaredAmount: '3100' });
    expect(res.statusCode, res.body).toBe(409);
    expect(envelopeOf(res.statusCode, res.body).code).toBe('RECONCILIATION_CONFIRMED');

    // The refusal is real: the confirmed figure is unchanged.
    const row = (await handoversOf(TECH_B.id)).find((r) => r.id === declared.id)!;
    expect(row.declared_amount).toBe('3000.00');
    expect(row.status).toBe('confirmed');
  });

  it('after a dispute the PATCH is refused the same way — both signed-off statuses close the path', async () => {
    const created = await declareCash(TECH_B.token, { businessDate: await businessDate(-3), declaredAmount: '800' });
    const declared = CashHandoverSchema.parse(created.json());
    await signOff(declared.id, 'disputed');

    const res = await amendCash(TECH_B.token, declared.id, declared.version, { declaredAmount: '900' });
    expect(res.statusCode, res.body).toBe(409);
    expect(envelopeOf(res.statusCode, res.body).code).toBe('RECONCILIATION_CONFIRMED');
  });

  it('a stale If-Match is 409 VERSION_CONFLICT while the row is still correctable', async () => {
    const created = await declareCash(TECH_A.token, { businessDate: await businessDate(-4), declaredAmount: '500' });
    const declared = CashHandoverSchema.parse(created.json());
    const res = await amendCash(TECH_A.token, declared.id, declared.version + 5, { declaredAmount: '600' });
    expect(res.statusCode, res.body).toBe(409);
    expect(envelopeOf(res.statusCode, res.body).code).toBe('VERSION_CONFLICT');
  });

  it('a technician cannot amend another employee’s declaration', async () => {
    const created = await declareCash(SALES_REP.token, { businessDate: await businessDate(-5), declaredAmount: '4000' });
    const declared = CashHandoverSchema.parse(created.json());
    const res = await amendCash(TECH_B.token, declared.id, declared.version, { declaredAmount: '4100' });
    expect(res.statusCode, res.body).toBe(403);
    expect(envelopeOf(res.statusCode, res.body).code).toBe('OUT_OF_SCOPE');
  });
});

describe('GET /v1/cash/handovers/me — own history (§10)', () => {
  it('lists only the caller’s rows, newest day first', async () => {
    const mine = await handoversOf(TECH_A.id);
    expect(mine.length).toBeGreaterThan(0);
    const res = await myHandovers(TECH_A.token);
    expect(res.statusCode, res.body).toBe(200);

    const items = cashHandoverListResponseSchema.parse(res.json());
    expect(items.map((h) => h.id).sort()).toEqual(mine.map((r) => r.id).sort());
    const dates = items.map((h) => h.businessDate);
    expect([...dates].sort().reverse()).toEqual(dates);
  });

  it('response has no expected_cash key at all — key absence, not a null value', async () => {
    // A day with a submitted declaration and completions behind it still
    // must not carry the figure; the assertion is on the serialised body.
    const res = await myHandovers(TECH_A.token);
    expect(res.statusCode, res.body).toBe(200);
    const body = JSON.parse(res.body) as Array<Record<string, unknown>>;
    expect(body.length).toBeGreaterThan(0);
    for (const item of body) {
      expect(item).not.toHaveProperty('expected_cash');
      expect(item).not.toHaveProperty('expectedCash');
      expect(Object.keys(item)).toEqual(
        expect.arrayContaining(['id', 'businessDate', 'declaredAmount', 'status', 'declaredAt', 'version']),
      );
    }
    // …and the whole envelope, in case the leak grew a wrapper.
    expect(res.body).not.toContain('expected_cash');
    expect(res.body).not.toContain('expectedCash');
  });

  it('a technician cannot read another’s handovers', async () => {
    // TECH_B has rows of his own; none of them may surface in TECH_A's /me,
    // and there is no endpoint here that takes an employee id at all.
    const techBRows = await handoversOf(TECH_B.id);
    expect(techBRows.length).toBeGreaterThan(0);

    const asTechA = await myHandovers(TECH_A.token);
    expect(asTechA.statusCode, asTechA.body).toBe(200);
    const aItems = cashHandoverListResponseSchema.parse(asTechA.json());
    expect(aItems.map((h) => h.id)).not.toContain(techBRows[0]!.id);
    expect(aItems.map((h) => h.id).sort()).toEqual((await handoversOf(TECH_A.id)).map((r) => r.id).sort());

    // TECH_B reads his own — the rows exist and are his.
    const asTechB = await myHandovers(TECH_B.token);
    expect(asTechB.statusCode, asTechB.body).toBe(200);
    const bItems = cashHandoverListResponseSchema.parse(asTechB.json());
    expect(bItems.map((h) => h.id).sort()).toEqual(techBRows.map((r) => r.id).sort());
  });
});
