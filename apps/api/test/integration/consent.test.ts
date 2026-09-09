import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import type { FastifyInstance } from 'fastify';
import {
  errorEnvelopeSchema,
  ROLES,
  type ConsentCreateResponse,
  type ErrorEnvelope,
  type LoginResponse,
  type RequiredConsentsResponse,
  type Role,
} from '@servgrid/shared';
import { loadConfig, type Config } from '../../src/config.js';
import { closePool } from '../../src/db/pool.js';
import { runMigrations } from '../../src/db/migrate.js';
import { hashPassword } from '../../src/lib/password.js';
import { CURRENT_CONSENT_VERSION } from '../../src/modules/auth/service.js';
import { createConsentService } from '../../src/modules/consents/service.js';
import { buildServer } from '../../src/server.js';
import { ULID, validEnv } from '../helpers/env.js';

/**
 * Consent integration suite (PHASE-0-FOUNDATION.md T0.9, PLAN-BACKEND.md §4):
 * the required-consents query, idempotent acceptance, and the two evidence
 * rules — the recorded IP is the request's own address, never a body field,
 * and only the current copy's version can be accepted. Runs against a
 * scratch database built from the real migrations (§14: no mocked database
 * anywhere), because a double-tap riding the UNIQUE constraint and a version
 * bump re-requiring acceptance are exactly the things a mock cannot prove.
 */

function databaseUrl(): string {
  return process.env.DATABASE_URL ?? 'postgres://servgrid:servgrid@localhost:5432/servgrid';
}

function adminUrlFor(url: string): string {
  const parsed = new URL(url);
  parsed.pathname = '/postgres';
  return parsed.toString();
}

const SCRATCH_DB = 'servgrid_consent_test';
const PASSWORD = 'mv-plain-copier-63';

/** A previous copy revision — what a bump replaces. */
const PREVIOUS_VERSION = '2026-08-15';
/** The next copy revision, for the bump. */
const BUMPED_VERSION = '2026-10-01';

/** TEST-NET-3: an address this suite's requests never originate from. */
const SPOOFED_IP = '203.0.113.9';

let admin: Pool;
let db: Pool;
let app: FastifyInstance;
let config: Config;

