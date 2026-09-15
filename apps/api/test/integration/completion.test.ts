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
 * Job completion (PHASE-1-TECHNICIAN.md T1.6, PLAN-BACKEND.md §6.2,
 * PLAN-DATA-MODEL.md §3.4). Runs against a scratch database built from
 * the real migrations (§14: no mocked database anywhere) and drives
 * `POST /v1/jobs/:id/complete` over HTTP, because the things this task
 * must prove are exactly what a mock cannot prove:
 *
 *  - the discount rule is the DATABASE's (`completion_discount_*`,
 *    `completion_mode_coherent`) and the service only maps a refused
 *    insert to a readable 422 — a 500 leaking a constraint name fails
 *    here, loudly;
 *  - the eight steps are ONE transaction — a failure at step 5 (the
 *    stack upsert) leaves neither the completion nor the stack row;
 *  - parts never touch money: a completion with parts and one without
 *    produce identical money rows;
 *  - the same Idempotency-Key replays the identical body and creates no
 *    second completion.
 *
 * The warranty rule is a prompt, not a constraint (§6.2): nothing here
 * asserts that an in-warranty unit is forced to cost 0 — the accepted
 * `cost 0, discount 0, mode none` shape is asserted instead.
 */

function databaseUrl(): string {
  return process.env.DATABASE_URL ?? 'postgres://servgrid:servgrid@localhost:5432/servgrid';
}

function adminUrlFor(url: string): string {
  const parsed = new URL(url);
  parsed.pathname = '/postgres';
  return parsed.toString();
}

const SCRATCH_DB = 'servgrid_completion_test';
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
  const username = `t16.${role}.${randomBytes(4).toString('hex')}`;
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
let productId = '';

async function seedJob(status: JobStatus, assignedTo: string | null = TECH_A.id): Promise<string> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO job_cards (job_number, customer_id, service_id, title, status, assigned_to, assigned_at, closed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [
      `JC-T16-${randomBytes(4).toString('hex')}`,
      customerId,
      serviceId,
      `T1.6 job ${status}`,
      status,
      status === 'unassigned' ? null : assignedTo,
      status === 'unassigned' ? null : new Date().toISOString(),
      // job_closed_coherent: terminal exactly when closed_at is set.
      status === 'completed' || status === 'cancelled' ? new Date().toISOString() : null,
    ],
  );
  return r.rows[0]!.id;
}

/** The closure row behind a JOB_ALREADY_CLOSED message that can name who and when. */
async function seedCancellation(jobId: string, cancelledBy: string, cancelledAt: Date): Promise<void> {
  await db.query(
    `INSERT INTO job_cancellations (job_card_id, cancelled_by, cancelled_at, reason_code, reason_note)
     VALUES ($1, $2, $3, 'no_access', 'gate locked, nobody on site')`,
    [jobId, cancelledBy, cancelledAt.toISOString()],
  );
}

/** The completion row behind an already-completed job's JOB_ALREADY_CLOSED message. */
async function seedCompletion(jobId: string, completedBy: string, completedAt: Date): Promise<void> {
  await db.query(
    `INSERT INTO job_completions
       (job_card_id, completed_by, completed_at, work_summary, cost, discount_amount, collection_mode)
     VALUES ($1, $2, $3, 'Seeded earlier completion.', '5000', '0', 'cash')`,
    [jobId, completedBy, completedAt.toISOString()],
  );
}

