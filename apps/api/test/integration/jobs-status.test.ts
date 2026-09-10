import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import type { FastifyInstance } from 'fastify';
import {
  errorEnvelopeSchema,
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
import { OCCURRED_AT_MAX_AGE_DAYS } from '../../src/modules/jobs/service.js';
import { ULID, validEnv } from '../helpers/env.js';

/**
 * Job status transitions (PHASE-1-TECHNICIAN.md T1.5, PLAN-BACKEND.md
 * §6.1/§6.3). Runs against a scratch database built from the real
 * migrations (§14: no mocked database anywhere) and drives
 * `POST /v1/jobs/:id/status` over HTTP, because the clamp, the row lock
 * and the `job_events` trail are exactly what a mock cannot prove.
 *
 * The §6.1 graph itself lives in `packages/shared` and is enumerated
 * there (status.test.ts); what this suite enumerates is the *endpoint*:
 * every status × status pair is attempted, the three stepper moves are
 * the only ones accepted, and every other pair — including the
 * graph-legal rows that belong to complete/cancel/assign — is refused
 * `409 ILLEGAL_TRANSITION`.
 */

function databaseUrl(): string {
  return process.env.DATABASE_URL ?? 'postgres://servgrid:servgrid@localhost:5432/servgrid';
}

function adminUrlFor(url: string): string {
  const parsed = new URL(url);
  parsed.pathname = '/postgres';
  return parsed.toString();
}

const SCRATCH_DB = 'servgrid_jobs_status_test';
const PASSWORD = 'mv-plain-copier-63';

let admin: Pool;
let db: Pool;
let app: FastifyInstance;
let config: Config;

const OWNER = { username: '', id: '', token: '' };
const TECH_A = { username: '', id: '', token: '' };
const TECH_B = { username: '', id: '', token: '' };
const DISPATCHER = { username: '', id: '', token: '' };
const SALES_REP = { username: '', id: '', token: '' };

async function seedEmployee(
  role: 'owner' | 'dispatcher' | 'technician' | 'sales_rep',
  who: { username: string; id: string; token: string },
): Promise<void> {
  const username = `t15.${role}.${randomBytes(4).toString('hex')}`;
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
let serviceId = '';

async function seedJob(status: JobStatus, assignedTo: string | null = TECH_A.id): Promise<string> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO job_cards (job_number, customer_id, service_id, title, status, assigned_to, assigned_at, closed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [
      `JC-T15-${randomBytes(4).toString('hex')}`,
      customerId,
      serviceId,
      `T1.5 job ${status}`,
      status,
      status === 'unassigned' ? null : assignedTo,
      status === 'unassigned' ? null : new Date().toISOString(),
      // job_closed_coherent: terminal exactly when closed_at is set.
      status === 'completed' || status === 'cancelled' ? new Date().toISOString() : null,
    ],
  );
  return r.rows[0]!.id;
}

interface EventRow {
  event_type: string;
  actor_id: string | null;
  occurred_at: Date;
  from_status: JobStatus;
  to_status: JobStatus;
  source: string;
  payload: Record<string, unknown> | null;
}

async function latestEvent(jobId: string): Promise<EventRow | null> {
  const r = await db.query<EventRow>(
    `SELECT event_type, actor_id, occurred_at, from_status, to_status, source, payload
     FROM job_events WHERE job_card_id = $1 ORDER BY id DESC LIMIT 1`,
    [jobId],
  );
  return r.rows[0] ?? null;
}

function envelopeOf(status: number, body: string): ErrorEnvelope['error'] {
  expect(status).toBeGreaterThanOrEqual(400);
  const parsed = errorEnvelopeSchema.parse(JSON.parse(body)) as unknown as ErrorEnvelope;
  const error = parsed.error;
  expect(error.requestId).toMatch(ULID);
  return error;
}

function postStatus(token: string, jobId: string, body: Record<string, unknown>) {
  return app.inject({
    method: 'POST',
    url: `/v1/jobs/${jobId}/status`,
    headers: { authorization: `Bearer ${token}`, 'x-client-source': 'mobile' },
    payload: body,
  });
}

function sent(daysAgoSeconds = 60): string {
  return new Date(Date.now() - daysAgoSeconds * 1000).toISOString();
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

  customerId = (
    await db.query<{ id: string }>(
      `INSERT INTO customers (name, phone) VALUES ('T1.5 Customer', '9840000001') RETURNING id`,
    )
  ).rows[0]!.id;
  serviceId = (
    await db.query<{ id: string }>(
      `INSERT INTO services (code, name) VALUES ('T1.5-SVC', 'T1.5 suite service') RETURNING id`,
    )
  ).rows[0]!.id;

  await seedEmployee('owner', OWNER);
  await seedEmployee('technician', TECH_A);
  await seedEmployee('technician', TECH_B);
  await seedEmployee('dispatcher', DISPATCHER);
  await seedEmployee('sales_rep', SALES_REP);
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

describe('the stepper moves — the transitions /status carries (§6.1, §6.3)', () => {
  it('a technician moves his own job assigned → en_route', async () => {
    const jobId = await seedJob('assigned');
    const when = sent();
    const res = await postStatus(TECH_A.token, jobId, { to: 'en_route', occurredAt: when });
    expect(res.statusCode, res.body).toBe(200);

    const body = res.json();
    expect(body.status).toBe('en_route');
    // The response is the technician's card, and only that shape.
    const card = JobCardTechnicianSchema.parse(body);
    expect(card.id).toBe(jobId);

    const row = await db.query<{ status: JobStatus; version: number }>(
      'SELECT status, version FROM job_cards WHERE id = $1',
      [jobId],
    );
    expect(row.rows[0]!.status).toBe('en_route');
    // The touch trigger counted a real business change.
    expect(row.rows[0]!.version).toBe(2);

    const event = await latestEvent(jobId);
    expect(event).toMatchObject({
      event_type: 'status_changed',
      actor_id: TECH_A.id,
      from_status: 'assigned',
      to_status: 'en_route',
      source: 'mobile',
    });
    // A fresh occurredAt is recorded as sent, not as received.
    expect(new Date(event!.occurred_at).toISOString()).toBe(when);
    expect(event!.payload).toBeNull();
  });

  it('a technician moves his own job en_route → in_progress', async () => {
    const jobId = await seedJob('en_route');
    const res = await postStatus(TECH_A.token, jobId, { to: 'in_progress', occurredAt: sent() });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().status).toBe('in_progress');
    expect(JobCardTechnicianSchema.parse(res.json()).status).toBe('in_progress');
  });

  it('assigned → in_progress directly — en_route is skippable, nobody lies to the app', async () => {
    const jobId = await seedJob('assigned');
    const res = await postStatus(TECH_A.token, jobId, { to: 'in_progress', occurredAt: sent() });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().status).toBe('in_progress');
  });

  it('the owner steps a job on any technician’s behalf', async () => {
    const jobId = await seedJob('assigned', TECH_B.id);
    const res = await postStatus(OWNER.token, jobId, { to: 'en_route', occurredAt: sent() });
    expect(res.statusCode, res.body).toBe(200);
    // The owner reads his own shape — money columns present (null on an
    // open job), never the technician's narrower card.
    const body = res.json();
    expect(body.status).toBe('en_route');
    expect(JobCardOwnerSchema.parse(body).cost).toBeNull();
  });
});

