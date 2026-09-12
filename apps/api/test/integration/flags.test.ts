import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import type { FastifyInstance } from 'fastify';
import {
  errorEnvelopeSchema,
  featureFlagsSchema,
  type ErrorEnvelope,
  type LoginResponse,
} from '@servgrid/shared';
import { loadConfig, type Config } from '../../src/config.js';
import { closePool } from '../../src/db/pool.js';
import { runMigrations } from '../../src/db/migrate.js';
import { hashPassword } from '../../src/lib/password.js';
import { buildServer } from '../../src/server.js';
import { createLocationService } from '../../src/modules/location/service.js';
import { ULID, validEnv } from '../helpers/env.js';

/**
 * Feature-flag evaluation and the T0 rollback gates (PLAN-EXECUTION.md
 * §3, PHASE-1-TECHNICIAN T1.23 rollback table). Runs against a scratch
 * database built from the real migrations (§14: no mocked database
 * anywhere) and proves the things the field run depends on:
 *
 *  - evaluation is per employee: the owner's override rides every
 *    `/auth/me` answer and nothing else changes;
 *  - the flip is owner-only on the employee-admin matrix cells, refuses
 *    unknown flags and unknown employees loudly;
 *  - `tech.offline` off closes the sync doors with 409 FLAG_DISABLED —
 *    "online-only, queued items preserved";
 *  - `tech.location` off makes ping ingest answer 200 with every ping
 *    rejected DISABLED, so a handset clears its buffer instead of
 *    retrying forever.
 */

function databaseUrl(): string {
  return process.env.DATABASE_URL ?? 'postgres://servgrid:servgrid@localhost:5432/servgrid';
}

function adminUrlFor(url: string): string {
  const parsed = new URL(url);
  parsed.pathname = '/postgres';
  return parsed.toString();
}

const SCRATCH_DB = 'servgrid_flags_test';
const PASSWORD = 'flags-plain-copier-19';

let admin: Pool;
let db: Pool;
let app: FastifyInstance;
let config: Config;

const OWNER = { username: '', id: '', token: '' };
const TECH = { username: '', id: '', token: '' };
const DISPATCHER = { username: '', id: '', token: '' };

