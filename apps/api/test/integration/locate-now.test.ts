import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import type { FastifyInstance } from 'fastify';
import { errorEnvelopeSchema, type ErrorEnvelope, type LoginResponse } from '@servgrid/shared';
import { loadConfig, type Config } from '../../src/config.js';
import { closePool } from '../../src/db/pool.js';
import { runMigrations } from '../../src/db/migrate.js';
import { hashPassword } from '../../src/lib/password.js';
import { initFcm } from '../../src/lib/fcm.js';
import { buildServer } from '../../src/server.js';
import { EXPIRED_UNANSWERED_REASON, expireLocationRequests } from '../../src/modules/location/repo.js';
import { ULID, validEnv } from '../helpers/env.js';

/**
 * Locate-now and the console reads (PHASE-4 T4.4, PLAN-BACKEND.md §8).
 * Runs against a scratch database built from the real migrations (§14:
 * no mocked database anywhere) and drives the four console endpoints
 * over HTTP. The only stub is the FCM wire — the same seam the
 * notifications suite uses — because the behaviours under test are the
 * ones a mock cannot prove honestly:
 *
 *  - the request row is inserted BEFORE the push is attempted, so a push
 *    failure still leaves a queryable request (the proof is in the wire
 *    body: the push carries the row's already-allocated id);
 *  - an unanswered request past `expires_at` is closed by the
 *    `expire-location-requests` sweep with a failure_reason — the path
 *    the UI depends on to say "device has not answered" instead of
 *    spinning;
 *  - a stale FCM token (UNREGISTERED / SENDER_ID_MISMATCH) clears the
 *    device's `fcm_token` and records failure_reason — an unreachable
 *    device is itself a tracking-health finding;
 *  - a dispatcher calling any console read is 403: positions are a
 *    `location.read` surface, and his cell is `none` (§5);
 *  - the trail returns pings ordered by `recorded_at` and nothing
 *    outside the requested business date.
 */

function databaseUrl(): string {
  return process.env.DATABASE_URL ?? 'postgres://servgrid:servgrid@localhost:5432/servgrid';
}

function adminUrlFor(url: string): string {
  const parsed = new URL(url);
  parsed.pathname = '/postgres';
  return parsed.toString();
}

const SCRATCH_DB = 'servgrid_locate_now_test';
const PASSWORD = 'locate-now-runner-44';

let admin: Pool;
let db: Pool;
let app: FastifyInstance;
let config: Config;

const OWNER = { username: '', id: '', token: '' };
const DISPATCHER = { username: '', id: '', token: '' };
const TECH = { username: '', id: '', token: '' };
const TECH2 = { username: '', id: '', token: '' };
const REP = { username: '', id: '', token: '' };

const TECH_TOKEN_FCM = 'fcm-locate-tech';
const TECH2_TOKEN_FCM = 'fcm-locate-tech2';

/** The FCM wire stub (the notifications suite's seam). Per-token scripted
 * outcomes; anything unscripted answers 200. */
const behaviorByToken = new Map<string, { status: number; message: string }>();

interface CapturedSend {
  token: string;
  body: string;
}
const sent: CapturedSend[] = [];

const realFetch = globalThis.fetch;

// lib/fcm signs its OAuth JWT with the service account's private key
// BEFORE the (stubbed) fetch — the key must be real RSA, the same seam
// the notifications suite uses.
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });

beforeAll(() => {
  initFcm(
    JSON.stringify({
      project_id: 'servgrid-test',
      client_email: 'locate-now@servgrid-test.iam.gserviceaccount.com',
      private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    }),
  );
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url.startsWith('https://oauth2.googleapis.com/')) {
      return new Response(JSON.stringify({ access_token: 'test-access-token', expires_in: 3600 }), {
        status: 200,
      });
    }
    if (url.startsWith('https://fcm.googleapis.com/')) {
      const parsed = JSON.parse(String(init?.body ?? '{}')) as { message?: { token?: string } };
      const token = parsed.message?.token ?? '';
      const scripted = behaviorByToken.get(token);
      sent.push({ token, body: String(init?.body ?? '') });
      if (scripted === undefined || scripted.status === 200) {
        return new Response(JSON.stringify({ name: 'projects/servgrid-test/messages/1' }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: { message: scripted.message } }), {
        status: scripted.status,
      });
    }
    return realFetch(input, init);
  }) as typeof fetch;
});

