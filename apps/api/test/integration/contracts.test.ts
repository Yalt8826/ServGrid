import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import type { FastifyInstance } from 'fastify';
import {
  type Contract,
  ContractSchema,
  contractListEnvelopeSchema,
  type ErrorEnvelope,
  type LoginResponse,
} from '@servgrid/shared';
import { loadConfig, type Config } from '../../src/config.js';
import { closePool } from '../../src/db/pool.js';
import { runMigrations } from '../../src/db/migrate.js';
import { hashPassword } from '../../src/lib/password.js';
import { fiscalYearFor, scopeKey } from '../../src/lib/sequences.js';
import { buildServer } from '../../src/server.js';
import { ULID, validEnv } from '../helpers/env.js';

/**
 * Contracts integration suite (PHASE-2B-CONTRACTS.md T2B.2, PLAN-BACKEND.md
 * §11.1, decision 2026-09-15). Runs against a scratch database migrated
 * from scratch — no mocked database anywhere. What it proves:
 *
 * - **A create allocates an AMC number and reads the derived view back** —
 *   state, next visit due and the creator's name all come from
 *   v_contracts, never from the request.
 * - **Replays and numbers** — the same key and body re-serves the stored
 *   response with ONE row and the sequence advanced by exactly one; an
 *   overlap is refused 409 naming the existing AMC with NO number burnt;
 *   a renewal starting the day after the old end is accepted.
 * - **The reminders are the view's** — `filter=due` lists a customer whose
 *   last completed job is months old and not one with an open job;
 *   `filter=ending` draws the 7-day line; `q` matches names and numbers
 *   with a literal `%`; the offset cursor pages without duplicates.
 * - **Edits and cancels** — If-Match optimistic concurrency, the overlap
 *   re-check on date moves, and a cancel that frees the dates while the
 *   linked jobs stay ordinary jobs.
 */

function databaseUrl(): string {
  return process.env.DATABASE_URL ?? 'postgres://servgrid:servgrid@localhost:5432/servgrid';
}

function adminUrlFor(url: string): string {
  const parsed = new URL(url);
  parsed.pathname = '/postgres';
  return parsed.toString();
}

const SCRATCH_DB = 'servgrid_contracts_api_test';
const PASSWORD = 'amc-integration-63';

/** The IST business date `offsetDays` from today, as the plain `YYYY-MM-DD` a date column takes. */
function istDate(offsetDays: number): string {
  return new Date(Date.now() + offsetDays * 86_400_000 + 5.5 * 3_600_000).toISOString().slice(0, 10);
}

