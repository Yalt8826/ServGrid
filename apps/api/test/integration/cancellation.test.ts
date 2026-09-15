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
import { ULID, validEnv } from '../helpers/env.js';

/**
 * Cancellation and rescheduling (PHASE-1-TECHNICIAN.md T1.7,
 * PLAN-BACKEND.md §6.3, PLAN-DATA-MODEL.md §3.4). Runs against a scratch
 * database built from the real migrations (§14: no mocked database
 * anywhere) and drives the two date-writing paths over HTTP, because the
 * things this task must prove are exactly what a mock cannot prove:
 *
 *  - cancelling WITH a `rescheduleTo` raises the successor card in the
 *    SAME transaction as the cancellation — a refusal on either side
 *    leaves neither;
 *  - cancelling and rescheduling are DIFFERENT paths with DIFFERENT
 *    events: `cancelled` writes `job_cancellations` and closes the card;
 *    `rescheduled` (a PATCH of `scheduled_for` under `If-Match`) moves
 *    the very same card and touches neither status nor cancellations;
 *  - the reason rule ('other' needs a note) is the DATABASE's
 *    (`job_cancellations_other_justified`) and is surfaced as a readable
 *    422 — never a 500, never a constraint name;
 *  - the technician makes the cancel call on his OWN job, not another's.
 */

function databaseUrl(): string {
  return process.env.DATABASE_URL ?? 'postgres://servgrid:servgrid@localhost:5432/servgrid';
}

function adminUrlFor(url: string): string {
  const parsed = new URL(url);
  parsed.pathname = '/postgres';
  return parsed.toString();
}

const SCRATCH_DB = 'servgrid_cancellation_test';
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
  const username = `t17.${role}.${randomBytes(4).toString('hex')}`;
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
let amcId = '';

interface SeedJobOverrides {
  status?: JobStatus;
  assignedTo?: string | null;
  scheduledFor?: Date | null;
  contractId?: string | null;
}