// The §6.3 endpoints own the other rows: assignment (assign), completion
// (complete), cancellation (cancel). /status carries only the stepper, so
// the full enumeration below asserts 36 from×to pairs minus those three.
const STEPPER_MOVES = new Set([
  'assigned>en_route',
  'assigned>in_progress',
  'en_route>in_progress',
]);

const ALL_STATUSES: readonly JobStatus[] = [
  'unassigned',
  'assigned',
  'en_route',
  'in_progress',
  'completed',
  'cancelled',
];

describe('the full enumeration — every illegal move refused 409 ILLEGAL_TRANSITION', () => {
  let jobsByStatus: Map<JobStatus, string>;

  beforeAll(async () => {
    jobsByStatus = new Map();
    for (const status of ALL_STATUSES) {
      jobsByStatus.set(status, await seedJob(status, TECH_A.id));
    }
  });

  it('every from × to pair the endpoint does not carry is refused, status left alone', async () => {
    const refusals: string[] = [];
    for (const from of ALL_STATUSES) {
      for (const to of ALL_STATUSES) {
        if (STEPPER_MOVES.has(`${from}>${to}`)) continue;
        const jobId = jobsByStatus.get(from)!;
        const res = await postStatus(OWNER.token, jobId, { to, occurredAt: sent() });
        if (res.statusCode !== 409) {
          refusals.push(`${from}>${to} answered ${res.statusCode} ${res.body}`);
          continue;
        }
        expect(envelopeOf(res.statusCode, res.body).code).toBe('ILLEGAL_TRANSITION');
        // A refusal writes no event and moves nothing.
        expect(await latestEvent(jobId)).toBeNull();
        const row = await db.query<{ status: JobStatus }>('SELECT status FROM job_cards WHERE id = $1', [jobId]);
        expect(row.rows[0]!.status).toBe(from);
      }
    }
    expect(refusals).toEqual([]);
  });

  it('the graph-legal rows that belong to other endpoints have their door named', async () => {
    const completion = await postStatus(OWNER.token, jobsByStatus.get('in_progress')!, {
      to: 'completed',
      occurredAt: sent(),
    });
    expect(completion.statusCode).toBe(409);
    expect(envelopeOf(completion.statusCode, completion.body).message).toMatch(/complet/i);

    for (const from of ['unassigned', 'assigned', 'en_route'] as const) {
      const res = await postStatus(OWNER.token, jobsByStatus.get(from)!, {
        to: 'cancelled',
        occurredAt: sent(),
      });
      expect(res.statusCode, `${from}>cancelled`).toBe(409);
      expect(envelopeOf(res.statusCode, res.body).message).toMatch(/cancell/i);
    }

    for (const [from, to] of [
      ['unassigned', 'assigned'],
      ['assigned', 'assigned'],
      ['en_route', 'assigned'],
    ] as const) {
      const res = await postStatus(OWNER.token, jobsByStatus.get(from)!, { to, occurredAt: sent() });
      expect(res.statusCode, `${from}>${to}`).toBe(409);
      expect(envelopeOf(res.statusCode, res.body).message).toMatch(/assign/i);
    }
  });

  it('a technician is refused the same non-stepper moves on his own job', async () => {
    const assigned = await seedJob('assigned');
    const toCompleted = await postStatus(TECH_A.token, assigned, { to: 'completed', occurredAt: sent() });
    expect(toCompleted.statusCode).toBe(409);
    expect(envelopeOf(toCompleted.statusCode, toCompleted.body).code).toBe('ILLEGAL_TRANSITION');

    const enRoute = await seedJob('en_route');
    const toCancelled = await postStatus(TECH_A.token, enRoute, { to: 'cancelled', occurredAt: sent() });
    expect(toCancelled.statusCode).toBe(409);
    expect(envelopeOf(toCancelled.statusCode, toCancelled.body).code).toBe('ILLEGAL_TRANSITION');
  });
});

