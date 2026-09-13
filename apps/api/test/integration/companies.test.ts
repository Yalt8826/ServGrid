import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import type { FastifyInstance } from 'fastify';
import {
  CompanySchema,
  errorEnvelopeSchema,
  syncBatchResponseSchema,
  type CompanyRecord,
  type ErrorEnvelope,
  type LoginResponse,
  type SyncBatchResponse,
  type SyncOperation,
} from '@servgrid/shared';
import { loadConfig, type Config } from '../../src/config.js';
import { closePool } from '../../src/db/pool.js';
import { runMigrations } from '../../src/db/migrate.js';
import { hashPassword } from '../../src/lib/password.js';
import { buildServer } from '../../src/server.js';
import { ULID, validEnv } from '../helpers/env.js';

/**
 * Companies integration suite (PHASE-3-SALES-REP.md T3.2, PLAN-BACKEND.md
 * §11, PLAN-DATA-MODEL.md §3.2). The assertions the task exists for:
 *
 * - **Case-insensitive unique name among ACTIVE rows** — `name` is citext
 *   and `companies_active_name_unique` (migration 005) is partial; the
 *   service turns a collision into 409 DUPLICATE_ENTITY whose
 *   `details.existing` carries the server's row, because a rep told
 *   "already exists" must be able to see WHICH account (§11.1's contracts
 *   reasoning). An INACTIVE duplicate is allowed: deactivation is what
 *   releases the name for re-entry.
 * - **Two reps creating the same company OFFLINE is the ordinary
 *   collision of a shared territory** — the first drain applies; the
 *   second comes back `rejected` (a batch outcome — the op ran through
 *   the real stack and its own route's rbac) with DUPLICATE_ENTITY and
 *   `details.existing` naming the row that beat it, and exactly one row
 *   exists at the end.
 */

function databaseUrl(): string {
  return process.env.DATABASE_URL ?? 'postgres://servgrid:servgrid@localhost:5432/servgrid';
}

function adminUrlFor(url: string): string {
  const parsed = new URL(url);
  parsed.pathname = '/postgres';
  return parsed.toString();
}

const SCRATCH_DB = 'servgrid_companies_test';
const PASSWORD = 'cust-plain-copier-52';

interface Actor {
  username: string;
  id: string;
  token: string;
}

const OWNER: Actor = { username: '', id: '', token: '' };
const REP_A: Actor = { username: '', id: '', token: '' };
const REP_B: Actor = { username: '', id: '', token: '' };

let admin: Pool;
let db: Pool;
let app: FastifyInstance;
let config: Config;

