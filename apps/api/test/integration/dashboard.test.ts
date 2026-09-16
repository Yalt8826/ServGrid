import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import type { FastifyInstance } from 'fastify';
import { errorEnvelopeSchema, type ErrorEnvelope, type LoginResponse } from '@servgrid/shared';
import { loadConfig, type Config } from '../../src/config.js';
import { closePool, getPool } from '../../src/db/pool.js';
import { runMigrations } from '../../src/db/migrate.js';
import { hashPassword } from '../../src/lib/password.js';
import { buildServer } from '../../src/server.js';
import { ULID, validEnv } from '../helpers/env.js';

/**
 * Owner dashboard (PHASE-4-OWNER.md T4.6, PLAN.md §8, UI/plan-2/07-OWNER.md
 * §O1). Runs against a scratch database built from the real migrations
 * (§14: no mocked database anywhere) and drives the two endpoints over
 * HTTP. The brief's assertions, in order:
 *
 * - each figure matches a hand-counted fixture — the expected numbers are
 *   written next to the seeds that produce them, not read back from the
 *   views under test;
 * - "today" is the IST business date, proven across a UTC midnight — a job
 *   scheduled 01:30 IST is 20:00 UTC the PREVIOUS day, and a completion on
 *   the 1st of the IST month at 01:30 sits in the previous UTC month; both
 *   must be counted by the IST reading this dashboard promises;
 * - attention rows arrive in consequence order, not by timestamp — the
 *   oldest, least-recently-touched money sorts first and a just-created
 *   job does not;
 * - every query reads a view — proven from the SQL text the process pool
 *   actually ran (captured around the two requests), which must contain
 *   each source view and not one direct `FROM job_cards`.
 */

function databaseUrl(): string {
  return process.env.DATABASE_URL ?? 'postgres://servgrid:servgrid@localhost:5432/servgrid';
}

function adminUrlFor(url: string): string {
  const parsed = new URL(url);
  parsed.pathname = '/postgres';
  return parsed.toString();
}

const SCRATCH_DB = 'servgrid_dashboard_test';
const PASSWORD = 'dash-plain-copier-17';

let admin: Pool;
let db: Pool;
let app: FastifyInstance;
let config: Config;

const OWNER = { username: '', id: '', token: '' };
const DISPATCHER = { username: '', id: '', token: '' };
const TECH_A = { username: '', id: '', token: '' };
const TECH_B = { username: '', id: '', token: '' };
const TECH_C = { username: '', id: '', token: '' };
const SALES_REP = { username: '', id: '', token: '' };

async function seedEmployee(
  role: 'owner' | 'dispatcher' | 'technician' | 'sales_rep',
  who: { username: string; id: string; token: string },
): Promise<void> {
  const username = `t46.${role}.${randomBytes(4).toString('hex')}`;
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

// ── IST helpers — every date in this suite comes from the database's own
// business_date(), never from the CI machine's clock ────────────────────────

/** Today's IST business date, as `YYYY-MM-DD`. */
async function istToday(): Promise<string> {
  const r = await db.query<{ d: string }>(`SELECT business_date(now())::text AS d`);
  return r.rows[0]!.d;
}

/**
 * The timestamptz of an IST wall-clock time on an IST business date —
 * `(date + time) AT TIME ZONE 'Asia/Kolkata'` reads the wall clock AS
 * Kolkata time, which is exactly how a technician's 01:30 becomes 20:00
 * UTC the previous day.
 */
async function istInstant(istDate: string, istTime: string): Promise<string> {
  const r = await db.query<{ ts: string }>(
    `SELECT (($1::date + $2::time) AT TIME ZONE 'Asia/Kolkata')::text AS ts`,
    [istDate, istTime],
  );
  return r.rows[0]!.ts;
}

async function istDateOffset(offsetDays: number): Promise<string> {
  const r = await db.query<{ d: string }>(
    `SELECT (business_date(now()) + $1::int)::text AS d`,
    [offsetDays],
  );
  return r.rows[0]!.d;
}

/** The first day of the current IST month. */
async function istMonthStart(): Promise<string> {
  const r = await db.query<{ d: string }>(
    `SELECT date_trunc('month', business_date(now()))::date::text AS d`,
  );
  return r.rows[0]!.d;
}

/** The Monday that starts the current IST (ISO) week. */
async function istWeekStart(): Promise<string> {
  const r = await db.query<{ d: string }>(
    `SELECT date_trunc('week', business_date(now()))::date::text AS d`,
  );
  return r.rows[0]!.d;
}

// ── seed helpers ───────────────────────────────────────────────────────────

let serviceId = '';
let customerId = '';

async function seedJob(opts: {
  status: 'unassigned' | 'assigned' | 'en_route' | 'in_progress' | 'completed' | 'cancelled';
  scheduledFor: string | null;
  assignedTo?: string;
  closedAt?: string | null;
}): Promise<string> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO job_cards (job_number, customer_id, service_id, title, status, assigned_to,
                            assigned_at, scheduled_for, closed_at)
     VALUES ($1, $2, $3, 'Dashboard fixture job', $4, $5, $6, $7, $8) RETURNING id`,
    [
      `JC-DASH-${randomBytes(6).toString('hex')}`,
      customerId,
      serviceId,
      opts.status,
      opts.status === 'unassigned' ? null : (opts.assignedTo ?? TECH_A.id),
      opts.status === 'unassigned' ? null : new Date().toISOString(),
      opts.scheduledFor,
      opts.closedAt ?? null,
    ],
  );
  return r.rows[0]!.id;
}

async function seedCompletion(opts: {
  jobId: string;
  completedBy: string;
  completedAt: string;
  cost: string;
  mode: 'cash' | 'upi';
}): Promise<void> {
  await db.query(
    `INSERT INTO job_completions
       (job_card_id, completed_by, completed_at, work_summary, cost, discount_amount, collection_mode)
     VALUES ($1, $2, $3, 'Replaced batteries, tested load.', $4, '0', $5)`,
    [opts.jobId, opts.completedBy, opts.completedAt, opts.cost, opts.mode],
  );
}

async function seedDeclaration(
  employeeId: string,
  businessDate: string,
  declaredAmount: string,
): Promise<void> {
  await db.query(
    `INSERT INTO cash_reconciliations (employee_id, business_date, declared_amount, declared_at)
     VALUES ($1, $2, $3, now())`,
    [employeeId, businessDate, declaredAmount],
  );
}

/** Sign one day's declaration off exactly as Phase 4's confirm/dispute will leave it. */
async function signOff(
  employeeId: string,
  businessDate: string,
  kind: 'confirmed' | 'disputed',
): Promise<void> {
  await db.query(
    `UPDATE cash_reconciliations
     SET status = $3::reconciliation_status,
         confirmed_amount = CASE WHEN $3::text = 'confirmed' THEN declared_amount ELSE NULL END,
         confirmed_by = $4,
         confirmed_at = now(),
         owner_note = CASE WHEN $3::text = 'disputed' THEN 'figures do not match' ELSE NULL END
     WHERE employee_id = $1 AND business_date = $2::date`,
    [employeeId, businessDate, kind, OWNER.id],
  );
}

async function seedCompany(name: string): Promise<string> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO companies (name) VALUES ($1) RETURNING id`,
    [name],
  );
  return r.rows[0]!.id;
}