async function seedJob(overrides: SeedJobOverrides = {}): Promise<string> {
  const status = overrides.status ?? 'assigned';
  const assignedTo = overrides.assignedTo === undefined ? TECH_A.id : overrides.assignedTo;
  const r = await db.query<{ id: string }>(
    `INSERT INTO job_cards (job_number, customer_id, service_id, title, status, assigned_to, assigned_at, closed_at, scheduled_for, contract_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
    [
      `JC-T17-${randomBytes(4).toString('hex')}`,
      customerId,
      serviceId,
      'T1.7 cancellation job',
      status,
      status === 'unassigned' ? null : assignedTo,
      status === 'unassigned' ? null : new Date().toISOString(),
      // job_closed_coherent: terminal exactly when closed_at is set.
      status === 'completed' || status === 'cancelled' ? new Date().toISOString() : null,
      overrides.scheduledFor === undefined ? new Date().toISOString() : (overrides.scheduledFor?.toISOString() ?? null),
      overrides.contractId ?? null,
    ],
  );
  return r.rows[0]!.id;
}

// ── request and read-back helpers ───────────────────────────────────────────

function postCancel(
  token: string,
  jobId: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
) {
  return app.inject({
    method: 'POST',
    url: `/v1/jobs/${jobId}/cancel`,
    headers: { authorization: `Bearer ${token}`, 'x-client-source': 'mobile', ...headers },
    payload: body,
  });
}

function patchJob(
  token: string,
  jobId: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
) {
  return app.inject({
    method: 'PATCH',
    url: `/v1/jobs/${jobId}`,
    headers: { authorization: `Bearer ${token}`, 'x-client-source': 'web', ...headers },
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

/** The reason rule lives in CHECK constraints; no refusal may ever echo one back. */
function expectNoConstraintLeak(body: string): void {
  expect(body).not.toMatch(/completion_|customer_products_|job_completion_parts_|job_cancellations_/);
  expect(body).not.toMatch(/23514|23505|23503|22003|check_violation|unique_violation/i);
}

/** An IST business date `days` from now — the clock `business_date()` keeps. */
function istDatePlus(days: number): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(
    new Date(Date.now() + days * 24 * 60 * 60 * 1000),
  );
}

interface CardRow {
  job_number: string;
  status: JobStatus;
  assigned_to: string | null;
  customer_id: string;
  service_id: string;
  customer_product_id: string | null;
  title: string;
  priority: string;
  scheduled_for: Date | null;
  scheduled_date: string | null;
  created_by: string | null;
  closed_at: Date | null;
  contract_visit_id: string | null;
  contract_id: string | null;
  version: number;
}

async function cardRow(jobId: string): Promise<CardRow> {
  const r = await db.query<CardRow>(
    `SELECT job_number, status, assigned_to::text, customer_id::text, service_id::text,
            customer_product_id::text, title, priority::text, scheduled_for,
            scheduled_date::text, created_by::text, closed_at, contract_visit_id::text,
            contract_id::text, version
     FROM job_cards WHERE id = $1`,
    [jobId],
  );
  return r.rows[0]!;
}

interface CancellationRow {
  cancelled_by: string;
  cancelled_at: Date;
  reason_code: string;
  reason_note: string | null;
  replacement_job_id: string | null;
}

async function cancellationRow(jobId: string): Promise<CancellationRow | null> {
  const r = await db.query<CancellationRow>(
    `SELECT cancelled_by::text, cancelled_at, reason_code::text, reason_note, replacement_job_id::text
     FROM job_cancellations WHERE job_card_id = $1`,
    [jobId],
  );
  return r.rows[0] ?? null;
}

interface EventRow {
  event_type: string;
  actor_id: string | null;
  occurred_at: Date;
  recorded_at: Date;
  from_status: JobStatus | null;
  to_status: JobStatus | null;
  source: string;
  payload: Record<string, unknown> | null;
}

async function eventsOf(jobId: string): Promise<EventRow[]> {
  const r = await db.query<EventRow>(
    `SELECT event_type, actor_id::text, occurred_at, recorded_at, from_status, to_status, source, payload
     FROM job_events WHERE job_card_id = $1 ORDER BY id`,
    [jobId],
  );
  return r.rows;
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
      `INSERT INTO customers (name, phone) VALUES ('T1.7 Customer', '9840000001') RETURNING id`,
    )
  ).rows[0]!.id;
  serviceId = (
    await db.query<{ id: string }>(
      `INSERT INTO services (code, name) VALUES ('T1.7-SVC', 'T1.7 suite service') RETURNING id`,
    )
  ).rows[0]!.id;

  await seedEmployee('owner', OWNER);
  await seedEmployee('technician', TECH_A);
  await seedEmployee('technician', TECH_B);
  await seedEmployee('dispatcher', DISPATCHER);
  await seedEmployee('sales_rep', SALES_REP);

  // The customer's AMC (T2B.3) — wide enough that the successor tests can
  // pick a day inside it and a day past its end.
  amcId = (
    await db.query<{ id: string }>(
      `INSERT INTO service_contracts
         (contract_number, customer_id, start_date, end_date, contract_value, created_by)
       VALUES ($1, $2, $3::date, $4::date, '12000.00', $5) RETURNING id`,
      [`AMC-T17-${randomBytes(4).toString('hex')}`, customerId, istDatePlus(-10), istDatePlus(500), DISPATCHER.id],
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

describe('cancel with a date — the successor card (§6.3)', () => {
  it('a technician cancels his dated job with a rescheduleTo: exactly one successor, linked, unassigned, fresh number', async () => {
    const jobId = await seedJob({ status: 'in_progress', scheduledFor: new Date(Date.now() - 26 * 60 * 60 * 1000) });
    const original = await cardRow(jobId);
    const rescheduleTo = istDatePlus(3);

    const res = await postCancel(TECH_A.token, jobId, {
      reasonCode: 'no_access',
      reasonNote: 'gate locked, customer says come Thursday',
      rescheduleTo,
    });
    expect(res.statusCode, res.body).toBe(200);
    const card = JobCardTechnicianSchema.parse(res.json());
    expect(card.status).toBe('cancelled');
    expect(card.jobNumber).toBe(original.job_number); // the response is the CANCELLED card
    expect(card.scheduledFor).toBe(original.scheduled_for!.toISOString()); // its date did not silently move

    // The cancellation row — one, by the technician, linked to the successor.
    const cancellation = await cancellationRow(jobId);
    expect(cancellation).not.toBeNull();
    expect(cancellation!.cancelled_by).toBe(TECH_A.id);
    expect(cancellation!.reason_code).toBe('no_access');
    expect(cancellation!.reason_note).toBe('gate locked, customer says come Thursday');
    expect(cancellation!.replacement_job_id).not.toBeNull();
    expect(Math.abs(cancellation!.cancelled_at.getTime() - Date.now())).toBeLessThan(10_000);

    // The successor: same customer, same service, new date, unassigned.
    const successor = await cardRow(cancellation!.replacement_job_id!);
    expect(successor.status).toBe('unassigned');
    expect(successor.assigned_to).toBeNull(); // job_assignment_coherent's unassigned half
    expect(successor.customer_id).toBe(original.customer_id);
    expect(successor.service_id).toBe(original.service_id);
    expect(successor.customer_product_id).toBe(original.customer_product_id);
    expect(successor.title).toBe(original.title);
    expect(successor.priority).toBe(original.priority);
    expect(successor.scheduled_date).toBe(rescheduleTo); // the generated IST business day IS the day asked for
    expect(successor.scheduled_for!.toISOString()).toBe(new Date(`${rescheduleTo}T00:00:00+05:30`).toISOString());
    expect(successor.created_by).toBe(TECH_A.id);
    expect(successor.closed_at).toBeNull();
    expect(successor.contract_visit_id).toBeNull();
    expect(successor.version).toBe(1);

    // A fresh job number — same fiscal-year format, never the predecessor's.
    expect(successor.job_number).toMatch(/^JC-\d{4}-\d{5,}$/);
    expect(successor.job_number).not.toBe(original.job_number);

    // Exactly one successor: the linked card is the only new one.
    const cards = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM job_cards WHERE title = 'T1.7 cancellation job'`,
    );
    expect(cards.rows[0]!.n).toBe(2);

    // The trail: `cancelled` on the old card (reason context in the
    // payload), `created` on the new one.
    const originalEvents = await eventsOf(jobId);
    expect(originalEvents).toHaveLength(1);
    expect(originalEvents[0]).toMatchObject({
      event_type: 'cancelled',
      actor_id: TECH_A.id,
      from_status: 'in_progress',
      to_status: 'cancelled',
      source: 'mobile',
    });
    expect(originalEvents[0]!.payload).toMatchObject({
      reasonCode: 'no_access',
      reasonNote: 'gate locked, customer says come Thursday',
      replacementJobId: cancellation!.replacement_job_id,
    });
    expect(originalEvents[0]!.recorded_at.getTime()).toBeGreaterThanOrEqual(originalEvents[0]!.occurred_at.getTime());

    const successorEvents = await eventsOf(cancellation!.replacement_job_id!);
    expect(successorEvents).toHaveLength(1);
    expect(successorEvents[0]).toMatchObject({
      event_type: 'created',
      actor_id: TECH_A.id,
      from_status: null,
      to_status: 'unassigned',
      source: 'mobile',
    });
    expect(successorEvents[0]!.payload).toMatchObject({ cancelledJobId: jobId });

    // The closed card: terminal exactly when closed_at is set, version moved once.
    const closed = await cardRow(jobId);
    expect(closed.status).toBe('cancelled');
    expect(closed.closed_at).not.toBeNull();
    expect(closed.version).toBe(original.version + 1);
  });

  it('a rescheduleTo in the past is refused 422 — and NOTHING is written: the successor and the cancellation commit together or not at all', async () => {
    const jobId = await seedJob({ status: 'assigned' });
    const before = await cardRow(jobId);

    const res = await postCancel(TECH_A.token, jobId, {
      reasonCode: 'no_access',
      reasonNote: 'gate locked',
      rescheduleTo: istDatePlus(-1),
    });
    expect(res.statusCode, res.body).toBe(422);
    expect(envelopeOf(res.statusCode, res.body).code).toBe('VALIDATION_FAILED');
    expect(res.body).toMatch(/already past/i);
    expectNoConstraintLeak(res.body);

    expect(await cancellationRow(jobId)).toBeNull();
    expect(await cardRow(jobId)).toMatchObject({
      status: before.status,
      closed_at: null,
      version: before.version,
    });
    expect(await eventsOf(jobId)).toHaveLength(0);
  });

  it('cancelling an already-cancelled job is 409 JOB_ALREADY_CLOSED — no second successor, no second closure', async () => {
    const jobId = await seedJob({ status: 'in_progress' });
    const first = await postCancel(TECH_A.token, jobId, {
      reasonCode: 'no_access',
      reasonNote: 'gate locked',
      rescheduleTo: istDatePlus(2),
    });
    expect(first.statusCode, first.body).toBe(200);
    const linked = (await cancellationRow(jobId))!.replacement_job_id!;

    const second = await postCancel(OWNER.token, jobId, {
      reasonCode: 'duplicate',
      rescheduleTo: istDatePlus(5),
    });
    expect(second.statusCode, second.body).toBe(409);
    expect(envelopeOf(second.statusCode, second.body).code).toBe('JOB_ALREADY_CLOSED');

    // Still exactly one cancellation, still the first successor.
    const again = await cancellationRow(jobId);
    expect(again!.replacement_job_id).toBe(linked);
  });
});