async function seedEmployee(role: 'owner' | 'sales_rep', who: Actor, offline = false): Promise<void> {
  const username = `comp.${role}.${randomBytes(4).toString('hex')}`;
  const r = await db.query<{ id: string }>(
    `INSERT INTO employees (username, password_hash, full_name, role)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [username, await hashPassword(PASSWORD), `Test ${username}`, role],
  );
  who.id = r.rows[0]!.id;
  who.username = username;
  if (offline) {
    // The offline tier ships dark (PLAN-EXECUTION.md §3): the suite turns
    // it on for the rep who drains an outbox, the way the owner's flip
    // would — the flag mechanics themselves are flags.test.ts's subject.
    await db.query(
      `INSERT INTO employee_flag_overrides (employee_id, flag, enabled) VALUES ($1, 'tech.offline', true)`,
      [who.id],
    );
  }
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

async function createCompany(actor: Actor, payload: Record<string, unknown>): Promise<{ statusCode: number; body: string }> {
  return app.inject({ method: 'POST', url: '/v1/companies', headers: bearer(actor), payload });
}

function errorOf(status: number, body: string): ErrorEnvelope['error'] {
  expect(status).toBeGreaterThanOrEqual(400);
  const error = (JSON.parse(body) as ErrorEnvelope).error;
  expect(error.requestId).toMatch(ULID);
  return error;
}

/** One queued outbox create, verbatim from the handset shape (§7). */
function offlineCreate(localId: string, payload: Record<string, unknown>): SyncOperation {
  return {
    localId,
    idempotencyKey: randomUUID(),
    method: 'POST',
    path: '/v1/companies',
    body: payload,
  };
}

function randomUUID(): string {
  const hex = randomBytes(16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function drain(actor: Actor, operations: SyncOperation[]): Promise<SyncBatchResponse> {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/sync/batch',
    headers: { ...bearer(actor), 'x-client-source': 'mobile' },
    payload: { operations },
  });
  expect(res.statusCode, res.body).toBe(200);
  return syncBatchResponseSchema.parse(res.json());
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

  await seedEmployee('owner', OWNER);
  await seedEmployee('sales_rep', REP_A);
  await seedEmployee('sales_rep', REP_B, true); // REP_B drains an outbox below
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

describe('the name rule — case-insensitive unique among active rows', () => {
  const suffix = randomBytes(3).toString('hex');

  it('a second active create that differs only by case is refused 409 DUPLICATE_ENTITY, with details.existing carrying the server’s row', async () => {
    const first = await createCompany(REP_A, { name: `Integr Alpha Traders ${suffix}` });
    expect(first.statusCode, first.body).toBe(200);
    const created = CompanySchema.parse(JSON.parse(first.body)) as CompanyRecord;

    const second = await createCompany(REP_B, { name: `INTEGR ALPHA TRADERS ${suffix}` });
    expect(second.statusCode, second.body).toBe(409);
    const error = errorOf(second.statusCode, second.body);
    expect(error.code).toBe('DUPLICATE_ENTITY');
    // The refusal names the account, so the rep can go and open it.
    const existing = CompanySchema.parse((error.details as { existing: unknown }).existing) as CompanyRecord;
    expect(existing.id).toBe(created.id);
    expect(existing.ownerRepId).toBe(REP_A.id);
  });

  it('an INACTIVE duplicate is allowed — deactivation is what releases the name', async () => {
    const original = await createCompany(REP_A, { name: `Integr Beta Mills ${suffix}` });
    expect(original.statusCode, original.body).toBe(200);
    const row = CompanySchema.parse(JSON.parse(original.body)) as CompanyRecord;

    // There is no DELETE route (§11 defines none); this suite needs the
    // state, not the route — deactivation is the soft delete the schema
    // carries for exactly this release-the-name property (migration 005).
    await db.query('UPDATE companies SET is_active = false WHERE id = $1', [row.id]);

    const reentry = await createCompany(REP_A, { name: `INTEGR BETA MILLS ${suffix}` });
    expect(reentry.statusCode, reentry.body).toBe(200);
    const recreated = CompanySchema.parse(JSON.parse(reentry.body)) as CompanyRecord;
    expect(recreated.id).not.toBe(row.id);

    // ...and the rule is live rows only: the new one now refuses a case-twin.
    const twin = await createCompany(REP_B, { name: `integr beta mills ${suffix}` });
    expect(twin.statusCode, twin.body).toBe(409);
    expect(errorOf(twin.statusCode, twin.body).code).toBe('DUPLICATE_ENTITY');
  });
});

describe('two reps create the same company offline', () => {
  it('the first drain applies; the second is rejected DUPLICATE_ENTITY with details.existing — and exactly one row exists', async () => {
    const suffix = randomBytes(3).toString('hex');
    const shared = {
      name: `Integr Gamma Enterprises ${suffix}`,
      city: 'Bengaluru',
    };

    // Rep A's create reaches the server first (his device synced at the
    // office wifi); he owns the row the moment it exists.
    const online = await createCompany(REP_A, shared);
    expect(online.statusCode, online.body).toBe(200);
    const serverRow = CompanySchema.parse(JSON.parse(online.body)) as CompanyRecord;
    expect(serverRow.ownerRepId).toBe(REP_A.id);

    // Rep B queued the identical create offline; the drain re-runs it
    // through the real stack, his credentials, the create route's own rbac.
    const batch = await drain(REP_B, [
      // ...and a create nobody conflicts with proves the door itself works.
      offlineCreate('l_01', { name: `Integr Delta Traders ${suffix}`, phone: '9847000001' }),
      offlineCreate('l_02', shared),
    ]);

    const applied = batch.results.find((r) => r.localId === 'l_01')!;
    expect(applied.outcome).toBe('applied');
    expect(applied.status).toBe(200);
    const appliedRow = CompanySchema.parse(applied.body) as CompanyRecord;
    expect(appliedRow.ownerRepId).toBe(REP_B.id); // the drain ran as rep B

    const rejected = batch.results.find((r) => r.localId === 'l_02')!;
    expect(rejected.outcome).toBe('rejected');
    expect(rejected.status).toBe(409);
    expect(rejected.error!.code).toBe('DUPLICATE_ENTITY');
    // The verdict carries the server's row: which account beat him, whose it is.
    const existing = CompanySchema.parse((rejected.error!.details as { existing: unknown }).existing) as CompanyRecord;
    expect(existing.id).toBe(serverRow.id);
    expect(existing.ownerRepId).toBe(REP_A.id);

    // Exactly one row: the rejection kept the account singular and rep A's.
    const rows = await db.query<{ id: string; owner_rep_id: string | null }>(
      'SELECT id, owner_rep_id FROM companies WHERE name = $1',
      [shared.name],
    );
    expect(rows.rows.length).toBe(1);
    expect(rows.rows[0]!.id).toBe(serverRow.id);
    expect(rows.rows[0]!.owner_rep_id).toBe(REP_A.id);
  });
});

describe('the envelope stays honest', () => {
  it('the duplicate refusal is a real error envelope, requestId and all', async () => {
    const suffix = randomBytes(3).toString('hex');
    await createCompany(REP_A, { name: `Integr Epsilon Traders ${suffix}` });
    const second = await createCompany(REP_A, { name: `Integr Epsilon Traders ${suffix}` });
    const parsed = errorEnvelopeSchema.parse(JSON.parse(second.body)) as unknown as ErrorEnvelope;
    expect(parsed.error.code).toBe('DUPLICATE_ENTITY');
    expect(parsed.error.requestId).toMatch(ULID);
  });
});