async function seedSale(opts: {
  companyId: string;
  status: 'draft' | 'confirmed' | 'void';
  amount: string;
}): Promise<void> {
  const sale = await db.query<{ id: string }>(
    `INSERT INTO sales_cards (sale_number, company_id, sales_rep_id, sale_date, status,
                              confirmed_at, voided_at, voided_by, void_reason)
     VALUES ($1, $2, $3, business_date(now()), $4::sales_card_status,
             CASE WHEN $4::text <> 'draft' THEN now() END,
             CASE WHEN $4::text = 'void' THEN now() END,
             CASE WHEN $4::text = 'void' THEN $5::uuid END,
             CASE WHEN $4::text = 'void' THEN 'entered twice' END)
     RETURNING id`,
    [
      opts.status === 'draft' ? null : `SC-DASH-${randomBytes(5).toString('hex')}`,
      opts.companyId,
      SALES_REP.id,
      opts.status,
      OWNER.id,
    ],
  );
  await db.query(
    `INSERT INTO sales_card_items (sales_card_id, line_no, product_name, quantity, unit_price)
     VALUES ($1, 1, 'Dashboard fixture sale', 1, $2)`,
    [sale.rows[0]!.id, opts.amount],
  );
}

async function seedPayment(companyId: string, amount: string): Promise<void> {
  await db.query(
    `INSERT INTO payments (payment_number, company_id, amount, mode, received_by, received_at, status)
     VALUES ($1, $2, $3, 'upi', $4, now(), 'collected')`,
    [`PM-DASH-${randomBytes(5).toString('hex')}`, companyId, amount, SALES_REP.id],
  );
}

/**
 * A tracked handset for `who` with the given permission, and optionally a
 * last ping `ageInterval` old. The login already created a device row
 * (location_permission 'none'); this makes THAT one the tracked one rather
 * than stacking a newer install on top of it.
 */
async function seedDevice(
  who: { id: string },
  permission: 'none' | 'foreground' | 'background',
  ageInterval: string | null,
): Promise<void> {
  await db.query(
    `UPDATE devices SET location_permission = $2::device_location_permission WHERE employee_id = $1`,
    [who.id, permission],
  );
  if (ageInterval !== null) {
    const dev = await db.query<{ id: string }>(`SELECT id FROM devices WHERE employee_id = $1`, [
      who.id,
    ]);
    await db.query(
      `INSERT INTO location_pings (employee_id, device_id, recorded_at, latitude, longitude, source)
       VALUES ($1, $2, now() - $3::interval, 12.9716, 77.5946, 'scheduled')`,
      [who.id, dev.rows[0]!.id, ageInterval],
    );
  }
}

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

function envelopeOf(status: number, body: string): ErrorEnvelope['error'] {
  expect(status).toBeGreaterThanOrEqual(400);
  const parsed = errorEnvelopeSchema.parse(JSON.parse(body)) as unknown as ErrorEnvelope;
  expect(parsed.error.requestId).toMatch(ULID);
  return parsed.error;
}

function getDashboard(who: { token: string }) {
  return app.inject({ method: 'GET', url: '/v1/dashboard/owner', headers: bearer(who.token) });
}