describe('cancel without a date — simply cancelled (§6.3)', () => {
  it('no rescheduleTo creates no successor; an undated job cancels plainly too', async () => {
    for (const scheduledFor of [new Date(Date.now() - 3 * 60 * 60 * 1000), null] as const) {
      const jobId = await seedJob({ status: 'assigned', scheduledFor });
      const res = await postCancel(TECH_A.token, jobId, {
        reasonCode: 'customer_unavailable',
        reasonNote: 'nobody home',
      });
      expect(res.statusCode, res.body).toBe(200);

      const cancellation = await cancellationRow(jobId);
      expect(cancellation).toMatchObject({ reason_code: 'customer_unavailable', replacement_job_id: null });

      const row = await cardRow(jobId);
      expect(row.status).toBe('cancelled');
      expect(row.closed_at).not.toBeNull();
      // The card kept the day it was promised for — nothing advanced it.
      expect(row.scheduled_for?.toISOString() ?? null).toBe(scheduledFor?.toISOString() ?? null);

      const events = await eventsOf(jobId);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ event_type: 'cancelled', to_status: 'cancelled' });
      expect(events[0]!.payload).toEqual({
        reasonCode: 'customer_unavailable',
        reasonNote: 'nobody home',
      }); // no replacementJobId — no successor exists
      // …and no rescheduled event either: cancelling is not rescheduling.
      expect(events.some((e) => e.event_type === 'rescheduled')).toBe(false);
    }
  });
});