afterEach(() => {
  behaviorByToken.clear();
  sent.length = 0;
});

async function seedAndLogin(
  role: 'owner' | 'dispatcher' | 'technician' | 'sales_rep',
  installId: string,
  who: { username: string; id: string; token: string },
): Promise<void> {
  const username = `t44.${role}.${randomBytes(4).toString('hex')}`;
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
      device: { installId, platform: 'android', appVersion: '1.0.0', osVersion: '14', manufacturer: 'Xiaomi', model: 'Redmi Note 12' },
    },
  });
  expect(res.statusCode, res.body).toBe(200);
  who.token = res.json<LoginResponse>().accessToken;
}

/** Give a login-registered device an FCM token and background permission
 * — the fully-onboarded handset a locate-now push targets (the health
 * view reads permission from this row, and a `none` permission reads
 * permission_missing however fresh the pings are). */
async function setFcmToken(employeeId: string, token: string | null): Promise<void> {
  await db.query(
    `UPDATE devices SET fcm_token = $2, failure_reason = NULL, location_permission = 'background'
     WHERE employee_id = $1`,
    [employeeId, token],
  );
}

/** POST /v1/location/requests as the owner. */
function postRequest(token: string, employeeId: string, mode: 'fix' | 'live') {
  return app.inject({
    method: 'POST',
    url: '/v1/location/requests',
    headers: { authorization: `Bearer ${token}` },
    payload: { employeeId, mode },
  });
}

function envelopeOf(status: number, body: string): ErrorEnvelope['error'] {
  expect(status).toBeGreaterThanOrEqual(400);
  const parsed = errorEnvelopeSchema.parse(JSON.parse(body)) as unknown as ErrorEnvelope;
  expect(parsed.error.requestId).toMatch(ULID);
  return parsed.error;
}

async function requestRow(id: string): Promise<{
  failure_reason: string | null;
  pushed_at: Date | null;
  fulfilled_at: Date | null;
  expires_at: Date;
  requested_at: Date;
}> {
  const r = await db.query<{
    failure_reason: string | null;
    pushed_at: Date | null;
    fulfilled_at: Date | null;
    expires_at: Date;
    requested_at: Date;
  }>(
    `SELECT failure_reason, pushed_at, fulfilled_at, expires_at, requested_at
     FROM location_requests WHERE id = $1::uuid`,
    [id],
  );
  return r.rows[0]!;
}

// ── IST helpers (the location-ingest suite's construction) ─────────────────

const pad = (n: number): string => String(n).padStart(2, '0');

/** The working day this run plants pings on — computed once, so every
 * describe agrees on the same day whatever hour the suite runs at. */
const TRAIL_DAY = recentWorkingDay();

interface IstDate {
  y: number;
  m: number;
  d: number;
}

function istDateParts(instant: Date): IstDate {
  const shifted = new Date(instant.getTime() + 5.5 * 60 * 60_000);
  return { y: shifted.getUTCFullYear(), m: shifted.getUTCMonth() + 1, d: shifted.getUTCDate() };
}

function istWeekday(date: IstDate): number {
  return new Date(Date.UTC(date.y, date.m - 1, date.d, 6, 30)).getUTCDay();
}

function istIso(date: IstDate, hh: number, mm: number): string {
  return new Date(`${date.y}-${pad(date.m)}-${pad(date.d)}T${pad(hh)}:${pad(mm)}:00+05:30`).toISOString();
}

