import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import type { FastifyInstance } from 'fastify';
import { deviceDiagnosticSchema, type LoginResponse } from '@servgrid/shared';
import { loadConfig } from '../../src/config.js';
import { closePool } from '../../src/db/pool.js';
import { runMigrations } from '../../src/db/migrate.js';
import { hashPassword } from '../../src/lib/password.js';
import { buildServer } from '../../src/server.js';
import { validEnv } from '../helpers/env.js';

/**
 * `GET /v1/devices/me` (PHASE-ON-ONLINE.md TON.5). The permission ladder
 * used to remember two steps Android cannot report — battery exemption
 * and OEM autostart — in AsyncStorage. With nothing stored on the phone,
 * it posts them to `POST /v1/devices` and reads them back here: the row
 * of the device the access token was issued for at login. Against a
 * scratch database built from the real migrations.
 */

function databaseUrl(): string {
  return process.env.DATABASE_URL ?? 'postgres://servgrid:servgrid@localhost:5432/servgrid';
}

function adminUrlFor(url: string): string {
  const parsed = new URL(url);
  parsed.pathname = '/postgres';
  return parsed.toString();
}

const SCRATCH_DB = 'servgrid_devices_test';
const PASSWORD = 'devices-plain-copier-58';

let admin: Pool;
let db: Pool;
let app: FastifyInstance;

interface Phone {
  token: string;
  installId: string;
}

const TECH: Phone = { token: '', installId: '' };
const OTHER: Phone = { token: '', installId: '' };

const HANDSET = { platform: 'android', appVersion: '0.1.0', osVersion: '14', manufacturer: 'Xiaomi', model: 'Redmi Note 12' } as const;

async function seedTechnician(who: Phone): Promise<void> {
  const username = `ton5.tech.${randomBytes(4).toString('hex')}`;
  await db.query(`INSERT INTO employees (username, password_hash, full_name, role) VALUES ($1, $2, $3, 'technician')`, [
    username,
    await hashPassword(PASSWORD),
    `Test ${username}`,
  ]);
  who.installId = randomUUID();
  const res = await app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: { username, password: PASSWORD, device: { installId: who.installId, ...HANDSET } },
  });
  expect(res.statusCode, res.body).toBe(200);
  who.token = res.json<LoginResponse>().accessToken;
}

/** What the ladder's `postDiagnostics` sends: the login device's identity plus a step. */
function postDiagnostics(who: Phone, diagnostics: Record<string, unknown>) {
  return app.inject({
    method: 'POST',
    url: '/v1/devices',
    headers: { authorization: `Bearer ${who.token}` },
    payload: { installId: who.installId, ...HANDSET, ...diagnostics },
  });
}

function readMine(who: Phone, headers: Record<string, string> = {}) {
  return app.inject({ method: 'GET', url: '/v1/devices/me', headers: { authorization: `Bearer ${who.token}`, ...headers } });
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
  app = buildServer(loadConfig(validEnv({ DATABASE_URL: scratchUrl.toString() })), { logger: false });
  await app.ready();
  await seedTechnician(TECH);
  await seedTechnician(OTHER);
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

describe('GET /v1/devices/me — the ladder reads its memory back from the server', () => {
  it('returns the login device: not confirmed at first, then both steps once the ladder posts them', async () => {
    const before = await readMine(TECH);
    expect(before.statusCode, before.body).toBe(200);
    const fresh = deviceDiagnosticSchema.parse(before.json());
    expect(fresh.installId).toBe(TECH.installId);
    expect(fresh.batteryOptExempt).not.toBe(true);
    expect(fresh.autostartConfirmed).not.toBe(true);

    expect((await postDiagnostics(TECH, { batteryOptExempt: true })).statusCode).toBe(200);
    expect((await postDiagnostics(TECH, { autostartConfirmed: true })).statusCode).toBe(200);

    const after = deviceDiagnosticSchema.parse((await readMine(TECH)).json());
    expect(after.installId).toBe(TECH.installId);
    expect(after.batteryOptExempt).toBe(true);
    expect(after.autostartConfirmed).toBe(true);
  });

  it('a post that omits a diagnostic keeps the stored value — one ladder step never clears another', async () => {
    const phone: Phone = { token: '', installId: '' };
    await seedTechnician(phone);
    await postDiagnostics(phone, { locationPermission: 'background' });
    await postDiagnostics(phone, { batteryOptExempt: true });
    // A notifications-only post: before the fix it reset location_permission
    // to 'none' and battery_opt_exempt to false, turning the chip red.
    await postDiagnostics(phone, { notificationsEnabled: true });

    const row = deviceDiagnosticSchema.parse((await readMine(phone)).json());
    expect(row.locationPermission).toBe('background');
    expect(row.batteryOptExempt).toBe(true);
    expect(row.notificationsEnabled).toBe(true);
    expect(row.autostartConfirmed).toBe(false);
  });

  it('each employee reads only his own phone — a header naming another install changes nothing', async () => {
    await postDiagnostics(OTHER, { batteryOptExempt: true });

    const mine = deviceDiagnosticSchema.parse((await readMine(TECH, { 'x-device-id': OTHER.installId })).json());
    expect(mine.installId).toBe(TECH.installId);

    const theirs = deviceDiagnosticSchema.parse((await readMine(OTHER)).json());
    expect(theirs.installId).toBe(OTHER.installId);
  });

  it('an anonymous caller is 401', async () => {
    const anon = await app.inject({ method: 'GET', url: '/v1/devices/me' });
    expect(anon.statusCode).toBe(401);
  });
});
