import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import type { FastifyInstance } from 'fastify';
import {
  errorEnvelopeSchema,
  trackingHealthSchema,
  type ErrorEnvelope,
  type LoginResponse,
  type Role,
} from '@servgrid/shared';
import { loadConfig, type Config } from '../../src/config.js';
import { closePool } from '../../src/db/pool.js';
import { runMigrations } from '../../src/db/migrate.js';
import { hashPassword } from '../../src/lib/password.js';
import { buildServer } from '../../src/server.js';
import { ULID, validEnv } from '../helpers/env.js';

/**
 * The self-scoped tracking-health suite (PHASE-1-TECHNICIAN.md T1.12,
 * PLAN-BACKEND.md §8 "health reads"): `GET /v1/location/health/me` is the
 * TrackingHealthChip's data and the one health read Phase 1 ships. The
 * chip is a Phase 1 exit criterion — it must be able to show a true red —
 * so what this suite pins is exactly what makes the endpoint safe:
 *
 * 1. the response is ONE row, the actor's own, for every role that can
 *    call it (§8's Roles column: technician and sales rep), even though
 *    the view beneath it holds a row for every active employee;
 * 2. a technician cannot reach another employee's health by any path —
 *    the only path that exists is /me, keyed off the token;
 * 3. a dispatcher — whose `location.health` read cell is `all`, for the
 *    Phase 2 roster warning — gets 403 on /me, and 404 rather than 403 on
 *    any path that would enumerate: a route that does not exist answers
 *    the framework's generic NOT_FOUND to every role alike, so probing it
 *    leaks neither the route nor whether another employee's row exists.
 *
 * Real Postgres, real view, no mocks (PLAN-BACKEND.md §14) — the fixture
 * devices and pings land in the same tables the handset writes, and the
 * response is asserted against the same view the Phase 2/4 consoles will
 * read. The notifications case is deliberate: the technician's device has
 * notifications off and is still `active`, which is §4's argument for
 * never folding `notifications_enabled` into `health`, proven on the wire.
 */

function databaseUrl(): string {
  return process.env.DATABASE_URL ?? 'postgres://servgrid:servgrid@localhost:5432/servgrid';
}

function adminUrlFor(url: string): string {
  const parsed = new URL(url);
  parsed.pathname = '/postgres';
  return parsed.toString();
}

const SCRATCH_DB = 'servgrid_authz_health_test';
const PASSWORD = 'mv-health-t12-81';

type Caller = Role | null; // null = anonymous — no Authorization header at all

const LOGIN_DEVICE = {
  installId: 'install-t12',
  platform: 'android',
  appVersion: '0.1.0',
  osVersion: '14',
  manufacturer: 'Xiaomi',
  model: 'Redmi Note 12',
};

let admin: Pool;
let db: Pool;
let app: FastifyInstance;
let config: Config;

const tokens: Partial<Record<Role, string>> = {};
const selfIds: Partial<Record<Role, string>> = {};
const fullNames: Partial<Record<Role, string>> = {};
/** A second technician whose health row exists and must never come back. */
const otherTech = { id: '', name: 'Health Other Tech' };

function bearer(actor: Caller): Record<string, string> {
  return actor && tokens[actor] ? { authorization: `Bearer ${tokens[actor]}` } : {};
}

function envelopeOf(status: number, body: string): ErrorEnvelope['error'] {
  expect(status).toBeGreaterThanOrEqual(400);
  const parsed = errorEnvelopeSchema.parse(JSON.parse(body)) as unknown as ErrorEnvelope;
  expect(parsed.error.requestId).toMatch(ULID);
  return parsed.error;
}

async function loginAs(username: string): Promise<LoginResponse> {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: { username, password: PASSWORD, device: LOGIN_DEVICE },
  });
  expect(res.statusCode, `login as ${username} should succeed`).toBe(200);
  return res.json<LoginResponse>();
}

