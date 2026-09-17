import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import type { FastifyInstance } from 'fastify';
import {
  errorEnvelopeSchema,
  serviceCallsResponseSchema,
  ServiceCallSchema,
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
 * Service calls (migration 023). Runs against a scratch database built
 * from the real migrations and drives the endpoints over HTTP, because
 * what is worth proving here is exactly what a mock cannot: that the
 * SIX-MONTH CYCLE is derived from the last completed job, that a customer
 * with an open job is never called, that a push-back moves the reminder
 * out and can never pull it in, that a follow-up from a previous cycle is
 * ignored once a new job is completed, and that the reminder returns after
 * the pushed date passes.
 */

function databaseUrl(): string {
  return process.env.DATABASE_URL ?? 'postgres://servgrid:servgrid@localhost:5432/servgrid';
}

function adminUrlFor(url: string): string {
  const parsed = new URL(url);
  parsed.pathname = '/postgres';
  return parsed.toString();
}

const SCRATCH_DB = 'servgrid_service_calls_test';
const PASSWORD = 'sc-plain-copier-71';

let admin: Pool;
let db: Pool;
let app: FastifyInstance;
let config: Config;

const OWNER = { username: '', id: '', token: '' };
let serviceId = '';
const DISPATCHER = { username: '', id: '', token: '' };
const TECH = { username: '', id: '', token: '' };
const SALES_REP = { username: '', id: '', token: '' };

async function seedEmployee(
  role: 'owner' | 'dispatcher' | 'technician' | 'sales_rep',
  who: { username: string; id: string; token: string },
): Promise<void> {
  const username = `t23.${role}.${randomBytes(4).toString('hex')}`;
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

/** A customer, with the minimum the table insists on. */
async function seedCustomer(name: string): Promise<string> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO customers (name, phone, area) VALUES ($1, $2, $3) RETURNING id`,
    [name, `9${randomBytes(4).readUInt32BE(0).toString().slice(0, 9)}`, 'Test Area'],
  );
  return r.rows[0]!.id;
}

/**
 * A job for a customer, completed `monthsAgo` months back (or left open),
 * written straight to the table: a completion through the API would drag in
 * the whole assignment/completion machinery this suite is not about.
 */
async function seedJob(
  customerId: string,
  options: { monthsAgo?: number; status?: 'completed' | 'assigned'; title?: string } = {},
): Promise<void> {
  const status = options.status ?? 'completed';
  const closed =
    options.monthsAgo === undefined
      ? 'NULL'
      : `(now() - (interval '1 month' * ${options.monthsAgo}) - interval '1 day')`;
  // A plain unique number: the business-number sequence belongs to the
  // create path this suite deliberately does not drive. The table's own
  // coherence constraints decide the closed_at column — closed means
  // closed.
  await db.query(
    `INSERT INTO job_cards (job_number, customer_id, service_id, title, status, assigned_to, assigned_at, closed_at, created_by)
     VALUES ($5, $1, $6, $2, $3::job_status, $7, CASE WHEN $8 THEN now() ELSE NULL END, ${closed}, $4)`,
    [
      customerId,
      options.title ?? 'Service visit',
      status,
      OWNER.id,
      `JC-TEST-${randomBytes(4).toString('hex')}`,
      serviceId,
      // Both statuses this suite seeds are held by somebody.
      TECH.id,
      true,
    ],
  );
}

/** An open job: the site has somebody coming, so nobody should ring them. */
async function seedOpenJob(customerId: string): Promise<void> {
  await seedJob(customerId, { status: 'assigned' });
}

async function getCalls(token: string, query = '') {
  return app.inject({
    method: 'GET',
    url: `/v1/service-calls${query}`,
    headers: { authorization: `Bearer ${token}`, 'x-client-source': 'mobile' },
  });
}

async function postCall(token: string, customerId: string, body: Record<string, unknown>) {
  return app.inject({
    method: 'POST',
    url: `/v1/customers/${customerId}/follow-ups`,
    headers: { authorization: `Bearer ${token}`, 'x-client-source': 'mobile' },
    payload: body,
  });
}

/** `YYYY-MM-DD`, `offset` days from today's business date. */
async function businessDay(offset: number): Promise<string> {
  const r = await db.query<{ d: string }>(`SELECT (business_date(now()) + $1::int)::text AS d`, [offset]);
  return r.rows[0]!.d;
}

function envelopeOf(status: number, body: string): ErrorEnvelope['error'] {
  expect(status).toBeGreaterThanOrEqual(400);
  const parsed = errorEnvelopeSchema.parse(JSON.parse(body)) as unknown as ErrorEnvelope;
  const error = parsed.error;
  expect(error.requestId).toMatch(ULID);
  return error;
}

function idsOf(list: { customerId: string }[]): string[] {
  return list.map((row) => row.customerId);
}

beforeAll(async () => {
  admin = new Pool({ connectionString: adminUrlFor(databaseUrl()) });
  await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${SCRATCH_DB}`);

  const scratch = new URL(databaseUrl());
  scratch.pathname = `/${SCRATCH_DB}`;
  // The app reads the scratch database, not the dev one: the config is
  // built AFTER the URL is swapped (the money-leak suite's own order).
  process.env.DATABASE_URL = scratch.toString();
  config = loadConfig(validEnv({ DATABASE_URL: scratch.toString() }));
  db = new Pool({ connectionString: scratch.toString() });
  await runMigrations({ pool: db });

  app = await buildServer(config);
  await app.ready();

  const svc = await db.query<{ id: string }>(
    `INSERT INTO services (code, name, default_charge) VALUES ($1, $2, $3) RETURNING id`,
    [`sc-${randomBytes(4).toString('hex')}`, 'Service call test', '750.00'],
  );
  serviceId = svc.rows[0]!.id;

  await seedEmployee('owner', OWNER);
  await seedEmployee('dispatcher', DISPATCHER);
  await seedEmployee('technician', TECH);
  await seedEmployee('sales_rep', SALES_REP);
}, 60_000);