function getAttention(who: { token: string }) {
  return app.inject({
    method: 'GET',
    url: '/v1/dashboard/owner/attention',
    headers: bearer(who.token),
  });
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

  await seedEmployee('owner', OWNER);
  await seedEmployee('dispatcher', DISPATCHER);
  await seedEmployee('technician', TECH_A);
  await seedEmployee('technician', TECH_B);
  await seedEmployee('technician', TECH_C);
  await seedEmployee('sales_rep', SALES_REP);

  const svc = await db.query<{ id: string }>(
    `INSERT INTO services (code, name) VALUES ('DASH-SVC', 'Dashboard suite service') RETURNING id`,
  );
  serviceId = svc.rows[0]!.id;
  const cust = await db.query<{ id: string }>(
    `INSERT INTO customers (name, phone)
     VALUES ('Dashboard Fixture Customer', '080 4000 1234') RETURNING id`,
  );
  customerId = cust.rows[0]!.id;

  // Tracking fixtures: A and the rep are healthy; B has not pinged in two
  // hours (stale); C never got background permission (permission_missing).
  await seedDevice(TECH_A, 'background', '5 minutes');
  await seedDevice(TECH_B, 'background', '2 hours');
  await seedDevice(TECH_C, 'foreground', null);
  await seedDevice(SALES_REP, 'background', '5 minutes');
});

afterAll(async () => {
  await app?.close();
  await db?.end();
  await closePool();
  if (admin) {
    await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
    await admin.end();
  }
});

describe('GET /v1/dashboard/owner — the door', () => {
  it('answers the owner', async () => {
    const res = await getDashboard(OWNER);
    expect(res.statusCode, res.body).toBe(200);
  });

  it('answers nobody else — the cash.confirm read cell is the owner’s alone', async () => {
    for (const who of [DISPATCHER, TECH_A, SALES_REP]) {
      const res = await getDashboard(who);
      expect(res.statusCode, res.body).toBe(403);
      expect(envelopeOf(res.statusCode, res.body).code).toBe('FORBIDDEN');
    }
    const anon = await app.inject({ method: 'GET', url: '/v1/dashboard/owner' });
    expect(anon.statusCode).toBe(401);
    expect(envelopeOf(anon.statusCode, anon.body).code).toBe('UNAUTHENTICATED');

    const attentionForbidden = await getAttention(TECH_B);
    expect(attentionForbidden.statusCode, attentionForbidden.body).toBe(403);
    expect(envelopeOf(attentionForbidden.statusCode, attentionForbidden.body).code).toBe('FORBIDDEN');
    const attentionAnon = await app.inject({ method: 'GET', url: '/v1/dashboard/owner/attention' });
    expect(attentionAnon.statusCode).toBe(401);
  });
});