function addDays(iso: string, days: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** `2026-09-14` + 4 months → `2027-01-14`, clamped to month end the way Postgres does (31 Oct + 4 → 28/29 Feb). */
function addMonthsClamped(iso: string, months: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const target = new Date(Date.UTC(y!, m! - 1 + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  return `${target.getUTCFullYear()}-${String(target.getUTCMonth() + 1).padStart(2, '0')}-${String(Math.min(d!, lastDay)).padStart(2, '0')}`;
}

function monthsAgo(months: number): Date {
  return new Date(Date.now() - months * 30 * 86_400_000);
}

interface Actor {
  username: string;
  id: string;
  token: string;
}

const DISPATCHER: Actor = { username: '', id: '', token: '' };

let admin: Pool;
let db: Pool;
let app: FastifyInstance;
let config: Config;

function bearer(actor: Actor): Record<string, string> {
  return { authorization: `Bearer ${actor.token}` };
}

/** Every POST carries an `Idempotency-Key` — the idempotency plugin wraps the request in one transaction. */
async function post(path: string, body: Record<string, unknown>, key = randomUUID()): Promise<{ statusCode: number; body: string }> {
  return app.inject({ method: 'POST', url: path, headers: { ...bearer(DISPATCHER), 'idempotency-key': key }, payload: body });
}

async function patch(path: string, body: Record<string, unknown>, ifMatch: string): Promise<{ statusCode: number; body: string }> {
  return app.inject({ method: 'PATCH', url: path, headers: { ...bearer(DISPATCHER), 'if-match': ifMatch }, payload: body });
}

function errorOf(status: number, body: string): ErrorEnvelope['error'] {
  expect(status).toBeGreaterThanOrEqual(400);
  const error = (JSON.parse(body) as ErrorEnvelope).error;
  expect(error.requestId).toMatch(ULID);
  return error;
}

/** The sequences row the AMC numbers allocate from — the "no number burnt" assertion reads it raw. */
async function sequenceValue(): Promise<number> {
  const r = await db.query<{ current_value: string }>(
    'SELECT current_value FROM sequences WHERE scope = $1',
    [scopeKey('contract', fiscalYearFor(new Date()))],
  );
  return r.rows.length === 0 ? 0 : Number(r.rows[0]!.current_value);
}

async function seedCustomer(name: string): Promise<string> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO customers (name, phone) VALUES ($1, '98470000') RETURNING id`,
    [name],
  );
  return r.rows[0]!.id;
}

/** An AMC inserted directly, then read through the same view shape the API returns. */
async function seedAmc(customerId: string, startDate: string, endDate: string, value: string): Promise<Contract> {
  const inserted = await db.query<{ id: string }>(
    `INSERT INTO service_contracts (contract_number, customer_id, start_date, end_date, contract_value, created_by)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [`AMC-INT-${randomBytes(6).toString('hex')}`, customerId, startDate, endDate, value, DISPATCHER.id],
  );
  // Dates as ::text — the same shape the repo selects, so the parse sees strings.
  const r = await db.query<Record<string, unknown>>(
    `SELECT id, contract_number, customer_id, customer_name,
            start_date::text AS start_date, end_date::text AS end_date,
            contract_value::text AS contract_value, notes,
            created_by, created_by_name, created_at,
            cancelled_at, cancel_reason, state,
            last_service_date::text AS last_service_date,
            next_visit_due::text AS next_visit_due,
            open_job_id, open_job_number, open_job_scheduled_for,
            days_to_end, is_visit_due, is_ending_soon, version
     FROM v_contracts WHERE id = $1`,
    [inserted.rows[0]!.id],
  );
  const v = r.rows[0]!;
  return ContractSchema.parse({
    id: v.id,
    contractNumber: v.contract_number,
    customerId: v.customer_id,
    customerName: v.customer_name,
    startDate: v.start_date,
    endDate: v.end_date,
    contractValue: v.contract_value,
    notes: v.notes,
    createdBy: v.created_by,
    createdByName: v.created_by_name,
    createdAt: (v.created_at as Date).toISOString(),
    cancelledAt: v.cancelled_at === null ? null : (v.cancelled_at as Date).toISOString(),
    cancelReason: v.cancel_reason,
    state: v.state,
    lastServiceDate: v.last_service_date,
    nextVisitDue: v.next_visit_due,
    openJob:
      v.open_job_id === null
        ? null
        : {
            id: v.open_job_id,
            jobNumber: v.open_job_number,
            scheduledFor: v.open_job_scheduled_for === null ? null : (v.open_job_scheduled_for as Date).toISOString(),
          },
    daysToEnd: Number(v.days_to_end),
    isVisitDue: v.is_visit_due,
    isEndingSoon: v.is_ending_soon,
    version: v.version,
  });
}

let jobSeq = 0;

/** A job inserted the way T2B.1's schema suite does — raw SQL against job_cards. */
async function seedJob(overrides: {
  customerId: string;
  status?: string;
  scheduledFor?: Date | null;
  closedAt?: Date | null;
  assignedTo?: string | null;
  contractId?: string | null;
}): Promise<string> {
  jobSeq += 1;
  const status = overrides.status ?? 'assigned';
  const r = await db.query<{ id: string }>(
    `INSERT INTO job_cards (job_number, customer_id, service_id, title, status, assigned_to, assigned_at, scheduled_for, closed_at, contract_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
    [
      `JC-INT-${jobSeq}-${randomBytes(3).toString('hex')}`,
      overrides.customerId,
      serviceId,
      'Contracts integration fixture job',
      status,
      status === 'unassigned' ? null : (overrides.assignedTo ?? techId),
      status === 'unassigned' ? null : new Date().toISOString(),
      overrides.scheduledFor ?? null,
      overrides.closedAt ?? null,
      overrides.contractId ?? null,
    ],
  );
  return r.rows[0]!.id;
}

let serviceId = '';
let techId = '';

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

  const username = `int.contracts.${randomBytes(4).toString('hex')}`;
  DISPATCHER.id = (
    await db.query<{ id: string }>(
      `INSERT INTO employees (username, password_hash, full_name, role)
       VALUES ($1, $2, $3, 'dispatcher') RETURNING id`,
      [username, await hashPassword(PASSWORD), 'Doris the Dispatcher'],
    )
  ).rows[0]!.id;
  await db.query(
    `INSERT INTO employee_flag_overrides (employee_id, flag, enabled, updated_by)
     VALUES ($1, 'contracts.manage', true, $1), ($1, 'dispatch.console', true, $1)`,
    [DISPATCHER.id],
  );
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
  DISPATCHER.token = res.json<LoginResponse>().accessToken;

  techId = (
    await db.query<{ id: string }>(
      `INSERT INTO employees (username, password_hash, full_name, role)
       VALUES ($1, 'not-a-real-hash', 'Tom the Technician', 'technician') RETURNING id`,
      [`int.contracts.tech.${randomBytes(4).toString('hex')}`],
    )
  ).rows[0]!.id;

  serviceId = (
    await db.query<{ id: string }>(
      `INSERT INTO services (code, name) VALUES ('INT-AMC', 'Contracts integration service') RETURNING id`,
    )
  ).rows[0]!.id;
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

// ── 1–6: the create door ────────────────────────────────────────────────────

describe('create — a number, the derived read-back, replays and overlaps', () => {
  const first = { customerId: '', startDate: '', endDate: '' };
  let firstContract: Contract;
  let seqBeforeCreate = 0;
  const replayKey = randomUUID();

  it('creates an AMC: an AMC number, active state, the dispatcher as creator, the due date four months out', async () => {
    first.customerId = await seedCustomer('Integration Alpha Traders');
    first.startDate = istDate(0);
    first.endDate = istDate(364);
    seqBeforeCreate = await sequenceValue();

    const res = await post('/v1/contracts', { ...first, contractValue: '18000.00' }, replayKey);
    expect(res.statusCode, res.body).toBe(200);
    firstContract = ContractSchema.parse(JSON.parse(res.body)) as Contract;

    expect(firstContract.contractNumber).toMatch(/^AMC-\d{4}-\d{5}$/);
    expect(firstContract.state).toBe('active');
    expect(firstContract.createdByName).toBe('Doris the Dispatcher');
    // No completed job at the customer: the reminder counts from the start.
    expect(firstContract.nextVisitDue).toBe(addMonthsClamped(first.startDate, 4));
    expect(firstContract.version).toBe(1);
    expect(await sequenceValue()).toBe(seqBeforeCreate + 1);
  });

  it('replays the same key and body: identical response, one row, the sequence not advanced again', async () => {
    const res = await post('/v1/contracts', { ...first, contractValue: '18000.00' }, replayKey);
    expect(res.statusCode, res.body).toBe(200);
    expect(JSON.parse(res.body)).toEqual(firstContract);

    const rows = await db.query<{ id: string }>(
      'SELECT id FROM service_contracts WHERE customer_id = $1',
      [first.customerId],
    );
    expect(rows.rows).toHaveLength(1);
    expect(await sequenceValue()).toBe(seqBeforeCreate + 1); // the replay burnt nothing
  });

  it('refuses the same key with a different body: 422 IDEMPOTENCY_KEY_REUSED', async () => {
    const res = await post('/v1/contracts', { ...first, contractValue: '19000.00' }, replayKey);
    expect(res.statusCode, res.body).toBe(422);
    expect(errorOf(res.statusCode, res.body).code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('refuses an overlap with 409 DUPLICATE_ENTITY naming the existing AMC and its dates — no number burnt', async () => {
    const before = await sequenceValue();
    const res = await post(
      '/v1/contracts',
      { customerId: first.customerId, startDate: istDate(30), endDate: istDate(120), contractValue: '5000.00' },
    );
    expect(res.statusCode, res.body).toBe(409);
    const error = errorOf(res.statusCode, res.body);
    expect(error.code).toBe('DUPLICATE_ENTITY');
    const existing = (error.details as { existing: { contractNumber: string } }).existing;
    expect(existing.contractNumber).toBe(firstContract.contractNumber);
    // The message names the existing term so the dispatcher can go look.
    expect(error.message).toContain(firstContract.contractNumber);
    expect(error.message).toMatch(/from \d{1,2} [A-Z][a-z]{2} \d{4} to \d{1,2} [A-Z][a-z]{2} \d{4}/);
    expect(await sequenceValue()).toBe(before); // the refused create burnt nothing
  });

  it('accepts a renewal starting the day after the current AMC ends', async () => {
    const res = await post('/v1/contracts', {
      customerId: first.customerId,
      startDate: addDays(firstContract.endDate, 1),
      endDate: addDays(addMonthsClamped(firstContract.endDate, 12), -1),
      contractValue: firstContract.contractValue,
    });
    expect(res.statusCode, res.body).toBe(200);
    const renewal = ContractSchema.parse(JSON.parse(res.body)) as Contract;
    expect(renewal.id).not.toBe(firstContract.id);
    expect(renewal.state).toBe('upcoming');
  });

  it('refuses an unknown customer with 422 and a sentence', async () => {
    const ghost = randomBytes(16).toString('hex');
    const id = `${ghost.slice(0, 8)}-${ghost.slice(8, 12)}-${ghost.slice(12, 16)}-${ghost.slice(16, 20)}-${ghost.slice(20, 32)}`;
    const res = await post('/v1/contracts', { customerId: id, startDate: istDate(0), endDate: istDate(30), contractValue: '1.00' });
    expect(res.statusCode, res.body).toBe(422);
    expect(errorOf(res.statusCode, res.body).message).toBe("That customer doesn't exist — pick them again from the search.");
  });
});

// ── 7–10: the lists ─────────────────────────────────────────────────────────

describe('filter=due — the four-month reminder, most overdue first', () => {
  const moreOverdue = { customer: '', amc: null as Contract | null };
  const lessOverdue = { customer: '', amc: null as Contract | null };
  const recentlyServiced = { customer: '', amc: null as Contract | null };
  const hasOpenJob = { customer: '', amc: null as Contract | null };

  beforeAll(async () => {
    moreOverdue.customer = await seedCustomer('Due Senior Mills');
    lessOverdue.customer = await seedCustomer('Due Junior Works');
    recentlyServiced.customer = await seedCustomer('Due Fresh Motors');
    hasOpenJob.customer = await seedCustomer('Due Booked Site');

    // The terms predate the completed jobs: GREATEST(start, last_service)
    // then anchors on the job, which is the rule the tab reminds by.
    for (const entry of [moreOverdue, lessOverdue, recentlyServiced, hasOpenJob]) {
      entry.amc = await seedAmc(entry.customer, istDate(-400), istDate(335), '9000.00');
    }

    await seedJob({ customerId: moreOverdue.customer, status: 'completed', closedAt: monthsAgo(7) });
    await seedJob({ customerId: lessOverdue.customer, status: 'completed', closedAt: monthsAgo(5) });
    await seedJob({ customerId: recentlyServiced.customer, status: 'completed', closedAt: new Date(Date.now() - 7 * 86_400_000) });
    await seedJob({ customerId: hasOpenJob.customer, status: 'completed', closedAt: monthsAgo(5) });
    // The open job that makes the booked site NOT a reminder.
    await seedJob({ customerId: hasOpenJob.customer, status: 'assigned', assignedTo: techId });
  });

  it('lists the overdue customers most overdue first, and not a serviced or booked customer', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/contracts?filter=due', headers: bearer(DISPATCHER) });
    expect(res.statusCode, res.body).toBe(200);
    const body = contractListEnvelopeSchema.parse(JSON.parse(res.body));
    const ids = body.items.map((c) => c.id);

    expect(ids).toContain(moreOverdue.amc!.id);
    expect(ids).toContain(lessOverdue.amc!.id);
    expect(ids).not.toContain(recentlyServiced.amc!.id);
    expect(ids).not.toContain(hasOpenJob.amc!.id);
    expect(ids.indexOf(moreOverdue.amc!.id)).toBeLessThan(ids.indexOf(lessOverdue.amc!.id));
    for (const item of body.items) expect(item.isVisitDue).toBe(true);
  });
});

describe('filter=ending — the seven-day warning, fewest days first', () => {
  const threeDays = { customer: '', amc: null as Contract | null };
  const sevenDays = { customer: '', amc: null as Contract | null };
  const eightDays = { customer: '', amc: null as Contract | null };

  beforeAll(async () => {
    threeDays.customer = await seedCustomer('Ending Three Site');
    sevenDays.customer = await seedCustomer('Ending Seven Site');
    eightDays.customer = await seedCustomer('Ending Eight Site');
    threeDays.amc = await seedAmc(threeDays.customer, istDate(-358), istDate(3), '1000.00');
    sevenDays.amc = await seedAmc(sevenDays.customer, istDate(-358), istDate(7), '1000.00');
    eightDays.amc = await seedAmc(eightDays.customer, istDate(-358), istDate(8), '1000.00');
  });

  it('lists an AMC ending within 7 days and not one ending in 8, ordered by days to end', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/contracts?filter=ending', headers: bearer(DISPATCHER) });
    expect(res.statusCode, res.body).toBe(200);
    const body = contractListEnvelopeSchema.parse(JSON.parse(res.body));
    const ids = body.items.map((c) => c.id);

    expect(ids).toContain(threeDays.amc!.id);
    expect(ids).toContain(sevenDays.amc!.id);
    expect(ids).not.toContain(eightDays.amc!.id);
    expect(ids.indexOf(threeDays.amc!.id)).toBeLessThan(ids.indexOf(sevenDays.amc!.id));
    for (const item of body.items) expect(item.isEndingSoon).toBe(true);
  });
});

describe('q — names and numbers, and a % that matches literally', () => {
  const named = { customer: '', amc: null as Contract | null };
  const percent = { customer: '', amc: null as Contract | null };

  beforeAll(async () => {
    named.customer = await seedCustomer('Query Alpha Traders');
    percent.customer = await seedCustomer('Percent% Motors');
    named.amc = await seedAmc(named.customer, istDate(0), istDate(300), '100.00');
    percent.amc = await seedAmc(percent.customer, istDate(0), istDate(300), '100.00');
  });

  it('a customer name fragment finds its AMC', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/contracts?q=Query%20Alpha', headers: bearer(DISPATCHER) });
    expect(res.statusCode, res.body).toBe(200);
    const body = contractListEnvelopeSchema.parse(JSON.parse(res.body));
    expect(body.items.map((c) => c.id)).toEqual([named.amc!.id]);
  });

  it('a contract number finds its AMC', async () => {
    const res = await app.inject({ method: 'GET', url: `/v1/contracts?q=${named.amc!.contractNumber}`, headers: bearer(DISPATCHER) });
    expect(res.statusCode, res.body).toBe(200);
    const body = contractListEnvelopeSchema.parse(JSON.parse(res.body));
    expect(body.items.map((c) => c.id)).toEqual([named.amc!.id]);
  });

  it('a % in q is a literal percent, not a wildcard', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/contracts?q=%25', headers: bearer(DISPATCHER) });
    expect(res.statusCode, res.body).toBe(200);
    const body = contractListEnvelopeSchema.parse(JSON.parse(res.body));
    // Unescaped, `%%%` would match EVERY row; escaped it only matches the
    // one name that carries a literal percent sign.
    expect(body.items.map((c) => c.id)).toEqual([percent.amc!.id]);
  });
});

describe('pagination — the offset cursor over the whole list', () => {
  it('pages with limit=2: no duplicates, a null cursor at the end, the same rows in the same order; a garbage cursor is 422', async () => {
    // Five fresh AMCs on top of whatever the earlier tests created.
    for (let i = 0; i < 5; i += 1) {
      const customer = await seedCustomer(`Paged Site ${randomBytes(4).toString('hex')}`);
      await seedAmc(customer, istDate(0), istDate(200 + i), '100.00');
    }

    const full = await app.inject({ method: 'GET', url: '/v1/contracts?limit=200', headers: bearer(DISPATCHER) });
    expect(full.statusCode, full.body).toBe(200);
    const all = contractListEnvelopeSchema.parse(JSON.parse(full.body));
    expect(all.nextCursor).toBeNull();

    const seen: string[] = [];
    let cursor = '';
    let pages = 0;
    for (;;) {
      const url = cursor === '' ? '/v1/contracts?limit=2' : `/v1/contracts?limit=2&cursor=${encodeURIComponent(cursor)}`;
      const res = await app.inject({ method: 'GET', url, headers: bearer(DISPATCHER) });
      expect(res.statusCode, res.body).toBe(200);
      const page = contractListEnvelopeSchema.parse(JSON.parse(res.body));
      seen.push(...page.items.map((c) => c.id));
      pages += 1;
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }
    expect(pages).toBe(Math.ceil(all.items.length / 2));
    expect(new Set(seen).size).toBe(seen.length); // no duplicates
    expect(seen).toEqual(all.items.map((c) => c.id)); // same rows, same order

    const garbage = await app.inject({
      method: 'GET',
      url: `/v1/contracts?cursor=${encodeURIComponent(Buffer.from('{"offset":"x"}').toString('base64url'))}`,
      headers: bearer(DISPATCHER),
    });
    expect(garbage.statusCode, garbage.body).toBe(422);
  });
});

// ── 11–14: detail, edit, cancel ─────────────────────────────────────────────

describe('detail — the linked jobs, newest first, no money but the AMC price', () => {
  it('lists linked jobs newest first with the assignee named, and no money key at any depth', async () => {
    const customer = await seedCustomer('Detail Site');
    const amc = await seedAmc(customer, istDate(-10), istDate(355), '24000.00');

    const older = await seedJob({ customerId: customer, status: 'assigned', scheduledFor: new Date(Date.now() - 3 * 86_400_000), assignedTo: techId, contractId: amc.id });
    const newer = await seedJob({ customerId: customer, status: 'completed', scheduledFor: new Date(Date.now() - 1 * 86_400_000), closedAt: new Date(), assignedTo: techId, contractId: amc.id });
    const undated = await seedJob({ customerId: customer, status: 'unassigned', contractId: amc.id }); // no date — last

    const res = await app.inject({ method: 'GET', url: `/v1/contracts/${amc.id}`, headers: bearer(DISPATCHER) });
    expect(res.statusCode, res.body).toBe(200);
    const body = JSON.parse(res.body) as { contract: Contract; jobs: Array<{ id: string; assignedToName: string | null }> };
    expect(body.contract.id).toBe(amc.id);
    // Newest first (scheduled_for DESC, no date last).
    expect(body.jobs.map((j) => j.id)).toEqual([newer, older, undated]);
    expect(body.jobs[0]!.assignedToName).toBe('Tom the Technician');

    // No money key at any depth — except the AMC price the dispatcher owns.
    const forbidden = ['cost', 'discountAmount', 'discountReason', 'amountCollected', 'collectionMode', 'paymentReference', 'unitPrice', 'lineTotal', 'declaredAmount', 'confirmedAmount', 'balance'];
    const hits: string[] = [];
    const walk = (value: unknown, path: string): void => {
      if (Array.isArray(value)) {
        value.forEach((item, i) => walk(item, `${path}[${i}]`));
        return;
      }
      if (value !== null && typeof value === 'object') {
        for (const [key, child] of Object.entries(value)) {
          if (forbidden.includes(key)) hits.push(`${path}.${key}`);
          walk(child, `${path}.${key}`);
        }
      }
    };
    walk(body, '$');
    expect(hits).toEqual([]);
    expect(body.contract.contractValue).toBe('24000.00');
  });
});

describe('patch — If-Match, the overlap re-check, and the term rule', () => {
  const site = { customer: '', amc: null as Contract | null, later: null as Contract | null };

  beforeAll(async () => {
    site.customer = await seedCustomer('Patch Site');
    site.amc = await seedAmc(site.customer, istDate(-30), istDate(335), '12000.00');
    // A later AMC whose range a bad date move would collide with.
    site.later = await seedAmc(site.customer, istDate(336), istDate(700), '13000.00');
  });

  it('changes the price with the current version and bumps version', async () => {
    const res = await patch(`/v1/contracts/${site.amc!.id}`, { contractValue: '13500.00' }, String(site.amc!.version));
    expect(res.statusCode, res.body).toBe(200);
    const updated = ContractSchema.parse(JSON.parse(res.body)) as Contract;
    expect(updated.contractValue).toBe('13500.00');
    expect(updated.version).toBe(site.amc!.version + 1);
    site.amc = updated;
  });

  it('a stale version is 409 VERSION_CONFLICT naming the current version', async () => {
    const res = await patch(`/v1/contracts/${site.amc!.id}`, { notes: 'stale edit' }, String(site.amc!.version - 1));
    expect(res.statusCode, res.body).toBe(409);
    const error = errorOf(res.statusCode, res.body);
    expect(error.code).toBe('VERSION_CONFLICT');
    expect((error.details as { currentVersion: number }).currentVersion).toBe(site.amc!.version);
  });

  it('a missing If-Match is 422', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/contracts/${site.amc!.id}`,
      headers: bearer(DISPATCHER),
      payload: { notes: 'no version said' },
    });
    expect(res.statusCode, res.body).toBe(422);
  });

  it('moving the end date into a later AMC range is 409 naming the later AMC', async () => {
    const res = await patch(`/v1/contracts/${site.amc!.id}`, { endDate: istDate(400) }, String(site.amc!.version));
    expect(res.statusCode, res.body).toBe(409);
    const error = errorOf(res.statusCode, res.body);
    expect(error.code).toBe('DUPLICATE_ENTITY');
    expect((error.details as { existing: { contractNumber: string } }).existing.contractNumber).toBe(site.later!.contractNumber);
  });

  it('moving the end date before the start is 422', async () => {
    const res = await patch(`/v1/contracts/${site.amc!.id}`, { endDate: addDays(site.amc!.startDate, -1) }, String(site.amc!.version));
    expect(res.statusCode, res.body).toBe(422);
    expect(errorOf(res.statusCode, res.body).message).toBe('The end date cannot be before the start date.');
  });
});

