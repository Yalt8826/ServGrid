import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import type { FastifyInstance } from 'fastify';
import {
  errorEnvelopeSchema,
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
 * The completion amendment (PHASE-4-OWNER.md T4.3, PLAN-BACKEND.md §6.2b,
 * PLAN-DATA-MODEL.md §3.4 "Amendment"). Runs against a scratch database
 * built from the real migrations and drives the endpoints over HTTP —
 * §14: no mocked database anywhere. What a mock cannot be wrong about is
 * exactly the subject here: the generated `amount_collected`, the
 * `completion_discount_justified` constraint judging the FINAL row, and
 * the covering `cash_reconciliations` row for the employee-day.
 *
 * The brief's "Done when" spine is the four-step cycle proven end to end:
 * amend → confirm → amend refused → reopen → amend. Around it sit the six
 * named tests: before confirm the queue reflects the new figure; after
 * confirm the 409 NAMES the reconciliation (so the client can offer to
 * reopen it); the event trail carries both before and after; a discount
 * introduced by an amendment still needs a reason; and nobody but the
 * owner can amend — the three other roles 403, and the flag dark means
 * nobody at all (T0).
 */

function databaseUrl(): string {
  return process.env.DATABASE_URL ?? 'postgres://servgrid:servgrid@localhost:5432/servgrid';
}

function adminUrlFor(url: string): string {
  const parsed = new URL(url);
  parsed.pathname = '/postgres';
  return parsed.toString();
}

const SCRATCH_DB = 'servgrid_amendment_test';
const PASSWORD = 'am-t43-plain-43';
const AMEND_REASON = 'technician typed 50000 for 5000 — corrected against the paper docket';
const REOPEN_REASON = 'the confirmed figure was the typo, not the amendment';

let admin: Pool;
let db: Pool;
let app: FastifyInstance;
let config: Config;

const OWNER = { username: '', id: '', token: '' };
/** A second owner with the flag left dark — `owner.amend` is asked of every caller. */
const OWNER_NOFLAG = { username: '', id: '', token: '' };
const DISPATCHER = { username: '', id: '', token: '' };
const TECH = { username: '', id: '', token: '' };
const SALES_REP = { username: '', id: '', token: '' };

async function seedEmployee(
  role: 'owner' | 'dispatcher' | 'technician' | 'sales_rep',
  who: { username: string; id: string; token: string },
): Promise<void> {
  const username = `t43.${role}.${randomBytes(4).toString('hex')}`;
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

/** Business dates computed the way the database computes them — IST, not this machine's clock. */
async function bd(offsetDays: number): Promise<string> {
  const r = await db.query<{ d: string }>(
    `SELECT (business_date(now()) + $1::int)::text AS d`,
    [offsetDays],
  );
  return r.rows[0]!.d;
}

/** IST noon of a business date — unambiguously inside that day. */
function noonOf(date: string): string {
  return `${date}T12:00:00+05:30`;
}

let customerId = '';
let serviceId = '';
let jobSeq = 0;

interface SeededJob {
  jobId: string;
  businessDate: string;
}

/** A completed job + its cash completion, written directly — the fixture the amendment corrects. */
async function seedCompletion(date: string, cost: string): Promise<SeededJob> {
  jobSeq += 1;
  const jobId = (
    await db.query<{ id: string }>(
      `INSERT INTO job_cards (job_number, customer_id, service_id, title, status,
                              assigned_to, assigned_at, scheduled_for, closed_at)
       VALUES ($1, $2, $3, 'T43 amendment job', 'completed', $4, $5, $5, $5)
       RETURNING id`,
      [
        `JC-T43-${jobSeq}-${randomBytes(3).toString('hex')}`,
        customerId,
        serviceId,
        TECH.id,
        noonOf(date),
      ],
    )
  ).rows[0]!.id;
  await db.query(
    `INSERT INTO job_completions
       (job_card_id, completed_by, completed_at, work_summary, cost, collection_mode)
     VALUES ($1, $2, $3, 'Replaced batteries', $4::numeric, 'cash')`,
    [jobId, TECH.id, noonOf(date), cost],
  );
  return { jobId, businessDate: date };
}

/** A declaration, written directly — confirm/reopen themselves go over HTTP. */
async function seedDeclaration(employeeId: string, date: string, amount: string): Promise<string> {
  return (
    await db.query<{ id: string }>(
      `INSERT INTO cash_reconciliations (employee_id, business_date, declared_amount, declared_at)
       VALUES ($1, $2::date, $3::numeric, $4) RETURNING id`,
      [employeeId, date, amount, noonOf(date)],
    )
  ).rows[0]!.id;
}

function amend(token: string, jobId: string, body: Record<string, unknown>) {
  return app.inject({
    method: 'POST',
    url: `/v1/jobs/${jobId}/completion/amend`,
    headers: { authorization: `Bearer ${token}`, 'x-client-source': 'web' },
    payload: body,
  });
}

function ownerAction(
  token: string,
  action: 'confirm' | 'reopen',
  declarationId: string,
  body: Record<string, unknown>,
) {
  return app.inject({
    method: 'POST',
    url: `/v1/cash/handovers/${declarationId}/${action}`,
    headers: { authorization: `Bearer ${token}`, 'x-client-source': 'web' },
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

async function completionRowOf(jobId: string): Promise<{
  cost: string;
  discount_amount: string;
  discount_reason: string | null;
  amount_collected: string;
  version: number;
}> {
  const r = await db.query<{
    cost: string;
    discount_amount: string;
    discount_reason: string | null;
    amount_collected: string;
    version: number;
  }>(
    `SELECT cost::text AS cost, discount_amount::text AS discount_amount, discount_reason,
            amount_collected::text AS amount_collected, version
     FROM job_completions WHERE job_card_id = $1`,
    [jobId],
  );
  return r.rows[0]!;
}

/** The queue row for TECH's day, read the way the owner's screen reads it. */
async function queueRowFor(date: string): Promise<{ expectedCash: string | null; declaredAmount: string | null }> {
  const res = await app.inject({
    method: 'GET',
    url: `/v1/cash/queue?from=${date}&to=${date}`,
    headers: { authorization: `Bearer ${OWNER.token}` },
  });
  expect(res.statusCode, res.body).toBe(200);
  const rows = res.json<{ rows: Array<{ employeeId: string; expectedCash: string | null; declaredAmount: string | null }> }>().rows;
  const row = rows.find((r) => r.employeeId === TECH.id);
  expect(row, `queue row for ${date}`).toBeDefined();
  return row!;
}

/** The newest `completion_amended` event on a job, payload included. */
async function lastAmendEventOf(jobId: string): Promise<{ payload: Record<string, unknown>; actor_id: string } | null> {
  const r = await db.query<{ payload: Record<string, unknown>; actor_id: string }>(
    `SELECT payload, actor_id FROM job_events
     WHERE job_card_id = $1 AND event_type = 'completion_amended'
     ORDER BY occurred_at DESC, id DESC LIMIT 1`,
    [jobId],
  );
  return r.rows[0] ?? null;
}

async function amendEventCountOf(jobId: string): Promise<string> {
  const r = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM job_events
     WHERE job_card_id = $1 AND event_type = 'completion_amended'`,
    [jobId],
  );
  return r.rows[0]!.n;
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

  await seedEmployee('owner', OWNER);
  await seedEmployee('owner', OWNER_NOFLAG);
  await seedEmployee('dispatcher', DISPATCHER);
  await seedEmployee('technician', TECH);
  await seedEmployee('sales_rep', SALES_REP);

  // The owner rides with both owner flags lit: the amendment is the
  // subject, and its four-step cycle drives confirm/reopen (T4.2's
  // surface) beside it. The flags' own switchable behaviour is
  // integration/flags.test.ts's subject; the dark side is asserted below.
  await db.query(
    `INSERT INTO employee_flag_overrides (employee_id, flag, enabled)
     VALUES ($1, 'owner.amend', true), ($2, 'owner.amend', false),
            ($1, 'owner.cash', true)`,
    [OWNER.id, OWNER_NOFLAG.id],
  );

  customerId = (
    await db.query<{ id: string }>(
      `INSERT INTO customers (name, phone) VALUES ('T43 Customer', '9840000043') RETURNING id`,
    )
  ).rows[0]!.id;
  serviceId = (
    await db.query<{ id: string }>(
      `INSERT INTO services (code, name) VALUES ('T43-SVC', 'T43 suite service') RETURNING id`,
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

describe('POST /v1/jobs/:id/completion/amend — before the sign-off (§6.2b)', () => {
  it('amends the figure and the queue reflects the new amount', async () => {
    // The brief's own story: ₹50,000 typed for ₹5,000. The technician's
    // declaration for the day already stands (submitted, not confirmed).
    const day = await bd(-3);
    const { jobId } = await seedCompletion(day, '50000');
    await seedDeclaration(TECH.id, day, '50000');

    const res = await amend(OWNER.token, jobId, { cost: '5000', reason: AMEND_REASON });
    expect(res.statusCode, res.body).toBe(200);

    const card = res.json<{
      id: string;
      cost: string;
      discountAmount: string;
      discountReason: string | null;
      amountCollected: string;
      status: string;
    }>();
    // The response is the owner card — the corrected money in the owner's
    // own shape, `amount_collected` regenerated by the database.
    expect(card.id).toBe(jobId);
    expect(card.status).toBe('completed');
    expect(card.cost).toBe('5000.00');
    expect(card.discountAmount).toBe('0.00');
    expect(card.amountCollected).toBe('5000.00');

    // …and the queue — v_employee_expected_cash, the view the typo
    // poisoned — now expects what was actually collected.
    const row = await queueRowFor(day);
    expect(row.expectedCash).toBe('5000.00');
    expect(row.declaredAmount).toBe('50000.00');
  });

  it('a job with no completion has nothing to amend — 404', async () => {
    jobSeq += 1;
    const jobId = (
      await db.query<{ id: string }>(
        `INSERT INTO job_cards (job_number, customer_id, service_id, title, status,
                                assigned_to, assigned_at, scheduled_for)
         VALUES ($1, $2, $3, 'T43 uncompleted', 'assigned', $4, $5, $5) RETURNING id`,
        [`JC-T43-${jobSeq}-${randomBytes(3).toString('hex')}`, customerId, serviceId, TECH.id, noonOf(await bd(-3))],
      )
    ).rows[0]!.id;
    const res = await amend(OWNER.token, jobId, { cost: '10', reason: AMEND_REASON });
    expect(res.statusCode, res.body).toBe(404);
    expect(envelopeOf(res.statusCode, res.body).code).toBe('NOT_FOUND');
  });
});

describe('POST /v1/jobs/:id/completion/amend — the confirmed day blocks (§6.2b step 3)', () => {
  it('amend after confirm → 409 RECONCILIATION_CONFIRMED naming the reconciliation in details', async () => {
    const day = await bd(-4);
    const { jobId } = await seedCompletion(day, '2000');
    const declarationId = await seedDeclaration(TECH.id, day, '2000');
    const confirmed = await ownerAction(OWNER.token, 'confirm', declarationId, { confirmedAmount: '2000' });
    expect(confirmed.statusCode, confirmed.body).toBe(200);

    const res = await amend(OWNER.token, jobId, { cost: '200', reason: AMEND_REASON });
    expect(res.statusCode, res.body).toBe(409);
    const error = envelopeOf(res.statusCode, res.body);
    expect(error.code).toBe('RECONCILIATION_CONFIRMED');
    // The details NAME the reconciliation — the same id reopen acts on, so
    // the client can offer the reopen as the next step.
    const details = error.details as {
      reconciliation: { id: string; businessDate: string; status: string };
    };
    expect(details.reconciliation.id).toBe(declarationId);
    expect(details.reconciliation.businessDate).toBe(day);
    expect(details.reconciliation.status).toBe('confirmed');

    // The refusal wrote nothing: the figure the owner signed off stands.
    expect((await completionRowOf(jobId)).cost).toBe('2000.00');
    expect(await amendEventCountOf(jobId)).toBe('0');
  });
});

describe('the four-step cycle — amend → confirm → amend refused → reopen → amend', () => {
  it('proves the whole loop end to end, and the trail carries before AND after', async () => {
    const day = await bd(-5);
    const { jobId } = await seedCompletion(day, '1000');
    const declarationId = await seedDeclaration(TECH.id, day, '1000');

    // 1. amend — an open day corrects freely.
    const first = await amend(OWNER.token, jobId, { cost: '1200', reason: 'first reading was short' });
    expect(first.statusCode, first.body).toBe(200);
    expect((await completionRowOf(jobId)).cost).toBe('1200.00');

    // 2. confirm — the owner signs the day off at what was handed over.
    const confirmed = await ownerAction(OWNER.token, 'confirm', declarationId, { confirmedAmount: '1200' });
    expect(confirmed.statusCode, confirmed.body).toBe(200);

    // 3. amend refused — a figure under a signed-off reconciliation does not move.
    const refused = await amend(OWNER.token, jobId, { cost: '900', reason: AMEND_REASON });
    expect(refused.statusCode, refused.body).toBe(409);
    expect(envelopeOf(refused.statusCode, refused.body).code).toBe('RECONCILIATION_CONFIRMED');
    expect((await completionRowOf(jobId)).cost).toBe('1200.00');

    // 4. reopen — a deliberate second action, reason required, audited.
    const reopened = await ownerAction(OWNER.token, 'reopen', declarationId, { reason: REOPEN_REASON });
    expect(reopened.statusCode, reopened.body).toBe(200);

    // 5. amend — the day is open again, the correction lands.
    const second = await amend(OWNER.token, jobId, { cost: '800', reason: 'the docket said 800 all along' });
    expect(second.statusCode, second.body).toBe(200);
    const row = await completionRowOf(jobId);
    expect(row.cost).toBe('800.00');
    expect(row.amount_collected).toBe('800.00');
    expect((await queueRowFor(day)).expectedCash).toBe('800.00');

    // The event trail: the LAST amendment carries BOTH values of everything
    // that moved — and the reason that moved it. `from` is the database's
    // text for the stored figure; `to` is what the owner sent.
    const event = await lastAmendEventOf(jobId);
    expect(event).not.toBeNull();
    expect(event!.actor_id).toBe(OWNER.id);
    expect(event!.payload).toMatchObject({
      reason: 'the docket said 800 all along',
      cost: { from: '1200.00', to: '800' },
      discountAmount: { from: '0.00', to: '0.00' },
      discountReason: { from: null, to: null },
    });

    // Two amendments on this job — the append-only log holds both; no
    // history column on the table to overwrite (§3.4).
    expect(await amendEventCountOf(jobId)).toBe('2');
  });
});

describe('the discount rule rides the amendment unchanged (§3.4)', () => {
  it('a discount introduced by an amendment still requires a reason — the constraint decides', async () => {
    const day = await bd(-6);
    const { jobId } = await seedCompletion(day, '1000');

    const res = await amend(OWNER.token, jobId, { discountAmount: '200', reason: AMEND_REASON });
    expect(res.statusCode, res.body).toBe(422);
    const error = envelopeOf(res.statusCode, res.body);
    expect(error.code).toBe('VALIDATION_FAILED');
    // The sentence is the constraint's own mapping — the service did not
    // re-decide the rule, it translated the refusal.
    expect(error.message).toBe('A discount needs a reason — say why the amount was reduced.');
    const row = await completionRowOf(jobId);
    expect(row.discount_amount).toBe('0.00');
    expect(row.amount_collected).toBe('1000.00');

    // With the reason the same amendment lands.
    const ok = await amend(OWNER.token, jobId, {
      discountAmount: '200',
      discountReason: 'one battery was under warranty',
      reason: AMEND_REASON,
    });
    expect(ok.statusCode, ok.body).toBe(200);
    const amended = await completionRowOf(jobId);
    expect(amended.discount_amount).toBe('200.00');
    expect(amended.discount_reason).toBe('one battery was under warranty');
    expect(amended.amount_collected).toBe('800.00');
  });

  it('a discount raised past the cost is bounded by the same constraint', async () => {
    const day = await bd(-7);
    const { jobId } = await seedCompletion(day, '300');
    const res = await amend(OWNER.token, jobId, {
      cost: '500',
      discountAmount: '600',
      discountReason: 'goodwill',
      reason: AMEND_REASON,
    });
    expect(res.statusCode, res.body).toBe(422);
    expect(envelopeOf(res.statusCode, res.body).code).toBe('VALIDATION_FAILED');
    expect((await completionRowOf(jobId)).cost).toBe('300.00');
  });
});

describe('who may amend — the matrix cell and the flag (§6.2b)', () => {
  let jobId = '';

  beforeAll(async () => {
    // One open-day completion for every refusal below to aim at.
    ({ jobId } = await seedCompletion(await bd(-8), '300'));
  });

  it('dispatcher, technician and sales rep all get 403 — owner only', async () => {
    for (const [role, who] of [
      ['dispatcher', DISPATCHER],
      ['technician', TECH],
      ['sales_rep', SALES_REP],
    ] as const) {
      const res = await amend(who.token, jobId, { cost: '1', reason: AMEND_REASON });
      expect(res.statusCode, `${role}: ${res.body}`).toBe(403);
      expect(envelopeOf(res.statusCode, res.body).code).toBe('FORBIDDEN');
    }
    expect((await completionRowOf(jobId)).cost).toBe('300.00');
  });

  it('an anonymous caller is 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/jobs/${jobId}/completion/amend`,
      headers: { 'x-client-source': 'web' },
      payload: { cost: '1', reason: AMEND_REASON },
    });
    expect(res.statusCode, res.body).toBe(401);
  });

  it('the flag dark — an owner meets 409 FLAG_DISABLED, the T0 rollback', async () => {
    const res = await amend(OWNER_NOFLAG.token, jobId, { cost: '1', reason: AMEND_REASON });
    expect(res.statusCode, res.body).toBe(409);
    expect(envelopeOf(res.statusCode, res.body).code).toBe('FLAG_DISABLED');
    expect((await completionRowOf(jobId)).cost).toBe('300.00');
  });

  it('a missing or blank reason is a 422 — an amendment without a why is not one', async () => {
    for (const body of [{}, { cost: '1' }, { reason: '' }, { reason: '   ' }]) {
      const res = await amend(OWNER.token, jobId, body);
      expect(res.statusCode, JSON.stringify(body)).toBe(422);
      expect(envelopeOf(res.statusCode, res.body).code).toBe('VALIDATION_FAILED');
    }
    expect((await completionRowOf(jobId)).cost).toBe('300.00');
  });

  it('an unknown job id is a 404', async () => {
    const res = await amend(OWNER.token, randomUUID(), { cost: '1', reason: AMEND_REASON });
    expect(res.statusCode, res.body).toBe(404);
    expect(envelopeOf(res.statusCode, res.body).code).toBe('NOT_FOUND');
  });
});