describe('GET /v1/dashboard/owner — the four figures against hand counts', () => {
  let today = '';
  let monthStart = '';

  beforeAll(async () => {
    today = await istToday();
    monthStart = await istMonthStart();

    // ── Figure 1 — today's open board: 2 unassigned · 1 assigned ·
    // 1 en_route · 2 in_progress. The 01:30 IST job is 20:00 UTC YESTERDAY.
    await seedJob({ status: 'unassigned', scheduledFor: await istInstant(today, '01:30') });
    await seedJob({ status: 'unassigned', scheduledFor: await istInstant(today, '12:00') });
    await seedJob({ status: 'assigned', scheduledFor: await istInstant(today, '09:00') });
    await seedJob({ status: 'en_route', scheduledFor: await istInstant(today, '10:00') });
    await seedJob({
      status: 'in_progress',
      scheduledFor: await istInstant(today, '08:00'),
      assignedTo: TECH_B.id,
    });
    await seedJob({
      status: 'in_progress',
      scheduledFor: await istInstant(today, '15:00'),
      assignedTo: TECH_B.id,
    });

    // ── Open in the past — overdue, so NOT in today's figure; they feed
    // the attention feed's rank 3 instead.
    await seedJob({
      status: 'assigned',
      scheduledFor: await istInstant(await istDateOffset(-5), '09:00'),
    });
    await seedJob({
      status: 'en_route',
      scheduledFor: await istInstant(await istDateOffset(-1), '09:00'),
      assignedTo: TECH_B.id,
    });

    // ── Terminal today — excluded from the open board.
    await seedJob({
      status: 'completed',
      scheduledFor: await istInstant(today, '11:00'),
      closedAt: await istInstant(today, '13:00'),
    });
    await seedJob({
      status: 'cancelled',
      scheduledFor: await istInstant(today, '11:30'),
      closedAt: await istInstant(today, '12:00'),
    });

    // ── Figure 3 — completions. The month-1st 01:30 IST row is the
    // previous month's last day in UTC; a UTC current_date implementation
    // would drop it from month-to-date. The prev-month row must stay out.
    const cashToday = await seedJob({
      status: 'completed',
      scheduledFor: await istInstant(today, '08:00'),
      closedAt: await istInstant(today, '12:10'),
    });
    await seedCompletion({
      jobId: cashToday,
      completedBy: TECH_A.id,
      completedAt: await istInstant(today, '01:30'),
      cost: '4500.00',
      mode: 'cash',
    });

    const upiToday = await seedJob({
      status: 'completed',
      scheduledFor: await istInstant(today, '14:00'),
      closedAt: await istInstant(today, '16:00'),
    });
    await seedCompletion({
      jobId: upiToday,
      completedBy: TECH_A.id,
      completedAt: await istInstant(today, '14:00'),
      cost: '1000.00',
      mode: 'upi',
    });

    const cashMonthStart = await seedJob({
      status: 'completed',
      scheduledFor: await istInstant(monthStart, '10:00'),
      closedAt: await istInstant(monthStart, '12:00'),
    });
    await seedCompletion({
      jobId: cashMonthStart,
      completedBy: TECH_A.id,
      completedAt: await istInstant(monthStart, '01:30'),
      cost: '2000.00',
      mode: 'cash',
    });

    const prevMonthLastDay = (
      await db.query<{ d: string }>(
        `SELECT (date_trunc('month', business_date(now()))::date - 1)::text AS d`,
      )
    ).rows[0]!.d;
    const upiPrevMonth = await seedJob({
      status: 'completed',
      scheduledFor: await istInstant(prevMonthLastDay, '10:00'),
      closedAt: await istInstant(prevMonthLastDay, '23:30'),
    });
    await seedCompletion({
      jobId: upiPrevMonth,
      completedBy: TECH_B.id,
      completedAt: await istInstant(prevMonthLastDay, '23:30'),
      cost: '9999.00',
      mode: 'upi',
    });

    // ── Figure 2 — declarations against the cash the completions above put
    // on the books. Expected cash: TECH_A ₹4500 today (+ ₹2000 on the month
    // 1st, + ₹500 in the previous month), TECH_B ₹8000 today and ₹3000
    // today−3. Awaiting confirmation = SUBMITTED declarations only:
    // 8000 + 2500.
    const varianceDay = await istDateOffset(-3);
    const varianceJob = await seedJob({
      status: 'completed',
      scheduledFor: await istInstant(varianceDay, '08:00'),
      closedAt: await istInstant(varianceDay, '17:00'),
    });
    await seedCompletion({
      jobId: varianceJob,
      completedBy: TECH_B.id,
      completedAt: await istInstant(varianceDay, '10:00'),
      cost: '3000.00',
      mode: 'cash',
    });

    const techBTodayJob = await seedJob({
      status: 'completed',
      scheduledFor: await istInstant(today, '09:00'),
      closedAt: await istInstant(today, '12:30'),
    });
    await seedCompletion({
      jobId: techBTodayJob,
      completedBy: TECH_B.id,
      completedAt: await istInstant(today, '12:30'),
      cost: '8000.00',
      mode: 'cash',
    });

    // The previous month's last day again — guaranteed OUT of month-to-date
    // and in some earlier week bucket — carrying the OLDEST un-declared
    // money for the attention feed's first rank.
    const lastMondayJob = await seedJob({
      status: 'completed',
      scheduledFor: await istInstant(prevMonthLastDay, '09:00'),
      closedAt: await istInstant(prevMonthLastDay, '11:00'),
    });
    await seedCompletion({
      jobId: lastMondayJob,
      completedBy: TECH_A.id,
      completedAt: await istInstant(prevMonthLastDay, '12:00'),
      cost: '500.00',
      mode: 'cash',
    });

    await seedDeclaration(TECH_B.id, today, '8000.00'); // submitted → awaiting
    await seedDeclaration(TECH_B.id, varianceDay, '2500.00'); // variance, submitted → awaiting
    await seedDeclaration(TECH_A.id, await istDateOffset(-1), '100.00'); // no_expected_cash
    await signOff(TECH_A.id, await istDateOffset(-1), 'confirmed'); // → excluded from awaiting
    await seedDeclaration(TECH_B.id, await istDateOffset(-2), '50.00');
    await signOff(TECH_B.id, await istDateOffset(-2), 'disputed'); // → excluded from awaiting

    // ── Figure 4 — company balances. Positive balances only.
    const coX = await seedCompany('Dues Fixture X');
    const coY = await seedCompany('Dues Fixture Y');
    const coZ = await seedCompany('Dues Fixture Z (credit)');
    const coW = await seedCompany('Dues Fixture W (draft)');
    const coV = await seedCompany('Dues Fixture V (void)');
    await seedSale({ companyId: coX, status: 'confirmed', amount: '5000.00' });
    await seedPayment(coX, '2000.00'); // balance 3000
    await seedSale({ companyId: coY, status: 'confirmed', amount: '1200.00' }); // 1200
    await seedSale({ companyId: coZ, status: 'confirmed', amount: '1000.00' });
    await seedPayment(coZ, '1500.00'); // overpaid → −500 credit, NOT a due
    await seedSale({ companyId: coW, status: 'draft', amount: '7000.00' }); // not money yet
    await seedSale({ companyId: coV, status: 'void', amount: '8888.00' }); // a reversal
  });

  it('figure 1 — open jobs by status today, exact', async () => {
    const res = await getDashboard(OWNER);
    expect(res.statusCode, res.body).toBe(200);
    const body = JSON.parse(res.body) as { openJobsByStatusToday: Record<string, number> };
    expect(body.openJobsByStatusToday).toEqual({
      unassigned: 2,
      assigned: 1,
      enRoute: 1,
      inProgress: 2,
    });
  });

  it('figure 2 — cash awaiting confirmation, exact', async () => {
    const res = await getDashboard(OWNER);
    const body = JSON.parse(res.body) as { cashAwaitingConfirmation: string };
    expect(body.cashAwaitingConfirmation).toBe('10500.00');
  });

  it('figure 3 — month-to-date revenue, exact, on the IST month', async () => {
    const res = await getDashboard(OWNER);
    const body = JSON.parse(res.body) as { monthToDateRevenue: string };
    // 4500 + 1000 + 2000 (today and the month 1st) + 8000 + 3000 (TECH_B's
    // today and today−3 completions — also this month). The ₹2000 was
    // collected 01:30 IST on the 1st — 20:00 UTC of the PREVIOUS month's
    // last day — so this figure can only be right if the month is the IST
    // one; the ₹9999 and ₹500 from the previous month must stay out.
    expect(body.monthToDateRevenue).toBe('18500.00');
  });

  it('figure 4 — outstanding company dues, credits and unconfirmed sales excluded', async () => {
    const res = await getDashboard(OWNER);
    const body = JSON.parse(res.body) as { outstandingCompanyDues: string };
    expect(body.outstandingCompanyDues).toBe('4200.00');
  });

  it('figure 1 — "today" is the IST day across a UTC midnight', async () => {
    // The 01:30 IST job was scheduled at 20:00 UTC the previous day; under
    // a UTC current_date reading it would fall on "yesterday" and the
    // unassigned count would be 1. The IST count is 2.
    const res = await getDashboard(OWNER);
    const body = JSON.parse(res.body) as { openJobsByStatusToday: Record<string, number> };
    expect(body.openJobsByStatusToday.unassigned).toBe(2);

    // …and the row itself carries the IST business date, not the UTC date.
    const q = await db.query<{ scheduled_date: string }>(
      `SELECT scheduled_date::text FROM v_job_cards_dispatcher
       WHERE scheduled_for = $1`,
      [await istInstant(today, '01:30')],
    );
    expect(q.rows[0]!.scheduled_date).toBe(today);
  });

  describe('the two charts', () => {
    async function dashboardOf(): Promise<{
      jobsPerDay: Array<{ date: string; jobs: number }>;
      revenuePerWeek: Array<{ weekStart: string; revenue: string }>;
    }> {
      const res = await getDashboard(OWNER);
      expect(res.statusCode, res.body).toBe(200);
      return JSON.parse(res.body);
    }

    it('jobs per day — 30 buckets ending today, empty days present as 0, counts exact', async () => {
      const body = await dashboardOf();
      expect(body.jobsPerDay).toHaveLength(30);
      expect(body.jobsPerDay[29]!.date).toBe(today);
      expect(body.jobsPerDay[0]!.date).toBe(await istDateOffset(-29));

      // The hand count: jobs per scheduled IST day, straight off the seeds.
      const expected = await db.query<{ d: string; n: string }>(
        `SELECT scheduled_date::text AS d, count(*)::text AS n
         FROM v_job_cards_dispatcher
         WHERE scheduled_date > business_date(now()) - 30
         GROUP BY scheduled_date ORDER BY scheduled_date`,
      );
      const expectedMap = new Map(expected.rows.map((r) => [r.d, Number(r.n)]));
      for (const point of body.jobsPerDay) {
        expect(point.jobs).toBe(expectedMap.get(point.date) ?? 0);
      }
      // The buckets are not all zero, and today carries the seeded board.
      expect(body.jobsPerDay.some((p) => p.jobs > 0)).toBe(true);
      expect(expectedMap.get(today)).toBeGreaterThanOrEqual(8);
    });

    it('revenue per week — 12 buckets ending the current ISO week, sums exact', async () => {
      const body = await dashboardOf();
      expect(body.revenuePerWeek).toHaveLength(12);
      const weekStart = await istWeekStart();
      expect(body.revenuePerWeek[11]!.weekStart).toBe(weekStart);
      expect(body.revenuePerWeek[0]!.weekStart).toBe(
        (
          await db.query<{ d: string }>(
            `SELECT (date_trunc('week', business_date(now()))::date - 77)::text AS d`,
          )
        ).rows[0]!.d,
      );

      // The hand count: completions per IST ISO week over the seeded set.
      const expected = await db.query<{ w: string; total: string }>(
        `SELECT date_trunc('week', business_date)::date::text AS w,
                COALESCE(SUM(amount_collected), 0)::text AS total
         FROM job_completions
         WHERE business_date >= date_trunc('week', business_date(now()))::date - 77
         GROUP BY 1 ORDER BY 1`,
      );
      const expectedMap = new Map(expected.rows.map((r) => [r.w, r.total]));
      for (const point of body.revenuePerWeek) {
        expect(point.revenue).toBe(expectedMap.get(point.weekStart) ?? '0.00');
      }
      // The current week holds today's ₹4500 and ₹1000 — and, when the 1st
      // of the month falls in it, the ₹2000 as well.
      expect(Number(body.revenuePerWeek[11]!.revenue)).toBeGreaterThanOrEqual(5500);
    });
  });
});

