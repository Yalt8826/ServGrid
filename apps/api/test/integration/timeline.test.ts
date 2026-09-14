import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import type { FastifyInstance } from 'fastify';
import {
  errorEnvelopeSchema,
  jobTimelineDispatcherResponseSchema,
  jobTimelineOwnerResponseSchema,
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
 * GET /v1/jobs/:id/events (T4.11, PLAN-BACKEND.md §6.3 "dispatcher,
 * owner"; UI/plan-2/07-OWNER.md §O4's detail). Runs against a scratch
 * database built from the real migrations (§14: no mocked database
 * anywhere). What a mock cannot prove and this drives over HTTP:
 *
 *  - the owner's read carries the FULL trail in time order, with the
 *    `completion_amended` payload's before/after pair intact, plus the
 *    completion with its parts fitted;
 *  - the dispatcher's read is the SMALLER schema: no `completion` key at
 *    all, and the money-bearing payload visibly redacted — the same line
 *    the money-leak walk holds, proven here against the real tables;
 *  - the timeline is "dispatcher, owner": technician and sales rep are
 *    403, an unknown id is a 404 envelope.
 */

function databaseUrl(): string {
  return process.env.DATABASE_URL ?? 'postgres://servgrid:servgrid@localhost:5432/servgrid';
}

function adminUrlFor(url: string): string {
  const parsed = new URL(url);
  parsed.pathname = '/postgres';
  return parsed.toString();
}

const SCRATCH_DB = 'servgrid_timeline_test';
const PASSWORD = 'tl-plain-copier-11';

let admin: Pool;
let db: Pool;
let app: FastifyInstance;
let config: Config;

const OWNER = { username: '', id: '', token: '' };
const DISPATCHER = { username: '', id: '', token: '' };
const TECH = { username: '', id: '', token: '' };
const REP = { username: '', id: '', token: '' };

async function seedEmployee(
  role: 'owner' | 'dispatcher' | 'technician' | 'sales_rep',
  who: { username: string; id: string; token: string },
): Promise<void> {
  const username = `tl.${role}.${randomBytes(4).toString('hex')}`;
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

function bearer(actor: { token: string }): Record<string, string> {
  return { authorization: `Bearer ${actor.token}` };
}

let customerId = '';
let serviceId = '';
let jobId = '';

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
  await seedEmployee('technician', TECH);
  await seedEmployee('sales_rep', REP);

  customerId = (
    await db.query<{ id: string }>(
      `INSERT INTO customers (name, phone) VALUES ('Timeline Customer', '9847000031') RETURNING id`,
    )
  ).rows[0]!.id;
  serviceId = (
    await db.query<{ id: string }>(
      `INSERT INTO services (code, name) VALUES ('TL-SVC', 'Timeline suite service') RETURNING id`,
    )
  ).rows[0]!.id;

  jobId = (
    await db.query<{ id: string }>(
      `INSERT INTO job_cards (job_number, customer_id, service_id, title, status, assigned_to, assigned_at, closed_at)
       VALUES ($1, $2, $3, 'Timeline fixture job', 'completed', $4, $5, $5) RETURNING id`,
      [`JC-TL-${randomBytes(4).toString('hex')}`, customerId, serviceId, TECH.id, new Date().toISOString()],
    )
  ).rows[0]!.id;

  // The trail, in a known order: created → assigned → completed, then the
  // amendment whose payload is the money's before/after pair.
  const events: Array<[string, string, unknown]> = [
    ['created', minutesAgo(90), null],
    ['assigned', minutesAgo(80), null],
    ['completed', minutesAgo(60), { completedAtClamped: { sent: minutesAgo(60), recordedAs: minutesAgo(60) } }],
    [
      'completion_amended',
      minutesAgo(30),
      { reason: 'typed 5000 for 500', cost: { from: '5000.00', to: '500.00' }, discountAmount: { from: '0', to: '0' } },
    ],
  ];
  for (const [eventType, at, payload] of events) {
    await db.query(
      `INSERT INTO job_events (job_card_id, event_type, actor_id, occurred_at, from_status, to_status, source, payload)
       VALUES ($1, $2, $3, $4, 'unassigned', 'completed', 'web', $5::jsonb)`,
      [jobId, eventType, TECH.id, at, payload === null ? null : JSON.stringify(payload)],
    );
  }

  // The completion with its figures and two fitted parts — one catalogue,
  // one free-text from customer stock.
  await db.query(
    `INSERT INTO job_completions
       (job_card_id, completed_by, completed_at, work_summary, cost, discount_amount, collection_mode)
     VALUES ($1, $2, $3, 'Swapped batteries, tested load.', '500.00', '0', 'cash')`,
    [jobId, TECH.id, minutesAgo(60)],
  );
  await db.query(
    `INSERT INTO job_completion_parts (job_card_id, line_no, free_text_name, quantity, unit_cost, serial_number, from_customer_stock)
     VALUES ($1, 1, '12V 26Ah battery', '2', '1400.00', 'LM8842219', false),
            ($1, 2, 'Fuse 30A', '1', null, null, true)`,
    [jobId],
  );
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

function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

describe('GET /v1/jobs/:id/events — the owner read (§O4)', () => {
  it('carries the full trail in time order, the amendment payload intact', async () => {
    const res = await app.inject({ method: 'GET', url: `/v1/jobs/${jobId}/events`, headers: bearer(OWNER) });
    expect(res.statusCode, res.body).toBe(200);
    const body = jobTimelineOwnerResponseSchema.parse(JSON.parse(res.body));

    expect(body.events.map((e) => e.eventType)).toEqual(['created', 'assigned', 'completed', 'completion_amended']);
    // Every actor is named — "who do I ask" answered on the row.
    for (const event of body.events) {
      expect(event.actorName).not.toBeNull();
    }
    const amended = body.events[3]!;
    expect(amended.payload).toMatchObject({
      reason: 'typed 5000 for 500',
      cost: { from: '5000.00', to: '500.00' },
    });
  });

  it('carries the completion with its figures and the parts fitted', async () => {
    const res = await app.inject({ method: 'GET', url: `/v1/jobs/${jobId}/events`, headers: bearer(OWNER) });
    const body = jobTimelineOwnerResponseSchema.parse(JSON.parse(res.body));
    expect(body.completion).not.toBeNull();
    expect(body.completion?.cost).toBe('500.00');
    expect(body.completion?.amountCollected).toBe('500.00');
    expect(body.completion?.parts).toHaveLength(2);
    expect(body.completion?.parts[0]).toMatchObject({ name: '12V 26Ah battery', quantity: '2.00', unitCost: '1400.00' });
    expect(body.completion?.parts[1]).toMatchObject({ name: 'Fuse 30A', fromCustomerStock: true, unitCost: null });
  });
});

describe('GET /v1/jobs/:id/events — the dispatcher read', () => {
  it('is the smaller schema: no completion key, money payload redacted', async () => {
    const res = await app.inject({ method: 'GET', url: `/v1/jobs/${jobId}/events`, headers: bearer(DISPATCHER) });
    expect(res.statusCode, res.body).toBe(200);
    const parsed: unknown = JSON.parse(res.body);
    const body = jobTimelineDispatcherResponseSchema.parse(parsed);

    expect(body.events).toHaveLength(4);
    expect(parsed).not.toHaveProperty('completion');
    const amended = body.events.find((e) => e.eventType === 'completion_amended');
    expect(JSON.stringify(amended?.payload)).not.toContain('5000.00');
    expect(amended?.payload).toMatchObject({ redacted: expect.any(String) });
    // The other events' payloads ride through untouched (the clamp record is not money).
    const completed = body.events.find((e) => e.eventType === 'completed');
    expect(completed?.payload).toMatchObject({ completedAtClamped: expect.anything() });
  });
});

describe('GET /v1/jobs/:id/events — who may read it', () => {
  it('a technician is 403 — his trail comes from his mirror', async () => {
    const res = await app.inject({ method: 'GET', url: `/v1/jobs/${jobId}/events`, headers: bearer(TECH) });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');
  });

  it('a sales rep is 403', async () => {
    const res = await app.inject({ method: 'GET', url: `/v1/jobs/${jobId}/events`, headers: bearer(REP) });
    expect(res.statusCode).toBe(403);
  });

  it('an unknown id is a 404 envelope with a requestId', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/jobs/${randomBytes(16).toString('hex')}/events`,
      headers: bearer(OWNER),
    });
    expect(res.statusCode).toBe(404);
    const parsed = errorEnvelopeSchema.parse(JSON.parse(res.body)) as unknown as ErrorEnvelope;
    expect(parsed.error.requestId).toMatch(ULID);
  });
});