describe('scope and actors (§5, §6.3)', () => {
  it('a technician cannot move a job assigned to someone else — 403 OUT_OF_SCOPE', async () => {
    const jobId = await seedJob('assigned', TECH_A.id);
    const res = await postStatus(TECH_B.token, jobId, { to: 'en_route', occurredAt: sent() });
    expect(res.statusCode, res.body).toBe(403);
    expect(envelopeOf(res.statusCode, res.body).code).toBe('OUT_OF_SCOPE');
    // Nothing happened: no event, no move.
    expect(await latestEvent(jobId)).toBeNull();
    const row = await db.query<{ status: JobStatus }>('SELECT status FROM job_cards WHERE id = $1', [jobId]);
    expect(row.rows[0]!.status).toBe('assigned');
  });

  it('a dispatcher does not step cards — assignment and cancellation are his doors', async () => {
    const jobId = await seedJob('assigned');
    const res = await postStatus(DISPATCHER.token, jobId, { to: 'en_route', occurredAt: sent() });
    expect(res.statusCode, res.body).toBe(403);
    expect(envelopeOf(res.statusCode, res.body).code).toBe('FORBIDDEN');
  });

  it('a sales rep has no job surface at all', async () => {
    const jobId = await seedJob('assigned');
    const res = await postStatus(SALES_REP.token, jobId, { to: 'en_route', occurredAt: sent() });
    expect(res.statusCode, res.body).toBe(403);
    expect(envelopeOf(res.statusCode, res.body).code).toBe('FORBIDDEN');
  });
});