describe('GET /v1/dashboard/owner/attention — ordered by consequence, not recency', () => {
  it('ranks missing_submission, variance, overdue, tracking — in that order', async () => {
    const res = await getAttention(OWNER);
    expect(res.statusCode, res.body).toBe(200);
    const body = JSON.parse(res.body) as {
      items: Array<{
        category: string;
        businessDate: string | null;
        expectedCash: string | null;
        declaredAmount: string | null;
        variance: string | null;
        jobNumber: string | null;
        scheduledDate: string | null;
        customerName: string | null;
        health: string | null;
        lastPingAt: string | null;
      }>;
    };

    expect(body.items.length).toBeGreaterThan(0);
    // Rank 5 (contract_ending) joins when an in-window AMC exists; this
    // fixture seeds none, so the feed ends at tracking health — and today's
    // seeds make every live rank present.
    const distinctInOrder = [...new Set(body.items.map((i) => i.category))];
    expect(distinctInOrder).toEqual([
      'missing_submission',
      'cash_variance',
      'overdue_job',
      'tracking_health',
    ]);

    // NOT recency: every seeded row was created seconds ago, yet the feed
    // opens with the OLDEST un-declared money, not the newest card.
    const missingDates = body.items
      .filter((i) => i.category === 'missing_submission')
      .map((i) => i.businessDate);
    // TECH_A's previous-month ₹500, the month-1st ₹2000 and today's ₹4500
    // (the first two merge into one day if the month starts on that Monday
    // — the queue is per person per day): at least two distinct days, and
    // strictly oldest first.
    expect(missingDates.length).toBeGreaterThanOrEqual(2);
    expect([...missingDates].sort()).toEqual(missingDates);

    // The variance row: TECH_B declared ₹2500 for ₹3000, three days ago.
    const variance = body.items.find((i) => i.category === 'cash_variance')!;
    expect(variance.expectedCash).toBe('3000.00');
    expect(variance.declaredAmount).toBe('2500.00');
    expect(variance.variance).toBe('-500.00');

    // The overdue rows: the today−5 promise before yesterday's, and each
    // links straight to the thing.
    const overdue = body.items.filter((i) => i.category === 'overdue_job');
    expect(overdue).toHaveLength(2);
    expect(overdue[0]!.scheduledDate! < overdue[1]!.scheduledDate!).toBe(true);
    expect(overdue[0]!.jobNumber).toMatch(/^JC-DASH-/);
    expect(overdue[0]!.customerName).toBe('Dashboard Fixture Customer');

    // Tracking: the un-permitted handset outranks the merely quiet one,
    // and `never_reported` is deliberately absent (§O1's two, not four).
    const tracking = body.items.filter((i) => i.category === 'tracking_health');
    expect(tracking.map((t) => t.health)).toEqual(['permission_missing', 'stale']);
    expect(tracking[1]!.lastPingAt).not.toBeNull();
  });

  it('a confirmed day leaves the feed rather than moving within it — and the figure follows', async () => {
    // Confirm TECH_B's variance day the way T4.2's confirm will: the row
    // leaves rank 2 entirely, and awaiting confirmation drops by ₹2500.
    await signOff(TECH_B.id, await istDateOffset(-3), 'confirmed');

    const attention = await getAttention(OWNER);
    const body = JSON.parse(attention.body) as { items: Array<{ category: string }> };
    expect(body.items.some((i) => i.category === 'cash_variance')).toBe(false);
    const distinct = [...new Set(body.items.map((i) => i.category))];
    expect(distinct).toEqual(['missing_submission', 'overdue_job', 'tracking_health']);

    const dashboard = await getDashboard(OWNER);
    const figures = JSON.parse(dashboard.body) as { cashAwaitingConfirmation: string };
    expect(figures.cashAwaitingConfirmation).toBe('8000.00');
  });
});

