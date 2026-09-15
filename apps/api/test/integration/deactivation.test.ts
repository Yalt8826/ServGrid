import { randomBytes } from 'node:crypto';
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
 * Deactivation and role-change preconditions (T4.5, PLAN-BACKEND.md §4.1,
 * PLAN.md §5, PLAN-GAPS.md G15). Runs against a scratch database built
 * from the real migrations (§14: no mocked database anywhere) and drives
 * PATCH /v1/employees/:id over HTTP, because the contract is the ENVELOPE:
 * a 409 whose `details` name the blocking rows so the owner's screen can
 * render reassignment links instead of an error message.
 *
 * The three blocking conditions are each proven independently — open jobs,
 * owned companies, an unconfirmed cash reconciliation — then the success
 * path is proven in full:
 * tokens revoked, devices inactive, out of the tracking-health view, and
 * history (completions, payments) still attributing to the deactivated
 * account, because `is_active` was never a delete.
 */

function databaseUrl(): string {
  return process.env.DATABASE_URL ?? 'postgres://servgrid:servgrid@localhost:5432/servgrid';
}

function adminUrlFor(url: string): string {
  const parsed = new URL(url);
  parsed.pathname = '/postgres';
  return parsed.toString();
}

const SCRATCH_DB = 'servgrid_deactivation_test';
const PASSWORD = 'deactivation-precond-45';

let admin: Pool;
let db: Pool;
let app: FastifyInstance;
let config: Config;

const OWNER = { id: '', username: '', token: '' };

interface Actor {
  id: string;
  username: string;
}

async function seedEmployee(role: 'owner' | 'dispatcher' | 'technician' | 'sales_rep'): Promise<Actor & { token: string }> {
  const username = `t45.${role}.${randomBytes(4).toString('hex')}`;
  const r = await db.query<{ id: string }>(
    `INSERT INTO employees (username, password_hash, full_name, role)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [username, await hashPassword(PASSWORD), `Test ${username}`, role],
  );
  const id = r.rows[0]!.id;
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
  return { id, username, token: res.json<LoginResponse>().accessToken };
}

/** A subject with no session — the owner acts on him, he never logs in. */
async function seedQuiet(role: 'technician' | 'sales_rep'): Promise<Actor> {
  const username = `t45.quiet.${randomBytes(4).toString('hex')}`;
  const r = await db.query<{ id: string }>(
    `INSERT INTO employees (username, password_hash, full_name, role)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [username, await hashPassword(PASSWORD), `Test ${username}`, role],
  );
  return { id: r.rows[0]!.id, username };
}

async function seedCustomer(): Promise<string> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO customers (name, phone) VALUES ($1, $2) RETURNING id`,
    [`Customer ${randomBytes(4).toString('hex')}`, '9800000000'],
  );
  return r.rows[0]!.id;
}

async function seedService(): Promise<string> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO services (code, name) VALUES ($1, $2) RETURNING id`,
    [`svc-${randomBytes(4).toString('hex')}`, 'Test service'],
  );
  return r.rows[0]!.id;
}

let jobSeq = 0;

/** An open (assigned/in_progress) job on a technician's sheet. */
async function seedOpenJob(assignedTo: string, status: 'assigned' | 'in_progress' = 'assigned'): Promise<{ id: string; jobNumber: string }> {
  const customerId = await seedCustomer();
  const serviceId = await seedService();
  jobSeq += 1;
  const jobNumber = `JC-4500-${String(jobSeq).padStart(5, '0')}-${randomBytes(2).toString('hex')}`;
  const r = await db.query<{ id: string }>(
    `INSERT INTO job_cards (job_number, customer_id, service_id, title, status, assigned_to, assigned_by, assigned_at)
     VALUES ($1, $2, $3, 'Gate test job', $4, $5, $6, now()) RETURNING id`,
    [jobNumber, customerId, serviceId, status, assignedTo, OWNER.id],
  );
  return { id: r.rows[0]!.id, jobNumber };
}