afterAll(async () => {
  await app?.close();
  await closePool();
  await db?.end();
  await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
  await admin.end();
});

describe('service calls (§D7)', () => {
  it('is due six months after the last completed job — and not a day earlier', async () => {
    const served = await seedCustomer('Six Months Ago');
    await seedJob(served, { monthsAgo: 6, title: 'Battery swap' });
    const early = await seedCustomer('Five Months Ago');
    await seedJob(early, { monthsAgo: 5 });

    const res = await getCalls(DISPATCHER.token);
    expect(res.statusCode, res.body).toBe(200);
    const body = serviceCallsResponseSchema.parse(res.json());
    expect(idsOf(body.due)).toContain(served);
    expect(idsOf(body.due)).not.toContain(early);

    const row = body.due.find((c) => c.customerId === served)!;
    expect(row.lastJobTitle).toBe('Battery swap');
    expect(row.openJobs).toBe(0);
    // Six months on, the reminder is at least a day old.
    expect(row.daysDue).toBeGreaterThanOrEqual(0);
    expect(row.remindOn).toBe(row.dueOn);
  });

  it('never calls a customer who already has somebody coming', async () => {
    const booked = await seedCustomer('Already Booked');
    await seedJob(booked, { monthsAgo: 7 });
    await seedOpenJob(booked);

    const res = await getCalls(DISPATCHER.token);
    const body = serviceCallsResponseSchema.parse(res.json());
    expect(idsOf(body.due)).not.toContain(booked);
  });

  it('has nothing to say about a customer nobody has served', async () => {
    const fresh = await seedCustomer('Never Served');
    const res = await getCalls(DISPATCHER.token);
    const body = serviceCallsResponseSchema.parse(res.json());
    expect(idsOf(body.due)).not.toContain(fresh);
    expect(idsOf(body.pushed)).not.toContain(fresh);

    // …and a call logged against them is refused, not stored.
    const refused = await postCall(DISPATCHER.token, fresh, { outcome: 'called', note: 'Rang them' });
    expect(envelopeOf(refused.statusCode, refused.body).code).toBe('NOT_FOUND');
  });

  it('a push-back moves the reminder out of the due list and into the pushed one', async () => {
    const pushedOut = await seedCustomer('Push Me Back');
    await seedJob(pushedOut, { monthsAgo: 6 });

    const nextCallOn = await businessDay(90);
    const created = await postCall(DISPATCHER.token, pushedOut, {
      outcome: 'called',
      note: 'Not this month — asked for December',
      nextCallOn,
    });
    expect(created.statusCode, created.body).toBe(200);
    const call = ServiceCallSchema.parse(created.json());
    expect(call.pushedTo).toBe(nextCallOn);
    expect(call.remindOn).toBe(nextCallOn);
    expect(call.lastOutcome).toBe('called');
    expect(call.lastNote).toBe('Not this month — asked for December');
    expect(call.lastCalledBy).toContain('Test t23.dispatcher');

    const after = serviceCallsResponseSchema.parse((await getCalls(DISPATCHER.token)).json());
    expect(idsOf(after.due)).not.toContain(pushedOut);
    expect(idsOf(after.pushed)).toContain(pushedOut);
  });

  it('a push-back can never pull a reminder IN — the later date wins', async () => {
    const farOut = await seedCustomer('Due Later');
    // Served two months ago: due in four months.
    await seedJob(farOut, { monthsAgo: 2 });

    // A call that asks to ring them much sooner does not make them due.
    await postCall(DISPATCHER.token, farOut, { outcome: 'no_answer', nextCallOn: await businessDay(3) });

    const body = serviceCallsResponseSchema.parse((await getCalls(DISPATCHER.token)).json());
    expect(idsOf(body.due)).not.toContain(farOut);
    expect(idsOf(body.pushed)).not.toContain(farOut);
    const row = [...body.due, ...body.pushed].find((c) => c.customerId === farOut);
    expect(row).toBeUndefined();
  });

  it('a new completed job starts the cycle again and retires the old call', async () => {
    const serviced = await seedCustomer('Serviced Again');
    await seedJob(serviced, { monthsAgo: 8 });
    await postCall(DISPATCHER.token, serviced, { outcome: 'called', nextCallOn: await businessDay(90) });

    // The visit happens: a completion newer than the call.
    await seedJob(serviced, { monthsAgo: 0 });

    const body = serviceCallsResponseSchema.parse((await getCalls(DISPATCHER.token)).json());
    expect(idsOf(body.due)).not.toContain(serviced);
    expect(idsOf(body.pushed)).not.toContain(serviced);
  });

  it('a push-back that has arrived brings the customer back to the due list', async () => {
    const returning = await seedCustomer('Coming Back');
    await seedJob(returning, { monthsAgo: 9 });
    // Yesterday's promise: the reminder is due again today.
    await postCall(DISPATCHER.token, returning, { outcome: 'called', nextCallOn: await businessDay(-1) });

    const body = serviceCallsResponseSchema.parse((await getCalls(DISPATCHER.token)).json());
    expect(idsOf(body.due)).toContain(returning);
    expect(idsOf(body.pushed)).not.toContain(returning);
  });

  it('refuses a call that records nothing, and one that says nothing about what happened', async () => {
    const customer = await seedCustomer('Silent Call');
    await seedJob(customer, { monthsAgo: 6 });

    const empty = await postCall(DISPATCHER.token, customer, { outcome: 'called' });
    expect(envelopeOf(empty.statusCode, empty.body).code).toBe('VALIDATION_FAILED');

    const badOutcome = await postCall(DISPATCHER.token, customer, { outcome: 'rang_them' });
    expect(envelopeOf(badOutcome.statusCode, badOutcome.body).code).toBe('VALIDATION_FAILED');

    // A note alone is enough — that is how a cycle closes without a job.
    const noteOnly = await postCall(DISPATCHER.token, customer, { outcome: 'not_interested', note: 'Bought elsewhere' });
    expect(noteOnly.statusCode, noteOnly.body).toBe(200);
    expect(ServiceCallSchema.parse(noteOnly.json()).pushedTo).toBeNull();
  });

  it('the page is the office’s — a technician and a rep are refused before any row is read', async () => {
    for (const who of [TECH, SALES_REP]) {
      const listed = await getCalls(who.token);
      expect(envelopeOf(listed.statusCode, listed.body).code).toBe('FORBIDDEN');
    }
    const customer = await seedCustomer('Not Yours');
    await seedJob(customer, { monthsAgo: 6 });
    for (const who of [TECH, SALES_REP]) {
      const written = await postCall(who.token, customer, { outcome: 'called', note: 'Hello' });
      expect(envelopeOf(written.statusCode, written.body).code).toBe('FORBIDDEN');
    }
    // The owner may do both: he covers the desk.
    expect((await getCalls(OWNER.token)).statusCode).toBe(200);
  });
});