describe('the occurredAt clamp (§6.3: not in the future, not more than 14 days old)', () => {
  it('an occurredAt 20 days old is clamped to the 14-day floor and the clamp lands in the payload', async () => {
    const jobId = await seedJob('assigned');
    const twentyDaysAgo = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString();
    const res = await postStatus(TECH_A.token, jobId, { to: 'en_route', occurredAt: twentyDaysAgo });
    expect(res.statusCode, res.body).toBe(200);

    const event = await latestEvent(jobId)!;
    expect(event).not.toBeNull();
    const floor = Date.now() - OCCURRED_AT_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
    // The event is dated when it (supposedly) happened — clamped to the floor.
    expect(Math.abs(new Date(event!.occurred_at).getTime() - floor)).toBeLessThan(10_000);

    const payload = event!.payload as { occurredAtClamped?: { sent: string; recordedAs: string } } | null;
    expect(payload?.occurredAtClamped?.sent).toBe(twentyDaysAgo);
    expect(Math.abs(Date.parse(payload!.occurredAtClamped!.recordedAs) - floor)).toBeLessThan(10_000);
  });

  it('a future occurredAt is clamped to now', async () => {
    const jobId = await seedJob('assigned');
    const anHourAhead = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const res = await postStatus(TECH_A.token, jobId, { to: 'en_route', occurredAt: anHourAhead });
    expect(res.statusCode, res.body).toBe(200);

    const event = await latestEvent(jobId);
    expect(event).not.toBeNull();
    expect(Math.abs(new Date(event!.occurred_at).getTime() - Date.now())).toBeLessThan(10_000);
    expect((event!.payload as { occurredAtClamped: { sent: string } }).occurredAtClamped.sent).toBe(anHourAhead);
  });

  it('a fresh occurredAt is recorded as sent, with no clamp in the payload', async () => {
    const jobId = await seedJob('assigned');
    const fiveMinutesAgo = sent(5 * 60);
    const res = await postStatus(TECH_A.token, jobId, { to: 'en_route', occurredAt: fiveMinutesAgo });
    expect(res.statusCode, res.body).toBe(200);

    const event = await latestEvent(jobId);
    expect(event).not.toBeNull();
    expect(new Date(event!.occurred_at).toISOString()).toBe(fiveMinutesAgo);
    expect(event!.payload).toBeNull();
  });
});

describe('the request itself', () => {
  it('refuses an unauthenticated caller', async () => {
    const jobId = await seedJob('assigned');
    const res = await app.inject({
      method: 'POST',
      url: `/v1/jobs/${jobId}/status`,
      payload: { to: 'en_route', occurredAt: sent() },
    });
    expect(envelopeOf(res.statusCode, res.body).code).toBe('UNAUTHENTICATED');
  });

  it('rejects a body without `to`, with an unknown status, or with a bare date', async () => {
    const jobId = await seedJob('assigned');
    for (const body of [
      { occurredAt: sent() },
      { to: 'on_the_moon', occurredAt: sent() },
      { to: 'en_route', occurredAt: '2026-03-14' },
      { to: 'en_route', occurredAt: sent(), extra: true },
    ]) {
      const res = await postStatus(TECH_A.token, jobId, body);
      expect(res.statusCode, JSON.stringify(body)).toBe(422);
      expect(envelopeOf(res.statusCode, res.body).code).toBe('VALIDATION_FAILED');
    }
  });

  it('answers 404 for an unknown job and for an id that is not a uuid', async () => {
    const res = await postStatus(TECH_A.token, crypto.randomUUID(), { to: 'en_route', occurredAt: sent() });
    expect(envelopeOf(res.statusCode, res.body).code).toBe('NOT_FOUND');

    const malformed = await postStatus(TECH_A.token, 'not-a-uuid', { to: 'en_route', occurredAt: sent() });
    expect(envelopeOf(malformed.statusCode, malformed.body).code).toBe('NOT_FOUND');
  });
});