async function seedCompany(ownerRepId: string | null): Promise<{ id: string; name: string }> {
  const name = `Company ${randomBytes(6).toString('hex')}`;
  const r = await db.query<{ id: string }>(
    `INSERT INTO companies (name, owner_rep_id) VALUES ($1, $2) RETURNING id`,
    [name, ownerRepId],
  );
  return { id: r.rows[0]!.id, name };
}

/** Business dates computed the way the service computes them — IST, not this machine's clock. */
async function businessDate(offsetDays: number): Promise<string> {
  const r = await db.query<{ d: string }>(
    `SELECT (business_date(now()) + $1::int)::text AS d`,
    [offsetDays],
  );
  return r.rows[0]!.d;
}

async function seedCash(
  employeeId: string,
  status: 'submitted' | 'disputed',
  offsetDays = -1,
): Promise<string> {
  const d = await businessDate(offsetDays);
  const r = await db.query<{ id: string }>(
    `INSERT INTO cash_reconciliations
       (employee_id, business_date, declared_amount, declared_at, status,
        confirmed_at, confirmed_by, owner_note)
     VALUES ($1, $2, 500.00, now(), $3,
             $4, $5, $6)
     RETURNING id`,
    [
      employeeId,
      d,
      status,
      status === 'disputed' ? now() : null, // submitted ⇒ unanswered (CHECK)
      status === 'disputed' ? OWNER.id : null,
      status === 'disputed' ? 'short by 40, no explanation' : null, // disputed ⇒ justified (CHECK)
    ],
  );
  return r.rows[0]!.id;
}

function now(): Date {
  return new Date();
}

/** Confirms a reconciliation the way the owner's confirm does (§10) — the T4.2 queue endpoints are a later task. */
async function confirmCash(id: string): Promise<void> {
  await db.query(
    `UPDATE cash_reconciliations
     SET status = 'confirmed', confirmed_at = now(), confirmed_by = $2, confirmed_amount = declared_amount
     WHERE id = $1`,
    [id, OWNER.id],
  );
}

function envelopeOf(status: number, body: string): ErrorEnvelope['error'] {
  expect(status).toBeGreaterThanOrEqual(400);
  const parsed = errorEnvelopeSchema.parse(JSON.parse(body)) as unknown as ErrorEnvelope;
  const error = parsed.error;
  expect(error.requestId).toMatch(ULID);
  return error;
}