async function seedEmployee(role: Role = 'technician'): Promise<{ username: string; employeeId: string }> {
  const username = `consent.t9.${randomBytes(4).toString('hex')}`;
  const r = await db.query<{ id: string }>(
    `INSERT INTO employees (username, password_hash, full_name, role)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [username, await hashPassword(PASSWORD), `Test ${username}`, role],
  );
  return { username, employeeId: r.rows[0]!.id };
}

function loginBody(username: string, installId = 'install-consent') {
  return {
    username,
    password: PASSWORD,
    device: {
      installId,
      platform: 'android',
      appVersion: '0.1.0',
      osVersion: '14',
      manufacturer: 'Xiaomi',
      model: 'Redmi Note 12',
    },
  };
}

/** A fresh employee, logged in — login also creates the device row the
 * acceptance will name. */
async function loginAs(role: Role = 'technician') {
  const { username, employeeId } = await seedEmployee(role);
  const res = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: loginBody(username) });
  expect(res.statusCode).toBe(200);
  const login = res.json<LoginResponse>();
  return { username, employeeId, accessToken: login.accessToken, login };
}

function decodeJwt(token: string): Record<string, unknown> {
  const payload = token.split('.')[1]!;
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
}

async function deviceIdOf(employeeId: string): Promise<string> {
  const r = await db.query<{ id: string }>(
    'SELECT id FROM devices WHERE employee_id = $1 ORDER BY created_at LIMIT 1',
    [employeeId],
  );
  expect(r.rows, `login should have created a device for ${employeeId}`).toHaveLength(1);
  return r.rows[0]!.id;
}

async function getRequired(accessToken: string) {
  return app.inject({
    method: 'GET',
    url: '/v1/consents/required',
    headers: { authorization: `Bearer ${accessToken}` },
  });
}

async function postConsent(accessToken: string, payload: Record<string, unknown>) {
  return app.inject({
    method: 'POST',
    url: '/v1/consents',
    headers: { authorization: `Bearer ${accessToken}` },
    payload,
  });
}

async function acceptCurrent(
  accessToken: string,
  deviceId?: string,
): Promise<ConsentCreateResponse> {
  const res = await postConsent(accessToken, {
    kind: 'location_tracking',
    version: CURRENT_CONSENT_VERSION,
    ...(deviceId === undefined ? {} : { deviceId }),
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json<ConsentCreateResponse>();
}

function envelopeOf(status: number, body: string): ErrorEnvelope['error'] {
  expect(status).toBeGreaterThanOrEqual(400);
  const parsed = errorEnvelopeSchema.parse(JSON.parse(body)) as unknown as ErrorEnvelope;
  const error = parsed.error;
  expect(error.requestId).toMatch(ULID);
  return error;
}

/** The pre-bump state of every employee: a recorded acceptance of the copy
 * the build shipped before the bump. POST refuses old versions by design,
 * so the row is written exactly as that earlier build's POST would have. */
async function seedPreviousAcceptance(employeeId: string): Promise<void> {
  await db.query(
    `INSERT INTO consents (employee_id, kind, version) VALUES ($1, 'location_tracking', $2)`,
    [employeeId, PREVIOUS_VERSION],
  );
}

beforeAll(async () => {
  admin = new Pool({ connectionString: adminUrlFor(databaseUrl()), max: 2 });
  await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${SCRATCH_DB}`);

  const scratchUrl = new URL(databaseUrl());
  scratchUrl.pathname = `/${SCRATCH_DB}`;
  // The consent service reads through the process-wide pool (db/pool.ts);
  // point it at the scratch database before the first request.
  process.env.DATABASE_URL = scratchUrl.toString();
  db = new Pool({ connectionString: scratchUrl.toString(), max: 5 });
  await runMigrations({ pool: db });

  config = loadConfig(validEnv({ DATABASE_URL: scratchUrl.toString() }));
  app = buildServer(config, { logger: false });
  await app.ready();
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

describe('GET /v1/consents/required', () => {
  it('returns the current version for a technician who has accepted nothing, and empty after acceptance', async () => {
    const { employeeId, accessToken, login } = await loginAs();

    // Login's own consent snapshot (T0.7) reads the same constant.
    expect(login.consent).toEqual({ required: true, version: CURRENT_CONSENT_VERSION });

    const before = await getRequired(accessToken);
    expect(before.statusCode).toBe(200);
    expect(before.json<RequiredConsentsResponse>()).toEqual({
      required: [{ kind: 'location_tracking', version: CURRENT_CONSENT_VERSION }],
    });

    await acceptCurrent(accessToken, await deviceIdOf(employeeId));

    const after = await getRequired(accessToken);
    expect(after.statusCode).toBe(200);
    expect(after.json<RequiredConsentsResponse>()).toEqual({ required: [] });
  });

  it('refuses an unauthenticated caller', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/consents/required' });
    expect(envelopeOf(res.statusCode, res.body).code).toBe('UNAUTHENTICATED');
  });
});