function istDateString(date: IstDate): string {
  return `${date.y}-${pad(date.m)}-${pad(date.d)}`;
}

/** The most recent IST working day (Mon–Sat) whose whole window is
 * comfortably in the past, so pings planted on it pass the ingest
 * temporal checks no matter what hour the suite runs at. */
function recentWorkingDay(now: Date = new Date()): IstDate {
  for (let back = 0; back < 8; back++) {
    const date = istDateParts(new Date(now.getTime() - back * 24 * 60 * 60_000));
    const weekday = istWeekday(date);
    if (weekday >= 1 && weekday <= 6 && Date.parse(istIso(date, 18, 59)) <= now.getTime() - 6 * 60_000) {
      return date;
    }
  }
  throw new Error('no recent working day found — the suite cannot run');
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

  await seedAndLogin('owner', 'install-owner', OWNER);
  await seedAndLogin('dispatcher', 'install-dispatcher', DISPATCHER);
  await seedAndLogin('technician', 'install-tech', TECH);
  await seedAndLogin('technician', 'install-tech2', TECH2);
  await seedAndLogin('sales_rep', 'install-rep', REP);

  // The console ships dark (PLAN-EXECUTION.md §3): the owner's flag is
  // the T0 rollback tier under test below.
  await db.query(
    `INSERT INTO employee_flag_overrides (employee_id, flag, enabled)
     VALUES ($1, 'owner.location', true)`,
    [OWNER.id],
  );
  // Both technicians track (their pings are ingested below through the
  // real endpoint, which gates on tech.location).
  await db.query(
    `INSERT INTO employee_flag_overrides (employee_id, flag, enabled)
     VALUES ($1, 'tech.location', true), ($2, 'tech.location', true)`,
    [TECH.id, TECH2.id],
  );

  await setFcmToken(TECH.id, TECH_TOKEN_FCM);
  await setFcmToken(TECH2.id, TECH2_TOKEN_FCM);
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

// ── the row first, the push second (§8's order IS the feature) ────────────

describe('POST /v1/location/requests — persisted before the push is attempted', () => {
  it('a push failure still leaves a queryable request — the row existed before the send', async () => {
    // FCM itself is down (a 5xx — permanent per lib/fcm's retry ladder
    // but NOT a stale token). The console must still get a row.
    behaviorByToken.set(TECH_TOKEN_FCM, { status: 500, message: 'Backend error' });

    const res = await postRequest(OWNER.token, TECH.id, 'fix');
    expect(res.statusCode, res.body).toBe(200);

    const created = res.json();
    expect(created.status).toBe('failed');
    expect(created.failureReason).toBe('Backend error');
    expect(created.pushedAt).not.toBeNull();

    // THE PROOF OF ORDER: the push body carried the row's id. The id is
    // only allocated by the INSERT, so a row must already have existed
    // when the push was serialised — persist-first, not push-first. A
    // 5xx is retried by lib/fcm's ladder, so the one logical send may
    // appear as up to three wire attempts — every one of them carries
    // the same already-allocated id.
    expect(sent.length).toBeGreaterThanOrEqual(1);
    for (const capture of sent) {
      const data = JSON.parse(capture.body).message.data as Record<string, string>;
      expect(data.requestId).toBe(created.id);
    }

    // Queryable: the poll answers with the same closed row.
    const poll = await app.inject({
      method: 'GET',
      url: `/v1/location/requests/${created.id}`,
      headers: { authorization: `Bearer ${OWNER.token}` },
    });
    expect(poll.statusCode, poll.body).toBe(200);
    expect(poll.json().status).toBe('failed');

    // `fix` expires in 2 minutes (§8).
    const row = await requestRow(created.id);
    expect(row.expires_at.getTime() - row.requested_at.getTime()).toBe(2 * 60_000);
  });

  it('a delivered push records the instruction payload and an open, pushed request', async () => {
    const res = await postRequest(OWNER.token, TECH.id, 'fix');
    expect(res.statusCode, res.body).toBe(200);

    const created = res.json();
    expect(created.status).toBe('pushed');
    expect(created.failureReason).toBeNull();
    expect(created.mode).toBe('fix');

    // The data-only message carries exactly the instruction — ids and a
    // mode, no person or job content — and `fix` does NOT flip the
    // device's cadence (only `live` does).
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0]!.body)).toEqual({
      message: {
        token: TECH_TOKEN_FCM,
        data: { type: 'location-request', requestId: created.id, mode: 'fix' },
      },
    });

    const row = await requestRow(created.id);
    expect(row.failure_reason).toBeNull();
    expect(row.pushed_at).not.toBeNull();
  });

  it('a delivered `live` request expires in five minutes, not two', async () => {
    const res = await postRequest(OWNER.token, TECH.id, 'live');
    expect(res.statusCode, res.body).toBe(200);
    const created = res.json();
    expect(created.status).toBe('pushed');
    const row = await requestRow(created.id);
    expect(row.expires_at.getTime() - row.requested_at.getTime()).toBe(5 * 60_000);
  });

  it('a target with no pushable device closes immediately with no_pushable_device', async () => {
    // The rep is tracked (a valid target) but registered no FCM token.
    const res = await postRequest(OWNER.token, REP.id, 'fix');
    expect(res.statusCode, res.body).toBe(200);
    const created = res.json();
    expect(created.status).toBe('failed');
    expect(created.failureReason).toBe('no_pushable_device');
    expect(sent).toHaveLength(0); // nothing was attempted — there was nothing to attempt
  });

  it('an untracked or inactive target is 404, not a request that can never be answered', async () => {
    const ownerAsTarget = await postRequest(OWNER.token, DISPATCHER.id, 'fix');
    expect(ownerAsTarget.statusCode).toBe(404);
    expect(envelopeOf(ownerAsTarget.statusCode, ownerAsTarget.body).code).toBe('NOT_FOUND');

    const unknown = await postRequest(OWNER.token, randomBytes(16).toString('hex'), 'fix');
    expect(unknown.statusCode).toBe(422); // not a uuid — malformed, not missing
  });
});