async function versionOf(id: string): Promise<number> {
  const res = await app.inject({
    method: 'GET',
    url: `/v1/employees/${id}`,
    headers: { authorization: `Bearer ${OWNER.token}` },
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json<{ version: number }>().version;
}

async function patchEmployee(id: string, payload: Record<string, unknown>) {
  return app.inject({
    method: 'PATCH',
    url: `/v1/employees/${id}`,
    headers: { authorization: `Bearer ${OWNER.token}`, 'if-match': String(await versionOf(id)) },
    payload,
  });
}

interface BlockingDetail {
  kind: string;
  id: string;
  jobNumber?: string;
  name?: string;
  businessDate?: string;
  status?: string;
  endpoint?: string;
}

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

  const owner = await seedEmployee('owner');
  OWNER.id = owner.id;
  OWNER.username = owner.username;
  OWNER.token = owner.token;
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

describe('PATCH /v1/employees/:id — the three-way deactivation gate (T4.5)', () => {
  it('refuses while he holds open jobs — naming them — and deactivates once they are reassigned', async () => {
    const tech = await seedQuiet('technician');
    const jobA = await seedOpenJob(tech.id, 'assigned');
    const jobB = await seedOpenJob(tech.id, 'in_progress');

    const refused = await patchEmployee(tech.id, { isActive: false });
    expect(refused.statusCode).toBe(409);
    const error = envelopeOf(refused.statusCode, refused.body);
    expect(error.code).toBe('EMPLOYEE_HAS_OPEN_WORK');
    const details = error.details as BlockingDetail[];
    expect(details).toHaveLength(2);
    expect(details.map((d) => d.kind)).toEqual(['job', 'job']);
    expect(details.map((d) => d.jobNumber).sort()).toEqual([jobA.jobNumber, jobB.jobNumber].sort());
    expect(details.map((d) => d.id).sort()).toEqual([jobA.id, jobB.id].sort());

    // The owner's remedy is reassignment, not deletion — the same remedy the links offer.
    const other = await seedQuiet('technician');
    await db.query(`UPDATE job_cards SET assigned_to = $2 WHERE id = $1`, [jobA.id, other.id]);
    await db.query(`UPDATE job_cards SET assigned_to = $2 WHERE id = $1`, [jobB.id, other.id]);

    const ok = await patchEmployee(tech.id, { isActive: false });
    expect(ok.statusCode).toBe(200);
    expect(ok.json<{ isActive: boolean }>().isActive).toBe(false);
  });

  it('refuses while he owns companies — naming them — and deactivates once the accounts are house accounts again', async () => {
    const rep = await seedQuiet('sales_rep');
    const companyA = await seedCompany(rep.id);
    const companyB = await seedCompany(rep.id);

    const refused = await patchEmployee(rep.id, { isActive: false });
    expect(refused.statusCode).toBe(409);
    const error = envelopeOf(refused.statusCode, refused.body);
    expect(error.code).toBe('EMPLOYEE_HAS_OPEN_WORK');
    const details = error.details as BlockingDetail[];
    expect(details).toHaveLength(2);
    expect(details.map((d) => d.kind)).toEqual(['company', 'company']);
    expect(details.map((d) => d.id).sort()).toEqual([companyA.id, companyB.id].sort());
    expect(details.map((d) => d.name).sort()).toEqual([companyA.name, companyB.name].sort());

    // NULL is a house account — visible to both reps, invisible to neither.
    await db.query(`UPDATE companies SET owner_rep_id = NULL WHERE id = $1`, [companyA.id]);
    await db.query(`UPDATE companies SET owner_rep_id = NULL WHERE id = $1`, [companyB.id]);

    const ok = await patchEmployee(rep.id, { isActive: false });
    expect(ok.statusCode).toBe(200);
  });

  it('refuses on an unconfirmed cash reconciliation — submitted or disputed — and deactivates once both are answered', async () => {
    const tech = await seedQuiet('technician');
    const submitted = await seedCash(tech.id, 'submitted', -1);
    const disputed = await seedCash(tech.id, 'disputed', -2); // one declaration per person per day (unique)

    const refused = await patchEmployee(tech.id, { isActive: false });
    expect(refused.statusCode).toBe(409);
    const error = envelopeOf(refused.statusCode, refused.body);
    expect(error.code).toBe('EMPLOYEE_HAS_OPEN_WORK');
    const details = error.details as BlockingDetail[];
    expect(details).toHaveLength(2);
    expect(details.map((d) => d.kind)).toEqual(['cash', 'cash']);
    expect(details.map((d) => d.id).sort()).toEqual([submitted, disputed].sort());
    expect(details.map((d) => d.status).sort()).toEqual(['disputed', 'submitted']);

    // The owner answers the submitted one — the disputed row still blocks.
    await confirmCash(submitted);
    const stillBlocked = await patchEmployee(tech.id, { isActive: false });
    expect(stillBlocked.statusCode).toBe(409);
    expect(envelopeOf(stillBlocked.statusCode, stillBlocked.body).code).toBe('EMPLOYEE_HAS_OPEN_WORK');

    // …and answering the last one clears the gate. The cash rule is the
    // point of the whole gate: the person who could explain the variance
    // stays reachable until it is answered.
    await db.query(
      `UPDATE cash_reconciliations SET status = 'confirmed' WHERE id = $1`,
      [disputed],
    );
    const ok = await patchEmployee(tech.id, { isActive: false });
    expect(ok.statusCode).toBe(200);
  });

  it('a role change with no open work lands — no outbox condition exists any more (online-only)', async () => {
    const tech = await seedEmployee('technician');
    const ok = await patchEmployee(tech.id, { role: 'dispatcher' });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json<{ role: string; isActive: boolean }>().role).toBe('dispatcher');
    // A role change is not a deactivation: his sessions survive.
    expect(ok.json<{ isActive: boolean }>().isActive).toBe(true);
  });
});

describe('the deactivation consequence chain — sessions, devices, the health view, history', () => {
  it('on success: every refresh token revoked, devices inactive, absent from the tracking-health view', async () => {
    const tech = await seedEmployee('technician'); // login ⇒ one live refresh token + one active device

    // He is IN the health view before (a technician row, whatever his health value).
    const before = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM v_employee_tracking_health WHERE employee_id = $1`,
      [tech.id],
    );
    expect(before.rows[0]!.n).toBe(1);

    const ok = await patchEmployee(tech.id, { isActive: false });
    expect(ok.statusCode).toBe(200);

    const live = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM refresh_tokens WHERE employee_id = $1 AND revoked_at IS NULL`,
      [tech.id],
    );
    expect(live.rows[0]!.n).toBe(0);

    const devices = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM devices WHERE employee_id = $1 AND is_active`,
      [tech.id],
    );
    expect(devices.rows[0]!.n).toBe(0);

    const after = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM v_employee_tracking_health WHERE employee_id = $1`,
      [tech.id],
    );
    expect(after.rows[0]!.n).toBe(0);

    // His access dies with the refresh chain: a fresh login is a 401 —
    // UNAUTHENTICATED, the account no longer a door.
    const login = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: {
        username: tech.username,
        password: PASSWORD,
        device: {
          installId: 'install-after-deactivation',
          platform: 'android',
          appVersion: '0.1.0',
          osVersion: '14',
          manufacturer: 'Xiaomi',
          model: 'Redmi Note 12',
        },
      },
    });
    expect(login.statusCode).toBe(401);
    expect(envelopeOf(login.statusCode, login.body).code).toBe('UNAUTHENTICATED');
  });

  it('history is untouched: his completion and his payment still exist and still attribute to him', async () => {
    // A technician whose week already happened: one completed job with its
    // completion (the money record), nothing open.
    const tech = await seedQuiet('technician');
    const closed = await seedOpenJob(tech.id, 'assigned');
    await db.query(
      `UPDATE job_cards SET status = 'completed', closed_at = now() WHERE id = $1`,
      [closed.id],
    );
    await db.query(
      `INSERT INTO job_completions (job_card_id, completed_by, completed_at, work_summary, cost, collection_mode)
       VALUES ($1, $2, now(), 'Replaced batteries, tested output', 850.00, 'cash')`,
      [closed.id, tech.id],
    );

    // A rep whose payment already landed, in a house account he does not own.
    const rep = await seedQuiet('sales_rep');
    const house = await seedCompany(null);
    await db.query(
      `INSERT INTO payments (payment_number, company_id, amount, mode, received_by, received_at)
       VALUES ($1, $2, 1200.00, 'cash', $3, now())`,
      [`PM-4500-${randomBytes(4).toString('hex')}`, house.id, rep.id],
    );

    expect((await patchEmployee(tech.id, { isActive: false })).statusCode).toBe(200);
    expect((await patchEmployee(rep.id, { isActive: false })).statusCode).toBe(200);

    // The completion survives, still his — including the money figure the
    // owner's revenue reads; nothing was cascaded away.
    const completion = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM job_completions WHERE completed_by = $1 AND cost = 850.00`,
      [tech.id],
    );
    expect(completion.rows[0]!.n).toBe(1);
    const job = await db.query<{ assigned_to: string; status: string }>(
      `SELECT assigned_to::text, status::text FROM job_cards WHERE id = $1`,
      [closed.id],
    );
    expect(job.rows[0]!.assigned_to).toBe(tech.id);
    expect(job.rows[0]!.status).toBe('completed');

    // The payment survives, still his.
    const payment = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM payments WHERE received_by = $1 AND amount = 1200.00`,
      [rep.id],
    );
    expect(payment.rows[0]!.n).toBe(1);

    // `is_active` was never a delete: the account rows remain, inactive.
    const accounts = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM employees WHERE id = ANY($1::uuid[]) AND NOT is_active`,
      [[tech.id, rep.id]],
    );
    expect(accounts.rows[0]!.n).toBe(2);
  });
});