describe('attention rank 5 — contract_ending (decision 7: the warning is 7 days)', () => {
  it('AMCs ending within 7 days appear after every tracking row, ordered by days left', async () => {
    // Four AMCs across four sites: one ending in 2 days, one in 6, one in
    // 9 (outside the window), one cancelled (excluded whatever its dates).
    const names = ['T2B3 AMC site A', 'T2B3 AMC site B', 'T2B3 AMC site C', 'T2B3 AMC site D'];
    const customerIds: string[] = [];
    for (const name of names) {
      customerIds.push(
        (
          await db.query<{ id: string }>(
            `INSERT INTO customers (name, phone) VALUES ($1, $2) RETURNING id`,
            [name, `9840${randomBytes(3).toString('hex')}`],
          )
        ).rows[0]!.id,
      );
    }
    const amcRows: Array<{ id: string; customerId: string; end: string; cancelled: boolean }> = [];
    for (const [i, [customerIdI, endDays, cancelled]] of [
      [customerIds[0]!, 2, false],
      [customerIds[1]!, 6, false],
      [customerIds[2]!, 9, false],
      [customerIds[3]!, 3, true],
    ].entries()) {
      const end = await istDateOffset(endDays as number);
      const start = await istDateOffset(-30);
      amcRows.push({
        id: (
          await db.query<{ id: string }>(
            `INSERT INTO service_contracts
               (contract_number, customer_id, start_date, end_date, contract_value, created_by,
                cancelled_at, cancelled_by, cancel_reason)
             VALUES ($1, $2, $3::date, $4::date, '8000.00', $5, $6, $7, $8) RETURNING id`,
            [
              `AMC-DASH-${i}-${randomBytes(3).toString('hex')}`,
              customerIdI,
              start,
              end,
              OWNER.id,
              cancelled ? new Date().toISOString() : null,
              cancelled ? OWNER.id : null,
              cancelled ? 'wrong site' : null,
            ],
          )
        ).rows[0]!.id,
        customerId: customerIdI as string,
        end: end as string,
        cancelled: cancelled as boolean,
      });
    }

    const res = await getAttention(OWNER);
    expect(res.statusCode, res.body).toBe(200);
    const body = JSON.parse(res.body) as {
      items: Array<{
        category: string;
        contractId: string | null;
        contractNumber: string | null;
        contractEndDate: string | null;
        customerName: string | null;
      }>;
    };

    // Rank 5 sits BELOW every tracking-health row — the whole rank order,
    // still "ordered by consequence, not recency".
    const lastTracking = body.items.map((i) => i.category).lastIndexOf('tracking_health');
    const firstContract = body.items.findIndex((i) => i.category === 'contract_ending');
    expect(lastTracking).toBeGreaterThanOrEqual(0);
    expect(firstContract).toBeGreaterThan(lastTracking);

    // Exactly the two in-window AMCs, soonest end first.
    const ending = body.items.filter((i) => i.category === 'contract_ending');
    expect(ending).toHaveLength(2);
    expect(ending[0]!.contractEndDate! < ending[1]!.contractEndDate!).toBe(true);
    expect(ending[0]!.customerName).toBe('T2B3 AMC site A'); // ends in 2 days
    expect(ending[1]!.customerName).toBe('T2B3 AMC site B'); // ends in 6 days

    // Each row names the AMC to open — id, number and end — nothing else.
    const byCustomer = new Map(ending.map((i) => [i.customerName, i]));
    const siteA = byCustomer.get('T2B3 AMC site A')!;
    expect(siteA.contractId).toBe(amcRows.find((r) => r.customerId === customerIds[0])!.id);
    expect(siteA.contractNumber).toMatch(/^AMC-DASH-0-/);
    expect(siteA.contractEndDate).toBe(amcRows.find((r) => r.customerId === customerIds[0])!.end);

    // Out of the window (9 days) or cancelled: absent, however close.
    expect(body.items.some((i) => i.customerName === 'T2B3 AMC site C')).toBe(false);
    expect(body.items.some((i) => i.customerName === 'T2B3 AMC site D')).toBe(false);
  });
});