describe('POST /v1/consents', () => {
  it('posting the same (kind, version) twice is idempotent by constraint and returns the same result', async () => {
    const { employeeId, accessToken } = await loginAs();
    const deviceId = await deviceIdOf(employeeId);
    const payload = { kind: 'location_tracking', version: CURRENT_CONSENT_VERSION, deviceId };

    const first = await postConsent(accessToken, payload);
    const second = await postConsent(accessToken, payload);
    expect(first.statusCode, first.body).toBe(200);
    expect(second.statusCode, second.body).toBe(200);

    // One result, not two: the second tap rides the UNIQUE constraint and
    // reads back the first tap's row — same acceptedAt, same everything.
    expect(second.json()).toEqual(first.json());
    expect(first.json<ConsentCreateResponse>().acceptedAt).toBeDefined();

    const rows = await db.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM consents WHERE employee_id = $1',
      [employeeId],
    );
    expect(rows.rows[0]!.n).toBe(1);
  });

  it('a client-supplied ipAddress field is ignored; the recorded value is the request’s', async () => {
    const { employeeId, accessToken } = await loginAs();
    const deviceId = await deviceIdOf(employeeId);

    const res = await postConsent(accessToken, {
      kind: 'location_tracking',
      version: CURRENT_CONSENT_VERSION,
      deviceId,
      ipAddress: SPOOFED_IP,
    });
    expect(res.statusCode, res.body).toBe(200);

    const body = res.json<ConsentCreateResponse>();
    // app.inject presents 127.0.0.1 — that, not the body's claim.
    expect(body.ipAddress).toBe('127.0.0.1');
    expect(body.ipAddress).not.toBe(SPOOFED_IP);

    // And the row itself — the evidence — carries the request's address
    // (host() strips the /32 netmask the inet type stores).
    const row = await db.query<{ ip_address: string }>(
      'SELECT host(ip_address) AS ip_address FROM consents WHERE employee_id = $1',
      [employeeId],
    );
    expect(row.rows).toHaveLength(1);
    expect(row.rows[0]!.ip_address).toBe('127.0.0.1');
  });

  it('records the acceptance with the named device', async () => {
    const { employeeId, accessToken } = await loginAs();
    const deviceId = await deviceIdOf(employeeId);

    const body = await acceptCurrent(accessToken, deviceId);
    expect(body.kind).toBe('location_tracking');
    expect(body.version).toBe(CURRENT_CONSENT_VERSION);
    expect(body.deviceId).toBe(deviceId);
  });

  it('falls back to the access token’s device when the body omits one', async () => {
    const { accessToken } = await loginAs();
    const claims = decodeJwt(accessToken);

    const body = await acceptCurrent(accessToken);
    expect(body.deviceId).toBe(claims.deviceId);
  });

  it('refuses a device that belongs to someone else', async () => {
    const other = await loginAs();
    const { employeeId, accessToken } = await loginAs();

    const res = await postConsent(accessToken, {
      kind: 'location_tracking',
      version: CURRENT_CONSENT_VERSION,
      deviceId: await deviceIdOf(other.employeeId),
    });
    expect(res.statusCode).toBe(422);
    expect(envelopeOf(res.statusCode, res.body).code).toBe('VALIDATION_FAILED');

    const rows = await db.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM consents WHERE employee_id = $1',
      [employeeId],
    );
    expect(rows.rows[0]!.n).toBe(0);
  });

  it('refuses a version this build does not present — a stale label would be false evidence', async () => {
    const { employeeId, accessToken } = await loginAs();

    const res = await postConsent(accessToken, {
      kind: 'location_tracking',
      version: PREVIOUS_VERSION,
    });
    expect(res.statusCode).toBe(422);
    expect(envelopeOf(res.statusCode, res.body).code).toBe('VALIDATION_FAILED');

    // Nothing recorded, and the current copy is still owed.
    const rows = await db.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM consents WHERE employee_id = $1',
      [employeeId],
    );
    expect(rows.rows[0]!.n).toBe(0);
    const required = await getRequired(accessToken);
    expect(required.json<RequiredConsentsResponse>()).toEqual({
      required: [{ kind: 'location_tracking', version: CURRENT_CONSENT_VERSION }],
    });
  });

  it('refuses an unauthenticated caller', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/consents',
      payload: { kind: 'location_tracking', version: CURRENT_CONSENT_VERSION },
    });
    expect(envelopeOf(res.statusCode, res.body).code).toBe('UNAUTHENTICATED');
  });
});

describe('version bump', () => {
  it('makes acceptance required again for someone who accepted the previous one — every role', async () => {
    const bumped = createConsentService({ currentVersion: BUMPED_VERSION });

    for (const role of ROLES) {
      const { employeeId, accessToken } = await loginAs(role);

      // The pre-bump state: the previous copy accepted. The current copy is
      // still owed — an old acceptance never clears a new obligation.
      await seedPreviousAcceptance(employeeId);
      const owed = await getRequired(accessToken);
      expect(owed.json<RequiredConsentsResponse>()).toEqual({
        required: [{ kind: 'location_tracking', version: CURRENT_CONSENT_VERSION }],
      });

      // Accepting the current copy clears it — for the owner and dispatcher
      // exactly as for the technician and rep; the endpoint is role-blind.
      await acceptCurrent(accessToken);
      const clear = await getRequired(accessToken);
      expect(clear.json<RequiredConsentsResponse>()).toEqual({ required: [] });

      // The bump itself: the same person, who accepted the previous
      // version, owes the new one. Nothing changed but the date string.
      expect(await bumped.required(employeeId)).toEqual({
        required: [{ kind: 'location_tracking', version: BUMPED_VERSION }],
      });
    }
  });
});