async function seedEmployee(
  role: 'owner' | 'dispatcher' | 'technician',
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

function getMe(token: string) {
  return app.inject({ method: 'GET', url: '/v1/auth/me', headers: { authorization: `Bearer ${token}` } });
}

function putFlag(callerToken: string, employeeId: string, flag: string, enabled: boolean) {
  return app.inject({
    method: 'PUT',
    url: `/v1/employees/${employeeId}/flags`,
    headers: { authorization: `Bearer ${callerToken}` },
    payload: { flag, enabled },
  });
}

function envelopeOf(status: number, body: string): ErrorEnvelope['error'] {
  expect(status).toBeGreaterThanOrEqual(400);
  const parsed = errorEnvelopeSchema.parse(JSON.parse(body)) as unknown as ErrorEnvelope;
  const error = parsed.error;
  expect(error.requestId).toMatch(ULID);
  return error;
}

/** An instant inside the IST work window (noon on a Mon–Sat), at least
 * six minutes old and never older than a week — so a ping built on it
 * passes the temporal and window checks at whatever hour the suite runs,
 * and only the flag decides the outcome. */
function inWindowIso(now: Date = new Date()): string {
  for (let back = 0; back < 7; back++) {
    const istShifted = new Date(now.getTime() - back * 86_400_000 + 5.5 * 3_600_000);
    const weekday = istShifted.getUTCDay();
    if (weekday < 1 || weekday > 6) continue;
    const iso = new Date(`${istShifted.toISOString().slice(0, 10)}T12:00:00+05:30`).toISOString();
    if (Date.parse(iso) <= now.getTime() - 6 * 60_000) return iso;
  }
  throw new Error('no recent IST working day found — the suite cannot run');
}

beforeAll(async () => {
  admin = new Pool({ connectionString: adminUrlFor(databaseUrl()), max: 2 });
  await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${SCRATCH_DB}`);

  const scratchUrl = new URL(databaseUrl());
  scratchUrl.pathname = `/${SCRATCH_DB}`;
  // The services read through the process-wide pool (db/pool.ts); point it
  // at the scratch database before the first request.
  process.env.DATABASE_URL = scratchUrl.toString();
  db = new Pool({ connectionString: scratchUrl.toString(), max: 5 });
  await runMigrations({ pool: db });

  config = loadConfig(validEnv({ DATABASE_URL: scratchUrl.toString() }));
  app = buildServer(config, { logger: false });
  await app.ready();

  await seedEmployee('owner', OWNER);
  await seedEmployee('technician', TECH);
  await seedEmployee('dispatcher', DISPATCHER);
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

describe('evaluation — the override rides /auth/me', () => {
  it('reads every flag off before anyone touches anything', async () => {
    const res = await getMe(TECH.token);
    expect(res.statusCode, res.body).toBe(200);
    const flags = featureFlagsSchema.parse(res.json().featureFlags);
    expect(Object.values(flags).every((on) => on === false)).toBe(true);
  });

  it('flips exactly one flag for exactly one employee, and /auth/me answers with it', async () => {
    const flip = await putFlag(OWNER.token, TECH.id, 'tech.jobs', true);
    expect(flip.statusCode, flip.body).toBe(200);
    expect(flip.json().employeeId).toBe(TECH.id);
    expect(flip.json().flags['tech.jobs']).toBe(true);
    expect(flip.json().flags['tech.offline']).toBe(false); // untouched flags stay off

    const me = await getMe(TECH.token);
    expect(me.statusCode, me.body).toBe(200);
    const flags = featureFlagsSchema.parse(me.json().featureFlags);
    expect(flags['tech.jobs']).toBe(true);
    expect(flags['tech.offline']).toBe(false);

    // The owner is a different employee: his own evaluation is untouched.
    const mine = await getMe(OWNER.token);
    expect(featureFlagsSchema.parse(mine.json().featureFlags)['tech.jobs']).toBe(false);
  });

  it('lists the roster with effective flags, owner only', async () => {
    const asOwner = await app.inject({
      method: 'GET',
      url: '/v1/flags',
      headers: { authorization: `Bearer ${OWNER.token}` },
    });
    expect(asOwner.statusCode, asOwner.body).toBe(200);
    const entry = asOwner.json().employees.find((e: { employeeId: string }) => e.employeeId === TECH.id);
    expect(entry?.flags['tech.jobs']).toBe(true);

    const asDispatcher = await app.inject({
      method: 'GET',
      url: '/v1/flags',
      headers: { authorization: `Bearer ${DISPATCHER.token}` },
    });
    expect(asDispatcher.statusCode).toBe(403);
    expect(envelopeOf(asDispatcher.statusCode, asDispatcher.body).code).toBe('FORBIDDEN');
  });
});

describe('the flip is guarded', () => {
  it('refuses a non-owner (matrix cell employee:update)', async () => {
    const res = await putFlag(DISPATCHER.token, TECH.id, 'tech.jobs', true);
    expect(res.statusCode).toBe(403);
    expect(envelopeOf(res.statusCode, res.body).code).toBe('FORBIDDEN');
  });

  it('refuses an unknown flag name with the registry named', async () => {
    const res = await putFlag(OWNER.token, TECH.id, 'tech.warp', true);
    expect(res.statusCode).toBe(422);
  });

  it('refuses an unknown employee with 404', async () => {
    const res = await putFlag(OWNER.token, randomUUID(), 'tech.jobs', true);
    expect(res.statusCode).toBe(404);
    expect(envelopeOf(res.statusCode, res.body).code).toBe('NOT_FOUND');
  });
});

describe('the T0 rollback gates', () => {
  it('tech.offline off closes the sync doors with FLAG_DISABLED, on opens them', async () => {
    // Defaulted off: the mirror's door is closed until the owner names this technician.
    const closed = await app.inject({
      method: 'GET',
      url: '/v1/sync/bootstrap',
      headers: { authorization: `Bearer ${TECH.token}` },
    });
    expect(closed.statusCode).toBe(409);
    expect(envelopeOf(closed.statusCode, closed.body).code).toBe('FLAG_DISABLED');

    const open = await putFlag(OWNER.token, TECH.id, 'tech.offline', true);
    expect(open.statusCode, open.body).toBe(200);

    const bootstrap = await app.inject({
      method: 'GET',
      url: '/v1/sync/bootstrap',
      headers: { authorization: `Bearer ${TECH.token}` },
    });
    expect(bootstrap.statusCode, bootstrap.body).toBe(200);
  });

  it('tech.location off rejects every ping DISABLED over HTTP 200 — the buffer clears', async () => {
    const now = Date.now();
    const pings = [0, 1].map((i) => ({
      recordedAt: new Date(Date.parse(inWindowIso(new Date(now - i * 60_000)))).toISOString(),
      latitude: 12.9716,
      longitude: 77.5946,
      accuracyM: 20,
      source: 'scheduled' as const,
    }));

    // A real device row: location_pings carries a device FK, and the
    // flag-on half of this test must survive it.
    const register = await app.inject({
      method: 'POST',
      url: '/v1/devices',
      headers: { authorization: `Bearer ${TECH.token}` },
      payload: {
        installId: `install-${randomBytes(4).toString('hex')}`,
        platform: 'android',
        appVersion: '0.1.0',
        osVersion: '14',
        manufacturer: 'Xiaomi',
        model: 'Redmi Note 12',
      },
    });
    expect(register.statusCode, register.body).toBe(200);
    const deviceId = (
      await db.query<{ id: string }>(`SELECT id::text FROM devices WHERE employee_id = $1 LIMIT 1`, [TECH.id])
    ).rows[0]!.id;

    const service = createLocationService({ workWindow: config.workWindow });
    const disabled = await service.ingestPings(TECH.id, deviceId, pings, now);
    expect(disabled.accepted).toBe(0);
    expect(disabled.rejected.map((r) => r.code)).toEqual(['DISABLED', 'DISABLED']);

    const landed = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM location_pings WHERE employee_id = $1`,
      [TECH.id],
    );
    expect(landed.rows[0]!.n).toBe(0); // nothing stored, nothing retried

    // Turning the flag on lets the same handsets through.
    await putFlag(OWNER.token, TECH.id, 'tech.location', true);
    const allowed = await service.ingestPings(TECH.id, deviceId, [pings[0]!], now);
    expect(allowed.accepted).toBe(1);
  });
});
