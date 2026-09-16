import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import type { FastifyInstance } from 'fastify';
import { errorEnvelopeSchema, type ErrorEnvelope, type LoginResponse } from '@servgrid/shared';
import { loadConfig, type Config } from '../../src/config.js';
import { closePool } from '../../src/db/pool.js';
import { runMigrations } from '../../src/db/migrate.js';
import { hashPassword } from '../../src/lib/password.js';
import { buildServer } from '../../src/server.js';
import { validEnv } from '../helpers/env.js';

/**
 * `dispatch.console` is the DISPATCHER console's T0 rollback — and it was
 * gating the owner too (OW.1, 2026-09-16). The consequence was not a
 * refusal he could read: his Dispatch, Customers and Employees screens
 * went blank or errored, because they read `/v1/jobs/summary`,
 * `/v1/technicians/load` and `/v1/location/health`. Switching the
 * dispatcher's console off is precisely when the owner covers the desk,
 * so the flag must never disarm him.
 *
 * The exemption is narrow, and the last test is what keeps it narrow: the
 * owner's OWN flags still gate the owner. A blanket "owner ignores flags"
 * would throw away every T0 rollback he has.
 */

function databaseUrl(): string {
  return process.env.DATABASE_URL ?? 'postgres://servgrid:servgrid@localhost:5432/servgrid';
}

function adminUrlFor(url: string): string {
  const parsed = new URL(url);
  parsed.pathname = '/postgres';
  return parsed.toString();
}

const SCRATCH_DB = 'servgrid_owner_console_test';
const PASSWORD = 'ow-plain-copier-51';

let admin: Pool;
let db: Pool;
let app: FastifyInstance;
let config: Config;

const OWNER_DARK = { username: '', id: '', token: '' }; // no flags at all
const DISPATCHER_DARK = { username: '', id: '', token: '' }; // no flags at all
const DISPATCHER_LIT = { username: '', id: '', token: '' }; // dispatch.console on

async function seedEmployee(
  role: 'owner' | 'dispatcher',
  who: { username: string; id: string; token: string },
): Promise<void> {
  const username = `ow1.${role}.${randomBytes(4).toString('hex')}`;
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
        platform: 'web',
        appVersion: '0.1.0',
        osVersion: '14',
        manufacturer: 'Dell',
        model: 'Latitude',
      },
    },
  });
  expect(res.statusCode, res.body).toBe(200);
  who.token = res.json<LoginResponse>().accessToken;
}

const bearer = (who: { token: string }) => ({ authorization: `Bearer ${who.token}` });

/** The three console reads the owner's screens depend on. */
const CONSOLE_READS = [
  '/v1/jobs/summary',
  '/v1/technicians/load',
  '/v1/location/health',
] as const;

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

  await seedEmployee('owner', OWNER_DARK);
  await seedEmployee('dispatcher', DISPATCHER_DARK);
  await seedEmployee('dispatcher', DISPATCHER_LIT);

  await db.query(
    `INSERT INTO employee_flag_overrides (employee_id, flag, enabled) VALUES ($1, 'dispatch.console', true)`,
    [DISPATCHER_LIT.id],
  );
});

afterAll(async () => {
  await app?.close();
  await db?.end();
  await closePool();
  if (admin !== undefined) {
    await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
    await admin.end();
  }
});

describe('dispatch.console — the owner is exempt, the dispatcher is not', () => {
  it('the owner reads every console endpoint with the flag dark', async () => {
    for (const url of CONSOLE_READS) {
      const res = await app.inject({ method: 'GET', url, headers: bearer(OWNER_DARK) });
      expect(res.statusCode, `${url} as owner: ${res.body}`).toBe(200);
    }
  });

  it('a dispatcher without the flag is still refused, with the sentence that names the switch', async () => {
    for (const url of CONSOLE_READS) {
      const res = await app.inject({ method: 'GET', url, headers: bearer(DISPATCHER_DARK) });
      expect(res.statusCode, `${url} as dark dispatcher: ${res.body}`).toBe(409);
      const body = errorEnvelopeSchema.parse(res.json<ErrorEnvelope>());
      expect(body.error.code).toBe('FLAG_DISABLED');
      expect(body.error.message).toContain('dispatch console');
    }
  });

  it('a dispatcher with the flag lit reads them, so the flag still does its job', async () => {
    for (const url of CONSOLE_READS) {
      const res = await app.inject({ method: 'GET', url, headers: bearer(DISPATCHER_LIT) });
      expect(res.statusCode, `${url} as lit dispatcher: ${res.body}`).toBe(200);
    }
  });

  it("the exemption is narrow: the owner's OWN flags still gate him", async () => {
    // owner.cash is dark for OWNER_DARK — the reconciliation queue must
    // still refuse him. If this ever passes, the exemption has widened
    // into "the owner ignores flags", and every T0 rollback he has is gone.
    const res = await app.inject({ method: 'GET', url: '/v1/cash/queue', headers: bearer(OWNER_DARK) });
    expect(res.statusCode, res.body).toBe(409);
    expect(errorEnvelopeSchema.parse(res.json<ErrorEnvelope>()).error.code).toBe('FLAG_DISABLED');
  });
});