async function seedEmployee(role: Role, fullName: string): Promise<{ id: string; username: string }> {
  const username = `emp.t12.${randomUUID().slice(0, 8)}`;
  const r = await db.query<{ id: string }>(
    `INSERT INTO employees (username, password_hash, full_name, role)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [username, await hashPassword(PASSWORD), fullName, role],
  );
  return { id: r.rows[0]!.id, username };
}

/**
 * Point the employee's (login-created, newest-install) device at the given
 * permission — the same columns `POST /v1/devices` keeps current (§8: that
 * endpoint is how the chip becomes truthful); the direct update stands in
 * for the upsert so the fixture stays independent of the devices module.
 */
async function setDeviceDiagnostics(
  employeeId: string,
  locationPermission: 'none' | 'foreground' | 'background',
): Promise<string> {
  const r = await db.query<{ id: string }>(
    `UPDATE devices SET location_permission = $2 WHERE employee_id = $1 RETURNING id`,
    [employeeId, locationPermission],
  );
  expect(r.rows, 'a login registers exactly one device').toHaveLength(1);
  return r.rows[0]!.id;
}

/** A ping `minutesAgo` old — the direct-table shape the handset drains to. */
async function seedPing(employeeId: string, deviceId: string, minutesAgo: number): Promise<void> {
  await db.query(
    `INSERT INTO location_pings (employee_id, device_id, recorded_at, latitude, longitude, source)
     VALUES ($1, $2, $3, 12.9716, 77.5946, 'scheduled')`,
    [employeeId, deviceId, new Date(Date.now() - minutesAgo * 60_000).toISOString()],
  );
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

  // Every role logs in — the logins are what mint the tokens and, as a
  // side effect, each actor's first device install.
  for (const role of ['owner', 'dispatcher', 'technician', 'sales_rep'] as const) {
    const name = `Health ${role}`;
    const seeded = await seedEmployee(role, name);
    const session = await loginAs(seeded.username);
    tokens[role] = session.accessToken;
    selfIds[role] = session.employee.id;
    fullNames[role] = name;
  }

  // The technician's device reports background and notifications OFF —
  // §4: notifications off is still tracking correctly, so the chip must
  // read `active` with `notificationsEnabled: false`, not collapsed into
  // one amber value.
  const techDeviceId = await setDeviceDiagnostics(selfIds.technician!, 'background');
  await seedPing(selfIds.technician!, techDeviceId, 5);

  // The rep's device reports only foreground permission while a fresh ping
  // exists — §4's precedence (permission state wins over ping recency)
  // proven through the endpoint: the chip must read `permission_missing`.
  const repDeviceId = await setDeviceDiagnostics(selfIds.sales_rep!, 'foreground');
  await seedPing(selfIds.sales_rep!, repDeviceId, 2);

  // A second technician with his own healthy device and ping — a row that
  // exists in the view and must never come back to anyone but him.
  otherTech.id = (await seedEmployee('technician', otherTech.name)).id;
  const r = await db.query<{ id: string }>(
    `INSERT INTO devices (employee_id, install_id, location_permission, notifications_enabled)
     VALUES ($1, 'install-t12-other', 'background', true) RETURNING id`,
    [otherTech.id],
  );
  await seedPing(otherTech.id, r.rows[0]!.id, 3);
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

describe('GET /v1/location/health/me — one row, the actor’s own (T1.12)', () => {
  it('the view beneath the endpoint holds every active employee’s row — five here — so single-row is the endpoint’s doing, not an empty view’s', async () => {
    const r = await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM v_employee_tracking_health`);
    expect(Number(r.rows[0]!.n)).toBe(5);
  });

  it('the technician gets exactly his own row — active, notifications off, ping age carried', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/location/health/me', headers: bearer('technician') });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json())).toBe(false);

    const row = trackingHealthSchema.parse(res.json());
    expect(row.employeeId).toBe(selfIds.technician);
    expect(row.employeeName).toBe(fullNames.technician);
    expect(row.role).toBe('technician');
    expect(row.deviceId).toEqual(expect.any(String));
    expect(row.locationPermission).toBe('background');
    expect(row.notificationsEnabled).toBe(false); // off, and STILL active — §4
    expect(row.health).toBe('active');
    expect(row.lastPingAt).not.toBeNull();
    expect(Math.abs(Date.now() - Date.parse(row.lastPingAt!))).toBeLessThan(10 * 60_000);
    expect(row.minutesSince).not.toBeNull();
    expect(row.minutesSince!).toBeLessThan(15);
    expect(row.minutesSince!).toBeGreaterThan(-1);
  });

  it('the sales rep gets exactly his own row — permission state wins over his fresh ping', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/location/health/me', headers: bearer('sales_rep') });
    expect(res.statusCode).toBe(200);

    const row = trackingHealthSchema.parse(res.json());
    expect(row.employeeId).toBe(selfIds.sales_rep);
    expect(row.employeeName).toBe(fullNames.sales_rep);
    expect(row.role).toBe('sales_rep');
    expect(row.locationPermission).toBe('foreground');
    expect(row.lastPingAt).not.toBeNull(); // he HAS pinged…
    expect(row.health).toBe('permission_missing'); // …but permission wins, ALWAYS
  });

  it('the row returned is never another employee’s — the other technician’s healthier row stays his', async () => {
    for (const actor of ['technician', 'sales_rep'] as const) {
      const res = await app.inject({ method: 'GET', url: '/v1/location/health/me', headers: bearer(actor) });
      const row = trackingHealthSchema.parse(res.json());
      expect(row.employeeId).not.toBe(otherTech.id);
      expect(row.employeeName).not.toBe(otherTech.name);
    }
  });
});