describe('the reason rule is the database’s (§3.4 job_cancellations_other_justified)', () => {
  it("reason_code 'other' without a note surfaces as a readable 422, and nothing is written", async () => {
    const jobId = await seedJob({ status: 'assigned' });
    const before = await cardRow(jobId);

    const res = await postCancel(TECH_A.token, jobId, { reasonCode: 'other' });
    expect(res.statusCode, res.body).toBe(422);
    const error = envelopeOf(res.statusCode, res.body);
    expect(error.code).toBe('VALIDATION_FAILED');
    expect(res.body).toMatch(/requires a note/i);
    expectNoConstraintLeak(res.body);

    expect(await cancellationRow(jobId)).toBeNull();
    expect(await cardRow(jobId)).toMatchObject({ status: before.status, closed_at: null, version: before.version });
    expect(await eventsOf(jobId)).toHaveLength(0);
  });

  it("'other' WITH a note is accepted", async () => {
    const jobId = await seedJob({ status: 'assigned' });
    const res = await postCancel(TECH_A.token, jobId, { reasonCode: 'other', reasonNote: 'wrong site on the card' });
    expect(res.statusCode, res.body).toBe(200);
    expect(await cancellationRow(jobId)).toMatchObject({ reason_code: 'other', reason_note: 'wrong site on the card' });
  });

  it('rejects a body without a reason, with a bad date, or with an unknown field', async () => {
    const jobId = await seedJob({ status: 'assigned' });
    for (const body of [
      { reasonNote: 'no reason code' },
      { reasonCode: 'not_a_code' },
      { reasonCode: 'no_access', rescheduleTo: '2026-03-14T10:00:00Z' }, // a date, not a datetime
      { reasonCode: 'no_access', surprise: true }, // strict
    ]) {
      const res = await postCancel(TECH_A.token, jobId, body);
      expect(res.statusCode, JSON.stringify(body)).toBe(422);
      expect(envelopeOf(res.statusCode, res.body).code).toBe('VALIDATION_FAILED');
    }
    expect(await cancellationRow(jobId)).toBeNull();
    expect(await eventsOf(jobId)).toHaveLength(0);
  });
});

