import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import type { FastifyInstance } from 'fastify';
import {
  deviceDiagnosticSchema,
  errorEnvelopeSchema,
  pingBatchResultSchema,
  type ErrorEnvelope,
  type LocationPingPayload,
  type LoginResponse,
} from '@servgrid/shared';
import { loadConfig, type Config } from '../../src/config.js';
import { closePool } from '../../src/db/pool.js';
import { runMigrations } from '../../src/db/migrate.js';
import { hashPassword } from '../../src/lib/password.js';
import { buildServer } from '../../src/server.js';
import { ULID, validEnv } from '../helpers/env.js';

/**
 * Location ingest (PHASE-1-TECHNICIAN.md T1.9, PLAN-BACKEND.md §8).
 * Runs against a scratch database built from the real migrations (§14:
 * no mocked database anywhere) and drives `POST /v1/location/pings` and
 * `POST /v1/devices` over HTTP, because the IST window conversion, the
 * UNIQUE (employee_id, recorded_at) conflict and the devices upsert are
 * exactly what a mock cannot prove.
 *
 * Every window boundary ping is constructed from an explicit UTC instant
 * carrying the +05:30 offset, so the suite proves the IST conversion —
 * 08:59 IST IS 03:29 UTC, and the server must say so.
 */

function databaseUrl(): string {
  return process.env.DATABASE_URL ?? 'postgres://servgrid:servgrid@localhost:5432/servgrid';
}

function adminUrlFor(url: string): string {
  const parsed = new URL(url);
  parsed.pathname = '/postgres';
  return parsed.toString();
}

const SCRATCH_DB = 'servgrid_location_ingest_test';
const PASSWORD = 'mv-ping-runner-19';

let admin: Pool;
let db: Pool;
let app: FastifyInstance;
let config: Config;

const TECH = { username: '', id: '', token: '' };
const DISPATCHER = { username: '', id: '', token: '' };
const SALES_REP = { username: '', id: '', token: '' };

const LOGIN_DEVICE = {
  installId: 'install-primary',
  platform: 'android',
  appVersion: '0.9.0',
  osVersion: '14',
  manufacturer: 'Xiaomi',
  model: 'Redmi Note 12',
};

async function seedAndLogin(
  role: 'owner' | 'dispatcher' | 'technician' | 'sales_rep',
  installId: string,
  who: { username: string; id: string; token: string },
): Promise<void> {
  const username = `t19.${role}.${randomBytes(4).toString('hex')}`;
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
    payload: { username, password: PASSWORD, device: { ...LOGIN_DEVICE, installId } },
  });
  expect(res.statusCode, res.body).toBe(200);
  who.token = res.json<LoginResponse>().accessToken;
}

// ── IST helpers — every instant is built from the +05:30 offset, so the
// tests state "08:59 IST" and let the conversion to UTC be visible. ──────

const pad = (n: number): string => String(n).padStart(2, '0');

interface IstDate {
  y: number;
  m: number;
  d: number;
}

/** The IST calendar date an instant falls on. */
function istDateParts(instant: Date): IstDate {
  const shifted = new Date(instant.getTime() + 5.5 * 60 * 60_000);
  return {
    y: shifted.getUTCFullYear(),
    m: shifted.getUTCMonth() + 1,
    d: shifted.getUTCDate(),
  };
}

/** 0 = Sunday … 6 = Saturday, of the IST calendar date. Noon IST is
 * unambiguously on that date, so its UTC weekday is the IST weekday. */
function istWeekday(date: IstDate): number {
  return new Date(Date.UTC(date.y, date.m - 1, date.d, 6, 30)).getUTCDay();
}

/** An IST wall-clock moment as a UTC ISO instant — the construction the
 * brief asks for, so the test proves the IST conversion end to end. */
function istIso(date: IstDate, hh: number, mm: number): string {
  return new Date(`${date.y}-${pad(date.m)}-${pad(date.d)}T${pad(hh)}:${pad(mm)}:00+05:30`).toISOString();
}

/** The most recent IST working day (Mon–Sat) whose whole window is
 * comfortably in the past, so in-window pings pass the temporal checks
 * no matter what hour the suite runs at. */
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

