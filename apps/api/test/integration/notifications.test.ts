import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import type { FastifyInstance } from 'fastify';
import { JobCardDispatcherSchema, type LoginResponse } from '@servgrid/shared';
import { loadConfig, type Config } from '../../src/config.js';
import { closePool } from '../../src/db/pool.js';
import { runMigrations } from '../../src/db/migrate.js';
import { __resetFcmForTests, initFcm } from '../../src/lib/fcm.js';
import {
  createNotificationsService,
  drainNotificationSends,
} from '../../src/modules/notifications/service.js';
import { hashPassword } from '../../src/lib/password.js';
import { buildServer } from '../../src/server.js';
import { validEnv } from '../helpers/env.js';

/**
 * Assignment notifications (PHASE-2-DISPATCHER.md T2.5, PLAN-BACKEND.md
 * §12.1). Runs against a scratch database from the real migrations (§14:
 * no mocked database anywhere). The only thing module-mocked is the FCM
 * wire — the real send was proven on hardware in T0.15, and §12.1's
 * contract is about the BODY and the bookkeeping, which is exactly what
 * the stub captures: every serialised request body, verbatim, plus the
 * status FCM answers with.
 *
 * Proven here, per the brief:
 *  - assign fires exactly one push per registered device (§12.1: "to the
 *    assigned technician's devices" — plural, one each);
 *  - reassign fires to BOTH the new and the losing technician (§15 item 5);
 *  - cancellation of an assigned job fires to the technician who had it;
 *  - work-window suppression, decision B1 style: 21:00 + normal is HELD
 *    server-side (held ≠ dropped) and goes out in the window-open batch;
 *    21:00 + urgent pushes immediately; a Sunday 11:00 is outside the
 *    window whatever the clock says;
 *  - `tech.notifications` off (the default) means nothing sent, nothing held;
 *  - UNREGISTERED and SENDER_ID_MISMATCH clear `devices.fcm_token` and
 *    record `failure_reason` (§12.1: an unreachable device is a
 *    tracking-health finding), and a successful send clears a stale one;
 *  - the serialised FCM body is `{"message":{"token":…,"data":{"type":
 *    "sync"}}}` and NOTHING else — asserted verbatim and swept for every
 *    fixture's customer name, address, phone and job title;
 *  - every push dropped changes nothing: the assign answers 200 with FCM
 *    dead on the floor.
 */

function databaseUrl(): string {
  return process.env.DATABASE_URL ?? 'postgres://servgrid:servgrid@localhost:5432/servgrid';
}

function adminUrlFor(url: string): string {
  const parsed = new URL(url);
  parsed.pathname = '/postgres';
  return parsed.toString();
}

const SCRATCH_DB = 'servgrid_notifications_test';
const PASSWORD = 'as-plain-copier-71';

/** 2026-01-14 is a Wednesday; 2026-01-15 Thursday; 2026-01-18 a Sunday. */
const WED_11_00_IST = '2026-01-14T11:00:00+05:30';
const WED_21_00_IST = '2026-01-14T21:00:00+05:30';
const THU_09_05_IST = '2026-01-15T09:05:00+05:30';
const SUN_11_00_IST = '2026-01-18T11:00:00+05:30';

/** Freeze `Date` at an IST instant; timers and I/O keep running for real. */
function clockAt(instant: string): void {
  vi.useFakeTimers({ toFake: ['Date'], now: new Date(instant).getTime() });
}

// ── the FCM wire stub ────────────────────────────────────────────────────────

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PRIVATE_KEY_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

interface CapturedSend {
  token: string;
  /** The serialised request body, exactly as lib/fcm.ts put it on the wire. */
  body: string;
}

const sent: CapturedSend[] = [];

/** Per-token scripted FCM outcome; anything unscripted answers 200. */
const behaviorByToken = new Map<string, { status: number; message: string }>();

const realFetch = globalThis.fetch;