describe('cancel — who and why, and the jobs stay ordinary', () => {
  const site = { customer: '', amc: null as Contract | null };
  let linkedJobId = '';

  beforeAll(async () => {
    site.customer = await seedCustomer('Cancel Site');
    site.amc = await seedAmc(site.customer, istDate(-10), istDate(355), '8000.00');
    linkedJobId = await seedJob({ customerId: site.customer, status: 'unassigned', contractId: site.amc.id });
  });

  it('cancels with the reason recorded, refuses a second cancel and a patch, leaves the linked job alone, and frees the dates', async () => {
    const res = await post(`/v1/contracts/${site.amc!.id}/cancel`, { reason: 'Recorded against the wrong site.' });
    expect(res.statusCode, res.body).toBe(200);
    const cancelled = ContractSchema.parse(JSON.parse(res.body)) as Contract;
    expect(cancelled.state).toBe('cancelled');
    expect(cancelled.cancelReason).toBe('Recorded against the wrong site.');
    expect(cancelled.cancelledAt).not.toBeNull();

    const again = await post(`/v1/contracts/${site.amc!.id}/cancel`, { reason: 'Twice.' });
    expect(again.statusCode, again.body).toBe(409);
    expect(errorOf(again.statusCode, again.body).code).toBe('ILLEGAL_TRANSITION');

    const edited = await patch(`/v1/contracts/${site.amc!.id}`, { notes: 'too late' }, String(cancelled.version));
    expect(edited.statusCode, edited.body).toBe(409);
    expect(errorOf(edited.statusCode, edited.body).code).toBe('ILLEGAL_TRANSITION');

    // The linked job was never touched: still unassigned, still linked.
    const detail = await app.inject({ method: 'GET', url: `/v1/contracts/${site.amc!.id}`, headers: bearer(DISPATCHER) });
    expect(detail.statusCode, detail.body).toBe(200);
    const body = JSON.parse(detail.body) as { jobs: Array<{ id: string; status: string }> };
    expect(body.jobs.map((j) => j.id)).toContain(linkedJobId);
    expect(body.jobs.find((j) => j.id === linkedJobId)!.status).toBe('unassigned');

    // A cancelled AMC drops out of the overlap rule: the same dates are free.
    const reRecord = await post('/v1/contracts', {
      customerId: site.customer,
      startDate: site.amc!.startDate,
      endDate: site.amc!.endDate,
      contractValue: '8200.00',
    });
    expect(reRecord.statusCode, reRecord.body).toBe(200);
  });

  it('a blank reason is 422', async () => {
    const res = await post(`/v1/contracts/${site.amc!.id}/cancel`, { reason: '   ' });
    expect(res.statusCode, res.body).toBe(422);
  });
});