// ── the unanswered path — what the UI depends on to avoid a spinner ───────

describe('expire-location-requests — the sweep closes what no device answered', () => {
  it('a request past expires_at is closed with failure_reason = unanswered', async () => {
    // An open request whose window has passed: requested and pushed ten
    // minutes ago, expired five minutes ago, no answer, no failure yet.
    const inserted = await db.query<{ id: string }>(
      `INSERT INTO location_requests
         (requested_by, target_employee_id, mode, requested_at, expires_at, pushed_at)
       VALUES ($1, $2, 'fix', now() - interval '10 minutes', now() - interval '5 minutes',
               now() - interval '10 minutes')
       RETURNING id`,
      [OWNER.id, TECH.id],
    );
    const staleId = inserted.rows[0]!.id;

    // The sweep is §12's job, run here with a fixed clock (the scheduler
    // in src/jobs calls exactly this query every minute).
    const closed = await expireLocationRequests(db, Date.now());
    expect(closed).toContain(staleId);

    const row = await requestRow(staleId);
    expect(row.failure_reason).toBe(EXPIRED_UNANSWERED_REASON);
    expect(row.fulfilled_at).toBeNull();

    // Idempotent: a second sweep has nothing left to close.
    expect(await expireLocationRequests(db, Date.now())).not.toContain(staleId);
  });

  it('the sweep never touches an open request inside its window, or an already-closed one', async () => {
    // Open and inside its window (the API created it moments ago).
    const open = (await postRequest(OWNER.token, TECH2.id, 'fix')).json();
    // Push-failed: already closed with its FCM-level reason.
    behaviorByToken.set(TECH_TOKEN_FCM, { status: 500, message: 'Backend error' });
    const failed = (await postRequest(OWNER.token, TECH.id, 'fix')).json();
    await db.query(`UPDATE location_requests SET expires_at = now() - interval '1 minute' WHERE id = $1::uuid`, [
      failed.id,
    ]);

    await expireLocationRequests(db, Date.now());

    const openRow = await requestRow(open.id);
    expect(openRow.failure_reason).toBeNull(); // still waiting — honestly

    const failedRow = await requestRow(failed.id);
    expect(failedRow.failure_reason).toBe('Backend error'); // its own reason stands
  });
});

