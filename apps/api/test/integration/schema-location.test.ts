import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { runMigrations } from '../../src/db/migrate.js';

/**
 * Migration 009 integration suite (PHASE-1-TECHNICIAN.md T1.2): the
 * location family (PLAN-DATA-MODEL.md §3.8) and the tracking-health
 * view (§4) — the chip's single source of truth, and a Phase 1 exit
 * criterion. Runs against the real Postgres 16 from `docker compose up
 * db` — no mocked database anywhere (PLAN-BACKEND.md §14). The suite
 * builds its own scratch database from the server's admin connection
 * and drops it afterwards; a failed run leaves nothing behind.
 *
 * The health view is proven fixture by fixture, all five values,
 * because the chip is the only thing standing between a dead tracker
 * and nobody noticing. The precedence under test: permission state
 * wins over ping recency, ALWAYS.
 */

function databaseUrl(): string {
  // CI exports DATABASE_URL explicitly; locally the compose defaults are
  // the documented shape, so an unset variable falls back to them.
  return (
    process.env.DATABASE_URL ?? 'postgres://servgrid:servgrid@localhost:5432/servgrid'
  );
}

function adminUrlFor(url: string): string {
  const parsed = new URL(url);
  parsed.pathname = '/postgres';
  return parsed.toString();
}

const SCRATCH_DB = 'servgrid_location_test';

let admin: Pool;
let db: Pool;

beforeAll(async () => {
  admin = new Pool({ connectionString: adminUrlFor(databaseUrl()), max: 2 });
  await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${SCRATCH_DB}`);

  const url = new URL(databaseUrl());
  url.pathname = `/${SCRATCH_DB}`;
  db = new Pool({ connectionString: url.toString(), max: 5 });
  await runMigrations({ pool: db });
});

afterAll(async () => {
  await db?.end();
  if (admin) {
    // WITH (FORCE): the scratch pools are closed above, but a failed
    // test may have abandoned a client — never wedge the suite.
    await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
    await admin.end();
  }
});

let seq = 0;

/** Insert an employee, returning its id. */
async function insertEmployee(role = 'technician'): Promise<string> {
  seq += 1;
  const r = await db.query<{ id: string }>(
    `INSERT INTO employees (username, password_hash, full_name, role)
     VALUES ($1, 'test-argon2id-hash', $2, $3)
     RETURNING id`,
    [`t12tech${seq}`, `Tech ${seq}`, role],
  );
  return r.rows[0]!.id;
}

/** Insert a device for an employee, returning its id. */
async function insertDevice(
  employeeId: string,
  permission = 'background',
): Promise<string> {
  seq += 1;
  const r = await db.query<{ id: string }>(
    `INSERT INTO devices (employee_id, install_id, location_permission)
     VALUES ($1, $2, $3)
     RETURNING id`,
    [employeeId, `install-${seq}`, permission],
  );
  return r.rows[0]!.id;
}

interface PingOverrides {
  minutesAgo?: number;
  latitude?: number;
  longitude?: number;
  recordedAt?: string;
}

/** Insert a ping, returning its id. */
async function insertPing(
  employeeId: string,
  deviceId: string,
  overrides: PingOverrides = {},
): Promise<string> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO location_pings (employee_id, device_id, recorded_at, latitude, longitude, source)
     VALUES ($1, $2, $3, $4, $5, 'scheduled')
     RETURNING id`,
    [
      employeeId,
      deviceId,
      overrides.recordedAt ??
        new Date(Date.now() - (overrides.minutesAgo ?? 5) * 60_000).toISOString(),
      overrides.latitude ?? 12.9716,
      overrides.longitude ?? 77.5946,
    ],
  );
  return r.rows[0]!.id;
}

/** The health row the view resolves for one employee, if any. */
async function healthOf(
  employeeId: string,
): Promise<{ health: string; last_ping_at: string | null } | undefined> {
  const r = await db.query<{ health: string; last_ping_at: string | null }>(
    `SELECT health, last_ping_at::text AS last_ping_at
     FROM v_employee_tracking_health WHERE employee_id = $1`,
    [employeeId],
  );
  return r.rows[0];
}

/** Run a query expected to fail; return the Postgres error code. */
async function errorCodeOf(query: Promise<unknown>): Promise<string> {
  try {
    await query;
  } catch (err) {
    return (err as { code?: string }).code ?? '';
  }
  throw new Error('expected the query to fail, but it succeeded');
}

describe('migration 009 — location_pings double-write guard (§3.8)', () => {
  it('rejects a duplicate (employee_id, recorded_at) — the retried batch', async () => {
    const emp = await insertEmployee();
    const dev = await insertDevice(emp);
    await insertPing(emp, dev, { recordedAt: '2026-03-14T06:00:00Z' });
    // A technician surfacing from a basement replays his buffered
    // batch; the second copy of the same ping must be refused, the
    // rest of the batch must still land.
    const code = await errorCodeOf(
      insertPing(emp, dev, { recordedAt: '2026-03-14T06:00:00Z' }),
    );
    expect(code).toBe('23505');
  });

  it('accepts two pings from the same employee at different moments', async () => {
    const emp = await insertEmployee();
    const dev = await insertDevice(emp);
    await insertPing(emp, dev, { recordedAt: '2026-03-14T07:00:00Z' });
    await expect(
      insertPing(emp, dev, { recordedAt: '2026-03-14T07:15:00Z' }),
    ).resolves.toBeTruthy();
  });

  it('rejects latitude 91 and longitude 181 — the range checks', async () => {
    const emp = await insertEmployee();
    const dev = await insertDevice(emp);
    expect(
      await errorCodeOf(insertPing(emp, dev, { latitude: 91 })),
    ).toBe('23514');
    expect(
      await errorCodeOf(insertPing(emp, dev, { longitude: 181 })),
    ).toBe('23514');
  });

  it('derives business_date from recorded_at in IST, not the UTC date', async () => {
    const emp = await insertEmployee();
    const dev = await insertDevice(emp);
    const id = await insertPing(emp, dev, { recordedAt: '2026-03-14T20:30:00Z' });
    const r = await db.query<{ business_date: string }>(
      `SELECT business_date::text AS business_date FROM location_pings WHERE id = $1`,
      [id],
    );
    // 20:30 UTC is 02:00 IST on the 15th — the day the ping was taken.
    expect(r.rows[0]?.business_date).toBe('2026-03-15');
  });
});