describe('a technician cannot reach another employee’s health by any path', () => {
  it('the id-shaped path does not exist — 404, never the other technician’s row', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/location/health/${otherTech.id}`,
      headers: bearer('technician'),
    });
    expect(res.statusCode).toBe(404);
    expect(envelopeOf(404, res.body).code).toBe('NOT_FOUND');
  });

  it('neither does a trail, a collection, or any other shape that would enumerate', async () => {
    for (const url of ['/v1/location/health', `/v1/location/health/${otherTech.id}/trail`]) {
      const res = await app.inject({ method: 'GET', url, headers: bearer('technician') });
      expect(res.statusCode, url).toBe(404);
      expect(envelopeOf(res.statusCode, res.body).code, url).toBe('NOT_FOUND');
    }
  });

  it('the one path that exists answers with his own row only — and /me takes no id to misuse', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/location/health/me', headers: bearer('technician') });
    expect(res.statusCode).toBe(200);
    expect(trackingHealthSchema.parse(res.json()).employeeId).toBe(selfIds.technician);
  });
});

describe('a dispatcher — 403 on /me, 404 rather than 403 on any enumerating path', () => {
  it('his `location.health` read cell is `all` for the Phase 2 roster, and this is not that surface — 403 on /me', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/location/health/me', headers: bearer('dispatcher') });
    expect(res.statusCode).toBe(403);
    expect(envelopeOf(403, res.body).code).toBe('FORBIDDEN');
  });

  it('a path naming a technician that EXISTS is 404 — the generic NOT_FOUND, not a 403 that would confirm the route', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/location/health/${selfIds.technician}`,
      headers: bearer('dispatcher'),
    });
    expect(res.statusCode).toBe(404);
    expect(envelopeOf(404, res.body).code).toBe('NOT_FOUND');
  });

  it('an id that exists and one that does not are indistinguishable — existence is not leaked', async () => {
    const real = await app.inject({
      method: 'GET',
      url: `/v1/location/health/${selfIds.technician}`,
      headers: bearer('dispatcher'),
    });
    const absent = await app.inject({
      method: 'GET',
      url: `/v1/location/health/${randomUUID()}`,
      headers: bearer('dispatcher'),
    });
    expect(real.statusCode).toBe(404);
    expect(absent.statusCode).toBe(404);
    const realEnvelope = envelopeOf(404, real.body);
    const absentEnvelope = envelopeOf(404, absent.body);
    expect(absentEnvelope.code).toBe(realEnvelope.code);
    expect(absentEnvelope.message).toBe(realEnvelope.message);
  });

  it('the owner’s `all` cell is the Phase 4 console, not this chip — 403 on /me for him too', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/location/health/me', headers: bearer('owner') });
    expect(res.statusCode).toBe(403);
    expect(envelopeOf(403, res.body).code).toBe('FORBIDDEN');
  });

  it('without a token, the gate is 401 before any scope question arises', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/location/health/me' });
    expect(res.statusCode).toBe(401);
    expect(envelopeOf(401, res.body).code).toBe('UNAUTHENTICATED');
  });
});
