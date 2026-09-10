import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import type { FastifyInstance } from 'fastify';
import {
  errorEnvelopeSchema,
  JobCardDispatcherSchema,
  JobCardOwnerSchema,
  JobCardTechnicianSchema,
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
 * Jobs authorisation suite (PHASE-1-TECHNICIAN.md T1.5, PLAN.md §5,
 * PLAN-BACKEND.md §6.3): the reads, per role.
 *
 * The load-bearing assertion is the T1.5 brief's own sentence: a
 * technician's `GET /v1/jobs/:id` response contains no `cost`,
 * `discount_amount` or `amount_collected` — *after his own completion*.
 * It is asserted on the serialised body (the bytes the handset parses),
 * not on a schema type; and the same request is then re-read by the
 * owner, who must see the money, so a test that accidentally passed
 * because the money row was missing cannot exist here.
 *
 * The completion is seeded exactly as §6.2's transaction would leave it
 * (job terminal + closed_at + job_completions row) — T1.6 ships the
 * endpoint; this suite needs the state, not the route.
 */

function databaseUrl(): string {
  return process.env.DATABASE_URL ?? 'postgres://servgrid:servgrid@localhost:5432/servgrid';
}

function adminUrlFor(url: string): string {
  const parsed = new URL(url);
  parsed.pathname = '/postgres';
  return parsed.toString();
}

const SCRATCH_DB = 'servgrid_authz_jobs_test';
const PASSWORD = 'mv-plain-copier-63';

/** Every field a job payload must never carry for a technician — the schema's camelCase and the DB's snake_case. */
const MONEY_KEYS = [
  'cost',
  'discount_amount',
  'discountAmount',
  'amount_collected',
  'amountCollected',
  'collection_mode',
  'collectionMode',
  'discount_reason',
  'discountReason',
] as const;

type SuiteRole = 'owner' | 'dispatcher' | 'technician' | 'sales_rep';

interface Actor {
  username: string;
  id: string;
  token: string;
}

const OWNER: Actor = { username: '', id: '', token: '' };
const DISPATCHER: Actor = { username: '', id: '', token: '' };
const TECH_A: Actor = { username: '', id: '', token: '' };
const TECH_B: Actor = { username: '', id: '', token: '' };
const SALES_REP: Actor = { username: '', id: '', token: '' };

let admin: Pool;
let db: Pool;
let app: FastifyInstance;
let config: Config;

async function seedEmployee(role: SuiteRole, who: Actor): Promise<void> {
  const username = `t15az.${role}.${randomBytes(4).toString('hex')}`;
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

let customerId = '';
let otherCustomerId = '';
let serviceId = '';

interface SeedJobOverrides {
  status?: JobStatus;
  assignedTo?: string | null;
  scheduledFor?: Date | null;
  customerId?: string;
}

async function seedJob(overrides: SeedJobOverrides = {}): Promise<string> {
  const status = overrides.status ?? 'assigned';
  const assignedTo = overrides.assignedTo === undefined ? TECH_A.id : overrides.assignedTo;
  const r = await db.query<{ id: string }>(
    `INSERT INTO job_cards (job_number, customer_id, service_id, title, status, assigned_to, assigned_at, closed_at, scheduled_for)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
    [
      `JC-AZ-${randomBytes(4).toString('hex')}`,
      overrides.customerId ?? customerId,
      serviceId,
      'Authz suite job',
      status,
      status === 'unassigned' ? null : assignedTo,
      status === 'unassigned' ? null : new Date().toISOString(),
      status === 'completed' || status === 'cancelled' ? new Date().toISOString() : null,
      overrides.scheduledFor === undefined ? null : (overrides.scheduledFor?.toISOString() ?? null),
    ],
  );
  return r.rows[0]!.id;
}

/** The completion row §6.2's transaction would have written for the job. */
async function seedCompletion(jobId: string, completedBy: string): Promise<void> {
  await db.query(
    `INSERT INTO job_completions
       (job_card_id, completed_by, completed_at, work_summary, cost, discount_amount, discount_reason, collection_mode)
     VALUES ($1, $2, $3, 'Replaced batteries, tested load.', '5000.00', '500.00', 'goodwill', 'cash')`,
    [jobId, completedBy, new Date().toISOString()],
  );
}

function bearer(actor: Actor): Record<string, string> {
  return { authorization: `Bearer ${actor.token}` };
}

function envelopeOf(status: number, body: string): ErrorEnvelope['error'] {
  expect(status).toBeGreaterThanOrEqual(400);
  const parsed = errorEnvelopeSchema.parse(JSON.parse(body)) as unknown as ErrorEnvelope;
  expect(parsed.error.requestId).toMatch(ULID);
  return parsed.error;
}

function get(actor: Actor | null, url: string) {
  return app.inject({
    method: 'GET',
    url,
    headers: actor === null ? {} : bearer(actor),
  });
}

function expectMoneyFree(serialisedBody: string, context: string): void {
  const parsed: Record<string, unknown> = JSON.parse(serialisedBody);
  for (const key of MONEY_KEYS) {
    expect(parsed, `${context}: ${key} must not exist on the body`).not.toHaveProperty(key);
  }
  // And the raw bytes the handset parses carry none of them.
  expect(serialisedBody, context).not.toMatch(new RegExp(`"(${MONEY_KEYS.join('|')})"`));
}

// J1: TECH_A, open, no date · J2: TECH_A, completed WITH money ·
// J3: TECH_B, en_route · J4: unassigned · J5: TECH_A, overdue ·
// J6: TECH_B at another customer (the `q`/customer filter's target).
const J = { j1: '', j2: '', j3: '', j4: '', j5: '', j6: '' };

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
  await seedEmployee('sales_rep', SALES_REP);

  customerId = (
    await db.query<{ id: string }>(
      `INSERT INTO customers (name, phone) VALUES ('T1.5 Authz Customer', '9840000001') RETURNING id`,
    )
  ).rows[0]!.id;
  otherCustomerId = (
    await db.query<{ id: string }>(
      `INSERT INTO customers (name, phone) VALUES ('T1.5 Authz Other Site', '9840000002') RETURNING id`,
    )
  ).rows[0]!.id;
  serviceId = (
    await db.query<{ id: string }>(
      `INSERT INTO services (code, name) VALUES ('T1.5-AZ', 'Authz suite service') RETURNING id`,
    )
  ).rows[0]!.id;

  J.j1 = await seedJob({ status: 'assigned' });
  J.j2 = await seedJob({ status: 'completed' });
  await seedCompletion(J.j2, TECH_A.id);
  J.j3 = await seedJob({ status: 'en_route', assignedTo: TECH_B.id });
  J.j4 = await seedJob({ status: 'unassigned', assignedTo: null });
  J.j5 = await seedJob({ status: 'assigned', scheduledFor: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000) });
  J.j6 = await seedJob({ status: 'assigned', assignedTo: TECH_B.id, customerId: otherCustomerId });
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

describe('GET /v1/jobs/:id — a technician never reads money, even his own completion', () => {
  it('his own completed job: the serialised body carries no cost, discount or collected amount', async () => {
    const res = await get(TECH_A, `/v1/jobs/${J.j2}`);
    expect(res.statusCode, res.body).toBe(200);

    expectMoneyFree(res.body, 'technician, own completed job');

    // The work summary survives; the money is not a trimmed afterthought —
    // the strict parse fails on any key the technician's shape does not own.
    const card = JobCardTechnicianSchema.parse(JSON.parse(res.body));
    expect(card.status).toBe('completed');
    expect(card.jobNumber).toMatch(/^JC-AZ-/);
  });

  it('his own open job reads too — own scope is present tense or closed', async () => {
    const res = await get(TECH_A, `/v1/jobs/${J.j1}`);
    expect(res.statusCode, res.body).toBe(200);
    expectMoneyFree(res.body, 'technician, own open job');
    expect(JobCardTechnicianSchema.parse(JSON.parse(res.body)).status).toBe('assigned');
  });

  it("another technician's job is 403 OUT_OF_SCOPE — completed or not", async () => {
    const res = await get(TECH_B, `/v1/jobs/${J.j2}`);
    expect(res.statusCode, res.body).toBe(403);
    expect(envelopeOf(res.statusCode, res.body).code).toBe('OUT_OF_SCOPE');
  });

  it('an unknown job is 404, a non-uuid id never reaches pg', async () => {
    const missing = await get(TECH_A, `/v1/jobs/${crypto.randomUUID()}`);
    expect(envelopeOf(missing.statusCode, missing.body).code).toBe('NOT_FOUND');
    const malformed = await get(TECH_A, '/v1/jobs/not-a-uuid');
    expect(envelopeOf(malformed.statusCode, malformed.body).code).toBe('NOT_FOUND');
  });
});

describe('GET /v1/jobs/:id — the office and the owner', () => {
  it('a dispatcher reads any job, and the dispatcher shape has no money to strip', async () => {
    const res = await get(DISPATCHER, `/v1/jobs/${J.j2}`);
    expect(res.statusCode, res.body).toBe(200);

    expectMoneyFree(res.body, 'dispatcher, completed job');
    const card = JobCardDispatcherSchema.parse(JSON.parse(res.body));
    expect(card.assignedTo).toBe(TECH_A.id);
    expect(card.customerName).toBe('T1.5 Authz Customer');
    expect(card.isOverdue).toBe(false);
    expect(card.isContractVisit).toBe(false);
  });

  it('the owner reads the same completed job and sees the money', async () => {
    const res = await get(OWNER, `/v1/jobs/${J.j2}`);
    expect(res.statusCode, res.body).toBe(200);

    const card = JobCardOwnerSchema.parse(JSON.parse(res.body));
    expect(card.cost).toBe('5000.00');
    expect(card.discountAmount).toBe('500.00');
    expect(card.discountReason).toBe('goodwill');
    expect(card.amountCollected).toBe('4500.00');
    expect(card.collectionMode).toBe('cash');
  });

  it('the owner reads an open job with the money fields present and null', async () => {
    const res = await get(OWNER, `/v1/jobs/${J.j1}`);
    expect(res.statusCode, res.body).toBe(200);
    const card = JobCardOwnerSchema.parse(JSON.parse(res.body));
    expect(card.cost).toBeNull();
    expect(card.amountCollected).toBeNull();
  });

  it('a sales rep has no job surface at all — 403 FORBIDDEN', async () => {
    const res = await get(SALES_REP, `/v1/jobs/${J.j1}`);
    expect(res.statusCode, res.body).toBe(403);
    expect(envelopeOf(res.statusCode, res.body).code).toBe('FORBIDDEN');
  });

  it('an unauthenticated caller is 401', async () => {
    const res = await get(null, `/v1/jobs/${J.j1}`);
    expect(envelopeOf(res.statusCode, res.body).code).toBe('UNAUTHENTICATED');
  });
});

describe('GET /v1/jobs — role-scoped lists (§6.3)', () => {
  it('a technician gets exactly his own jobs, completed ones included', async () => {
    const res = await get(TECH_A, '/v1/jobs');
    expect(res.statusCode, res.body).toBe(200);

    const body: { items: unknown[]; nextCursor: string | null } = JSON.parse(res.body);
    const ids = body.items.map((card) => (card as { id: string }).id).sort();
    expect(ids).toEqual([J.j1, J.j2, J.j5].sort());
    // Every item is the technician's shape (the strict parse is the proof).
    for (const item of body.items) {
      JobCardTechnicianSchema.parse(item);
      expectMoneyFree(JSON.stringify(item), 'technician list item');
    }
  });

  it('a dispatcher and the owner see every job', async () => {
    for (const actor of [DISPATCHER, OWNER]) {
      const res = await get(actor, '/v1/jobs');
      expect(res.statusCode, res.body).toBe(200);
      const ids: string[] = JSON.parse(res.body).items.map((card: { id: string }) => card.id);
      expect(ids.sort()).toEqual(Object.values(J).sort());
    }
  });

  it('a sales rep is refused the list entirely', async () => {
    const res = await get(SALES_REP, '/v1/jobs');
    expect(res.statusCode, res.body).toBe(403);
    expect(envelopeOf(res.statusCode, res.body).code).toBe('FORBIDDEN');
  });

  it('filters: status, repeated status, technicianId, customerId, overdue, q', async () => {
    const idsOf = (body: string): string[] =>
      (JSON.parse(body) as { items: Array<{ id: string }> }).items.map((card) => card.id);

    const assigned = await get(OWNER, '/v1/jobs?status=assigned');
    expect(idsOf(assigned.body).sort()).toEqual([J.j1, J.j5, J.j6].sort());

    const open = await get(OWNER, '/v1/jobs?status=assigned&status=en_route');
    expect(idsOf(open.body).sort()).toEqual([J.j1, J.j3, J.j5, J.j6].sort());

    const techB = await get(OWNER, `/v1/jobs?technicianId=${TECH_B.id}`);
    expect(idsOf(techB.body).sort()).toEqual([J.j3, J.j6].sort());

    const otherSite = await get(OWNER, `/v1/jobs?customerId=${otherCustomerId}`);
    expect(idsOf(otherSite.body)).toEqual([J.j6]);

    // Overdue is a filter, not a state: only the job whose day has passed.
    const overdue = await get(OWNER, '/v1/jobs?overdue=true');
    expect(idsOf(overdue.body)).toEqual([J.j5]);

    const search = await get(OWNER, '/v1/jobs?q=Other+Site');
    expect(idsOf(search.body)).toEqual([J.j6]);
  });

  it('cursor pagination walks the whole list without repeating or losing a row', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page += 1) {
      const url = cursor === null ? '/v1/jobs?limit=2' : `/v1/jobs?limit=2&cursor=${encodeURIComponent(cursor)}`;
      const res = await get(DISPATCHER, url);
      expect(res.statusCode, res.body).toBe(200);
      const body: { items: Array<{ id: string }>; nextCursor: string | null } = JSON.parse(res.body);
      expect(body.items.length).toBeLessThanOrEqual(2);
      seen.push(...body.items.map((card) => card.id));
      cursor = body.nextCursor;
      if (cursor === null) break;
    }
    expect(seen.sort()).toEqual(Object.values(J).sort());
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('rejects a bad filter, a bad page size and a stale cursor with 422', async () => {
    for (const url of [
      '/v1/jobs?status=bogus',
      '/v1/jobs?limit=0',
      '/v1/jobs?technicianId=not-a-uuid',
      '/v1/jobs?from=not-a-date',
      '/v1/jobs?cursor=%21%40%23', // '!@#' — not a cursor this API minted
    ]) {
      const res = await get(OWNER, url);
      expect(res.statusCode, url).toBe(422);
      expect(envelopeOf(res.statusCode, res.body).code).toBe('VALIDATION_FAILED');
    }
  });
});