/** The latest IST Sunday `hh:mm` no later than two minutes from now.
 *
 * Resolved per hour, not per date. A Sunday test wants 06:00, 12:00 and
 * 21:00 — and on a Sunday afternoon no single Sunday has all three inside
 * the accepted range: today's 21:00 is still ahead (FUTURE), last week's
 * 06:00 is more than 7 days back (TOO_OLD). Picking each hour's latest
 * occurrence keeps every ping inside the range on any day at any hour.
 *
 * The +2 minutes sits inside the server's 5-minute FUTURE skew, and it is
 * what keeps TOO_OLD out of reach: the next weekly occurrence lies beyond
 * now+2min, so this one is less than 7 days minus 2 minutes old. */
function recentSundayAt(hh: number, mm: number, now: Date = new Date()): string {
  const latest = now.getTime() + 2 * 60_000;
  for (let back = 0; back < 8; back++) {
    const date = istDateParts(new Date(latest - back * 24 * 60 * 60_000));
    const iso = istIso(date, hh, mm);
    if (istWeekday(date) === 0 && Date.parse(iso) <= latest) return iso;
  }
  throw new Error('no recent Sunday found — the suite cannot run');
}

/** The most recent IST Saturday whose 10:00 is comfortably in the past. */
function recentSaturday(now: Date = new Date()): IstDate {
  for (let back = 0; back < 8; back++) {
    const date = istDateParts(new Date(now.getTime() - back * 24 * 60 * 60_000));
    if (istWeekday(date) === 6 && Date.parse(istIso(date, 10, 0)) <= now.getTime() - 6 * 60_000) {
      return date;
    }
  }
  throw new Error('no recent Saturday found — the suite cannot run');
}

function pingAt(iso: string, overrides: Partial<LocationPingPayload> = {}): LocationPingPayload {
  return {
    recordedAt: iso,
    latitude: 12.9716,
    longitude: 77.5946,
    accuracyM: 20,
    source: 'scheduled',
    ...overrides,
  };
}

function postPings(token: string, pings: LocationPingPayload[]) {
  return app.inject({
    method: 'POST',
    url: '/v1/location/pings',
    headers: { authorization: `Bearer ${token}` },
    payload: { pings },
  });
}

async function pingRowCount(): Promise<number> {
  const r = await db.query<{ n: string }>('SELECT count(*)::text AS n FROM location_pings');
  return Number(r.rows[0]!.n);
}

interface PingRow {
  employee_id: string;
  device_id: string;
  recorded_at: Date;
  business_date: string;
  accuracy_m: number | null;
  battery_pct: number | null;
  source: string;
  received_at: Date;
}

async function pingRows(): Promise<PingRow[]> {
  const r = await db.query<PingRow>(
    `SELECT employee_id, device_id, recorded_at, business_date::text AS business_date,
            accuracy_m, battery_pct, source, received_at
     FROM location_pings ORDER BY recorded_at`,
  );
  return r.rows;
}

function envelopeOf(status: number, body: string): ErrorEnvelope['error'] {
  expect(status).toBeGreaterThanOrEqual(400);
  const parsed = errorEnvelopeSchema.parse(JSON.parse(body)) as unknown as ErrorEnvelope;
  expect(parsed.error.requestId).toMatch(ULID);
  return parsed.error;
}