/** An active unit at a site — the upsert's collision case. */
async function seedStackUnit(customer: string, serial: string, warrantyExpiresOn: string | null): Promise<string> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO customer_products (customer_id, free_text_name, serial_number, quantity, installed_on, warranty_expires_on)
     VALUES ($1, 'Seeded unit', $2, 1, '2025-04-01', $3) RETURNING id`,
    [customer, serial, warrantyExpiresOn],
  );
  return r.rows[0]!.id;
}

// ── request and read-back helpers ───────────────────────────────────────────

function sent(secondsAgo = 60): string {
  return new Date(Date.now() - secondsAgo * 1000).toISOString();
}

/** The IST business day the server's `business_date()` derives — the same clock the generated column uses. */
function istDate(iso: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date(iso));
}

/** The same clock the JOB_ALREADY_CLOSED message formats with — exact, in-process, no locale guessing. */
function closureWhen(at: Date): string {
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(at);
}

function completeBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { completedAt: sent(60), workSummary: 'Replaced batteries, tested load.', ...overrides };
}

function postComplete(
  token: string,
  jobId: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
) {
  return app.inject({
    method: 'POST',
    url: `/v1/jobs/${jobId}/complete`,
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

interface MoneyRow {
  cost: string;
  discount_amount: string;
  amount_collected: string;
  collection_mode: string;
  discount_reason: string | null;
  payment_reference: string | null;
  customer_signed: boolean;
  completed_by: string;
  completed_at: Date;
  business_date: string;
}

async function moneyRow(jobId: string): Promise<MoneyRow | null> {
  const r = await db.query<MoneyRow>(
    `SELECT cost::text, discount_amount::text, amount_collected::text, collection_mode,
            discount_reason, payment_reference, customer_signed, completed_by, completed_at, business_date::text
     FROM job_completions WHERE job_card_id = $1`,
    [jobId],
  );
  return r.rows[0] ?? null;
}

interface PartRow {
  line_no: number;
  product_id: string | null;
  free_text_name: string | null;
  quantity: string;
  unit_cost: string | null;
  serial_number: string | null;
  from_customer_stock: boolean;
}

async function partsOf(jobId: string): Promise<PartRow[]> {
  const r = await db.query<PartRow>(
    `SELECT line_no, product_id::text, free_text_name, quantity::text, unit_cost::text, serial_number, from_customer_stock
     FROM job_completion_parts WHERE job_card_id = $1 ORDER BY line_no`,
    [jobId],
  );
  return r.rows;
}

interface StackRow {
  id: string;
  customer_id: string;
  serial_number: string;
  quantity: number;
  source_job_id: string | null;
  installed_by: string | null;
  installed_on: string | null;
  warranty_expires_on: string | null;
  is_active: boolean;
}

async function stackRowsByJob(jobId: string): Promise<StackRow[]> {
  const r = await db.query<StackRow>(
    `SELECT id, customer_id::text, serial_number, quantity, source_job_id::text, installed_by::text,
            installed_on::text, warranty_expires_on::text, is_active
     FROM customer_products WHERE source_job_id = $1 ORDER BY serial_number`,
    [jobId],
  );
  return r.rows;
}

async function activeStackRowBySerial(serial: string): Promise<StackRow | null> {
  const r = await db.query<StackRow>(
    `SELECT id, customer_id::text, serial_number, quantity, source_job_id::text, installed_by::text,
            installed_on::text, warranty_expires_on::text, is_active
     FROM customer_products WHERE lower(serial_number) = lower($1) AND is_active`,
    [serial],
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

async function latestEvent(jobId: string): Promise<EventRow | null> {
  const r = await db.query<EventRow>(
    `SELECT event_type, actor_id, occurred_at, recorded_at, from_status, to_status, source, payload
     FROM job_events WHERE job_card_id = $1 ORDER BY id DESC LIMIT 1`,
    [jobId],
  );
  return r.rows[0] ?? null;
}

async function cardRow(jobId: string): Promise<{ status: JobStatus; closed_at: Date | null; version: number }> {
  const r = await db.query<{ status: JobStatus; closed_at: Date | null; version: number }>(
    'SELECT status, closed_at, version FROM job_cards WHERE id = $1',
    [jobId],
  );
  return r.rows[0]!;
}

/** The discount rule lives in CHECK constraints; no refusal may ever echo one back. */
function expectNoConstraintLeak(body: string): void {
  expect(body).not.toMatch(/completion_|customer_products_|job_completion_parts_/);
  expect(body).not.toMatch(/23514|23505|23503|22003|check_violation|unique_violation/i);
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
      `INSERT INTO customers (name, phone) VALUES ('T1.6 Customer', '9840000001') RETURNING id`,
    )
  ).rows[0]!.id;
  otherCustomerId = (
    await db.query<{ id: string }>(
      `INSERT INTO customers (name, phone) VALUES ('T1.6 Other Site', '9840000002') RETURNING id`,
    )
  ).rows[0]!.id;
  serviceId = (
    await db.query<{ id: string }>(
      `INSERT INTO services (code, name) VALUES ('T1.6-SVC', 'T1.6 suite service') RETURNING id`,
    )
  ).rows[0]!.id;
  productId = (
    await db.query<{ id: string }>(
      `INSERT INTO products (sku, name, category) VALUES ('T16-BATT-150', 'T1.6 test battery 150Ah', 'battery') RETURNING id`,
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

describe('the happy path — one transaction, eight steps', () => {
  it('a technician completes his in_progress job; the money row, the card, the event all land', async () => {
    const jobId = await seedJob('in_progress');
    const when = sent(60);
    const res = await postComplete(TECH_A.token, jobId, {
      completedAt: when,
      workSummary: 'Replaced both batteries, tested 40 minutes.',
      cost: '5000',
      discountAmount: '500',
      discountReason: 'goodwill',
      collectionMode: 'cash',
      paymentReference: 'cash-docket-114',
      customerSigned: true,
    });
    expect(res.statusCode, res.body).toBe(200);

    // The response is the technician's card — completed, and money-free
    // (§6.3: job.money read is `none` for the technician who just wrote it).
    const body = res.json();
    const card = JobCardTechnicianSchema.parse(body);
    expect(card.status).toBe('completed');
    expect(body).not.toHaveProperty('cost');

    const money = await moneyRow(jobId);
    expect(money).toMatchObject({
      cost: '5000.00',
      discount_amount: '500.00',
      amount_collected: '4500.00', // generated, never sent
      collection_mode: 'cash',
      discount_reason: 'goodwill',
      payment_reference: 'cash-docket-114',
      customer_signed: true,
      completed_by: TECH_A.id,
    });
    // completed_at is the CLIENT's clock; business_date is its IST day.
    expect(new Date(money!.completed_at).toISOString()).toBe(when);
    expect(money!.business_date).toBe(istDate(when));

    const row = await cardRow(jobId);
    expect(row.status).toBe('completed');
    expect(row.closed_at).not.toBeNull();
    expect(new Date(row.closed_at!).toISOString()).toBe(when); // closed when the work happened
    expect(row.version).toBe(2); // the touch trigger counted a real change

    const event = await latestEvent(jobId);
    expect(event).toMatchObject({
      event_type: 'completed',
      actor_id: TECH_A.id,
      from_status: 'in_progress',
      to_status: 'completed',
      source: 'mobile',
      payload: null,
    });
    expect(new Date(event!.occurred_at).toISOString()).toBe(when); // §6.2 step 4: occurred_at from the client
    expect(event!.recorded_at.getTime()).toBeGreaterThanOrEqual(event!.occurred_at.getTime());
  });

  it('completing straight from assigned is legal, and from en_route too (§6.2 step 1)', async () => {
    for (const status of ['assigned', 'en_route'] as const) {
      const jobId = await seedJob(status);
      const res = await postComplete(TECH_A.token, jobId, completeBody({ cost: '800', collectionMode: 'upi' }));
      expect(res.statusCode, status).toBe(200);
      expect(await cardRow(jobId)).toMatchObject({ status: 'completed' });
      expect(await latestEvent(jobId)).toMatchObject({ from_status: status, to_status: 'completed' });
    }
  });

  it('a warranty job — cost 0, discount 0, mode none — is accepted (§3.4)', async () => {
    const jobId = await seedJob('in_progress');
    const res = await postComplete(TECH_A.token, jobId, {
      completedAt: sent(60),
      workSummary: 'Cleaned filters, reset inverter.',
      cost: '0',
      discountAmount: '0',
      collectionMode: 'none',
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(await moneyRow(jobId)).toMatchObject({
      cost: '0.00',
      discount_amount: '0.00',
      amount_collected: '0.00',
      collection_mode: 'none',
    });
  });

  it('the defaults ARE the warranty shape: only completedAt and workSummary is a valid completion', async () => {
    const jobId = await seedJob('in_progress');
    const res = await postComplete(TECH_A.token, jobId, completeBody());
    expect(res.statusCode, res.body).toBe(200);
    expect(await moneyRow(jobId)).toMatchObject({
      cost: '0.00',
      discount_amount: '0.00',
      amount_collected: '0.00',
      collection_mode: 'none',
    });
  });

  it('the owner completes on a technician’s behalf and reads the money back in his own shape', async () => {
    const jobId = await seedJob('in_progress', TECH_A.id);
    const res = await postComplete(OWNER.token, jobId, completeBody({ cost: '3200', collectionMode: 'card' }));
    expect(res.statusCode, res.body).toBe(200);

    const card = JobCardOwnerSchema.parse(res.json());
    expect(card.status).toBe('completed');
    expect(card.cost).toBe('3200.00');
    expect(card.amountCollected).toBe('3200.00');
    expect(card.collectionMode).toBe('card');
  });

  it('an amountCollected in the payload is ignored — the column is generated (derived money is never stored)', async () => {
    const jobId = await seedJob('in_progress');
    const res = await postComplete(TECH_A.token, jobId, completeBody({ cost: '1000', collectionMode: 'cash', amountCollected: '999' }));
    expect(res.statusCode, res.body).toBe(200);
    expect(await moneyRow(jobId)).toMatchObject({ cost: '1000.00', amount_collected: '1000.00' });
  });
});

describe('the discount rule is the database’s, mapped to a readable 422 (§6.2 step 2)', () => {
  it('a discount without a reason is refused 422 with a sentence, never a constraint name', async () => {
    const jobId = await seedJob('in_progress');
    const res = await postComplete(TECH_A.token, jobId, completeBody({ cost: '5000', discountAmount: '500' }));
    expect(res.statusCode, res.body).toBe(422);
    expect(envelopeOf(res.statusCode, res.body).code).toBe('VALIDATION_FAILED');
    expect(res.body).toMatch(/discount requires a reason/i);
    expectNoConstraintLeak(res.body);

    // Nothing was written: the job is exactly where it was.
    expect(await moneyRow(jobId)).toBeNull();
    expect(await cardRow(jobId)).toMatchObject({ status: 'in_progress', version: 1 });
    expect(await latestEvent(jobId)).toBeNull();
  });

  it('a discount larger than the amount owed is the CHECK talking — mapped, readable, no 500', async () => {
    const jobId = await seedJob('in_progress');
    const res = await postComplete(TECH_A.token, jobId, completeBody({
      cost: '500',
      discountAmount: '600',
      discountReason: 'goodwill',
      collectionMode: 'cash',
    }));
    expect(res.statusCode, res.body).toBe(422);
    expect(envelopeOf(res.statusCode, res.body).code).toBe('VALIDATION_FAILED');
    expect(res.body).toMatch(/larger than the amount/i);
    expectNoConstraintLeak(res.body);
    expect(await moneyRow(jobId)).toBeNull();
  });

  it('an amount owed with no paid-by is completion_mode_coherent refusing — mapped to its sentence', async () => {
    const jobId = await seedJob('in_progress');
    // No collectionMode → the service sends 'none'; the database, not the
    // service, refuses a nonzero owed with mode none.
    const res = await postComplete(TECH_A.token, jobId, completeBody({ cost: '500' }));
    expect(res.statusCode, res.body).toBe(422);
    expect(envelopeOf(res.statusCode, res.body).code).toBe('VALIDATION_FAILED');
    expect(res.body).toMatch(/how the customer paid/i);
    expectNoConstraintLeak(res.body);
    expect(await moneyRow(jobId)).toBeNull();
    expect(await cardRow(jobId)).toMatchObject({ status: 'in_progress' });
  });
});

describe('JOB_ALREADY_CLOSED — the offline conflict names who and when (§6.1)', () => {
  it('completing a job the office cancelled names the canceller and the moment', async () => {
    const jobId = await seedJob('cancelled');
    const cancelledAt = new Date(Date.now() - 90 * 60 * 1000);
    await seedCancellation(jobId, DISPATCHER.id, cancelledAt);

    const res = await postComplete(TECH_A.token, jobId, completeBody({ cost: '1200', collectionMode: 'cash' }));
    expect(res.statusCode, res.body).toBe(409);
    const error = envelopeOf(res.statusCode, res.body);
    expect(error.code).toBe('JOB_ALREADY_CLOSED');
    expect(error.message).toContain(`cancelled by Test ${DISPATCHER.username} on ${closureWhen(cancelledAt)} IST`);
    expect(error.message).toMatch(/kept on this phone/i); // no silent overwrite: his work survives
    expectNoConstraintLeak(res.body);

    expect(await moneyRow(jobId)).toBeNull();
    expect(await cardRow(jobId)).toMatchObject({ status: 'cancelled' });
  });

  it('completing an already-completed job names who completed it', async () => {
    const jobId = await seedJob('completed');
    const completedAt = new Date(Date.now() - 3 * 60 * 60 * 1000);
    await seedCompletion(jobId, TECH_A.id, completedAt);

    const res = await postComplete(OWNER.token, jobId, completeBody());
    expect(res.statusCode, res.body).toBe(409);
    const error = envelopeOf(res.statusCode, res.body);
    expect(error.code).toBe('JOB_ALREADY_CLOSED');
    expect(error.message).toContain(
      `already completed by Test ${TECH_A.username} on ${closureWhen(completedAt)} IST`,
    );
    // Still exactly one completion, the seeded one.
    expect(await moneyRow(jobId)).toMatchObject({ completed_by: TECH_A.id });
  });

  it('an unassigned job has nobody to complete it — 409 ILLEGAL_TRANSITION', async () => {
    const jobId = await seedJob('unassigned', null);
    const res = await postComplete(OWNER.token, jobId, completeBody());
    expect(res.statusCode, res.body).toBe(409);
    expect(envelopeOf(res.statusCode, res.body).code).toBe('ILLEGAL_TRANSITION');
    expect(await moneyRow(jobId)).toBeNull();
  });
});

describe('stackChanges — upserted in the same transaction, stamped source_job_id (§6.2 step 5)', () => {
  it('two stack changes create two customer_products rows traced to the job', async () => {
    const jobId = await seedJob('in_progress');
    const when = sent(60);
    const res = await postComplete(TECH_A.token, jobId, completeBody({
      completedAt: when,
      cost: '0',
      collectionMode: 'none',
      stackChanges: [
        { productId, serialNumber: 'BT-88120', quantity: 2, warrantyExpiresOn: '2028-03-14' },
        { freeTextName: 'Third-party stabiliser', serialNumber: 'SB-2201' },
      ],
    }));
    expect(res.statusCode, res.body).toBe(200);

    const rows = await stackRowsByJob(jobId);
    expect(rows).toHaveLength(2);
    const battery = rows.find((r) => r.serial_number === 'BT-88120')!;
    const stabiliser = rows.find((r) => r.serial_number === 'SB-2201')!;
    // Both stamped with the job and the site — the audit trail (§3.3).
    for (const row of [battery, stabiliser]) {
      expect(row.source_job_id).toBe(jobId);
      expect(row.customer_id).toBe(customerId);
      expect(row.installed_by).toBe(TECH_A.id);
      expect(row.is_active).toBe(true);
      // installed_on defaults to the completion's IST business day.
      expect(row.installed_on).toBe(istDate(when));
    }
    expect(battery.quantity).toBe(2);
    expect(battery.warranty_expires_on).toBe('2028-03-14');
  });

  it('a serial the site already has is upserted — refreshed and re-stamped, never duplicated (case-insensitive)', async () => {
    const jobId = await seedJob('in_progress');
    const existingId = await seedStackUnit(customerId, 'UPS-5000', '2026-01-01');
    const when = sent(60);

    // The technician types the serial in lowercase; the row is the same unit.
    const res = await postComplete(TECH_A.token, jobId, completeBody({
      completedAt: when,
      cost: '0',
      collectionMode: 'none',
      stackChanges: [{ productId, serialNumber: 'ups-5000', warrantyExpiresOn: '2027-06-01' }],
    }));
    expect(res.statusCode, res.body).toBe(200);

    const row = await activeStackRowBySerial('UPS-5000');
    expect(row!.id).toBe(existingId); // the SAME row, updated
    expect(row!.source_job_id).toBe(jobId);
    expect(row!.installed_by).toBe(TECH_A.id);
    expect(row!.installed_on).toBe(istDate(when));
    expect(row!.warranty_expires_on).toBe('2027-06-01');
    // Exactly one active row carries the serial, and it is the job's only trace.
    const traced = await stackRowsByJob(jobId);
    expect(traced).toHaveLength(1);
    expect(traced[0]!.id).toBe(existingId);
  });

  it('a failure at step 5 rolls the WHOLE completion back — both rows or neither', async () => {
    const jobId = await seedJob('in_progress');
    // A well-formed uuid that is not in products: the FK fires at step 5,
    // after the completion row (step 2) is already written in the transaction.
    const ghostProductId = crypto.randomUUID();
    const res = await postComplete(TECH_A.token, jobId, completeBody({
      cost: '2500',
      collectionMode: 'cash',
      stackChanges: [{ productId: ghostProductId, serialNumber: 'GHOST-1' }],
    }));
    expect(res.statusCode, res.body).toBe(422);
    expect(envelopeOf(res.statusCode, res.body).code).toBe('VALIDATION_FAILED');
    expect(res.body).toMatch(/no longer in the system/i);
    expectNoConstraintLeak(res.body);

    // Neither row survived: no completion, no stack row, no event, no close.
    expect(await moneyRow(jobId)).toBeNull();
    expect(await stackRowsByJob(jobId)).toHaveLength(0);
    expect(await latestEvent(jobId)).toBeNull();
    expect(await cardRow(jobId)).toMatchObject({ status: 'in_progress', version: 1, closed_at: null });
  });

  it('a serial already active at ANOTHER site is a readable refusal — and writes nothing', async () => {
    await seedStackUnit(otherCustomerId, 'SHARED-1', null);
    const jobId = await seedJob('in_progress');

    const res = await postComplete(TECH_A.token, jobId, completeBody({
      cost: '0',
      collectionMode: 'none',
      stackChanges: [{ productId, serialNumber: 'shared-1' }],
    }));
    expect(res.statusCode, res.body).toBe(422);
    expect(res.body).toMatch(/already recorded at another site/i);
    expectNoConstraintLeak(res.body);

    expect(await moneyRow(jobId)).toBeNull();
    // The other site's row is untouched and still singular.
    const row = await activeStackRowBySerial('SHARED-1');
    expect(row!.customer_id).toBe(otherCustomerId);
  });
});

describe('parts are a record, not a bill (§3.4) — money identical with or without them', () => {
  it('two completions with the same money, one carrying parts, produce identical money rows', async () => {
    const withParts = await seedJob('in_progress');
    const withoutParts = await seedJob('in_progress');
    const money = { cost: '5000', discountAmount: '500', discountReason: 'goodwill', collectionMode: 'cash' };

    const first = await postComplete(TECH_A.token, withParts, completeBody({
      ...money,
      parts: [
        { productId, quantity: 2, unitCost: '350.00', serialNumber: 'FIT-77' },
        { freeTextName: 'Fuse set', quantity: 1, fromCustomerStock: true },
      ],
    }));
    expect(first.statusCode, first.body).toBe(200);

    const second = await postComplete(TECH_A.token, withoutParts, completeBody(money));
    expect(second.statusCode, second.body).toBe(200);

    const a = await moneyRow(withParts);
    const b = await moneyRow(withoutParts);
    // The assertion that stops anyone deriving cost from a parts total.
    expect({ ...a, completed_at: null, business_date: null }).toEqual({ ...b, completed_at: null, business_date: null });
    expect(a!.cost).toBe('5000.00');
    expect(a!.amount_collected).toBe('4500.00');

    const parts = await partsOf(withParts);
    expect(parts).toEqual([
      {
        line_no: 1,
        product_id: productId,
        free_text_name: null,
        quantity: '2.00',
        unit_cost: '350.00',
        serial_number: 'FIT-77',
        from_customer_stock: false,
      },
      {
        line_no: 2,
        product_id: null,
        free_text_name: 'Fuse set',
        quantity: '1.00',
        unit_cost: null, // the stairwell case: he does not know what it cost
        serial_number: null,
        from_customer_stock: true,
      },
    ]);
    expect(await partsOf(withoutParts)).toEqual([]);
  });
});

describe('idempotency — the same key replays the identical body, once (§6.3)', () => {
  it('a replayed Idempotency-Key returns the stored bytes and creates no second completion', async () => {
    const jobId = await seedJob('in_progress');
    const key = crypto.randomUUID();
    const body = completeBody({ cost: '1500', collectionMode: 'upi', paymentReference: 'UPI-991' });

    const first = await postComplete(TECH_A.token, jobId, body, { 'idempotency-key': key });
    expect(first.statusCode, first.body).toBe(200);

    const second = await postComplete(TECH_A.token, jobId, body, { 'idempotency-key': key });
    expect(second.statusCode, second.body).toBe(200);
    expect(second.body).toBe(first.body); // byte-identical replay

    const rows = await db.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM job_completions WHERE job_card_id = $1',
      [jobId],
    );
    expect(rows.rows[0]!.n).toBe(1);
    expect(await db.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM job_events WHERE job_card_id = $1 AND event_type = \'completed\'',
      [jobId],
    ).then((r) => r.rows[0]!.n)).toBe(1);
  });
});

describe('who may complete (§6.3: technician own, owner all)', () => {
  it('a dispatcher has no job.money at all — 403 before the payload is read', async () => {
    const jobId = await seedJob('in_progress');
    const res = await postComplete(DISPATCHER.token, jobId, completeBody());
    expect(res.statusCode, res.body).toBe(403);
    expect(envelopeOf(res.statusCode, res.body).code).toBe('FORBIDDEN');
    expect(await moneyRow(jobId)).toBeNull();
  });

  it('a sales rep likewise — 403', async () => {
    const jobId = await seedJob('in_progress');
    const res = await postComplete(SALES_REP.token, jobId, completeBody());
    expect(envelopeOf(res.statusCode, res.body).code).toBe('FORBIDDEN');
  });

  it("another technician's job is 403 OUT_OF_SCOPE", async () => {
    const jobId = await seedJob('in_progress', TECH_A.id);
    const res = await postComplete(TECH_B.token, jobId, completeBody());
    expect(res.statusCode, res.body).toBe(403);
    expect(envelopeOf(res.statusCode, res.body).code).toBe('OUT_OF_SCOPE');
    expect(await moneyRow(jobId)).toBeNull();
    expect(await cardRow(jobId)).toMatchObject({ status: 'in_progress' });
  });

  it('an unauthenticated caller is 401', async () => {
    const jobId = await seedJob('in_progress');
    const res = await app.inject({
      method: 'POST',
      url: `/v1/jobs/${jobId}/complete`,
      headers: { 'x-client-source': 'mobile' },
      payload: completeBody(),
    });
    expect(envelopeOf(res.statusCode, res.body).code).toBe('UNAUTHENTICATED');
  });

  it('an unknown job is 404; an id that is not a uuid never reaches pg', async () => {
    const missing = await postComplete(TECH_A.token, crypto.randomUUID(), completeBody());
    expect(envelopeOf(missing.statusCode, missing.body).code).toBe('NOT_FOUND');
    const malformed = await postComplete(TECH_A.token, 'not-a-uuid', completeBody());
    expect(envelopeOf(malformed.statusCode, malformed.body).code).toBe('NOT_FOUND');
  });
});

describe('the completedAt clamp (§6.2: not in the future, not more than 14 days old)', () => {
  it('a completedAt 20 days old is clamped to the floor and the clamp lands in the event payload', async () => {
    const jobId = await seedJob('in_progress');
    const twentyDaysAgo = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString();
    const res = await postComplete(TECH_A.token, jobId, completeBody({ completedAt: twentyDaysAgo, cost: '0' }));
    expect(res.statusCode, res.body).toBe(200);

    const event = await latestEvent(jobId);
    expect(event).not.toBeNull();
    const floor = Date.now() - OCCURRED_AT_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
    expect(Math.abs(new Date(event!.occurred_at).getTime() - floor)).toBeLessThan(10_000);

    const payload = event!.payload as { completedAtClamped?: { sent: string; recordedAs: string } } | null;
    expect(payload?.completedAtClamped?.sent).toBe(twentyDaysAgo);
  });

  it('a future completedAt is clamped to now, honestly labelled', async () => {
    const jobId = await seedJob('in_progress');
    const anHourAhead = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const res = await postComplete(TECH_A.token, jobId, completeBody({ completedAt: anHourAhead, cost: '0' }));
    expect(res.statusCode, res.body).toBe(200);

    const event = await latestEvent(jobId);
    expect(Math.abs(new Date(event!.occurred_at).getTime() - Date.now())).toBeLessThan(10_000);
    expect((event!.payload as { completedAtClamped: { sent: string } }).completedAtClamped.sent).toBe(anHourAhead);
  });
});

describe('the request itself', () => {
  it('rejects a body without workSummary, with a bad clock, or with an unknown field', async () => {
    const jobId = await seedJob('in_progress');
    for (const body of [
      { completedAt: sent(60) }, // no work summary — the record is the work
      { workSummary: 'x' }, // no completedAt
      { completedAt: '2026-03-14T10:00:00', workSummary: 'x' }, // no offset — whose 10:00?
      { completedAt: sent(60), workSummary: 'x', cost: '-5' }, // negative money
      { completedAt: sent(60), workSummary: 'x', surprise: true }, // strict
    ]) {
      const res = await postComplete(TECH_A.token, jobId, body);
      expect(res.statusCode, JSON.stringify(body)).toBe(422);
      expect(envelopeOf(res.statusCode, res.body).code).toBe('VALIDATION_FAILED');
    }
    expect(await moneyRow(jobId)).toBeNull();
  });

  it('rejects a part line with neither product nor name — 422 before the transaction opens', async () => {
    const jobId = await seedJob('in_progress');
    const res = await postComplete(TECH_A.token, jobId, completeBody({ parts: [{ quantity: 1 }] }));
    expect(res.statusCode, res.body).toBe(422);
    expect(res.body).toMatch(/name the part/i);
  });

  it('rejects a stack change without a serial — the audit trail needs it', async () => {
    const jobId = await seedJob('in_progress');
    const res = await postComplete(TECH_A.token, jobId, completeBody({ stackChanges: [{ productId }] }));
    expect(res.statusCode, res.body).toBe(422);
  });
});

describe('an AMC job completes like any other (§6.2, decision 2026-09-15)', () => {
  it('completing an AMC job with cost omitted and collectionMode none is accepted — the reminder reads v_contracts', async () => {
    // The AMC behind the job, covering today.
    const amcId = (
      await db.query<{ id: string }>(
        `INSERT INTO service_contracts
           (contract_number, customer_id, start_date, end_date, contract_value, created_by)
         VALUES ($1, $2, $3::date, $4::date, '12000.00', $5) RETURNING id`,
        [
          `AMC-T16-${randomBytes(4).toString('hex')}`,
          customerId,
          new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date(Date.now() - 10 * 86_400_000)),
          new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date(Date.now() + 355 * 86_400_000)),
          DISPATCHER.id,
        ],
      )
    ).rows[0]!.id;
    const jobId = await seedJobWithContract(amcId);

    // No cost, no mode — the absent-means-zero shape a Free completion sends.
    const res = await postComplete(TECH_A.token, jobId, completeBody({ collectionMode: 'none' }));
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().status).toBe('completed');
    const money = await moneyRow(jobId);
    expect(money).not.toBeNull();
    expect(money!.cost).toBe('0.00');
    expect(money!.collection_mode).toBe('none');

    // §6.2 step 7 removed 2026-09-15: there is no hook to assert — the
    // AMC's reminder derives from the completed job itself (v_contracts:
    // last_service_date is any completed job at the customer).
    const lastService = await db.query<{ last_service_date: string }>(
      `SELECT last_service_date::text FROM v_contracts WHERE id = $1`,
      [amcId],
    );
    expect(lastService.rows[0]!.last_service_date).toBe(
      new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date()),
    );
  });
});

/** The seedJob card, linked to an AMC — the only extra column this suite needs. */
async function seedJobWithContract(contractId: string): Promise<string> {
  const jobId = await seedJob('in_progress');
  await db.query('UPDATE job_cards SET contract_id = $2 WHERE id = $1', [jobId, contractId]);
  return jobId;
}