describe('migration 009 — v_employee_tracking_health, all five values (§4)', () => {
  it("resolves 'never_reported' for a technician with a device and no pings", async () => {
    const emp = await insertEmployee();
    await insertDevice(emp, 'background');
    const row = await healthOf(emp);
    expect(row?.health).toBe('never_reported');
    expect(row?.last_ping_at).toBeNull();
  });

  it("resolves 'permission_missing' when permission was revoked, even though the ping is 4 minutes old", async () => {
    const emp = await insertEmployee();
    const dev = await insertDevice(emp, 'background');
    await insertPing(emp, dev, { minutesAgo: 4 });
    // The revocation is the latest truth the server knows (POST
    // /v1/devices): a fresh ping from before it is not health.
    await db.query(`UPDATE devices SET location_permission = 'foreground' WHERE id = $1`, [
      dev,
    ]);
    const row = await healthOf(emp);
    expect(row?.health).toBe('permission_missing');
  });

  it("resolves 'permission_missing' for a device with no permission at all and no pings", async () => {
    const emp = await insertEmployee();
    await insertDevice(emp, 'none');
    const row = await healthOf(emp);
    // No device would be 'none' too — COALESCE keeps the uninstalled
    // case in the same red state the ladder starts from.
    expect(row?.health).toBe('permission_missing');
  });

  it("resolves 'stale' at 46 minutes and 'active' at 44 — both sides of the 45-minute boundary", async () => {
    const staleEmp = await insertEmployee();
    const staleDev = await insertDevice(staleEmp, 'background');
    await insertPing(staleEmp, staleDev, { minutesAgo: 46 });

    const activeEmp = await insertEmployee();
    const activeDev = await insertDevice(activeEmp, 'background');
    await insertPing(activeEmp, activeDev, { minutesAgo: 44 });

    // Three missed 15-minute cadences is the line; 46 is beyond it,
    // 44 inside it.
    expect((await healthOf(staleEmp))?.health).toBe('stale');
    expect((await healthOf(activeEmp))?.health).toBe('active');
    expect((await healthOf(activeEmp))?.last_ping_at).toBeTruthy();
  });

  it("resolves 'not_tracked' for owner and dispatcher rows, whatever their devices say", async () => {
    const owner = await insertEmployee('owner');
    const ownerDev = await insertDevice(owner, 'background');
    await insertPing(owner, ownerDev, { minutesAgo: 2 });

    const dispatcher = await insertEmployee('dispatcher');
    const dispatcherDev = await insertDevice(dispatcher, 'foreground');
    await insertPing(dispatcher, dispatcherDev, { minutesAgo: 300 });

    // Role is the first branch of the CASE: the office is not followed,
    // so neither a live trail nor a revoked permission changes the
    // answer.
    expect((await healthOf(owner))?.health).toBe('not_tracked');
    expect((await healthOf(dispatcher))?.health).toBe('not_tracked');
  });

  it('carries notifications_enabled through, separate from health', async () => {
    const emp = await insertEmployee();
    const dev = await insertDevice(emp, 'background');
    await insertPing(emp, dev, { minutesAgo: 5 });
    const r = await db.query<{ health: string; notifications_enabled: boolean }>(
      `SELECT health, notifications_enabled
       FROM v_employee_tracking_health WHERE employee_id = $1`,
      [emp],
    );
    // devices.notifications_enabled defaults false — a technician who
    // declined the Android 13+ prompt still tracks fine, so the value
    // must stay out of the health enum.
    expect(r.rows[0]?.health).toBe('active');
    expect(r.rows[0]?.notifications_enabled).toBe(false);
  });

  it('drops a deactivated employee from the view entirely', async () => {
    const emp = await insertEmployee();
    const dev = await insertDevice(emp, 'background');
    await insertPing(emp, dev, { minutesAgo: 2 });
    expect((await healthOf(emp))?.health).toBe('active');

    await db.query(`UPDATE employees SET is_active = false WHERE id = $1`, [emp]);
    const row = await healthOf(emp);
    expect(row).toBeUndefined();
  });
});

describe('PLAN-DATA-MODEL.md §5 — the index plan, verified from pg_indexes', () => {
  it('carries exactly the §5 indexes for location_pings, none extra', async () => {
    const r = await db.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_indexes
       WHERE schemaname = 'public' AND tablename = 'location_pings'
       ORDER BY indexname`,
    );
    const names = new Set(r.rows.map((row) => row.indexname));
    const defs = new Map(r.rows.map((row) => [row.indexname, row.indexdef]));

    // The double-write guard and the trail query.
    expect(names).toContain('location_pings_employee_recorded_unique');
    expect(names).toContain('location_pings_employee_recorded_idx');
    expect(defs.get('location_pings_employee_recorded_idx')).toMatch(
      /employee_id, recorded_at DESC/,
    );
    // The day view across staff.
    expect(names).toContain('location_pings_business_date_employee_idx');
    // The pkey and the UNIQUE constraint round out the set — nothing
    // beyond §5 plus those two constraints.
    expect(names).toContain('location_pings_pkey');
    expect(r.rows).toHaveLength(4);
  });
});