describe('every query reads a view — proven from the SQL the pool actually ran', () => {
  it('no dashboard query selects from job_cards (or any base cash/location table) directly', async () => {
    const pool = getPool();
    const captured: string[] = [];
    const original = pool.query.bind(pool);
    // The GETs carry no Idempotency-Key, so they run on the pool itself —
    // patching the instance captures every statement the two requests issue.
    (pool as unknown as { query: unknown }).query = (text: unknown, values?: unknown[]) => {
      captured.push(typeof text === 'string' ? text : String((text as { text?: string })?.text));
      return original(text as string, values);
    };

    try {
      const dashboard = await getDashboard(OWNER);
      expect(dashboard.statusCode, dashboard.body).toBe(200);
      const attention = await getAttention(OWNER);
      expect(attention.statusCode, attention.body).toBe(200);
    } finally {
      (pool as unknown as { query: unknown }).query = original;
    }

    expect(captured.length).toBeGreaterThan(0);

    // Not one statement touches job_cards (the brief's assertion), nor the
    // declaration and location tables the views exist to stand in for.
    const sql = captured.join('\n');
    expect(sql).not.toMatch(/\b(?:FROM|JOIN)\s+job_cards\b/i);
    expect(sql).not.toMatch(/\b(?:FROM|JOIN)\s+cash_reconciliations\b/i);
    expect(sql).not.toMatch(/\b(?:FROM|JOIN)\s+location_pings\b/i);
    expect(sql).not.toMatch(/\b(?:FROM|JOIN)\s+location_requests\b/i);

    // …and every figure's named source is genuinely in the run.
    expect(sql).toMatch(/FROM\s+v_job_cards_dispatcher/i);
    expect(sql).toMatch(/FROM\s+v_cash_reconciliation_queue/i);
    expect(sql).toMatch(/FROM\s+v_company_balances/i);
    expect(sql).toMatch(/FROM\s+job_completions/i);
    expect(sql).toMatch(/FROM\s+v_employee_tracking_health/i);
  });
});

// ── OW.3: the four performance charts ──────────────────────────────────────

/**
 * `GET /v1/dashboard/owner/performance` — revenue collected and jobs
 * closed per technician, sales value and count per rep, over one range
 * (owner's decisions, 2026-09-16).
 *
 * The probes seed their OWN people, so the numbers are exact rather than
 * "at least": this file's other fixtures put completions and sales on the
 * same days, and an assertion that tolerated them would pass while the
 * grouping was wrong.
 */
function getPerformance(who: { token: string }, range: 'week' | '30d' | '90d' = 'week') {
  return app.inject({
    method: 'GET',
    url: `/v1/dashboard/owner/performance?range=${range}`,
    headers: bearer(who.token),
  });
}

interface PerfBody {
  range: { key: string; from: string; to: string };
  days: string[];
  technicians: { id: string; name: string }[];
  reps: { id: string; name: string }[];
  technicianRevenue: { date: string; employeeId: string; value: string }[];
  technicianJobs: { date: string; employeeId: string; count: number }[];
  repSalesValue: { date: string; employeeId: string; value: string }[];
  repSalesCount: { date: string; employeeId: string; count: number }[];
}

const PERF_TECH = { username: '', id: '', token: '' };
const PERF_REP = { username: '', id: '', token: '' };