// ── the stale-token path — an unreachable device is a finding ─────────────

describe('stale FCM tokens — cleared, with the reason recorded', () => {
  it('UNREGISTERED clears the device token and sets failure_reason on device and request', async () => {
    await setFcmToken(TECH.id, TECH_TOKEN_FCM);
    behaviorByToken.set(TECH_TOKEN_FCM, { status: 404, message: 'Requested entity was not found.' });

    const res = await postRequest(OWNER.token, TECH.id, 'fix');
    expect(res.statusCode, res.body).toBe(200);
    const created = res.json();
    expect(created.status).toBe('failed');
    expect(created.failureReason).toContain('Requested entity was not found.');

    const device = await db.query<{ fcm_token: string | null; failure_reason: string | null }>(
      `SELECT fcm_token, failure_reason FROM devices WHERE employee_id = $1`,
      [TECH.id],
    );
    expect(device.rows[0]!.fcm_token).toBeNull(); // the stale token is gone
    expect(device.rows[0]!.failure_reason).toContain('Requested entity was not found.');
  });

  it('SENDER_ID_MISMATCH is equally unrecoverable — the token is cleared too', async () => {
    await setFcmToken(TECH.id, TECH_TOKEN_FCM);
    behaviorByToken.set(TECH_TOKEN_FCM, { status: 400, message: 'SenderId mismatch' });

    const res = await postRequest(OWNER.token, TECH.id, 'fix');
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().status).toBe('failed');

    const device = await db.query<{ fcm_token: string | null }>(
      `SELECT fcm_token FROM devices WHERE employee_id = $1`,
      [TECH.id],
    );
    expect(device.rows[0]!.fcm_token).toBeNull();
  });

  it('a delivered push clears any recorded failure on the device that accepted it', async () => {
    await setFcmToken(TECH.id, TECH_TOKEN_FCM);
    await db.query(`UPDATE devices SET failure_reason = 'Requested entity was not found.' WHERE employee_id = $1`, [
      TECH.id,
    ]);

    const res = await postRequest(OWNER.token, TECH.id, 'fix');
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().status).toBe('pushed');

    const device = await db.query<{ failure_reason: string | null }>(
      `SELECT failure_reason FROM devices WHERE employee_id = $1`,
      [TECH.id],
    );
    expect(device.rows[0]!.failure_reason).toBeNull(); // the token demonstrably works
  });
});

// ── who may call — the owner, and the flag (§5, T0 tier) ──────────────────

