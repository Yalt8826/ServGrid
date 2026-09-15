import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import type { FastifyInstance } from 'fastify';
import {
  errorEnvelopeSchema,
  JobCardOwnerSchema,
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
 * POST /v1/jobs (T2B.3, PLAN-BACKEND.md §6.3) — the dispatcher's create
 * door, with the AMC link. Runs against a scratch database built from the
 * real migrations (§14: no mocked database anywhere) and drives the
 * create over HTTP, because the things this task must prove are exactly
 * what a mock cannot prove:
 *
 *  - the dispatch form's request (useDispatchForm.ts) creates a job:
 *    number allocated, title from the service, `unassigned`, one
 *    `created` event;
 *  - `contractId` links the job to the customer's AMC only when the AMC
 *    belongs to the customer, is uncancelled, and covers the job's day —
 *    each refusal a plain 422 sentence;
 *  - a refused create burns NO job number (validation runs before the
 *    allocation — the sequence is not gap-free, §3.9);
 *  - the replay rules the idempotency plugin gives every create: same
 *    key + same body replays, same key + different body is 422;
 *  - the dispatcher's response carries no money key, and the technician
 *    sees the AMC as `{ number, endDate }` — never a price.
 */

function databaseUrl(): string {
  return process.env.DATABASE_URL ?? 'postgres://servgrid:servgrid@localhost:5432/servgrid';
}

function adminUrlFor(url: string): string {
  const parsed = new URL(url);
  parsed.pathname = '/postgres';
  return parsed.toString();
}

const SCRATCH_DB = 'servgrid_jobs_create_test';
const PASSWORD = 'mv-plain-copier-63';

let admin: Pool;
let db: Pool;
let app: FastifyInstance;
let config: Config;

const OWNER = { username: '', id: '', token: '' };
const TECH = { username: '', id: '', token: '' };
const DISPATCHER = { username: '', id: '', token: '' };
const SALES_REP = { username: '', id: '', token: '' };

async function seedEmployee(
  role: 'owner' | 'dispatcher' | 'technician' | 'sales_rep',
  who: { username: string; id: string; token: string },
): Promise<void> {
  const username = `t2b3.${role}.${randomBytes(4).toString('hex')}`;
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

let customerX = '';
let customerY = '';
let unitAtX = '';
let serviceId = '';
let amcX = ''; // active AMC for X, [today-30, today+334]
let amcYCancelled = ''; // cancelled AMC for Y

/** An IST business date `days` from today — the clock `business_date()` keeps. */
function istDatePlus(days: number): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(
    new Date(Date.now() + days * 24 * 60 * 60 * 1000),
  );
}

/** An IST noon instant on `date` — unambiguous inside its business day. */
function istNoonOn(date: string): string {
  return new Date(`${date}T12:00:00+05:30`).toISOString();
}

beforeAll(async () => {
  admin = new Pool({ connectionString: adminUrlFor(databaseUrl()), max: 2 });
  await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${SCRATCH_DB}`);

  const scratchUrl = new URL(databaseUrl());
  scratchUrl.pathname = `/${SCRATCH_DB}`;
  // The jobs service reads through the process-wide pool (db/pool.ts);
  // point it at the scratch database before the first request.
  process.env.DATABASE_URL = scratchUrl.toString();
  db = new Pool({ connectionString: scratchUrl.toString(), max: 5 });
  await runMigrations({ pool: db });

  config = loadConfig(validEnv({ DATABASE_URL: scratchUrl.toString() }));
  app = buildServer(config, { logger: false });
  await app.ready();

  customerX = (
    await db.query<{ id: string }>(
      `INSERT INTO customers (name, phone) VALUES ('T2B3 Customer X', '9840000001') RETURNING id`,
    )
  ).rows[0]!.id;
  customerY = (
    await db.query<{ id: string }>(
      `INSERT INTO customers (name, phone) VALUES ('T2B3 Customer Y', '9840000002') RETURNING id`,
    )
  ).rows[0]!.id;
  serviceId = (
    await db.query<{ id: string }>(
      `INSERT INTO services (code, name) VALUES ('T2B3-SVC', 'AMC service visit') RETURNING id`,
    )
  ).rows[0]!.id;
  unitAtX = (
    await db.query<{ id: string }>(
      `INSERT INTO customer_products (customer_id, free_text_name, serial_number)
       VALUES ($1, 'UPS 850VA', 'SN-T2B3-0001') RETURNING id`,
      [customerX],
    )
  ).rows[0]!.id;

  await seedEmployee('owner', OWNER);
  await seedEmployee('technician', TECH);
  await seedEmployee('dispatcher', DISPATCHER);
  await seedEmployee('sales_rep', SALES_REP);

  // The dispatch console ships dark (PLAN-EXECUTION.md §3); these probes
  // exercise ROLE authorization, so owner + dispatcher ride with
  // `dispatch.console` on, and the technician with `tech.jobs` (the work
  // read he walks in test 9). The flags' own behaviour is flags.test.ts's.
  await db.query(
    `INSERT INTO employee_flag_overrides (employee_id, flag, enabled)
     SELECT id, f.flag, true
     FROM employees
     CROSS JOIN (VALUES ('dispatch.console')) AS f(flag)
     WHERE employees.role IN ('owner', 'dispatcher')`,
  );
  await db.query(
    `INSERT INTO employee_flag_overrides (employee_id, flag, enabled)
     SELECT id, 'tech.jobs', true FROM employees WHERE id = $1`,
    [TECH.id],
  );

  // The AMCs (decision 2026-09-15): one live for X covering today, one
  // cancelled for Y — the wrong-customer and cancelled refusals' fixtures.
  amcX = (
    await db.query<{ id: string }>(
      `INSERT INTO service_contracts
         (contract_number, customer_id, start_date, end_date, contract_value, notes, created_by)
       VALUES ($1, $2, $3::date, $4::date, '12000.00', 'T2B.3 fixture', $5)
       RETURNING id`,
      [`AMC-T2B3-X-${randomBytes(3).toString('hex')}`, customerX, istDatePlus(-30), istDatePlus(334), DISPATCHER.id],
    )
  ).rows[0]!.id;
  amcYCancelled = (
    await db.query<{ id: string }>(
      `INSERT INTO service_contracts
         (contract_number, customer_id, start_date, end_date, contract_value, notes, created_by,
          cancelled_at, cancelled_by, cancel_reason)
       VALUES ($1, $2, $3::date, $4::date, '9000.00', 'T2B.3 fixture', $5, now(), $5, 'wrong site')
       RETURNING id`,
      [`AMC-T2B3-Y-${randomBytes(3).toString('hex')}`, customerY, istDatePlus(-10), istDatePlus(354), DISPATCHER.id],
    )
  ).rows[0]!.id;
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

// ── request and read-back helpers ───────────────────────────────────────────

/** The body the dispatch form sends (useDispatchForm.ts), plus contractId when ticked. */
function createBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    customerId: customerX,
    serviceId,
    customerProductId: null,
    priority: 'normal',
    scheduledFor: istNoonOn(istDatePlus(0)),
    contactName: 'Mr Prakash',
    contactPhone: '+919812345678',
    description: 'Not cooling since Monday',
    ...overrides,
  };
}

function postCreate(
  token: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
) {
  return app.inject({
    method: 'POST',
    url: '/v1/jobs',
    headers: { authorization: `Bearer ${token}`, 'x-client-source': 'mobile', ...headers },
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

/** No refusal may ever echo a constraint's name back. */
function expectNoConstraintLeak(body: string): void {
  expect(body).not.toMatch(/service_contracts_|customer_products_|job_cards_/);
  expect(body).not.toMatch(/23514|23505|23503|22003|check_violation|unique_violation/i);
}

async function cardRow(jobId: string): Promise<Record<string, unknown> & { contract_id: string | null }> {
  const r = await db.query<Record<string, unknown> & { contract_id: string | null }>(
    `SELECT job_number, status, title, customer_id::text, service_id::text, contract_id::text
     FROM job_cards WHERE id = $1`,
    [jobId],
  );
  return r.rows[0]!;
}

interface EventRow {
  event_type: string;
  actor_id: string | null;
  from_status: string | null;
  to_status: string | null;
  source: string;
  payload: Record<string, unknown> | null;
}

async function eventsOf(jobId: string): Promise<EventRow[]> {
  const r = await db.query<EventRow>(
    `SELECT event_type, actor_id::text, from_status::text, to_status::text, source, payload
     FROM job_events WHERE job_card_id = $1 ORDER BY id`,
    [jobId],
  );
  return r.rows;
}

/** The job sequence's current value — and whether a row exists at all. */
async function jobSequence(): Promise<{ exists: boolean; value: string | null }> {
  const fy = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' })
    .formatToParts(new Date())
    .find((p) => p.type === 'year')!.value;
  const year = Number(fy);
  const month = Number(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date()).slice(5, 7));
  const fyStart = month >= 4 ? year : year - 1;
  const scope = `job:${String(fyStart % 100).padStart(2, '0')}${String((fyStart + 1) % 100).padStart(2, '0')}`;
  const r = await db.query<{ current_value: string }>(
    'SELECT current_value::text FROM sequences WHERE scope = $1',
    [scope],
  );
  return { exists: r.rows.length > 0, value: r.rows[0]?.current_value ?? null };
}

/** The key names every object under `value` carries, flattened. */
function walkKeys(value: unknown, path: string, hits: string[], forbidden: ReadonlySet<string>): void {
  if (Array.isArray(value)) {
    value.forEach((item, i) => walkKeys(item, `${path}[${i}]`, hits, forbidden));
    return;
  }
  if (typeof value === 'object' && value !== null) {
    for (const [key, child] of Object.entries(value)) {
      if (forbidden.has(key)) hits.push(`${path}.${key}`);
      walkKeys(child, `${path}.${key}`, hits, forbidden);
    }
  }
}

// ── the tests ───────────────────────────────────────────────────────────────

describe('POST /v1/jobs — the dispatch form creates a job (§6.3)', () => {
  it('a dispatcher creates: number allocated, unassigned, titled from the service, one created event', async () => {
    // The unit at X rides along — the dispatch form sends it when picked.
    const res = await postCreate(DISPATCHER.token, createBody({ customerProductId: unitAtX }));
    expect(res.statusCode, res.body).toBe(200);

    const card = res.json();
    expect(card.jobNumber).toMatch(/^JC-\d{4}-\d{5}$/);
    expect(card.status).toBe('unassigned');
    expect(card.title).toBe('AMC service visit'); // the service's name IS the title
    expect(card.isContractVisit).toBe(false);
    expect(card.assignedTo).toBeNull();
    expect(card.version).toBe(1);

    const row = await cardRow(card.id);
    expect(row.status).toBe('unassigned');
    expect(row.job_number).toBe(card.jobNumber);
    expect(row.contract_id).toBeNull();

    const events = await eventsOf(card.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event_type: 'created',
      actor_id: DISPATCHER.id,
      from_status: null,
      to_status: 'unassigned',
      source: 'mobile', // from the header
      payload: {},
    });
  });

  it('the owner creates too, and reads the owner shape back — money keys present and null', async () => {
    const res = await postCreate(OWNER.token, createBody({ scheduledFor: null, customerProductId: null }));
    expect(res.statusCode, res.body).toBe(200);
    const card = JobCardOwnerSchema.parse(res.json());
    expect(card.status).toBe('unassigned');
    expect(card.cost).toBeNull();
    expect(card.discountAmount).toBeNull();
    expect(card.amountCollected).toBeNull();
    expect(card.collectionMode).toBeNull();
  });

  it('the same Idempotency-Key replays the identical card; a different body under it is 422', async () => {
    const key = `t2b3-replay-${randomBytes(4).toString('hex')}`;
    const first = await postCreate(DISPATCHER.token, createBody(), { 'idempotency-key': key });
    expect(first.statusCode, first.body).toBe(200);

    const replay = await postCreate(DISPATCHER.token, createBody(), { 'idempotency-key': key });
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json()).toEqual(first.json());

    const different = await postCreate(DISPATCHER.token, createBody({ priority: 'urgent' }), {
      'idempotency-key': key,
    });
    expect(different.statusCode, different.body).toBe(422);
    expect(envelopeOf(different.statusCode, different.body).code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('with the covering AMC the job is a contract visit — linked, event carries contractId', async () => {
    const res = await postCreate(DISPATCHER.token, createBody({ contractId: amcX }));
    expect(res.statusCode, res.body).toBe(200);
    const card = res.json();
    expect(card.isContractVisit).toBe(true);

    const row = await cardRow(card.id);
    expect(row.contract_id).toBe(amcX);

    const events = await eventsOf(card.id);
    expect(events[0]!.payload).toEqual({ contractId: amcX });
  });

  it('AMC refusals, each in plain words', async () => {
    // Another customer's AMC — even uncancelled — is not X's.
    const activeY = await db.query<{ id: string }>(
      `INSERT INTO service_contracts
         (contract_number, customer_id, start_date, end_date, contract_value, created_by)
       VALUES ($1, $2, $3::date, $4::date, '5000.00', $5) RETURNING id`,
      [`AMC-T2B3-Y2-${randomBytes(3).toString('hex')}`, customerY, istDatePlus(-5), istDatePlus(360), DISPATCHER.id],
    );
    const wrongCustomer = await postCreate(
      DISPATCHER.token,
      createBody({ contractId: activeY.rows[0]!.id, customerId: customerX }),
    );
    expect(wrongCustomer.statusCode, wrongCustomer.body).toBe(422);
    expect(envelopeOf(wrongCustomer.statusCode, wrongCustomer.body).code).toBe('VALIDATION_FAILED');
    expect(wrongCustomer.body).toMatch(/belongs to a different customer/i);
    expectNoConstraintLeak(wrongCustomer.body);

    // The cancelled AMC for Y, offered for Y himself — still refused.
    const cancelled = await postCreate(
      DISPATCHER.token,
      createBody({ contractId: amcYCancelled, customerId: customerY }),
    );
    expect(cancelled.statusCode, cancelled.body).toBe(422);
    expect(cancelled.body).toMatch(/was cancelled/i);

    // A day past the AMC's end: the sentence names both dates.
    const after = istDatePlus(400);
    const notCovering = await postCreate(
      DISPATCHER.token,
      createBody({ contractId: amcX, scheduledFor: istNoonOn(after) }),
    );
    expect(notCovering.statusCode, notCovering.body).toBe(422);
    const dayLabel = (iso: string): string =>
      new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(
        new Date(`${iso}T00:00:00Z`),
      );
    expect(notCovering.body).toContain(dayLabel(amcStart()));
    expect(notCovering.body).toContain(dayLabel(amcEnd()));
    expect(notCovering.body).toContain(dayLabel(after));

    // No date on the job: judged against TODAY — covered, so accepted.
    const undated = await postCreate(DISPATCHER.token, createBody({ scheduledFor: null, contractId: amcX }));
    expect(undated.statusCode, undated.body).toBe(200);
    expect(undated.json().isContractVisit).toBe(true);
  });

  it('unknown customer, inactive service, unit at another site — each 422, nothing written, no number burnt', async () => {
    const before = await jobSequence();
    const cardsBefore = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM job_cards');

    const ghostCustomer = createBody({ customerId: crypto.randomUUID() });
    const ghostRes = await postCreate(DISPATCHER.token, ghostCustomer);
    expect(ghostRes.statusCode, ghostRes.body).toBe(422);
    expect(ghostRes.body).toMatch(/pick them again from the search/i);

    const deadService = (
      await db.query<{ id: string }>(
        `INSERT INTO services (code, name, is_active) VALUES ('T2B3-DEAD', 'Retired service', false) RETURNING id`,
      )
    ).rows[0]!.id;
    const deadRes = await postCreate(DISPATCHER.token, createBody({ serviceId: deadService }));
    expect(deadRes.statusCode, deadRes.body).toBe(422);
    expect(deadRes.body).toMatch(/no longer offered/i);

    const strangerUnit = await postCreate(
      DISPATCHER.token,
      createBody({ customerProductId: crypto.randomUUID() }),
    );
    expect(strangerUnit.statusCode, strangerUnit.body).toBe(422);
    expect(strangerUnit.body).toMatch(/isn't at this customer's site/i);

    expectNoConstraintLeak(ghostRes.body);
    expectNoConstraintLeak(deadRes.body);
    expectNoConstraintLeak(strangerUnit.body);

    const cardsAfter = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM job_cards');
    expect(cardsAfter.rows[0]!.n).toBe(cardsBefore.rows[0]!.n); // no row inserted
    const after = await jobSequence();
    expect(after).toEqual(before); // allocate runs LAST — a refused create burns nothing
  });

  it('a technician and a sales rep are 403; the flag off is FLAG_DISABLED', async () => {
    const tech = await postCreate(TECH.token, createBody());
    expect(tech.statusCode, tech.body).toBe(403);
    expect(envelopeOf(tech.statusCode, tech.body).code).toBe('FORBIDDEN');
    expect(tech.body).toMatch(/raised by the office/i);

    const rep = await postCreate(SALES_REP.token, createBody());
    expect(rep.statusCode, rep.body).toBe(403);
    expect(envelopeOf(rep.statusCode, rep.body).code).toBe('FORBIDDEN');

    // Flag off: the T0 rollback darkens the door even for the dispatcher.
    await db.query(`DELETE FROM employee_flag_overrides WHERE employee_id = $1 AND flag = 'dispatch.console'`, [
      DISPATCHER.id,
    ]);
    try {
      const dark = await postCreate(DISPATCHER.token, createBody());
      expect(dark.statusCode, dark.body).toBe(409);
      expect(envelopeOf(dark.statusCode, dark.body).code).toBe('FLAG_DISABLED');
    } finally {
      await db.query(
        `INSERT INTO employee_flag_overrides (employee_id, flag, enabled) VALUES ($1, 'dispatch.console', true)`,
        [DISPATCHER.id],
      );
    }
  });

  it("the dispatcher's response carries no money key anywhere", async () => {
    const res = await postCreate(DISPATCHER.token, createBody({ contractId: amcX }));
    expect(res.statusCode, res.body).toBe(200);
    const forbidden = new Set(['cost', 'discount_amount', 'discountAmount', 'amount_collected', 'amountCollected', 'collection_mode', 'collectionMode', 'contract_value', 'contractValue']);
    const hits: string[] = [];
    walkKeys(res.json(), '$', hits, forbidden);
    expect(hits).toEqual([]);
  });
});

describe('the technician sees the AMC (§7: contract { number, endDate }, never a price)', () => {
  it('assign the AMC job, then the work read and the point read name it', async () => {
    const created = await postCreate(DISPATCHER.token, createBody({ contractId: amcX }));
    expect(created.statusCode, created.body).toBe(200);
    const card = created.json();
    expect(card.version).toBe(1);

    const assigned = await app.inject({
      method: 'POST',
      url: `/v1/jobs/${card.id}/assign`,
      headers: { authorization: `Bearer ${DISPATCHER.token}`, 'if-match': String(card.version) },
      payload: { technicianId: TECH.id },
    });
    expect(assigned.statusCode, assigned.body).toBe(200);

    const work = await app.inject({
      method: 'GET',
      url: '/v1/technician/work',
      headers: { authorization: `Bearer ${TECH.token}` },
    });
    expect(work.statusCode, work.body).toBe(200);
    const workBody = work.json() as { jobs: Array<{ id: string; contract: { number: string; endDate: string } | null }> };
    const his = workBody.jobs.find((j) => j.id === card.id);
    expect(his).toBeDefined();
    expect(his!.contract).toEqual({ number: expect.stringMatching(/^AMC-T2B3-X-/), endDate: istDatePlus(334) });

    const hits: string[] = [];
    walkKeys(workBody, '$', hits, new Set(['contractValue', 'contract_value']));
    expect(hits).toEqual([]);

    const point = await app.inject({
      method: 'GET',
      url: `/v1/jobs/${card.id}`,
      headers: { authorization: `Bearer ${TECH.token}` },
    });
    expect(point.statusCode, point.body).toBe(200);
    expect(point.json().contract).toEqual(his!.contract);
  });

  it('a cancelled AMC hides the chip — the job reads contract: null again', async () => {
    const created = await postCreate(DISPATCHER.token, createBody({ contractId: amcX, scheduledFor: null }));
    expect(created.statusCode, created.body).toBe(200);
    const card = created.json();

    const assigned = await app.inject({
      method: 'POST',
      url: `/v1/jobs/${card.id}/assign`,
      headers: { authorization: `Bearer ${DISPATCHER.token}`, 'if-match': String(card.version) },
      payload: { technicianId: TECH.id },
    });
    expect(assigned.statusCode, assigned.body).toBe(200);

    // Cancel X's AMC the way the cancel endpoint would (decision 11's trail).
    await db.query(`UPDATE service_contracts SET cancelled_at = now(), cancelled_by = $2, cancel_reason = 'renewed wrongly' WHERE id = $1`, [
      amcX,
      DISPATCHER.id,
    ]);

    const work = await app.inject({
      method: 'GET',
      url: '/v1/technician/work',
      headers: { authorization: `Bearer ${TECH.token}` },
    });
    expect(work.statusCode, work.body).toBe(200);
    const workBody = work.json() as { jobs: Array<{ id: string; contract: { number: string; endDate: string } | null }> };
    const his = workBody.jobs.find((j) => j.id === card.id);
    expect(his).toBeDefined();
    expect(his!.contract).toBeNull();
  });
});

/** The AMC term's bounds, read back for the date-naming assertion. */
function amcStart(): string {
  return istDatePlus(-30);
}
function amcEnd(): string {
  return istDatePlus(334);
}