beforeAll(() => {
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

// ── fixtures ─────────────────────────────────────────────────────────────────

interface Actor {
  username: string;
  id: string;
  token: string;
}

const DISPATCHER: Actor = { username: '', id: '', token: '' };

let admin: Pool;
let db: Pool;
let app: FastifyInstance;
let config: Config;

/** Distinct sentinels — if any of these reach a push body, the suite burns. */
const CUSTOMER_NAME = 'Sundaram Appliances Pvt Ltd';
const CUSTOMER_PHONE = '9846000042';
const CUSTOMER_ADDRESS = '12 Anna Salai, Guindy, Chennai 600032';
const JOB_TITLE = 'Split AC not cooling — showroom floor unit';
const CONTACT_NAME = 'Deepa Krishnan';
const CONTACT_PHONE = '9847000019';
const FORBIDDEN_STRINGS = [
  CUSTOMER_NAME,
  CUSTOMER_PHONE,
  CUSTOMER_ADDRESS,
  JOB_TITLE,
  CONTACT_NAME,
  CONTACT_PHONE,
];

const ARUN = { id: '', name: 'Arun Kumar N' };
const VIKRAM = { id: '', name: 'Vikram S' };
const MEENA = { id: '', name: 'Meena R' };
const PRIYA = { id: '', name: 'Priya Lakshmi' };

const TOKENS = {
  arun1: 'fcm-arun-device-1',
  arun2: 'fcm-arun-device-2',
  meena: 'fcm-meena-device-1',
  priya: 'fcm-priya-device-1',
  stale404: 'fcm-stale-unregistered',
  staleMismatch: 'fcm-stale-sender-mismatch',
  freshOk: 'fcm-fresh-ok',
};

let customerId = '';
let serviceId = '';
const jobNumbers = { first: 'JC-NF-0001', second: 'JC-NF-0002', urgent: 'JC-NF-0003', held: 'JC-NF-0004', cancel: 'JC-NF-0005' };

async function seedLoginEmployee(role: string, fullName: string, who: Actor): Promise<void> {
  const username = `t25.${role}.${randomBytes(4).toString('hex')}`;
  who.id = (
    await db.query<{ id: string }>(
      `INSERT INTO employees (username, password_hash, full_name, role)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [username, await hashPassword(PASSWORD), fullName, role],
    )
  ).rows[0]!.id;
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

/** A technician WITHOUT a login — a push target, never an actor. */
async function seedTechnician(fullName: string): Promise<string> {
  return (
    await db.query<{ id: string }>(
      `INSERT INTO employees (username, password_hash, full_name, role)
       VALUES ($1, 'not-a-real-hash', $2, 'technician') RETURNING id`,
      [`t25.tech.${randomBytes(4).toString('hex')}`, fullName],
    )
  ).rows[0]!.id;
}

async function seedNotificationsFlag(employeeId: string): Promise<void> {
  await db.query(
    `INSERT INTO employee_flag_overrides (employee_id, flag, enabled, updated_by)
     VALUES ($1, 'tech.notifications', true, $1)`,
    [employeeId],
  );
}

async function seedDevice(employeeId: string, installId: string, fcmToken: string): Promise<string> {
  return (
    await db.query<{ id: string }>(
      `INSERT INTO devices (employee_id, install_id, fcm_token) VALUES ($1, $2, $3) RETURNING id`,
      [employeeId, installId, fcmToken],
    )
  ).rows[0]!.id;
}

async function seedJob(opts: {
  jobNumber: string;
  status?: 'unassigned' | 'assigned';
  assignedTo?: string | null;
  priority?: 'low' | 'normal' | 'high' | 'urgent';
}): Promise<string> {
  const status = opts.status ?? 'unassigned';
  return (
    await db.query<{ id: string }>(
      `INSERT INTO job_cards (job_number, customer_id, service_id, title, contact_name, contact_phone,
                              status, assigned_to, assigned_at, priority)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [
        opts.jobNumber,
        customerId,
        serviceId,
        JOB_TITLE,
        CONTACT_NAME,
        CONTACT_PHONE,
        status,
        status === 'unassigned' ? null : (opts.assignedTo ?? null),
        status === 'unassigned' ? null : new Date().toISOString(),
        opts.priority ?? 'normal',
      ],
    )
  ).rows[0]!.id;
}

const bearer = (actor: Actor): Record<string, string> => ({ authorization: `Bearer ${actor.token}` });

async function versionOf(jobId: string): Promise<number> {
  return (await db.query<{ version: number }>('SELECT version FROM job_cards WHERE id = $1', [jobId]))
    .rows[0]!.version;
}

async function assign(jobId: string, technicianId: string): Promise<void> {
  const version = await versionOf(jobId);
  const res = await app.inject({
    method: 'POST',
    url: `/v1/jobs/${jobId}/assign`,
    headers: { ...bearer(DISPATCHER), 'if-match': String(version) },
    payload: { technicianId },
  });
  expect(res.statusCode, res.body).toBe(200);
  await drainNotificationSends();
}

async function heldRowsFor(employeeId: string): Promise<Array<{ trigger_kind: string; priority: string; released_at: string | null }>> {
  return (
    await db.query<{ trigger_kind: string; priority: string; released_at: string | null }>(
      `SELECT trigger_kind::text, priority::text, released_at::text
       FROM held_notifications WHERE employee_id = $1`,
      [employeeId],
    )
  ).rows;
}

beforeAll(async () => {
  admin = new Pool({ connectionString: adminUrlFor(databaseUrl()), max: 2 });
  await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${SCRATCH_DB}`);

  const scratchUrl = new URL(databaseUrl());
  scratchUrl.pathname = `/${SCRATCH_DB}`;
  process.env.DATABASE_URL = scratchUrl.toString();
  db = new Pool({ connectionString: scratchUrl.toString(), max: 10 });
  await runMigrations({ pool: db });

  config = loadConfig(validEnv({ DATABASE_URL: scratchUrl.toString() }));
  app = buildServer(config, { logger: false });
  await app.ready();

  // A real throwaway RSA key (the fcm.test.ts pattern): the RS256 JWT
  // signs for real, only the HTTPS hops are stubbed.
  initFcm(
    JSON.stringify({
      project_id: 'servgrid-test',
      client_email: 'test@servgrid-test.iam.gserviceaccount.com',
      private_key: PRIVATE_KEY_PEM,
    }),
  );

  await seedLoginEmployee('dispatcher', 'Notification suite dispatcher', DISPATCHER);
  await db.query(
    `INSERT INTO employee_flag_overrides (employee_id, flag, enabled, updated_by)
     VALUES ($1, 'dispatch.console', true, $1)`,
    [DISPATCHER.id],
  );

  ARUN.id = await seedTechnician(ARUN.name);
  VIKRAM.id = await seedTechnician(VIKRAM.name);
  MEENA.id = await seedTechnician(MEENA.name);
  PRIYA.id = await seedTechnician(PRIYA.name);

  await seedNotificationsFlag(ARUN.id);
  await seedNotificationsFlag(MEENA.id);
  await seedNotificationsFlag(VIKRAM.id); // flag on, NO device — the silent technician
  // PRIYA deliberately has NO override — flags default off, which IS the
  // flag-off case under test.

  await seedDevice(ARUN.id, 'install-arun-1', TOKENS.arun1);
  await seedDevice(ARUN.id, 'install-arun-2', TOKENS.arun2);
  await seedDevice(MEENA.id, 'install-meena-1', TOKENS.meena);
  await seedDevice(PRIYA.id, 'install-priya-1', TOKENS.priya);
  // VIKRAM: registered, but no device — nothing to wake, nothing to hold against.

  customerId = (
    await db.query<{ id: string }>(
      `INSERT INTO customers (name, phone, address_line1, address_line2, city)
       VALUES ($1, $2, $3, 'Near Bus Stand', 'Chennai') RETURNING id`,
      [CUSTOMER_NAME, CUSTOMER_PHONE, CUSTOMER_ADDRESS],
    )
  ).rows[0]!.id;
  serviceId = (
    await db.query<{ id: string }>(
      `INSERT INTO services (code, name) VALUES ('NF-SVC', 'Notification suite service') RETURNING id`,
    )
  ).rows[0]!.id;
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  await app?.close();
  await db?.end();
  await closePool();
  if (admin) {
    await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
    await admin.end();
  }
});

afterEach(() => {
  vi.useRealTimers();
  sent.length = 0;
  behaviorByToken.clear();
  __resetFcmForTests();
});

// ── the suite ────────────────────────────────────────────────────────────────

describe('T2.5 assignment notifications (PLAN-BACKEND.md §12.1)', () => {
  it('assign fires exactly one push per registered device for that technician', async () => {
    clockAt(WED_11_00_IST); // inside the window, a weekday — push immediately

    const first = await seedJob({ jobNumber: jobNumbers.first });
    await assign(first, ARUN.id);
    expect(sent.map((s) => s.token).sort()).toEqual([TOKENS.arun1, TOKENS.arun2].sort());

    // A technician with no registered device: nothing to wake, no error, no hold.
    sent.length = 0;
    const second = await seedJob({ jobNumber: jobNumbers.second });
    await assign(second, VIKRAM.id);
    expect(sent).toHaveLength(0);
    expect(await heldRowsFor(VIKRAM.id)).toHaveLength(0);
  });

  it('reassign fires to BOTH the new and the losing technician', async () => {
    clockAt(WED_11_00_IST);

    const job = await seedJob({ jobNumber: 'JC-NF-0010', status: 'assigned', assignedTo: ARUN.id });
    await assign(job, MEENA.id);

    expect(sent.map((s) => s.token).sort()).toEqual([TOKENS.arun1, TOKENS.arun2, TOKENS.meena].sort());
  });

  it('cancellation of an assigned job wakes the technician who had it', async () => {
    clockAt(WED_11_00_IST);

    const job = await seedJob({ jobNumber: jobNumbers.cancel, status: 'assigned', assignedTo: ARUN.id });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/jobs/${job}/cancel`,
      headers: bearer(DISPATCHER),
      payload: { reasonCode: 'no_access' },
    });
    expect(res.statusCode, res.body).toBe(200);
    await drainNotificationSends();

    expect(sent.map((s) => s.token).sort()).toEqual([TOKENS.arun1, TOKENS.arun2].sort());
  });

  it('a 21:00 assignment of a normal job is HELD; the same at urgent pushes now (decision B1)', async () => {
    clockAt(WED_21_00_IST); // outside 09:00–19:00 IST on a weekday

    const normal = await seedJob({ jobNumber: jobNumbers.held });
    await assign(normal, ARUN.id);
    expect(sent).toHaveLength(0); // suppressed — but not dropped:
    const held = await heldRowsFor(ARUN.id);
    expect(held).toHaveLength(1);
    expect(held[0]).toMatchObject({ trigger_kind: 'assigned', priority: 'normal', released_at: null });

    // 'urgent' is the ONLY priority that overrides the window.
    const urgentJob = await seedJob({ jobNumber: jobNumbers.urgent, priority: 'urgent' });
    await assign(urgentJob, ARUN.id);
    expect(sent.map((s) => s.token).sort()).toEqual([TOKENS.arun1, TOKENS.arun2].sort());
    // The urgent bypass must not have discharged the held row.
    expect((await heldRowsFor(ARUN.id)).every((row) => row.released_at === null)).toBe(true);
  });

  it('a Sunday is outside the window even at 11:00 — held, not sent', async () => {
    clockAt(SUN_11_00_IST);
    // The earlier tests left held rows behind; this test owns the DELTA.
    const unreleasedBefore = (
      await db.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM held_notifications WHERE released_at IS NULL AND employee_id = $1',
        [ARUN.id],
      )
    ).rows[0]!.count;

    const job = await seedJob({ jobNumber: 'JC-NF-0011' });
    await assign(job, ARUN.id);
    expect(sent).toHaveLength(0);
    const unreleasedAfter = (
      await db.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM held_notifications WHERE released_at IS NULL AND employee_id = $1',
        [ARUN.id],
      )
    ).rows[0]!.count;
    expect(Number(unreleasedAfter)).toBe(Number(unreleasedBefore) + 1);
  });

  it('the window-open release batch discharges held wakes — one per device, held ≠ dropped', async () => {
    // The row held by the 21:00 test is still unreleased (this suite runs
    // its tests in order, one file, one process — fileParallelism: false).
    clockAt(THU_09_05_IST);
    const before = await heldRowsFor(ARUN.id);
    expect(before.length).toBeGreaterThanOrEqual(1);

    const notifications = createNotificationsService({ workWindow: config.workWindow });
    const summary = await notifications.releaseHeldAtWindowOpen(new Date(THU_09_05_IST).getTime());

    expect(summary.rowsReleased).toBe(before.length);
    expect(summary.employees).toBeGreaterThanOrEqual(1);
    expect(summary.delivered).toBeGreaterThan(0);
    expect(sent.map((s) => s.token).sort()).toEqual([TOKENS.arun1, TOKENS.arun2].sort());
    const after = await heldRowsFor(ARUN.id);
    expect(after.every((row) => row.released_at !== null)).toBe(true);
  });

  it('tech.notifications off (the default) means nothing sent and nothing held', async () => {
    clockAt(WED_11_00_IST);

    const job = await seedJob({ jobNumber: 'JC-NF-0012' });
    await assign(job, PRIYA.id);
    expect(sent).toHaveLength(0);
    expect(await heldRowsFor(PRIYA.id)).toHaveLength(0);

    // Even out of window, the flag-off technician is neither pushed nor held.
    clockAt(WED_21_00_IST);
    const night = await seedJob({ jobNumber: 'JC-NF-0013' });
    await assign(night, PRIYA.id);
    expect(sent).toHaveLength(0);
    expect(await heldRowsFor(PRIYA.id)).toHaveLength(0);
  });

  it('UNREGISTERED and SENDER_ID_MISMATCH clear fcm_token and record failure_reason; a success clears it', async () => {
    clockAt(WED_11_00_IST);
    behaviorByToken.set(TOKENS.stale404, { status: 404, message: 'Requested entity was not found.' });
    behaviorByToken.set(TOKENS.staleMismatch, { status: 400, message: 'SenderId mismatch' });
    // TOKENS.freshOk: unscripted → 200.

    const arunStale = await seedTechnician('Stale Token Tech');
    await seedNotificationsFlag(arunStale);
    const device404 = await seedDevice(arunStale, 'install-stale-1', TOKENS.stale404);
    const deviceMismatch = await seedDevice(arunStale, 'install-stale-2', TOKENS.staleMismatch);
    const deviceOk = await seedDevice(arunStale, 'install-stale-3', TOKENS.freshOk);
    // A failure recorded yesterday — the successful send must clear it.
    await db.query(`UPDATE devices SET failure_reason = 'Requested entity was not found.' WHERE id = $1`, [deviceOk]);

    const job = await seedJob({ jobNumber: 'JC-NF-0014' });
    await assign(job, arunStale);

    expect(sent.map((s) => s.token).sort()).toEqual(
      [TOKENS.stale404, TOKENS.staleMismatch, TOKENS.freshOk].sort(),
    );

    const devices = await db.query<{ id: string; fcm_token: string | null; failure_reason: string | null }>(
      `SELECT id, fcm_token, failure_reason FROM devices
       WHERE id = ANY($1::uuid[]) ORDER BY id`,
      [[device404, deviceOk]],
    );
    const byId = new Map(devices.rows.map((row) => [row.id, row]));
    expect(byId.get(device404)).toMatchObject({ fcm_token: null, failure_reason: 'Requested entity was not found.' });
    expect(byId.get(deviceOk)).toMatchObject({ fcm_token: TOKENS.freshOk, failure_reason: null });
    // And the sender-mismatch device: token cleared, reason recorded.
    const mismatch = await db.query<{ fcm_token: string | null; failure_reason: string | null }>(
      'SELECT fcm_token, failure_reason FROM devices WHERE id = $1',
      [deviceMismatch],
    );
    expect(mismatch.rows[0]).toMatchObject({ fcm_token: null, failure_reason: 'SenderId mismatch' });
  });

  it('the serialised FCM body is the content-free wake — no customer name, address, phone or job title', async () => {
    clockAt(WED_11_00_IST);
    const job = await seedJob({ jobNumber: 'JC-NF-0015' });
    await assign(job, ARUN.id);
    expect(sent.length).toBeGreaterThanOrEqual(1);

    for (const captured of sent) {
      // The exact serialisation lib/fcm.ts produces — data-only, string values.
      const parsed = JSON.parse(captured.body) as { message: Record<string, unknown> };
      expect(Object.keys(parsed)).toEqual(['message']);
      expect(Object.keys(parsed.message).sort()).toEqual(['data', 'token']);
      expect(JSON.stringify(parsed)).not.toContain('notification'); // no notification key, anywhere
      expect(parsed.message['data']).toEqual({ type: 'sync' });
      expect(parsed.message['token']).toBe(captured.token);
      // The sweep: not one sentinel — customer name, address, phone,
      // contact, job title — appears anywhere in the serialised body.
      for (const forbidden of FORBIDDEN_STRINGS) {
        expect(captured.body).not.toContain(forbidden);
      }
    }
  });

  it('every push dropped changes nothing — FCM dead on the floor, the assign still answers 200', async () => {
    clockAt(WED_11_00_IST);
    // Network death on every FCM hop (OAuth still answers — it is stubbed
    // above and the client treats a thrown send as transient anyway).
    behaviorByToken.set(TOKENS.arun1, { status: 503, message: 'Backend error' });
    behaviorByToken.set(TOKENS.arun2, { status: 503, message: 'Backend error' });

    const job = await seedJob({ jobNumber: 'JC-NF-0016' });
    const version = await versionOf(job);
    const res = await app.inject({
      method: 'POST',
      url: `/v1/jobs/${job}/assign`,
      headers: { ...bearer(DISPATCHER), 'if-match': String(version) },
      payload: { technicianId: ARUN.id },
    });
    expect(res.statusCode, res.body).toBe(200);
    const card = JobCardDispatcherSchema.parse(JSON.parse(res.body));
    expect(card.status).toBe('assigned');

    await drainNotificationSends();
    // Transient failures are neither delivered nor treated as stale —
    // the tokens stay, the tracking-health record stays untouched.
    const tokens = await db.query<{ fcm_token: string | null }>(
      `SELECT fcm_token FROM devices WHERE employee_id = $1 ORDER BY install_id`,
      [ARUN.id],
    );
    expect(tokens.rows.map((row) => row.fcm_token).sort()).toEqual([TOKENS.arun1, TOKENS.arun2].sort());
  });
});