describe('the console is the owner alone — a dispatcher calling any of these is 403', () => {
  it('the dispatcher is refused on every console surface', async () => {
    const created = (await postRequest(OWNER.token, TECH.id, 'fix')).json();

    const post = await postRequest(DISPATCHER.token, TECH.id, 'fix');
    expect(post.statusCode).toBe(403);
    expect(envelopeOf(post.statusCode, post.body).code).toBe('FORBIDDEN');

    const poll = await app.inject({
      method: 'GET',
      url: `/v1/location/requests/${created.id}`,
      headers: { authorization: `Bearer ${DISPATCHER.token}` },
    });
    expect(poll.statusCode).toBe(403);

    const roster = await app.inject({
      method: 'GET',
      url: '/v1/location/employees',
      headers: { authorization: `Bearer ${DISPATCHER.token}` },
    });
    expect(roster.statusCode).toBe(403);

    const trail = await app.inject({
      method: 'GET',
      url: `/v1/location/employees/${TECH.id}/trail?date=2026-09-10`,
      headers: { authorization: `Bearer ${DISPATCHER.token}` },
    });
    expect(trail.statusCode).toBe(403);
  });

  it('a technician has no cell on location.read either, and anonymous is 401', async () => {
    const roster = await app.inject({
      method: 'GET',
      url: '/v1/location/employees',
      headers: { authorization: `Bearer ${TECH.token}` },
    });
    expect(roster.statusCode).toBe(403);

    const anonymous = await app.inject({ method: 'GET', url: '/v1/location/employees' });
    expect(anonymous.statusCode).toBe(401);
    expect(envelopeOf(anonymous.statusCode, anonymous.body).code).toBe('UNAUTHENTICATED');
  });

  it('owner.location off is FLAG_DISABLED — the T0 rollback tier', async () => {
    await db.query(`DELETE FROM employee_flag_overrides WHERE employee_id = $1 AND flag = 'owner.location'`, [
      OWNER.id,
    ]);
    const res = await postRequest(OWNER.token, TECH.id, 'fix');
    expect(res.statusCode).toBe(409);
    expect(envelopeOf(res.statusCode, res.body).code).toBe('FLAG_DISABLED');

    // The console lights back up for the rest of the suite.
    await db.query(
      `INSERT INTO employee_flag_overrides (employee_id, flag, enabled) VALUES ($1, 'owner.location', true)`,
      [OWNER.id],
    );
  });
});

// ── the trail — ordered, and nothing outside the day ──────────────────────

describe('GET /v1/location/employees/:id/trail — a day, in time order', () => {
  const day = TRAIL_DAY;
  const previousDay = istDateParts(new Date(Date.parse(istIso(day, 12, 0)) - 24 * 60 * 60_000));
  const deviceIdQuery = () =>
    db.query<{ id: string }>(`SELECT id FROM devices WHERE employee_id = $1 LIMIT 1`, [TECH.id]);

  it('returns pings ordered by recorded_at, and nothing outside the requested business date', async () => {
    const device = await deviceIdQuery();

    // Planted out of order on purpose: the trail must come back sorted.
    // One ping belongs to the PREVIOUS IST day — a different business_date.
    await db.query(
      `INSERT INTO location_pings (employee_id, device_id, recorded_at, latitude, longitude, source)
       VALUES ($1, $2, $3::timestamptz, 12.9724, 77.5954, 'scheduled'),
              ($1, $2, $4::timestamptz, 12.9720, 77.5950, 'scheduled'),
              ($1, $2, $5::timestamptz, 12.9716, 77.5946, 'scheduled'),
              ($1, $2, $6::timestamptz, 13.0100, 77.5550, 'scheduled')`,
      [
        TECH.id,
        device.rows[0]!.id,
        istIso(day, 12, 15), // latest first in the insert...
        istIso(day, 12, 5),
        istIso(day, 12, 0),
        istIso(previousDay, 11, 0), // ...and on a different business date
      ],
    );

    const res = await app.inject({
      method: 'GET',
      url: `/v1/location/employees/${TECH.id}/trail?date=${istDateString(day)}`,
      headers: { authorization: `Bearer ${OWNER.token}` },
    });
    expect(res.statusCode, res.body).toBe(200);

    const trail = res.json();
    expect(trail).toHaveLength(3); // nothing from the previous day
    // Compare instants, not serialisations: the wire format is
    // Postgres's to_json ISO form, which need not match the input's.
    const recorded = trail.map((p: { recordedAt: string }) => Date.parse(p.recordedAt));
    expect(recorded).toEqual([...recorded].sort((a, b) => a - b)); // ascending
    expect(recorded).toEqual([istIso(day, 12, 0), istIso(day, 12, 5), istIso(day, 12, 15)].map(Date.parse));
    expect(trail[0]).toMatchObject({ latitude: 12.9716, longitude: 77.5946, source: 'scheduled' });
  });

  it('a missing or malformed date is a 422, an unknown employee a 404', async () => {
    const noDate = await app.inject({
      method: 'GET',
      url: `/v1/location/employees/${TECH.id}/trail`,
      headers: { authorization: `Bearer ${OWNER.token}` },
    });
    expect(noDate.statusCode).toBe(422);

    const badDate = await app.inject({
      method: 'GET',
      url: `/v1/location/employees/${TECH.id}/trail?date=12-09-2026`,
      headers: { authorization: `Bearer ${OWNER.token}` },
    });
    expect(envelopeOf(badDate.statusCode, badDate.body).code).toBe('VALIDATION_FAILED');

    const unknown = await app.inject({
      method: 'GET',
      url: `/v1/location/employees/${randomUUID()}/trail?date=${istDateString(day)}`,
      headers: { authorization: `Bearer ${OWNER.token}` },
    });
    expect(unknown.statusCode).toBe(404);
    expect(envelopeOf(unknown.statusCode, unknown.body).code).toBe('NOT_FOUND');
  });
});

