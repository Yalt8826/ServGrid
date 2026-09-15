import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import type { FastifyInstance } from 'fastify';
import {
  errorEnvelopeSchema,
  jobTimelineDispatcherResponseSchema,
  technicianWorkResponseSchema,
  type ErrorEnvelope,
  type JobStatus,
  type LoginResponse,
} from '@servgrid/shared';
import { loadConfig, type Config } from '../../src/config.js';
import { closePool } from '../../src/db/pool.js';
import { runMigrations } from '../../src/db/migrate.js';
import { hashPassword } from '../../src/lib/password.js';
import { buildServer } from '../../src/server.js';
import { ULID, validEnv } from '../helpers/env.js';

/**
 * The technician's online reads (PHASE-ON-ONLINE.md TON.1, PLAN-BACKEND.md
 * §7). The app stores nothing, so these two reads are everything his
 * screens render. Runs against a scratch database built from the real
 * migrations (§14: no mocked database anywhere):
 *
 *  - `GET /v1/technician/work` is HIS working set — his jobs, the sites
 *    they are at, the catalogue — and a job reassigned away is simply
 *    absent from the next read (the offline mirror needed a tombstone);
 *  - `GET /v1/jobs/:id/events` is open to him for his own job only;
 *  - completion goes to `/v1/jobs/:id/complete`. The queued app sent
 *    `/completions`, which never existed — pinned here so it cannot recur.
 */

function databaseUrl(): string {
  return process.env.DATABASE_URL ?? 'postgres://servgrid:servgrid@localhost:5432/servgrid';
}

function adminUrlFor(url: string): string {
  const parsed = new URL(url);
  parsed.pathname = '/postgres';
  return parsed.toString();
}

const SCRATCH_DB = 'servgrid_technician_work_test';
const PASSWORD = 'work-plain-copier-71';

let admin: Pool;
let db: Pool;
let app: FastifyInstance;
let config: Config;

interface Actor {
  username: string;
  id: string;
  token: string;
}

const OWNER: Actor = { username: '', id: '', token: '' };
const TECH_A: Actor = { username: '', id: '', token: '' };
const TECH_B: Actor = { username: '', id: '', token: '' };
const DISPATCHER: Actor = { username: '', id: '', token: '' };
const SALES_REP: Actor = { username: '', id: '', token: '' };

