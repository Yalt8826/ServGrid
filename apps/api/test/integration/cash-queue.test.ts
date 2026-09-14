import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import type { FastifyInstance } from 'fastify';
import {
  cashQueueResponseSchema,
  cashQueueRowSchema,
  errorEnvelopeSchema,
  type CashQueueRow,
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
 * The owner's cash reconciliation queue (PHASE-4-OWNER.md T4.2,
 * PLAN-BACKEND.md §10, PLAN-DATA-MODEL.md §4). Runs against a scratch
 * database built from the real migrations and drives the endpoints over
 * HTTP — §14: no mocked database anywhere, and the thing under test is
 * precisely what a mock cannot be wrong about: the FULL OUTER JOIN that
 * supplies a `missing_submission` row from the expected-cash side alone,
 * and a default range that must include it.
 *
 * The two "Done when" boxes of the brief are the spine of this suite:
 * the default range (last 14 days ending YESTERDAY) is proven to include
 * a `missing_submission` day, and today's caption path is proven — the
 * response carries `today`, so the client can caption businessDate ===
 * today rows "still syncing" instead of letting the flags lie.
 */

function databaseUrl(): string {
  return process.env.DATABASE_URL ?? 'postgres://servgrid:servgrid@localhost:5432/servgrid';
}

function adminUrlFor(url: string): string {
  const parsed = new URL(url);
  parsed.pathname = '/postgres';
  return parsed.toString();
}

const SCRATCH_DB = 'servgrid_cash_queue_test';
const PASSWORD = 'cq-t42-plain-44';
const REOPEN_REASON = 'technician counted the bag again after the day was confirmed';

let admin: Pool;
let db: Pool;
let app: FastifyInstance;
let config: Config;

const OWNER = { username: '', id: '', token: '' };
/** A second owner with the flag left dark — `owner.cash` is asked of every caller. */
const OWNER_NOFLAG = { username: '', id: '', token: '' };
const TECH_A = { username: '', id: '', token: '' };
const SALES_REP = { username: '', id: '', token: '' };