// ── the roster read — positions at last, for the owner only ───────────────

describe('GET /v1/location/employees — latest position + health per tracked employee', () => {
  it('lists tracked staff with their health row AND latest fix; the office is absent', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/location/employees',
      headers: { authorization: `Bearer ${OWNER.token}` },
    });
    expect(res.statusCode, res.body).toBe(200);

    const roster = res.json();
    const tech = roster.find((r: { employeeId: string }) => r.employeeId === TECH.id);
    expect(tech).toBeDefined();
    // The planted pings can be up to ~two days old (recentWorkingDay
    // depends on the hour the suite runs at): healthy if fresh, stale if
    // not — but never permission_missing, and never a wrong position.
    expect(['active', 'stale']).toContain(tech.health);
    expect(tech.position).not.toBeNull();
    expect(tech.position).toMatchObject({ latitude: 12.9724, longitude: 77.5954, source: 'scheduled' });
    expect(Date.parse(tech.lastPingAt)).toBe(Date.parse(istIso(TRAIL_DAY, 12, 15)));
    expect(tech.minutesSince).not.toBeNull();

    // The office roles are not on the console's map (not_tracked).
    expect(roster.find((r: { employeeId: string }) => r.employeeId === OWNER.id)).toBeUndefined();
    expect(roster.find((r: { employeeId: string }) => r.employeeId === DISPATCHER.id)).toBeUndefined();

    // A tracked employee who never reported is on the roster with an
    // honest null position, not missing.
    const tech2 = roster.find((r: { employeeId: string }) => r.employeeId === TECH2.id);
    expect(tech2).toBeDefined();
    expect(tech2.position).toBeNull();
    expect(tech2.health).toBe('never_reported');
  });
});

// ── fulfilment — the answer arrives through the ping door ─────────────────