describe('who may cancel (§6.3: dispatcher, owner, technician own)', () => {
  it('a technician cancels HIS job; another technician’s is 403 OUT_OF_SCOPE and writes nothing', async () => {
    const his = await seedJob({ status: 'en_route' });
    const own = await postCancel(TECH_A.token, his, { reasonCode: 'no_access', reasonNote: 'locked' });
    expect(own.statusCode, own.body).toBe(200);
    expect((await cardRow(his)).status).toBe('cancelled');

    const theirs = await seedJob({ status: 'assigned' });
    const other = await postCancel(TECH_B.token, theirs, { reasonCode: 'no_access', reasonNote: 'locked' });
    expect(other.statusCode, other.body).toBe(403);
    expect(envelopeOf(other.statusCode, other.body).code).toBe('OUT_OF_SCOPE');
    expect(await cancellationRow(theirs)).toBeNull();
    expect(await cardRow(theirs)).toMatchObject({ status: 'assigned', closed_at: null });
    expect(await eventsOf(theirs)).toHaveLength(0);
  });

  it('a technician cannot cancel an UNASSIGNED job — it is nobody’s own', async () => {
    const jobId = await seedJob({ status: 'unassigned', assignedTo: null });
    const res = await postCancel(TECH_A.token, jobId, { reasonCode: 'duplicate' });
    expect(res.statusCode, res.body).toBe(403);
    expect(envelopeOf(res.statusCode, res.body).code).toBe('OUT_OF_SCOPE');
    expect(await cancellationRow(jobId)).toBeNull();
  });

  it('the office cancels what the technician cannot: the dispatcher and the owner close an assigned job', async () => {
    const byDispatcher = await seedJob({ status: 'assigned' });
    const dispatcherRes = await postCancel(DISPATCHER.token, byDispatcher, { reasonCode: 'wrong_details' });
    expect(dispatcherRes.statusCode, dispatcherRes.body).toBe(200);
    expect((await cardRow(byDispatcher)).status).toBe('cancelled');
    expect((await cancellationRow(byDispatcher))!.cancelled_by).toBe(DISPATCHER.id);

    const byOwner = await seedJob({ status: 'in_progress' });
    const ownerRes = await postCancel(OWNER.token, byOwner, { reasonCode: 'customer_cancelled' });
    expect(ownerRes.statusCode, ownerRes.body).toBe(200);
    const ownerCard = JobCardOwnerSchema.parse(ownerRes.json());
    expect(ownerCard.status).toBe('cancelled'); // the owner's shape, money present and null
    expect(ownerCard.cost).toBeNull();
    expect((await cancellationRow(byOwner))!.cancelled_by).toBe(OWNER.id);
  });

  it('an UNASSIGNED job cannot be cancelled — the schema keeps nobody on a cancelled card (job_assignment_coherent)', async () => {
    // §6.1's graph licenses unassigned → cancelled, but migration 007's
    // job_assignment_coherent as written demands assigned_to IS NOT NULL
    // on every card whose status is not 'unassigned' — a cancelled card
    // with no assignee is unrepresentable, so the database refuses the
    // close. The refusal surfaces as the readable 422 fallback (never a
    // 500, never a constraint name) and NOTHING is written; widening the
    // constraint is a schema change that belongs to its own task, not a
    // quiet rewrite of a Phase-0 migration inside T1.7.
    const jobId = await seedJob({ status: 'unassigned', assignedTo: null });
    const before = await cardRow(jobId);
    const res = await postCancel(DISPATCHER.token, jobId, { reasonCode: 'duplicate' });
    expect(res.statusCode, res.body).toBe(422);
    expect(envelopeOf(res.statusCode, res.body).code).toBe('VALIDATION_FAILED');
    expectNoConstraintLeak(res.body);
    expect(await cancellationRow(jobId)).toBeNull();
    expect(await cardRow(jobId)).toMatchObject({ status: before.status, closed_at: null, version: before.version });
    expect(await eventsOf(jobId)).toHaveLength(0);
  });

  it('a sales rep is 403 at the door; an unauthenticated caller is 401', async () => {
    const jobId = await seedJob({ status: 'assigned' });
    const rep = await postCancel(SALES_REP.token, jobId, { reasonCode: 'duplicate' });
    expect(rep.statusCode, rep.body).toBe(403);
    expect(envelopeOf(rep.statusCode, rep.body).code).toBe('FORBIDDEN');

    const anon = await app.inject({
      method: 'POST',
      url: `/v1/jobs/${jobId}/cancel`,
      headers: { 'x-client-source': 'mobile' },
      payload: { reasonCode: 'duplicate' },
    });
    expect(envelopeOf(anon.statusCode, anon.body).code).toBe('UNAUTHENTICATED');
    expect(await cancellationRow(jobId)).toBeNull();
  });

  it('an unknown job is 404; an id that is not a uuid never reaches pg', async () => {
    const missing = await postCancel(TECH_A.token, crypto.randomUUID(), { reasonCode: 'duplicate' });
    expect(envelopeOf(missing.statusCode, missing.body).code).toBe('NOT_FOUND');
    const malformed = await postCancel(TECH_A.token, 'not-a-uuid', { reasonCode: 'duplicate' });
    expect(envelopeOf(malformed.statusCode, malformed.body).code).toBe('NOT_FOUND');
  });
});