async function seedEmployee(
  role: 'owner' | 'technician' | 'sales_rep',
  who: { username: string; id: string; token: string },
): Promise<void> {
  const username = `t42.${role}.${randomBytes(4).toString('hex')}`;
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

/** Business dates computed the way the view computes them — IST, not the CI machine's clock. */
async function bd(offsetDays: number): Promise<string> {
  const r = await db.query<{ d: string }>(
    `SELECT (business_date(now()) + $1::int)::text AS d`,
    [offsetDays],
  );
  return r.rows[0]!.d;
}

/** IST noon of a business date — unambiguously inside that day. */
function noonOf(date: string): string {
  return `${date}T12:00:00+05:30`;
}

let customerId = '';
let serviceId = '';
let companyId = '';
let jobSeq = 0;

/** A completed job + its cash-bearing completion — the expected-cash side of the join. */
async function seedCompletion(completedBy: string, date: string, cost: string): Promise<void> {
  jobSeq += 1;
  const jobId = (
    await db.query<{ id: string }>(
      `INSERT INTO job_cards (job_number, customer_id, service_id, title, status,
                              assigned_to, assigned_at, scheduled_for, closed_at)
       VALUES ($1, $2, $3, 'T42 queue job', 'completed', $4, $5, $5, $6)
       RETURNING id`,
      [
        `JC-T42-${jobSeq}-${randomBytes(3).toString('hex')}`,
        customerId,
        serviceId,
        completedBy,
        noonOf(date),
        noonOf(date),
      ],
    )
  ).rows[0]!.id;
  await db.query(
    `INSERT INTO job_completions
       (job_card_id, completed_by, completed_at, work_summary, cost, collection_mode)
     VALUES ($1, $2, $3, 'Replaced batteries', $4, 'cash')`,
    [jobId, completedBy, noonOf(date), cost],
  );
}

/** A declaration, written directly: the fixtures reach back past the
 * declare endpoint's 7-day window on purpose (the 30-day fixture). */
async function seedDeclaration(employeeId: string, date: string, amount: string): Promise<string> {
  return (
    await db.query<{ id: string }>(
      `INSERT INTO cash_reconciliations (employee_id, business_date, declared_amount, declared_at)
       VALUES ($1, $2::date, $3::numeric, $4) RETURNING id`,
      [employeeId, date, amount, noonOf(date)],
    )
  ).rows[0]!.id;
}

/** Rep cash arrives as a collected cash payment (PLAN-DATA-MODEL.md §4, payments side). */
async function seedCashPayment(receivedBy: string, date: string, amount: string): Promise<void> {
  await db.query(
    `INSERT INTO payments (payment_number, company_id, sales_card_id, amount, mode,
                           received_by, received_at, status)
     VALUES ($1, $2, NULL, $3::numeric, 'cash', $4, $5, 'collected')`,
    [`PM-T42-${randomBytes(4).toString('hex')}`, companyId, amount, receivedBy, noonOf(date)],
  );
}

function getQueue(token: string, query = '') {
  return app.inject({
    method: 'GET',
    url: `/v1/cash/queue${query}`,
    headers: { authorization: `Bearer ${token}` },
  });
}

interface QueueEnvelope {
  today: string;
  from: string;
  to: string;
  rows: CashQueueRow[];
}

async function queueFor(token: string, query = ''): Promise<QueueEnvelope> {
  const res = await app.inject({
    method: 'GET',
    url: `/v1/cash/queue${query}`,
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.statusCode, res.body).toBe(200);
  return cashQueueResponseSchema.parse(res.json()) as unknown as QueueEnvelope;
}

function ownerAction(
  token: string,
  action: 'confirm' | 'dispute' | 'reopen',
  declarationId: string,
  body: Record<string, unknown>,
) {
  return app.inject({
    method: 'POST',
    url: `/v1/cash/handovers/${declarationId}/${action}`,
    headers: { authorization: `Bearer ${token}`, 'x-client-source': 'web' },
    payload: body,
  });
}

function envelopeOf(status: number, body: string): ErrorEnvelope['error'] {
  expect(status).toBeGreaterThanOrEqual(400);
  const parsed = errorEnvelopeSchema.parse(JSON.parse(body)) as unknown as ErrorEnvelope;
  const error = parsed.error;
  expect(error.requestId).toMatch(ULID);
  return error;
}

async function declarationOf(id: string): Promise<{
  status: string;
  declared_amount: string;
  confirmed_amount: string | null;
  owner_note: string | null;
  confirmed_at: Date | null;
  reopen_reason: string | null;
  reopened_by: string | null;
}> {
  const r = await db.query<{
    status: string;
    declared_amount: string;
    confirmed_amount: string | null;
    owner_note: string | null;
    confirmed_at: Date | null;
    reopen_reason: string | null;
    reopened_by: string | null;
  }>(
    `SELECT status, declared_amount::text AS declared_amount, confirmed_amount::text AS confirmed_amount,
            owner_note, confirmed_at, reopen_reason, reopened_by
     FROM cash_reconciliations WHERE id = $1`,
    [id],
  );
  return r.rows[0]!;
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
  await seedEmployee('owner', OWNER_NOFLAG);
  await seedEmployee('technician', TECH_A);
  await seedEmployee('sales_rep', SALES_REP);

  // `owner.cash` rides enabled only for the first owner — the flag's own
  // on/off behaviour is this suite's subject; the matrix suite lights it
  // for its role probes the way it lights `sales.cash` for reps.
  await db.query(
    `INSERT INTO employee_flag_overrides (employee_id, flag, enabled)
     VALUES ($1, 'owner.cash', true)`,
    [OWNER.id],
  );

  customerId = (
    await db.query<{ id: string }>(
      `INSERT INTO customers (name, phone) VALUES ('T42 Customer', '9840000042') RETURNING id`,
    )
  ).rows[0]!.id;
  serviceId = (
    await db.query<{ id: string }>(
      `INSERT INTO services (code, name) VALUES ('T42-SVC', 'T42 suite service') RETURNING id`,
    )
  ).rows[0]!.id;
  companyId = (
    await db.query<{ id: string }>(`INSERT INTO companies (name) VALUES ('T42 Company') RETURNING id`)
  ).rows[0]!.id;

  // ── the 30-day fixture (business dates are IST, computed live) ──────────
  // TECH_A:
  //   today   expected 1200, no declaration — today, hidden by the default
  //   -1      expected 1000, declared 1000            → match
  //   -2      expected 2000, no declaration           → missing_submission (IN default)
  //   -3      expected  500, declared  700            → variance
  //   -20     expected  900, no declaration           → missing_submission (outside default)
  //   -25     no expected,   declared  400            → no_expected_cash
  // SALES_REP:
  //   -1      expected  300 (cash payment), declared 300 → match (a rep-day)
  await seedCompletion(TECH_A.id, await bd(0), '1200');
  await seedCompletion(TECH_A.id, await bd(-1), '1000');
  await seedDeclaration(TECH_A.id, await bd(-1), '1000');
  await seedCompletion(TECH_A.id, await bd(-2), '2000');
  await seedCompletion(TECH_A.id, await bd(-3), '500');
  await seedDeclaration(TECH_A.id, await bd(-3), '700');
  await seedCompletion(TECH_A.id, await bd(-20), '900');
  await seedDeclaration(TECH_A.id, await bd(-25), '400');
  await seedCashPayment(SALES_REP.id, await bd(-1), '300');
  await seedDeclaration(SALES_REP.id, await bd(-1), '300');
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

describe('GET /v1/cash/queue — the default range (T4.2)', () => {
  it('defaults to the last 14 days ending yesterday — never today', async () => {
    const body = await queueFor(OWNER.token);
    expect(body.to).toBe(await bd(-1));
    expect(body.from).toBe(await bd(-14));
    expect(body.today).toBe(await bd(0));
    // Every row is inside the range it announces.
    for (const row of body.rows) {
      expect(row.businessDate >= body.from).toBe(true);
      expect(row.businessDate <= body.to).toBe(true);
    }
  });

  it('the default range includes a missing_submission day — the row the feature exists for', async () => {
    // bd(-2): the technician collected ₹2,000 (a synced completion) and
    // never declared. The row exists on the expected-cash side ALONE —
    // a filter that drove off declared rows would hide it, which is the
    // "If it fails" clause of the brief.
    const body = await queueFor(OWNER.token);
    const missingDay = await bd(-2);
    const missing = body.rows.find((r) => r.businessDate === missingDay);
    expect(missing).toBeDefined();
    expect(missing!.flag).toBe('missing_submission');
    expect(missing!.expectedCash).toBe('2000.00');
    expect(missing!.declaredAmount).toBeNull();
    expect(missing!.declarationId).toBeNull();
    expect(missing!.status).toBeNull();
    expect(missing!.employeeId).toBe(TECH_A.id);
  });

  it('today stays reachable via an explicit filter, with today in the response for the "still syncing" caption', async () => {
    // By default today's row is absent — the flags lie on the current day.
    const def = await queueFor(OWNER.token);
    const today = await bd(0);
    expect(def.rows.some((r) => r.businessDate === today)).toBe(false);

    // One tap away: an explicit `to` reaches it.
    const body = await queueFor(OWNER.token, `?to=${today}`);
    expect(body.to).toBe(today);
    const todayRow = body.rows.find((r) => r.businessDate === today);
    expect(todayRow).toBeDefined();
    expect(todayRow!.flag).toBe('missing_submission');
    expect(todayRow!.expectedCash).toBe('1200.00');

    // The caption path: the response carries `today`, and the client
    // captions rows whose businessDate equals it "still syncing".
    expect(body.today).toBe(await bd(0));
    expect(todayRow!.businessDate).toBe(body.today);
  });

  it('missing_submission sorts first regardless of date, across a 30-day fixture', async () => {
    const from = await bd(-30);
    const to = await bd(-1);
    const body = await queueFor(OWNER.token, `?from=${from}&to=${to}`);

    // The whole 30-day fixture is in play, old flags included.
    const byDate = new Map(body.rows.map((r) => [r.businessDate, r]));
    expect(byDate.get(await bd(-20))?.flag).toBe('missing_submission');
    expect(byDate.get(await bd(-25))?.flag).toBe('no_expected_cash');

    // The 20-day-old missing_submission row sorts BEFORE yesterday's
    // healthy match, and before every non-missing row — the flag buckets
    // first, date only within a bucket.
    const firstMatch = body.rows.findIndex((r) => r.flag !== 'missing_submission');
    expect(firstMatch).toBeGreaterThan(0);
    expect(body.rows.slice(0, firstMatch).every((r) => r.flag === 'missing_submission')).toBe(true);
    expect(body.rows.slice(firstMatch).every((r) => r.flag !== 'missing_submission')).toBe(true);

    // Within the non-missing bucket: newest day first.
    const rest = body.rows.slice(firstMatch).map((r) => r.businessDate);
    expect([...rest].sort().reverse()).toEqual(rest);
  });

  it('filters by flag — and reads flag[]-style repeated keys too', async () => {
    const range = `&from=${await bd(-30)}&to=${await bd(-1)}`;
    const missing = await queueFor(OWNER.token, `?flag=missing_submission${range}`);
    expect(missing.rows.length).toBeGreaterThan(0);
    expect(missing.rows.every((r) => r.flag === 'missing_submission')).toBe(true);

    const bracketed = await app.inject({
      method: 'GET',
      url: `/v1/cash/queue?flag[]=variance${range}`,
      headers: { authorization: `Bearer ${OWNER.token}` },
    });
    expect(bracketed.statusCode, bracketed.body).toBe(200);
    const parsed = cashQueueResponseSchema.parse(bracketed.json()) as unknown as QueueEnvelope;
    expect(parsed.rows.every((r) => r.flag === 'variance')).toBe(true);
    expect(parsed.rows.map((r) => r.businessDate)).toEqual([await bd(-3)]);
  });

  it('a from after its to is a 422, not an inverted silent range', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/cash/queue?from=${await bd(-1)}&to=${await bd(-5)}`,
      headers: { authorization: `Bearer ${OWNER.token}` },
    });
    expect(res.statusCode, res.body).toBe(422);
    expect(envelopeOf(res.statusCode, res.body).code).toBe('VALIDATION_FAILED');
  });
});

describe('GET /v1/cash/queue — rep-days and technician-days (§3.7)', () => {
  it('a rep-day and a technician-day both appear on the same default view', async () => {
    const body = await queueFor(OWNER.token);
    const sharedDay = await bd(-1);
    const techDay = body.rows.find((r) => r.businessDate === sharedDay && r.role === 'technician');
    const repDay = body.rows.find((r) => r.businessDate === sharedDay && r.role === 'sales_rep');
    expect(techDay?.employeeId).toBe(TECH_A.id);
    expect(techDay?.flag).toBe('match');
    // The rep's expected cash came from the payments side (received_by),
    // not from a completion — keyed on employee, not technician.
    expect(repDay?.employeeId).toBe(SALES_REP.id);
    expect(repDay?.flag).toBe('match');
    expect(repDay?.expectedCash).toBe('300.00');
  });

  it('role filters the same rows — technician, then sales_rep', async () => {
    const techs = await queueFor(OWNER.token, `?role=technician`);
    expect(techs.rows.length).toBeGreaterThan(0);
    expect(techs.rows.every((r) => r.role === 'technician')).toBe(true);
    expect(techs.rows.some((r) => r.employeeId === SALES_REP.id)).toBe(false);

    const reps = await queueFor(OWNER.token, `?role=sales_rep`);
    expect(reps.rows.length).toBeGreaterThan(0);
    expect(reps.rows.every((r) => r.role === 'sales_rep')).toBe(true);
    expect(reps.rows.some((r) => r.employeeId === TECH_A.id)).toBe(false);
  });
});

describe('the flag — owner.cash asked of every caller (T0 rollback)', () => {
  it('an owner with the flag dark meets 409 FLAG_DISABLED, not the queue', async () => {
    const res = await getQueue(OWNER_NOFLAG.token);
    expect(res.statusCode, res.body).toBe(409);
    expect(envelopeOf(res.statusCode, res.body).code).toBe('FLAG_DISABLED');
  });

  it('the flag darkens the actions too', async () => {
    const id = await seedDeclaration(TECH_A.id, await bd(-16), '150');
    const res = await ownerAction(OWNER_NOFLAG.token, 'confirm', id, { confirmedAmount: '150' });
    expect(res.statusCode, res.body).toBe(409);
    expect(envelopeOf(res.statusCode, res.body).code).toBe('FLAG_DISABLED');
    expect((await declarationOf(id)).status).toBe('submitted');
  });
});

describe('POST /v1/cash/handovers/:id/dispute — the note is the point', () => {
  it('a dispute without a note is a 422 and writes nothing', async () => {
    const id = await seedDeclaration(TECH_A.id, await bd(-10), '150');
    for (const body of [{}, { ownerNote: '' }, { ownerNote: '   ' }, { note: 'wrong key' }]) {
      const res = await ownerAction(OWNER.token, 'dispute', id, body);
      expect(res.statusCode, JSON.stringify(body)).toBe(422);
      expect(envelopeOf(res.statusCode, res.body).code).toBe('VALIDATION_FAILED');
    }
    const row = await declarationOf(id);
    expect(row.status).toBe('submitted');
    expect(row.owner_note).toBeNull();
    expect(row.confirmed_at).toBeNull();
  });

  it('a dispute with a note lands: disputed, the note stored, who and when', async () => {
    const id = await seedDeclaration(TECH_A.id, await bd(-11), '260');
    const res = await ownerAction(OWNER.token, 'dispute', id, {
      ownerNote: 'figures do not match the completions',
    });
    expect(res.statusCode, res.body).toBe(200);
    const row = await declarationOf(id);
    expect(row.status).toBe('disputed');
    expect(row.owner_note).toBe('figures do not match the completions');
    expect(row.confirmed_at).not.toBeNull();
    expect(row.reopened_by).toBeNull();
  });
});

describe('POST /v1/cash/handovers/:id/confirm — both figures stored', () => {
  it('confirm with an amount differing from declared is allowed and stores both', async () => {
    // bd(-3): expected 500 (completion), declared 700, variance +200.
    // The owner confirms 650 — what was actually in the bag — and BOTH
    // figures stay: declared 700, confirmed 650.
    const from = await bd(-3);
    const body = await queueFor(OWNER.token, `?from=${from}&to=${from}`);
    const row = body.rows.find((r) => r.businessDate === from && r.employeeId === TECH_A.id);
    expect(row).toBeDefined();
    expect(row!.declarationId).toBeTruthy();
    expect(row!.variance).toBe('200.00');

    const res = await ownerAction(OWNER.token, 'confirm', row!.declarationId!, {
      confirmedAmount: '650',
    });
    expect(res.statusCode, res.body).toBe(200);

    const confirmed = cashQueueRowSchema.parse(res.json());
    expect(confirmed.status).toBe('confirmed');
    expect(confirmed.declaredAmount).toBe('700.00');
    expect(confirmed.expectedCash).toBe('500.00');
    // The view's variance still reads declared − expected; the owner's
    // figure lives in confirmed_amount, not by overwriting the declaration.
    expect(confirmed.variance).toBe('200.00');

    const stored = await declarationOf(row!.declarationId!);
    expect(stored.declared_amount).toBe('700.00');
    expect(stored.confirmed_amount).toBe('650.00');
    expect(stored.status).toBe('confirmed');
  });

  it('a day already answered is refused 409 — confirm is not an edit', async () => {
    const id = await seedDeclaration(TECH_A.id, await bd(-5), '90');
    const first = await ownerAction(OWNER.token, 'confirm', id, { confirmedAmount: '90' });
    expect(first.statusCode, first.body).toBe(200);
    const second = await ownerAction(OWNER.token, 'confirm', id, { confirmedAmount: '95' });
    expect(second.statusCode, second.body).toBe(409);
    expect(envelopeOf(second.statusCode, second.body).code).toBe('ILLEGAL_TRANSITION');
    expect((await declarationOf(id)).confirmed_amount).toBe('90.00');
  });

  it('an unknown declaration id is a 404', async () => {
    const res = await ownerAction(OWNER.token, 'confirm', randomUUID(), {
      confirmedAmount: '1',
    });
    expect(res.statusCode, res.body).toBe(404);
    expect(envelopeOf(res.statusCode, res.body).code).toBe('NOT_FOUND');
  });
});

describe('POST /v1/cash/handovers/:id/reopen — reversing the sign-off', () => {
  it('returns the row to submitted and writes an audit row carrying the reason', async () => {
    const id = await seedDeclaration(TECH_A.id, await bd(-6), '800');
    const confirmed = await ownerAction(OWNER.token, 'confirm', id, { confirmedAmount: '800' });
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    expect((await declarationOf(id)).status).toBe('confirmed');

    const res = await ownerAction(OWNER.token, 'reopen', id, { reason: REOPEN_REASON });
    expect(res.statusCode, res.body).toBe(200);

    // The row is back to submitted — the CHECK forces the confirmation
    // timestamp out with the status, and the sign-off's figures go too.
    const row = await declarationOf(id);
    expect(row.status).toBe('submitted');
    expect(row.confirmed_at).toBeNull();
    expect(row.confirmed_amount).toBeNull();
    expect(row.owner_note).toBeNull();
    expect(row.reopen_reason).toBe(REOPEN_REASON);
    expect(row.reopened_by).toBe(OWNER.id);

    // …and the response is the refreshed queue row, flag recomputed.
    const reopened = cashQueueRowSchema.parse(res.json());
    expect(reopened.status).toBe('submitted');
    expect(reopened.declaredAmount).toBe('800.00');

    // The audit row carries the reason — and what the reversal unwound.
    const audit = await db.query<{
      action: string;
      employee_id: string;
      actor: string;
      details: Record<string, unknown>;
    }>(`SELECT action, employee_id, actor, details FROM audit_log ORDER BY id DESC LIMIT 1`);
    expect(audit.rows[0]!.action).toBe('cash.reconciliation.reopened');
    expect(audit.rows[0]!.employee_id).toBe(TECH_A.id);
    expect(audit.rows[0]!.actor).toBe(OWNER.id);
    expect(audit.rows[0]!.details).toMatchObject({
      handoverId: id,
      previousStatus: 'confirmed',
      confirmedAmount: '800.00',
      reason: REOPEN_REASON,
    });
  });

  it('reopen from disputed works the same way, carrying the disputed note into the audit', async () => {
    const id = await seedDeclaration(TECH_A.id, await bd(-7), '140');
    const disputed = await ownerAction(OWNER.token, 'dispute', id, { ownerNote: 'short by a spanner' });
    expect(disputed.statusCode, disputed.body).toBe(200);

    const res = await ownerAction(OWNER.token, 'reopen', id, { reason: 'dispatcher found the sale' });
    expect(res.statusCode, res.body).toBe(200);
    expect((await declarationOf(id)).status).toBe('submitted');

    const audit = await db.query<{ details: Record<string, unknown> }>(
      `SELECT details FROM audit_log ORDER BY id DESC LIMIT 1`,
    );
    expect(audit.rows[0]!.details).toMatchObject({
      handoverId: id,
      previousStatus: 'disputed',
      ownerNote: 'short by a spanner',
      reason: 'dispatcher found the sale',
    });
  });

  it('a still-open (submitted) day has nothing to reverse — 409, the row untouched', async () => {
    const id = await seedDeclaration(TECH_A.id, await bd(-8), '55');
    const res = await ownerAction(OWNER.token, 'reopen', id, { reason: 'premature' });
    expect(res.statusCode, res.body).toBe(409);
    expect(envelopeOf(res.statusCode, res.body).code).toBe('ILLEGAL_TRANSITION');
    const row = await declarationOf(id);
    expect(row.status).toBe('submitted');
    expect(row.reopen_reason).toBeNull();
  });

  it('a reopen without a reason is a 422', async () => {
    const id = await seedDeclaration(TECH_A.id, await bd(-9), '65');
    await ownerAction(OWNER.token, 'confirm', id, { confirmedAmount: '65' });
    const res = await ownerAction(OWNER.token, 'reopen', id, {});
    expect(res.statusCode, res.body).toBe(422);
    expect(envelopeOf(res.statusCode, res.body).code).toBe('VALIDATION_FAILED');
    expect((await declarationOf(id)).status).toBe('confirmed');
  });
});

// ── T4.9 — "View the day": the completions and payments behind the figure ───

describe('GET /v1/cash/queue/day — the completions and payments behind the expected figure (T4.9)', () => {
  interface DayEnvelope {
    employeeId: string;
    employeeName: string;
    businessDate: string;
    completions: { jobId: string; jobNumber: string; amountCollected: string }[];
    cashPayments: { paymentId: string; paymentNumber: string; amount: string }[];
    completionTotal: string;
    paymentTotal: string;
  }

  function getDay(token: string, employeeId: string, date: string) {
    return app.inject({
      method: 'GET',
      url: `/v1/cash/queue/day?employeeId=${employeeId}&businessDate=${date}`,
      headers: { authorization: `Bearer ${token}` },
    });
  }

  it('returns the cash completions and cash payments of one employee-day, totals matching the queue row', async () => {
    const day = await bd(-10);
    // One completion (300) + one cash payment (250) for TECH_A on `day`;
    // the queue row's expected figure must be their sum, and the day
    // sheet's two side totals must reproduce it exactly.
    await seedCompletion(TECH_A.id, day, '300');
    await seedCashPayment(TECH_A.id, day, '250');

    const res = await getDay(OWNER.token, TECH_A.id, day);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json<DayEnvelope>();
    expect(body.employeeId).toBe(TECH_A.id);
    expect(body.businessDate).toBe(day);
    expect(body.completions).toHaveLength(1);
    expect(body.completions[0]!.amountCollected).toBe('300.00');
    expect(body.completions[0]!.jobNumber).toMatch(/^JC-/);
    expect(body.cashPayments).toHaveLength(1);
    expect(body.cashPayments[0]!.amount).toBe('250.00');
    expect(body.completionTotal).toBe('300.00');
    expect(body.paymentTotal).toBe('250.00');

    // The whole point: sheet total === queue figure, from the view itself.
    const body10 = await queueFor(OWNER.token, `?from=${day}&to=${day}`);
    const row = body10.rows.find((r) => r.businessDate === day && r.employeeId === TECH_A.id);
    expect(row).toBeDefined();
    expect(String(row!.expectedCash)).toBe('550.00');
  });

  it('another employee day and another mode money stay out', async () => {
    const day = await bd(-11);
    await seedCompletion(TECH_A.id, day, '400');
    // SALES_REP's cash on the SAME day, and TECH_A's UPI completion —
    // neither is behind TECH_A's expected figure for `day`.
    await seedCashPayment(SALES_REP.id, day, '900');
    jobSeq += 1;
    const upiJobId = (
      await db.query<{ id: string }>(
        `INSERT INTO job_cards (job_number, customer_id, service_id, title, status,
                                assigned_to, assigned_at, scheduled_for, closed_at)
         VALUES ($1, $2, $3, 'T42 upi job', 'completed', $4, $5, $5, $5)
         RETURNING id`,
        [
          `JC-T42-${jobSeq}-${randomBytes(3).toString('hex')}`,
          customerId,
          serviceId,
          TECH_A.id,
          noonOf(day),
        ],
      )
    ).rows[0]!.id;
    await db.query(
      `INSERT INTO job_completions
         (job_card_id, completed_by, completed_at, work_summary, cost, collection_mode)
       VALUES ($1, $2, $3, 'UPI job', '120', 'upi')`,
      [upiJobId, TECH_A.id, noonOf(day)],
    );

    const res = await getDay(OWNER.token, TECH_A.id, day);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json<DayEnvelope>();
    expect(body.completions).toHaveLength(1); // the UPI completion is not behind the cash figure
    expect(body.completionTotal).toBe('400.00');
    expect(body.cashPayments).toHaveLength(0); // the rep's cash is behind the REP's day, not TECH_A's
    expect(body.paymentTotal).toBe('0.00');
  });

  it('an unknown employee is a 404 — an empty sheet must not read as "a day with no cash"', async () => {
    const res = await getDay(OWNER.token, randomUUID(), await bd(-1));
    expect(res.statusCode, res.body).toBe(404);
    expect(envelopeOf(res.statusCode, res.body).code).toBe('NOT_FOUND');
  });

  it('a bad query is a 422, and the flag dark answers 409 like the queue read', async () => {
    const bad = await app.inject({
      method: 'GET',
      url: `/v1/cash/queue/day?employeeId=not-a-uuid&businessDate=${await bd(-1)}`,
      headers: { authorization: `Bearer ${OWNER.token}` },
    });
    expect(bad.statusCode).toBe(422);

    const dark = await getDay(OWNER_NOFLAG.token, TECH_A.id, await bd(-1));
    expect(dark.statusCode, dark.body).toBe(409);
    expect(envelopeOf(dark.statusCode, dark.body).code).toBe('FLAG_DISABLED');
  });
});