describe('the answer arrives — pings close the requests they answer', () => {
  it('an on_demand/live ping from the target fulfils the open request', async () => {
    const day = TRAIL_DAY;
    // Open well before the ping instant, so requested_at <= recorded_at
    // holds (the API path stamps requested_at with the real clock, and
    // the ping is a past in-window instant).
    const inserted = await db.query<{ id: string }>(
      `INSERT INTO location_requests
         (requested_by, target_employee_id, mode, requested_at, expires_at, pushed_at)
       VALUES ($1, $2, 'live', now() - interval '10 days', now() + interval '1 hour',
               now() - interval '10 days')
       RETURNING id`,
      [OWNER.id, TECH2.id],
    );
    const requestId = inserted.rows[0]!.id;

    // The device answers: a `live`-source fix through the real ingest.
    const res = await app.inject({
      method: 'POST',
      url: '/v1/location/pings',
      headers: { authorization: `Bearer ${TECH2.token}` },
      payload: {
        pings: [
          {
            recordedAt: istIso(day, 14, 0),
            latitude: 12.9611,
            longitude: 77.6385,
            accuracyM: 12,
            source: 'live',
          },
        ],
      },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().accepted).toBe(1);

    const row = await requestRow(requestId);
    expect(row.fulfilled_at).not.toBeNull();
    const ping = await db.query<{ id: string }>(
      `SELECT id FROM location_pings WHERE employee_id = $1 AND source = 'live'`,
      [TECH2.id],
    );
    const fulfilled = await db.query<{ fulfilled_ping_id: string }>(
      `SELECT fulfilled_ping_id FROM location_requests WHERE id = $1::uuid`,
      [requestId],
    );
    expect(Number(fulfilled.rows[0]!.fulfilled_ping_id)).toBe(Number(ping.rows[0]!.id));

    const poll = await app.inject({
      method: 'GET',
      url: `/v1/location/requests/${requestId}`,
      headers: { authorization: `Bearer ${OWNER.token}` },
    });
    expect(poll.statusCode, poll.body).toBe(200);
    expect(poll.json().status).toBe('fulfilled');
    expect(poll.json().fulfilledPingId).toBe(Number(ping.rows[0]!.id));
  });

  it('a live-source ping never closes a request made AFTER it — the requested_at guard', async () => {
    const day = TRAIL_DAY;

    // The request is created NOW; the ping below is dated on the recent
    // working day — in the past. The fulfilment UPDATE does run (the
    // source is `live`), but its `requested_at <= recorded_at` guard
    // must exclude a request the ping could not have been answering.
    const inserted = await db.query<{ id: string }>(
      `INSERT INTO location_requests
         (requested_by, target_employee_id, mode, requested_at, expires_at, pushed_at)
       VALUES ($1, $2, 'fix', now(), now() + interval '1 hour', now())
       RETURNING id`,
      [OWNER.id, TECH2.id],
    );
    const requestId = inserted.rows[0]!.id;

    const res = await app.inject({
      method: 'POST',
      url: '/v1/location/pings',
      headers: { authorization: `Bearer ${TECH2.token}` },
      payload: {
        pings: [
          {
            recordedAt: istIso(day, 15, 30),
            latitude: 12.9612,
            longitude: 77.6386,
            accuracyM: 15,
            source: 'live',
          },
        ],
      },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().accepted).toBe(1);

    const row = await requestRow(requestId);
    expect(row.fulfilled_at).toBeNull();
    expect(row.failure_reason).toBeNull(); // still honestly open

    const poll = await app.inject({
      method: 'GET',
      url: `/v1/location/requests/${requestId}`,
      headers: { authorization: `Bearer ${OWNER.token}` },
    });
    expect(poll.json().status).toBe('pushed');
  });

  it('a scheduled ping fulfils nothing — the ordinary cadence is not an answer', async () => {
    const day = TRAIL_DAY;
    const inserted = await db.query<{ id: string }>(
      `INSERT INTO location_requests
         (requested_by, target_employee_id, mode, requested_at, expires_at, pushed_at)
       VALUES ($1, $2, 'fix', now() - interval '10 days', now() + interval '1 hour',
               now() - interval '10 days')
       RETURNING id`,
      [OWNER.id, TECH2.id],
    );
    const requestId = inserted.rows[0]!.id;

    const res = await app.inject({
      method: 'POST',
      url: '/v1/location/pings',
      headers: { authorization: `Bearer ${TECH2.token}` },
      payload: {
        pings: [
          {
            recordedAt: istIso(day, 16, 30),
            latitude: 12.9613,
            longitude: 77.6387,
            accuracyM: 15,
            source: 'scheduled', // the ordinary cadence — not an answer
          },
        ],
      },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().accepted).toBe(1);

    const row = await requestRow(requestId);
    expect(row.fulfilled_at).toBeNull();
    expect(row.failure_reason).toBeNull();
  });
});