describe('rescheduling is a PATCH of scheduled_for — a different door (§6.3)', () => {
  it('PATCH moves the date, emits rescheduled, and does NOT change status or create a cancellation', async () => {
    const jobId = await seedJob({ status: 'assigned', scheduledFor: new Date(Date.now() + 24 * 60 * 60 * 1000) });
    const before = await cardRow(jobId);
    const newDate = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);

    const res = await patchJob(
      DISPATCHER.token,
      jobId,
      { scheduledFor: newDate.toISOString() },
      { 'if-match': String(before.version) },
    );
    expect(res.statusCode, res.body).toBe(200);

    // The dispatcher's card: new date, SAME status, version moved once.
    const body = res.json();
    expect(body.scheduledFor).toBe(newDate.toISOString());
    expect(body.status).toBe('assigned');
    expect(body.version).toBe(before.version + 1);

    const row = await cardRow(jobId);
    expect(row.scheduled_for!.toISOString()).toBe(newDate.toISOString());
    expect(row.status).toBe('assigned'); // left alone
    expect(row.closed_at).toBeNull();

    // NO cancellation row, NO cancelled event — a moved appointment is
    // not a wasted trip.
    expect(await cancellationRow(jobId)).toBeNull();

    const events = await eventsOf(jobId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event_type: 'rescheduled',
      actor_id: DISPATCHER.id,
      from_status: 'assigned',
      to_status: 'assigned', // the point: the card did not move
      source: 'web',
    });
    expect(events[0]!.payload).toEqual({
      scheduledFor: { from: before.scheduled_for!.toISOString(), to: newDate.toISOString() },
    });
  });

  it('the owner reschedules too; a stale If-Match is 409 VERSION_CONFLICT naming the current version', async () => {
    const jobId = await seedJob({ status: 'assigned', scheduledFor: new Date(Date.now() + 24 * 60 * 60 * 1000) });
    const before = await cardRow(jobId);
    const next = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);

    const owned = await patchJob(OWNER.token, jobId, { scheduledFor: next.toISOString() }, { 'if-match': '1' });
    expect(owned.statusCode, owned.body).toBe(200);
    expect(owned.json().version).toBe(before.version + 1);

    // The version the dispatcher still holds is now stale.
    const stale = await patchJob(
      DISPATCHER.token,
      jobId,
      { scheduledFor: new Date(Date.now() + 9 * 24 * 60 * 60 * 1000).toISOString() },
      { 'if-match': String(before.version) },
    );
    expect(stale.statusCode, stale.body).toBe(409);
    const error = envelopeOf(stale.statusCode, stale.body);
    expect(error.code).toBe('VERSION_CONFLICT');
    expect((error.details as { currentVersion: number }).currentVersion).toBe(before.version + 1);
    // The refused patch wrote nothing.
    expect((await cardRow(jobId)).scheduled_for!.toISOString()).toBe(next.toISOString());
  });

  it('PATCH is the office’s door: a technician — even on his own job — and a sales rep are 403', async () => {
    const jobId = await seedJob({ status: 'assigned', scheduledFor: new Date() });
    const body = { scheduledFor: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() };

    const tech = await patchJob(TECH_A.token, jobId, body, { 'if-match': '1' });
    expect(tech.statusCode, tech.body).toBe(403);
    expect(envelopeOf(tech.statusCode, tech.body).code).toBe('FORBIDDEN');
    expect(tech.body).toMatch(/cancel the job with the new date/i); // his door is named

    const rep = await patchJob(SALES_REP.token, jobId, body, { 'if-match': '1' });
    expect(rep.statusCode, rep.body).toBe(403);

    expect((await cardRow(jobId)).scheduled_for).toBeTruthy();
    expect(await eventsOf(jobId)).toHaveLength(0);
  });

  it('the request itself: missing or malformed If-Match is 422, a bad body is 422, an unknown job is 404', async () => {
    const jobId = await seedJob({ status: 'assigned', scheduledFor: new Date() });
    const body = { scheduledFor: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() };

    const ifMatchHeaders: Array<Record<string, string>> = [
      {},
      { 'if-match': '0' },
      { 'if-match': 'abc' },
      { 'if-match': '"1"' },
    ];
    for (const headers of ifMatchHeaders) {
      const res = await patchJob(DISPATCHER.token, jobId, body, headers);
      expect(res.statusCode, JSON.stringify(headers)).toBe(422);
      expect(envelopeOf(res.statusCode, res.body).code).toBe('VALIDATION_FAILED');
    }

    for (const bad of [{}, { scheduledFor: '2026-03-14' }, { scheduledFor: body.scheduledFor, surprise: true }]) {
      const res = await patchJob(DISPATCHER.token, jobId, bad, { 'if-match': '1' });
      expect(res.statusCode, JSON.stringify(bad)).toBe(422);
    }

    const missing = await patchJob(DISPATCHER.token, crypto.randomUUID(), body, { 'if-match': '1' });
    expect(envelopeOf(missing.statusCode, missing.body).code).toBe('NOT_FOUND');

    expect(await eventsOf(jobId)).toHaveLength(0);
    expect(await cancellationRow(jobId)).toBeNull();
  });
});