async function seedEmployee(role: 'owner' | 'dispatcher' | 'technician' | 'sales_rep', who: Actor): Promise<void> {
  const username = `ton1.${role}.${randomBytes(4).toString('hex')}`;
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

const CUSTOMER_A = { id: '', name: 'TON.1 Customer A' };
const CUSTOMER_B = { id: '', name: 'TON.1 Customer B' };
const CUSTOMER_C = { id: '', name: 'TON.1 Customer C' };
const SERVICE = { id: '' };
const PRODUCT = { id: '' };

async function seedCustomer(who: { id: string; name: string }): Promise<void> {
  who.id = (
    await db.query<{ id: string }>(`INSERT INTO customers (name, phone) VALUES ($1, $2) RETURNING id`, [
      who.name,
      `9840${randomBytes(4).toString('hex')}`.slice(0, 10),
    ])
  ).rows[0]!.id;
}

async function seedJob(overrides: { status?: JobStatus; assignedTo?: string; customer?: { id: string } } = {}): Promise<string> {
  const status = overrides.status ?? 'assigned';
  const r = await db.query<{ id: string }>(
    `INSERT INTO job_cards (job_number, customer_id, service_id, title, status, assigned_to, assigned_at, closed_at, scheduled_for)
     VALUES ($1, $2, $3, 'TON.1 job', $4, $5, $6, $7, $8) RETURNING id`,
    [
      `JC-TON1-${randomBytes(4).toString('hex')}`,
      (overrides.customer ?? CUSTOMER_A).id,
      SERVICE.id,
      status,
      status === 'unassigned' ? null : (overrides.assignedTo ?? TECH_A.id),
      status === 'unassigned' ? null : new Date().toISOString(),
      // job_closed_coherent: terminal exactly when closed_at is set.
      status === 'completed' || status === 'cancelled' ? new Date().toISOString() : null,
      new Date().toISOString(),
    ],
  );
  return r.rows[0]!.id;
}

function bearer(actor: Actor): Record<string, string> {
  return { authorization: `Bearer ${actor.token}` };
}

function getWork(actor: Actor) {
  return app.inject({ method: 'GET', url: '/v1/technician/work', headers: bearer(actor) });
}

function envelopeOf(status: number, body: string): ErrorEnvelope['error'] {
  expect(status).toBeGreaterThanOrEqual(400);
  const parsed = errorEnvelopeSchema.parse(JSON.parse(body)) as unknown as ErrorEnvelope;
  expect(parsed.error.requestId).toMatch(ULID);
  return parsed.error;
}

beforeAll(async () => {
  admin = new Pool({ connectionString: adminUrlFor(databaseUrl()), max: 2 });
  await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${SCRATCH_DB}`);

  const scratchUrl = new URL(databaseUrl());
  scratchUrl.pathname = `/${SCRATCH_DB}`;
  // The services read through the process-wide pool (db/pool.ts); point it
  // at the scratch database before the first request.
  process.env.DATABASE_URL = scratchUrl.toString();
  db = new Pool({ connectionString: scratchUrl.toString(), max: 5 });
  await runMigrations({ pool: db });

  config = loadConfig(validEnv({ DATABASE_URL: scratchUrl.toString() }));
  app = buildServer(config, { logger: false });
  await app.ready();

  for (const customer of [CUSTOMER_A, CUSTOMER_B, CUSTOMER_C]) await seedCustomer(customer);
  SERVICE.id = (
    await db.query<{ id: string }>(`INSERT INTO services (code, name) VALUES ($1, 'TON.1 suite service') RETURNING id`, [
      `TON1-SVC-${randomBytes(3).toString('hex')}`,
    ])
  ).rows[0]!.id;
  PRODUCT.id = (
    await db.query<{ id: string }>(`INSERT INTO products (sku, name, category) VALUES ($1, 'TON.1 suite UPS', 'ups') RETURNING id`, [
      `TON1-SKU-${randomBytes(3).toString('hex')}`,
    ])
  ).rows[0]!.id;

  await seedEmployee('owner', OWNER);
  await seedEmployee('technician', TECH_A);
  await seedEmployee('technician', TECH_B);
  await seedEmployee('dispatcher', DISPATCHER);
  await seedEmployee('sales_rep', SALES_REP);

  // The job screens ship dark (PLAN-EXECUTION.md §3): the suite turns them
  // on for its two technicians the way the owner's flip would.
  await db.query(
    `INSERT INTO employee_flag_overrides (employee_id, flag, enabled)
     SELECT id, 'tech.jobs', true FROM employees WHERE id IN ($1, $2)`,
    [TECH_A.id, TECH_B.id],
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

describe('GET /v1/technician/work — his working set, read online', () => {
  it('contains his open and recently closed jobs, the customers they touch and the catalogue — never another technician’s', async () => {
    const hisOpen = await seedJob({ status: 'in_progress' });
    const hisClosed = await seedJob({ status: 'completed' });
    const theirs = await seedJob({ status: 'assigned', assignedTo: TECH_B.id, customer: CUSTOMER_B });

    const res = await getWork(TECH_A);
    expect(res.statusCode, res.body).toBe(200);
    const body = technicianWorkResponseSchema.parse(res.json());

    const jobIds = body.jobs.map((j) => j.id);
    expect(jobIds).toContain(hisOpen);
    expect(jobIds).toContain(hisClosed);
    expect(jobIds).not.toContain(theirs);
    expect(body.jobs.every((j) => j.contract === null)).toBe(true); // Phase 2B shape, present and null
    // closedAt dates "done today" now that nothing is stamped on the handset.
    expect(body.jobs.find((j) => j.id === hisClosed)!.closedAt).not.toBeNull();
    expect(body.jobs.find((j) => j.id === hisOpen)!.closedAt).toBeNull();

    const customerIds = body.customers.map((c) => c.id);
    expect(customerIds).toContain(CUSTOMER_A.id);
    expect(customerIds).not.toContain(CUSTOMER_B.id); // only TECH_B works there
    expect(customerIds).not.toContain(CUSTOMER_C.id); // he has no job there at all

    expect(body.products.map((p) => p.id)).toContain(PRODUCT.id);
    expect(body.services.map((s) => s.id)).toContain(SERVICE.id);
    expect(res.json()).not.toHaveProperty('cursor');
  });

  it('a job reassigned away is simply absent from his next read — and so is a site he no longer has work at', async () => {
    const site = { id: '', name: 'TON.1 Customer D (reassignment)' };
    await seedCustomer(site);
    const job = await seedJob({ status: 'in_progress', customer: site });

    const before = technicianWorkResponseSchema.parse((await getWork(TECH_A)).json());
    expect(before.jobs.map((j) => j.id)).toContain(job);
    expect(before.customers.map((c) => c.id)).toContain(site.id);

    await db.query(`UPDATE job_cards SET assigned_to = $2, assigned_at = now() WHERE id = $1`, [job, TECH_B.id]);

    const after = technicianWorkResponseSchema.parse((await getWork(TECH_A)).json());
    expect(after.jobs.map((j) => j.id)).not.toContain(job);
    expect(after.customers.map((c) => c.id)).not.toContain(site.id);
    // ...and it is on the new technician's list straight away.
    const hers = technicianWorkResponseSchema.parse((await getWork(TECH_B)).json());
    expect(hers.jobs.map((j) => j.id)).toContain(job);
  });

  it('a soft-deleted customer is absent from the next read', async () => {
    await seedJob({ status: 'assigned', customer: CUSTOMER_C });
    const before = technicianWorkResponseSchema.parse((await getWork(TECH_A)).json());
    expect(before.customers.map((c) => c.id)).toContain(CUSTOMER_C.id);

    await db.query(`UPDATE customers SET is_active = false WHERE id = $1`, [CUSTOMER_C.id]);

    const after = technicianWorkResponseSchema.parse((await getWork(TECH_A)).json());
    expect(after.customers.map((c) => c.id)).not.toContain(CUSTOMER_C.id);
  });

  it('is the technician’s alone: dispatcher, sales rep and owner are 403, an anonymous caller 401', async () => {
    for (const who of [DISPATCHER, SALES_REP, OWNER]) {
      const res = await getWork(who);
      expect(res.statusCode, res.body).toBe(403);
      expect(envelopeOf(res.statusCode, res.body).code).toBe('FORBIDDEN');
    }
    const anon = await app.inject({ method: 'GET', url: '/v1/technician/work' });
    expect(envelopeOf(anon.statusCode, anon.body).code).toBe('UNAUTHENTICATED');
  });

  it('tech.jobs off closes it with FLAG_DISABLED', async () => {
    await db.query(`UPDATE employee_flag_overrides SET enabled = false WHERE employee_id = $1 AND flag = 'tech.jobs'`, [TECH_B.id]);
    const res = await getWork(TECH_B);
    expect(res.statusCode, res.body).toBe(409);
    expect(envelopeOf(res.statusCode, res.body).code).toBe('FLAG_DISABLED');
    await db.query(`UPDATE employee_flag_overrides SET enabled = true WHERE employee_id = $1 AND flag = 'tech.jobs'`, [TECH_B.id]);
  });
});

describe('GET /v1/jobs/:id/events — the technician reads his own job’s trail', () => {
  it('his own job: the trail arrives in the office’s money-free shape, with no completion block', async () => {
    const job = await seedJob({ status: 'en_route' });
    await db.query(
      `INSERT INTO job_events (job_card_id, event_type, actor_id, occurred_at, from_status, to_status, source)
       VALUES ($1, 'status_changed', $2, now(), 'assigned', 'en_route', 'mobile')`,
      [job, TECH_A.id],
    );

    const res = await app.inject({ method: 'GET', url: `/v1/jobs/${job}/events`, headers: bearer(TECH_A) });
    expect(res.statusCode, res.body).toBe(200);
    const body = jobTimelineDispatcherResponseSchema.parse(res.json());
    expect(body.events.map((e) => e.toStatus)).toContain('en_route');
    expect(res.json()).not.toHaveProperty('completion');
  });

  it('another technician’s job is OUT_OF_SCOPE, an unknown job NOT_FOUND, a sales rep FORBIDDEN', async () => {
    const theirs = await seedJob({ status: 'assigned', assignedTo: TECH_B.id, customer: CUSTOMER_B });

    const other = await app.inject({ method: 'GET', url: `/v1/jobs/${theirs}/events`, headers: bearer(TECH_A) });
    expect(other.statusCode, other.body).toBe(403);
    expect(envelopeOf(other.statusCode, other.body).code).toBe('OUT_OF_SCOPE');

    const unknown = await app.inject({ method: 'GET', url: `/v1/jobs/${randomUUID()}/events`, headers: bearer(TECH_A) });
    expect(unknown.statusCode, unknown.body).toBe(404);
    expect(envelopeOf(unknown.statusCode, unknown.body).code).toBe('NOT_FOUND');

    const rep = await app.inject({ method: 'GET', url: `/v1/jobs/${theirs}/events`, headers: bearer(SALES_REP) });
    expect(rep.statusCode, rep.body).toBe(403);
    expect(envelopeOf(rep.statusCode, rep.body).code).toBe('FORBIDDEN');
  });
});

describe('the completion path', () => {
  it('POST /v1/jobs/:id/completions does not exist — the path the queued app used; /complete completes his job', async () => {
    const job = await seedJob({ status: 'in_progress' });
    const payload = { completedAt: new Date().toISOString(), workSummary: 'Replaced the battery bank', collectionMode: 'none' };

    const wrong = await app.inject({
      method: 'POST',
      url: `/v1/jobs/${job}/completions`,
      headers: { ...bearer(TECH_A), 'x-client-source': 'mobile' },
      payload,
    });
    expect(wrong.statusCode, wrong.body).toBe(404);

    const right = await app.inject({
      method: 'POST',
      url: `/v1/jobs/${job}/complete`,
      headers: { ...bearer(TECH_A), 'x-client-source': 'mobile', 'idempotency-key': randomUUID() },
      payload,
    });
    expect(right.statusCode, right.body).toBe(200);
    const row = await db.query<{ status: string }>('SELECT status::text AS status FROM job_cards WHERE id = $1', [job]);
    expect(row.rows[0]!.status).toBe('completed');
  });
});