beforeAll(async () => {
  admin = new Pool({ connectionString: adminUrlFor(databaseUrl()), max: 2 });
  await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${SCRATCH_DB}`);

  const scratchUrl = new URL(databaseUrl());
  scratchUrl.pathname = `/${SCRATCH_DB}`;
  // The location service reads through the process-wide pool (db/pool.ts);
  // point it at the scratch database before the first request.
  process.env.DATABASE_URL = scratchUrl.toString();
  db = new Pool({ connectionString: scratchUrl.toString(), max: 5 });
  await runMigrations({ pool: db });

  config = loadConfig(validEnv({ DATABASE_URL: scratchUrl.toString() }));
  app = buildServer(config, { logger: false });
  await app.ready();

  // Login registers each actor's device — the same door the handsets use.
  await seedAndLogin('technician', 'install-tech', TECH);
  await seedAndLogin('dispatcher', 'install-dispatcher', DISPATCHER);
  await seedAndLogin('sales_rep', 'install-rep', SALES_REP);

  // Ping ingest ships dark (PLAN-EXECUTION.md §3): enable it for the two
  // tracked roles the suite drives; the flag mechanics themselves are
  // flags.test.ts's subject.
  await db.query(
    `INSERT INTO employee_flag_overrides (employee_id, flag, enabled)
     VALUES ($1, 'tech.location', true), ($2, 'tech.location', true)`,
    [TECH.id, SALES_REP.id],
  );
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

// ── work window (§8 rule 1) ──────────────────────────────────────────────

describe('the work window — evaluated server-side against recorded_at, in IST', () => {
  it('a ping at 08:59 IST on a working day is OUT_OF_WINDOW; 09:01 IST is accepted', async () => {
    const day = recentWorkingDay();
    const res = await postPings(TECH.token, [pingAt(istIso(day, 8, 59)), pingAt(istIso(day, 9, 1))]);
    expect(res.statusCode, res.body).toBe(200);

    const result = pingBatchResultSchema.parse(res.json());
    expect(result.accepted).toBe(1);
    expect(result.rejected).toEqual([{ index: 0, code: 'OUT_OF_WINDOW' }]);

    // The accepted ping is the 09:01 one, filed against the token's
    // employee and device, with the IST business date generated.
    const rows = await pingRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.business_date).toBe(`${day.y}-${pad(day.m)}-${pad(day.d)}`);
    expect(rows[0]!.employee_id).toBe(TECH.id);
    expect(rows[0]!.recorded_at.toISOString()).toBe(istIso(day, 9, 1));
    expect(rows[0]!.received_at).toBeInstanceOf(Date);
  });

  it('09:00 IST exactly is the first in-window minute (start inclusive)', async () => {
    const day = recentWorkingDay();
    const res = await postPings(TECH.token, [pingAt(istIso(day, 9, 0))]);
    expect(res.statusCode, res.body).toBe(200);
    expect(pingBatchResultSchema.parse(res.json()).accepted).toBe(1);
  });

  it('the close of the window: 18:59 accepted; 19:00 and 19:01 rejected (end exclusive)', async () => {
    const day = recentWorkingDay();
    const res = await postPings(TECH.token, [
      pingAt(istIso(day, 18, 59)),
      pingAt(istIso(day, 19, 0)),
      pingAt(istIso(day, 19, 1)),
    ]);
    expect(res.statusCode, res.body).toBe(200);

    const result = pingBatchResultSchema.parse(res.json());
    expect(result.accepted).toBe(1);
    expect(result.rejected).toEqual([
      { index: 1, code: 'OUT_OF_WINDOW' },
      { index: 2, code: 'OUT_OF_WINDOW' },
    ]);
  });

  it('a Sunday ping is rejected regardless of hour — before, inside and after the window', async () => {
    const before = await pingRowCount();
    const res = await postPings(TECH.token, [
      pingAt(recentSundayAt(6, 0)),
      pingAt(recentSundayAt(12, 0)),
      pingAt(recentSundayAt(21, 0)),
    ]);
    expect(res.statusCode, res.body).toBe(200);

    const result = pingBatchResultSchema.parse(res.json());
    expect(result.accepted).toBe(0);
    expect(result.rejected).toEqual([
      { index: 0, code: 'OUT_OF_WINDOW' },
      { index: 1, code: 'OUT_OF_WINDOW' },
      { index: 2, code: 'OUT_OF_WINDOW' },
    ]);
    expect(await pingRowCount()).toBe(before);
  });

  it('Saturday is a working day — an in-window Saturday ping is accepted', async () => {
    const saturday = recentSaturday();
    expect(istWeekday(saturday)).toBe(6);
    const res = await postPings(TECH.token, [pingAt(istIso(saturday, 10, 0))]);
    expect(res.statusCode, res.body).toBe(200);
    const result = pingBatchResultSchema.parse(res.json());
    expect(result.accepted).toBe(1);
    expect(result.rejected).toEqual([]);
  });
});

// ── temporal bounds (§8 rule 2) ──────────────────────────────────────────

describe('temporal bounds — the server clock, not the device clock', () => {
  it('a ping 8 days old is TOO_OLD', async () => {
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60_000).toISOString();
    const res = await postPings(TECH.token, [pingAt(eightDaysAgo)]);
    expect(res.statusCode, res.body).toBe(200);
    expect(pingBatchResultSchema.parse(res.json()).rejected).toEqual([{ index: 0, code: 'TOO_OLD' }]);
  });

  it('a ping 7 days minus a minute old is not TOO_OLD (the bound is 7 days)', async () => {
    const inside = new Date(Date.now() - (7 * 24 * 60 - 1) * 60_000).toISOString();
    const res = await postPings(TECH.token, [pingAt(inside)]);
    expect(res.statusCode, res.body).toBe(200);
    const result = pingBatchResultSchema.parse(res.json());
    // In-window or not (that depends on the hour the suite runs at), the
    // temporal bound did not fire.
    for (const rejection of result.rejected) expect(rejection.code).not.toBe('TOO_OLD');
  });

  it('a ping 10 minutes in the future is FUTURE', async () => {
    const tenMinutesAhead = new Date(Date.now() + 10 * 60_000).toISOString();
    const res = await postPings(TECH.token, [pingAt(tenMinutesAhead)]);
    expect(res.statusCode, res.body).toBe(200);
    expect(pingBatchResultSchema.parse(res.json()).rejected).toEqual([{ index: 0, code: 'FUTURE' }]);
  });

  it('a ping within the 5-minute skew is not FUTURE', async () => {
    const fourMinutesAhead = new Date(Date.now() + 4 * 60_000).toISOString();
    const res = await postPings(TECH.token, [pingAt(fourMinutesAhead)]);
    expect(res.statusCode, res.body).toBe(200);
    const result = pingBatchResultSchema.parse(res.json());
    for (const rejection of result.rejected) expect(rejection.code).not.toBe('FUTURE');
  });
});

// ── duplicates (§8 rule 4) ───────────────────────────────────────────────

describe('duplicates — a retried batch is free', () => {
  it('the same (employee, recorded_at) in a second batch returns DUPLICATE, and the batch is still 200', async () => {
    const day = recentWorkingDay();
    const ping = pingAt(istIso(day, 11, 30));

    const first = await postPings(TECH.token, [ping]);
    expect(first.statusCode, first.body).toBe(200);
    expect(pingBatchResultSchema.parse(first.json()).accepted).toBe(1);

    const retry = await postPings(TECH.token, [ping]);
    expect(retry.statusCode, retry.body).toBe(200);
    const result = pingBatchResultSchema.parse(retry.json());
    expect(result.accepted).toBe(0);
    expect(result.rejected).toEqual([{ index: 0, code: 'DUPLICATE' }]);

    // Exactly one row on disk — the retry wrote nothing.
    const rows = await pingRows();
    expect(rows.filter((r) => r.recorded_at.toISOString() === ping.recordedAt)).toHaveLength(1);
  });

  it('a repeated recorded_at within one batch: the first lands, the second is DUPLICATE', async () => {
    const day = recentWorkingDay();
    const ping = pingAt(istIso(day, 12, 45));
    const res = await postPings(TECH.token, [ping, { ...ping }]);
    expect(res.statusCode, res.body).toBe(200);

    const result = pingBatchResultSchema.parse(res.json());
    expect(result.accepted).toBe(1);
    expect(result.rejected).toEqual([{ index: 1, code: 'DUPLICATE' }]);
  });
});

// ── the batch envelope (§8 response) ─────────────────────────────────────

describe('the batch envelope — per-ping outcomes, HTTP 200 even when everything is rejected', () => {
  it('a mixed batch reports each ping by index, and flags coarse fixes (§8 rule 3)', async () => {
    const day = recentWorkingDay();
    const coarse = pingAt(istIso(day, 13, 0), { accuracyM: 2500, batteryPct: 64 });
    const res = await postPings(TECH.token, [
      pingAt(istIso(day, 13, 15)), // accepted
      pingAt(istIso(day, 8, 30)), // out of window
      pingAt(new Date(Date.now() + 10 * 60_000).toISOString()), // future
      coarse, // accepted, flagged for accuracy above 2000 m
    ]);
    expect(res.statusCode, res.body).toBe(200);

    // `flagged` is deliberately outside the shared schema (§8's contract
    // is `{ accepted, rejected }`), so read it off the raw body — the
    // schema parse below proves the two documented fields anyway.
    const raw = res.json() as { accepted: number; rejected: Array<{ index: number; code: string }>; flagged?: number[] };
    expect(raw.accepted).toBe(2);
    expect(raw.rejected).toEqual([
      { index: 1, code: 'OUT_OF_WINDOW' },
      { index: 2, code: 'FUTURE' },
    ]);
    // "accuracy_m above 2000 recorded but flagged" (§8): the coarse fix is
    // in the trail and the response names its index.
    expect(raw.flagged).toEqual([3]);
    expect(pingBatchResultSchema.parse(res.json()).accepted).toBe(2);
    const rows = await pingRows();
    const coarseRow = rows.find((r) => r.accuracy_m === 2500);
    expect(coarseRow?.battery_pct).toBe(64);
    expect(coarseRow?.source).toBe('scheduled');
  });

  it('all 200 pings rejected → HTTP 200 with 200 entries in rejected', async () => {
    const day = recentWorkingDay();
    const before = await pingRowCount();
    const pings = Array.from({ length: 200 }, () => pingAt(istIso(day, 3, 0)));
    const res = await postPings(TECH.token, pings);
    expect(res.statusCode, res.body).toBe(200);

    const result = pingBatchResultSchema.parse(res.json());
    expect(result.accepted).toBe(0);
    expect(result.rejected).toHaveLength(200);
    expect(result.rejected.map((r) => r.index)).toEqual(Array.from({ length: 200 }, (_, i) => i));
    expect(new Set(result.rejected.map((r) => r.code))).toEqual(new Set(['OUT_OF_WINDOW']));
    expect(await pingRowCount()).toBe(before);
  });

  it('a batch over 200 pings is a malformed request — 422, not per-ping outcomes', async () => {
    const day = recentWorkingDay();
    const pings = Array.from({ length: 201 }, () => pingAt(istIso(day, 3, 30)));
    const res = await postPings(TECH.token, pings);
    expect(envelopeOf(res.statusCode, res.body).code).toBe('VALIDATION_FAILED');
  });
});

// ── device registration (§8) ─────────────────────────────────────────────

describe('POST /v1/devices — upsert by (employee_id, installId)', () => {
  it('twice with the same installId updates rather than duplicating', async () => {
    const installId = `ladder-${randomBytes(3).toString('hex')}`;

    const first = await app.inject({
      method: 'POST',
      url: '/v1/devices',
      headers: { authorization: `Bearer ${TECH.token}` },
      payload: {
        installId,
        platform: 'android',
        appVersion: '0.9.0',
        osVersion: '14',
        manufacturer: 'Xiaomi',
        model: 'Redmi Note 12',
        fcmToken: 'fcm-token-1',
        locationPermission: 'foreground',
        batteryOptExempt: false,
      },
    });
    expect(first.statusCode, first.body).toBe(200);
    const registered = deviceDiagnosticSchema.parse(first.json());
    expect(registered.installId).toBe(installId);
    expect(registered.locationPermission).toBe('foreground');
    expect(registered.lastSeenAt).not.toBeNull();

    // The ladder step: background granted, notifications confirmed — and
    // fcmToken omitted, which must keep the stored token, not clear it.
    const second = await app.inject({
      method: 'POST',
      url: '/v1/devices',
      headers: { authorization: `Bearer ${TECH.token}` },
      payload: {
        installId,
        platform: 'android',
        appVersion: '0.9.1',
        osVersion: '14',
        manufacturer: 'Xiaomi',
        model: 'Redmi Note 12',
        locationPermission: 'background',
        notificationsEnabled: true,
      },
    });
    expect(second.statusCode, second.body).toBe(200);
    const updated = deviceDiagnosticSchema.parse(second.json());
    expect(updated.id).toBe(registered.id);

    const rows = await db.query<{
      id: string;
      fcm_token: string | null;
      location_permission: string;
      battery_opt_exempt: boolean;
      autostart_confirmed: boolean;
      notifications_enabled: boolean;
      app_version: string;
      version: number;
    }>(`SELECT id, fcm_token, location_permission, battery_opt_exempt, autostart_confirmed,
               notifications_enabled, app_version, version
         FROM devices WHERE employee_id = $1 AND install_id = $2`, [TECH.id, installId]);

    // One row — updated in place, not duplicated.
    expect(rows.rows).toHaveLength(1);
    const row = rows.rows[0]!;
    expect(row.id).toBe(registered.id);
    expect(row.fcm_token).toBe('fcm-token-1'); // omitted on the update → kept
    expect(row.location_permission).toBe('background'); // the chip's truthful reason
    expect(row.notifications_enabled).toBe(true);
    expect(row.battery_opt_exempt).toBe(false); // omitted → prior value survives
    expect(row.autostart_confirmed).toBe(false); // never reported → unconfirmed
    expect(row.app_version).toBe('0.9.1');
    expect(row.version).toBe(2); // the touch trigger counted a real update
  });

  it('a different installId is a different device row', async () => {
    const r = await db.query<{ install_id: string }>(
      'SELECT install_id FROM devices WHERE employee_id = $1 ORDER BY install_id',
      [TECH.id],
    );
    // Exactly two rows for this employee: login's install, and the ladder
    // install above (whose two POSTs with the same installId collapsed
    // into one row, not three).
    expect(r.rows).toHaveLength(2);
    expect(r.rows.map((row) => row.install_id)).toContain('install-tech');
    expect(r.rows.filter((row) => row.install_id.startsWith('ladder-'))).toHaveLength(1);
  });

  it('refuses an unauthenticated caller', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/devices',
      payload: { ...LOGIN_DEVICE, installId: 'nope' },
    });
    expect(envelopeOf(res.statusCode, res.body).code).toBe('UNAUTHENTICATED');
  });
});

// ── authorisation on the ping surface (§5 location.send) ─────────────────

describe('who may send pings — the location.send cell', () => {
  it('a sales rep sends pings — the tracked roles are technician and sales rep', async () => {
    const day = recentWorkingDay();
    const res = await postPings(SALES_REP.token, [pingAt(istIso(day, 15, 0))]);
    expect(res.statusCode, res.body).toBe(200);
    const result = pingBatchResultSchema.parse(res.json());
    expect(result.accepted).toBe(1);
    const rows = await pingRows();
    expect(rows.some((r) => r.employee_id === SALES_REP.id)).toBe(true);
  });

  it('a dispatcher cannot send pings — 403 FORBIDDEN (health, never position)', async () => {
    const day = recentWorkingDay();
    const res = await postPings(DISPATCHER.token, [pingAt(istIso(day, 15, 30))]);
    expect(res.statusCode, res.body).toBe(403);
    expect(envelopeOf(res.statusCode, res.body).code).toBe('FORBIDDEN');
  });

  it('an unauthenticated caller is 401', async () => {
    const day = recentWorkingDay();
    const res = await postPings('not-a-token', [pingAt(istIso(day, 15, 45))]);
    expect(res.statusCode, res.body).toBe(401);
    expect(envelopeOf(res.statusCode, res.body).code).toBe('UNAUTHENTICATED');
  });
});

// ── rate limit (§13: ping ingest 60/min per device) ──────────────────────

describe('the ping ingest rate limit — 60/min per device', () => {
  it('the 61st ping inside a minute is 429 RATE_LIMITED, on that device alone', async () => {
    // A fresh device: the limiter is keyed on the token's device, so this
    // test starts from an empty bucket whatever ran before it.
    const secondDevice = { username: '', id: '', token: '' };
    await seedAndLogin('technician', `install-rate-${randomBytes(4).toString('hex')}`, secondDevice);

    const day = recentWorkingDay();
    const outOfWindow = pingAt(istIso(day, 3, 45)); // cheap: rejected before any insert
    for (let i = 0; i < 60; i++) {
      const res = await postPings(secondDevice.token, [outOfWindow]);
      expect(res.statusCode, `request ${i + 1}: ${res.body}`).toBe(200);
    }

    const sixtyFirst = await postPings(secondDevice.token, [outOfWindow]);
    expect(sixtyFirst.statusCode, sixtyFirst.body).toBe(429);
    expect(sixtyFirst.headers['retry-after']).toBeDefined();
    expect(envelopeOf(sixtyFirst.statusCode, sixtyFirst.body).code).toBe('RATE_LIMITED');

    // The first device's bucket is untouched.
    const otherDevice = await postPings(TECH.token, [outOfWindow]);
    expect(otherDevice.statusCode).toBe(200);
  });
});