describe('GET /v1/dashboard/owner/performance — the owner’s four charts', () => {
  let perfCompany = '';
  let today = '';

  beforeAll(async () => {
    await seedEmployee('technician', PERF_TECH);
    await seedEmployee('sales_rep', PERF_REP);
    perfCompany = await seedCompany(`Perf Co ${randomBytes(3).toString('hex')}`);
    today = await istToday();

    // Two completions today for this technician alone: ₹1,200 collected
    // (1500 charged less a 300 discount) and ₹800 flat.
    const closedMorning = await istInstant(today, '11:00');
    const closedAfternoon = await istInstant(today, '15:00');
    const j1 = await seedJob({
      status: 'completed',
      scheduledFor: null,
      assignedTo: PERF_TECH.id,
      closedAt: closedMorning,
    });
    await db.query(
      `INSERT INTO job_completions
         (job_card_id, completed_by, completed_at, work_summary, cost, discount_amount, discount_reason, collection_mode)
       VALUES ($1, $2, $3, 'Perf fixture', '1500.00', '300.00', 'goodwill', 'cash')`,
      [j1, PERF_TECH.id, closedMorning],
    );
    const j2 = await seedJob({
      status: 'completed',
      scheduledFor: null,
      assignedTo: PERF_TECH.id,
      closedAt: closedAfternoon,
    });
    await seedCompletion({
      jobId: j2,
      completedBy: PERF_TECH.id,
      completedAt: closedAfternoon,
      cost: '800.00',
      mode: 'upi',
    });

    // One confirmed sale today for this rep, plus a draft and a void that
    // must not count: a draft is not a sale and a void never was one.
    for (const [status, amount] of [
      ['confirmed', '5000.00'],
      ['draft', '9999.00'],
      ['void', '7777.00'],
    ] as const) {
      await db.query(
        `INSERT INTO sales_cards (sale_number, company_id, sales_rep_id, sale_date, status,
                                  confirmed_at, voided_at, voided_by, void_reason)
         VALUES ($1, $2, $3, business_date(now()), $4::sales_card_status,
                 CASE WHEN $4::text <> 'draft' THEN now() END,
                 CASE WHEN $4::text = 'void' THEN now() END,
                 CASE WHEN $4::text = 'void' THEN $5::uuid END,
                 CASE WHEN $4::text = 'void' THEN 'entered twice' END)
         RETURNING id`,
        [
          status === 'draft' ? null : `SC-PERF-${randomBytes(5).toString('hex')}`,
          perfCompany,
          PERF_REP.id,
          status,
          OWNER.id,
        ],
      ).then(async (r) => {
        await db.query(
          `INSERT INTO sales_card_items (sales_card_id, line_no, product_name, quantity, unit_price)
           VALUES ($1, 1, 'Perf fixture sale', 1, $2)`,
          [r.rows[0]!.id, amount],
        );
      });
    }
  });

  it('is the owner’s door — every other role is refused', async () => {
    expect((await getPerformance(OWNER)).statusCode).toBe(200);
    for (const who of [DISPATCHER, TECH_A, SALES_REP]) {
      const res = await getPerformance(who);
      expect(res.statusCode, res.body).toBe(403);
      expect(envelopeOf(res.statusCode, res.body).code).toBe('FORBIDDEN');
    }
  });

  it('answers for the current IST week, Monday to Sunday, with every day in it', async () => {
    const body = (await getPerformance(OWNER, 'week')).json<PerfBody>();
    expect(body.range.key).toBe('week');
    expect(body.range.from).toBe(await istWeekStart());
    expect(body.days).toHaveLength(7);
    expect(body.days[0]).toBe(body.range.from);
    expect(body.days[6]).toBe(body.range.to);
  });

  it('30d and 90d are rolling windows ending today', async () => {
    const thirty = (await getPerformance(OWNER, '30d')).json<PerfBody>();
    expect(thirty.days).toHaveLength(30);
    expect(thirty.range.to).toBe(today);
    expect(thirty.range.from).toBe(await istDateOffset(-29));

    const ninety = (await getPerformance(OWNER, '90d')).json<PerfBody>();
    expect(ninety.days).toHaveLength(90);
    expect(ninety.range.to).toBe(today);
  });

  it('technician revenue is CASH COLLECTED — charged less discount — grouped per day', async () => {
    const body = (await getPerformance(OWNER, 'week')).json<PerfBody>();
    const mine = body.technicianRevenue.filter((p) => p.employeeId === PERF_TECH.id);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.date).toBe(today);
    // 1500 − 300 discount, plus 800 flat.
    expect(mine[0]!.value).toBe('2000.00');
  });

  it('jobs done counts the completions, per technician per day', async () => {
    const body = (await getPerformance(OWNER, 'week')).json<PerfBody>();
    const mine = body.technicianJobs.filter((p) => p.employeeId === PERF_TECH.id);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ date: today, count: 2 });
  });

  it('rep sales count confirmed cards only — a draft is not a sale and a void never was', async () => {
    const body = (await getPerformance(OWNER, 'week')).json<PerfBody>();
    const value = body.repSalesValue.filter((p) => p.employeeId === PERF_REP.id);
    const count = body.repSalesCount.filter((p) => p.employeeId === PERF_REP.id);
    expect(value).toHaveLength(1);
    expect(value[0]!.value).toBe('5000.00');
    expect(count[0]).toMatchObject({ date: today, count: 1 });
  });

  it('lists the people the charts stack, technicians and reps apart', async () => {
    const body = (await getPerformance(OWNER, 'week')).json<PerfBody>();
    expect(body.technicians.map((p) => p.id)).toContain(PERF_TECH.id);
    expect(body.reps.map((p) => p.id)).toContain(PERF_REP.id);
    // A technician is never offered as a rep filter, or the chart would
    // stack a person who cannot appear in it.
    expect(body.reps.map((p) => p.id)).not.toContain(PERF_TECH.id);
  });

  it('keeps someone who has left, when the range still holds their work', async () => {
    await db.query(`UPDATE employees SET is_active = false WHERE id = $1`, [PERF_TECH.id]);
    const body = (await getPerformance(OWNER, 'week')).json<PerfBody>();
    expect(body.technicians.map((p) => p.id)).toContain(PERF_TECH.id);
    await db.query(`UPDATE employees SET is_active = true WHERE id = $1`, [PERF_TECH.id]);
  });
});
