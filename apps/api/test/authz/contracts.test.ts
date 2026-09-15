import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import type { FastifyInstance } from 'fastify';
import {
  type Contract,
  ContractSchema,
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
 * Contracts authorisation suite (PHASE-2B-CONTRACTS.md T2B.2, decision
 * 2026-09-15). The AMC surface is the office's: dispatcher and owner on
 * every route, the technician and both sales reps 403 on every route —
 * the technician's AMC context rides inline on his own job (T2B.3), and
 * reps have no part in AMCs (decision 10). `contracts.manage` is the
 * phase's T0 rollback: flag off for the dispatcher, every route answers
 * FLAG_DISABLED. And nobody at all gets in without a token.
 */

function databaseUrl(): string {
  return process.env.DATABASE_URL ?? 'postgres://servgrid:servgrid@localhost:5432/servgrid';
}

function adminUrlFor(url: string): string {
  const parsed = new URL(url);
  parsed.pathname = '/postgres';
  return parsed.toString();
}

const SCRATCH_DB = 'servgrid_authz_contracts_test';
const PASSWORD = 'amc-plain-copier-41';

/** The IST business date `offsetDays` from today, as the plain `YYYY-MM-DD` a date column takes. */
function istDate(offsetDays: number): string {
  return new Date(Date.now() + offsetDays * 86_400_000 + 5.5 * 3_600_000).toISOString().slice(0, 10);
}

interface Actor {
  username: string;
  id: string;
  token: string;
}

const OWNER: Actor = { username: '', id: '', token: '' };
const DISPATCHER: Actor = { username: '', id: '', token: '' };
const TECH: Actor = { username: '', id: '', token: '' };
const REP_A: Actor = { username: '', id: '', token: '' };
const REP_B: Actor = { username: '', id: '', token: '' };

let admin: Pool;
let db: Pool;
let app: FastifyInstance;
let config: Config;

async function seedEmployee(role: 'owner' | 'dispatcher' | 'technician' | 'sales_rep', who: Actor): Promise<void> {
  const username = `t2b2az.${role}.${randomBytes(4).toString('hex')}`;
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

function bearer(actor: Actor): Record<string, string> {
  return { authorization: `Bearer ${actor.token}` };
}

function errorOf(status: number, body: string): ErrorEnvelope['error'] {
  expect(status).toBeGreaterThanOrEqual(400);
  const error = (JSON.parse(body) as ErrorEnvelope).error;
  expect(error.requestId).toMatch(ULID);
  return error;
}

let customerId = '';
let amcId = '';
let amcVersion = 1;

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
  await seedEmployee('sales_rep', REP_A);
  await seedEmployee('sales_rep', REP_B);

  // contracts.manage ON for exactly the two roles the surface answers.
  await db.query(
    `INSERT INTO employee_flag_overrides (employee_id, flag, enabled, updated_by)
     VALUES ($1, 'contracts.manage', true, $1), ($2, 'contracts.manage', true, $2)`,
    [OWNER.id, DISPATCHER.id],
  );

  customerId = (
    await db.query<{ id: string }>(
      `INSERT INTO customers (name, phone) VALUES ('Authz AMC Customer', '9847000042') RETURNING id`,
    )
  ).rows[0]!.id;

  amcId = (
    await db.query<{ id: string; version: number }>(
      `INSERT INTO service_contracts (contract_number, customer_id, start_date, end_date, contract_value, created_by)
       VALUES ($1, $2, $3, $4, '12000.00', $5) RETURNING id, version`,
      [`AMC-AZ-${randomBytes(4).toString('hex')}`, customerId, istDate(-10), istDate(355), OWNER.id],
    )
  ).rows[0]!.id;
  amcVersion = (
    await db.query<{ version: number }>('SELECT version FROM service_contracts WHERE id = $1', [amcId])
  ).rows[0]!.version;
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

/** The five doors, as the walk needs them: every payload valid, so a 403 can only be the gate. */
function routeCalls(
  actor: Actor,
  createBody: Record<string, unknown>,
): Array<{ method: 'GET' | 'POST' | 'PATCH'; url: string; headers?: Record<string, string>; payload?: Record<string, unknown> }> {
  return [
    { method: 'GET', url: '/v1/contracts', headers: bearer(actor) },
    { method: 'GET', url: `/v1/contracts/${amcId}`, headers: bearer(actor) },
    { method: 'POST', url: '/v1/contracts', headers: bearer(actor), payload: createBody },
    { method: 'PATCH', url: `/v1/contracts/${amcId}`, headers: { ...bearer(actor), 'if-match': String(amcVersion) }, payload: { notes: 'authz walk edit' } },
    { method: 'POST', url: `/v1/contracts/${amcId}/cancel`, headers: bearer(actor), payload: { reason: 'authz walk cancel' } },
  ];
}

describe('the office reads and writes every route — dispatcher and owner', () => {
  it('the dispatcher: 200 on the list, the detail, a create, an edit and a cancel', async () => {
    const list = await app.inject({ method: 'GET', url: '/v1/contracts', headers: bearer(DISPATCHER) });
    expect(list.statusCode, list.body).toBe(200);

    const detail = await app.inject({ method: 'GET', url: `/v1/contracts/${amcId}`, headers: bearer(DISPATCHER) });
    expect(detail.statusCode, detail.body).toBe(200);

    // A create over a range nothing else holds, so it cannot collide.
    const create = await app.inject({
      method: 'POST',
      url: '/v1/contracts',
      headers: bearer(DISPATCHER),
      payload: { customerId, startDate: istDate(400), endDate: istDate(760), contractValue: '15000.00' },
    });
    expect(create.statusCode, create.body).toBe(200);
    const created = ContractSchema.parse(JSON.parse(create.body)) as Contract;
    expect(created.contractNumber).toMatch(/^AMC-\d{4}-\d{5}$/);

    const patch = await app.inject({
      method: 'PATCH',
      url: `/v1/contracts/${created.id}`,
      headers: { ...bearer(DISPATCHER), 'if-match': '1' },
      payload: { notes: 'dispatcher edit' },
    });
    expect(patch.statusCode, patch.body).toBe(200);

    const cancel = await app.inject({
      method: 'POST',
      url: `/v1/contracts/${created.id}/cancel`,
      headers: bearer(DISPATCHER),
      payload: { reason: 'recorded against the wrong site' },
    });
    expect(cancel.statusCode, cancel.body).toBe(200);
    expect((JSON.parse(cancel.body) as Contract).state).toBe('cancelled');
  });

  it('the owner: 200 on the list, the detail, a create, an edit and a cancel', async () => {
    const list = await app.inject({ method: 'GET', url: '/v1/contracts', headers: bearer(OWNER) });
    expect(list.statusCode, list.body).toBe(200);

    const detail = await app.inject({ method: 'GET', url: `/v1/contracts/${amcId}`, headers: bearer(OWNER) });
    expect(detail.statusCode, detail.body).toBe(200);

    // The day after the dispatcher's create ended — a renewal, not an overlap.
    const create = await app.inject({
      method: 'POST',
      url: '/v1/contracts',
      headers: bearer(OWNER),
      payload: { customerId, startDate: istDate(761), endDate: istDate(1120), contractValue: '16000.00' },
    });
    expect(create.statusCode, create.body).toBe(200);
    const created = ContractSchema.parse(JSON.parse(create.body)) as Contract;

    const patch = await app.inject({
      method: 'PATCH',
      url: `/v1/contracts/${created.id}`,
      headers: { ...bearer(OWNER), 'if-match': '1' },
      payload: { notes: 'owner edit' },
    });
    expect(patch.statusCode, patch.body).toBe(200);

    const cancel = await app.inject({
      method: 'POST',
      url: `/v1/contracts/${created.id}/cancel`,
      headers: bearer(OWNER),
      payload: { reason: 'owner walk cancel' },
    });
    expect(cancel.statusCode, cancel.body).toBe(200);
  });
});

describe('every route refuses the field — technician and sales_rep are 403 FORBIDDEN', () => {
  // Distinct future ranges per call would overlap each other; these
  // requests must never reach the handler at all, so a shared body is fine.
  const refusedBody = { customerId, startDate: istDate(1200), endDate: istDate(1560), contractValue: '1.00' };

  it.each([TECH, REP_A, REP_B])('%s is 403 FORBIDDEN on all five routes', async (actor) => {
    for (const call of routeCalls(actor, refusedBody)) {
      const res = await app.inject({ method: call.method, url: call.url, headers: call.headers, payload: call.payload });
      expect(res.statusCode, `${call.method} ${call.url}: ${res.body}`).toBe(403);
      expect(errorOf(res.statusCode, res.body).code).toBe('FORBIDDEN');
    }
  });

  it('the refusals were the writes: the seeded AMC is untouched', async () => {
    const row = await db.query<{ notes: string | null; cancelled_at: Date | null; version: number }>(
      'SELECT notes, cancelled_at, version FROM service_contracts WHERE id = $1',
      [amcId],
    );
    expect(row.rows[0]!.notes).toBeNull();
    expect(row.rows[0]!.cancelled_at).toBeNull();
    expect(row.rows[0]!.version).toBe(amcVersion);
  });
});

describe('the flag is the T0 rollback — flag off, the surface goes dark for everyone on it', () => {
  it('contracts.manage off for the dispatcher: FLAG_DISABLED on every route', async () => {
    await db.query(
      `UPDATE employee_flag_overrides SET enabled = false WHERE employee_id = $1 AND flag = 'contracts.manage'`,
      [DISPATCHER.id],
    );
    for (const call of routeCalls(DISPATCHER, { customerId, startDate: istDate(1200), endDate: istDate(1560), contractValue: '1.00' })) {
      const res = await app.inject({ method: call.method, url: call.url, headers: call.headers, payload: call.payload });
      expect(res.statusCode, `${call.method} ${call.url}: ${res.body}`).toBe(409);
      expect(errorOf(res.statusCode, res.body).code).toBe('FLAG_DISABLED');
    }
    // Restore: later suites in this file read the flag through the dispatcher.
    await db.query(
      `UPDATE employee_flag_overrides SET enabled = true WHERE employee_id = $1 AND flag = 'contracts.manage'`,
      [DISPATCHER.id],
    );
  });
});

describe('no token, no AMC', () => {
  it('an unauthenticated request is 401 on the reads and the cancel door', async () => {
    const list = await app.inject({ method: 'GET', url: '/v1/contracts' });
    expect(list.statusCode, list.body).toBe(401);

    const detail = await app.inject({ method: 'GET', url: `/v1/contracts/${amcId}` });
    expect(detail.statusCode, detail.body).toBe(401);

    const cancel = await app.inject({
      method: 'POST',
      url: `/v1/contracts/${amcId}/cancel`,
      payload: { reason: 'no token' },
    });
    expect(cancel.statusCode, cancel.body).toBe(401);
  });
});