describe('an AMC job cancelled with a date — the successor inherits the AMC (decision 2026-09-15)', () => {
  it('a date inside the AMC term: the successor carries the same contract_id', async () => {
    const jobId = await seedJob({ status: 'assigned', contractId: amcId });
    const rescheduleTo = istDatePlus(3); // inside [today-10, today+500]

    const res = await postCancel(TECH_A.token, jobId, { reasonCode: 'no_access', rescheduleTo });
    expect(res.statusCode, res.body).toBe(200);
    const replacementJobId = (await cancellationRow(jobId))!.replacement_job_id!;
    const successor = await cardRow(replacementJobId);
    expect(successor.scheduled_date).toBe(rescheduleTo);
    expect(successor.contract_visit_id).toBeNull(); // the column is retired, never written
    expect(successor.contract_id).toBe(amcId); // still AMC work
  });

  it('a date past the AMC end: the successor is an ordinary job — contract_id NULL', async () => {
    const jobId = await seedJob({ status: 'assigned', contractId: amcId });
    const rescheduleTo = istDatePlus(600); // past today+500

    const res = await postCancel(TECH_A.token, jobId, { reasonCode: 'no_access', rescheduleTo });
    expect(res.statusCode, res.body).toBe(200);
    const replacementJobId = (await cancellationRow(jobId))!.replacement_job_id!;
    const successor = await cardRow(replacementJobId);
    expect(successor.contract_id).toBeNull();
  });

  it('without a date: no successor, and the AMC is untouched', async () => {
    const jobId = await seedJob({ status: 'assigned', contractId: amcId });

    const res = await postCancel(TECH_A.token, jobId, { reasonCode: 'no_access' });
    expect(res.statusCode, res.body).toBe(200);
    expect((await cancellationRow(jobId))!.replacement_job_id).toBeNull();
    const amc = await db.query<{ cancelled_at: Date | null }>(
      'SELECT cancelled_at FROM service_contracts WHERE id = $1',
      [amcId],
    );
    expect(amc.rows[0]!.cancelled_at).toBeNull();
  });
});
