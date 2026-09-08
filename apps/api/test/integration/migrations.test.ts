import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { runMigrations } from '../../src/db/migrate.js';

/**
 * Migration 001 integration suite (PHASE-0-FOUNDATION.md T0.2).
 *
 * Runs against the real Postgres 16 from `docker compose up db` — no
 * mocked database anywhere (PLAN-BACKEND.md §14). The suite builds its
 * own scratch database from the server's admin connection, rehearses
 * the migration set inside it, and drops it afterwards: no manual
 * intervention, and a failed run leaves nothing behind.
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

const SCRATCH_DB = 'servgrid_migrate_test';

let admin: Pool;
let db: Pool;

beforeAll(async () => {
  admin = new Pool({ connectionString: adminUrlFor(databaseUrl()), max: 2 });
  await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${SCRATCH_DB}`);

  const url = new URL(databaseUrl());
  url.pathname = `/${SCRATCH_DB}`;
  db = new Pool({ connectionString: url.toString(), max: 5 });
});

afterAll(async () => {
  await db?.end();
  if (admin) {
    // WITH (FORCE): the rehearsal pools are closed above, but a failed
    // test may have abandoned a client — never wedge the suite.
    await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
    await admin.end();
  }
});

describe('migration 001 — up → down → up on a clean database', () => {
  it('runs the full cycle with no manual intervention', async () => {
    // ---- up ----
    await runMigrations({ pool: db });
    const afterUp = await db.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM pgmigrations',
    );
    expect(Number(afterUp.rows[0]?.count)).toBeGreaterThanOrEqual(1);

    const exts = await db.query<{ extname: string }>(
      "SELECT extname FROM pg_extension WHERE extname IN ('pgcrypto', 'citext') ORDER BY extname",
    );
    expect(exts.rows.map((r) => r.extname)).toEqual(['citext', 'pgcrypto']);

    const fns = await db.query<{ proname: string }>(
      "SELECT proname FROM pg_proc WHERE proname IN ('business_date', 'touch_updated_at') ORDER BY proname",
    );
    expect(fns.rows.map((r) => r.proname)).toEqual(['business_date', 'touch_updated_at']);

    // ---- down ----
    await runMigrations({ pool: db, direction: 'down' });
    const afterDown = await db.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM pgmigrations',
    );
    expect(Number(afterDown.rows[0]?.count)).toBe(0);
    await expect(
      db.query("SELECT business_date('2026-03-14T20:30:00Z'::timestamptz)"),
    ).rejects.toThrow(/does not exist/);

    // ---- up again ----
    await runMigrations({ pool: db });
    const afterReUp = await db.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM pgmigrations',
    );
    expect(Number(afterReUp.rows[0]?.count)).toBeGreaterThanOrEqual(1);
    const probe = await db.query<{ d: string }>(
      "SELECT business_date('2026-03-14T20:30:00Z'::timestamptz)::text AS d",
    );
    expect(probe.rows[0]?.d).toBe('2026-03-15');
  });
});

describe('business_date — IST boundary', () => {
  beforeAll(async () => {
    await runMigrations({ pool: db });
  });

  it('maps 20:30 UTC to the next IST day (the spec case)', async () => {
    // IST is +05:30, so a 20:30 UTC timestamp is 02:00 next-day IST.
    const r = await db.query<{ d: string }>(
      "SELECT business_date('2026-03-14T20:30:00Z'::timestamptz)::text AS d",
    );
    expect(r.rows[0]?.d).toBe('2026-03-15');
  });

  it('splits a UTC evening across IST midnight at exactly 18:30Z', async () => {
    const r = await db.query<{ before: string; at: string; after: string }>(
      `SELECT
         business_date('2026-03-14T18:29:59Z'::timestamptz)::text AS before,
         business_date('2026-03-14T18:30:00Z'::timestamptz)::text AS at,
         business_date('2026-03-14T18:30:01Z'::timestamptz)::text AS after`,
    );
    // 18:29:59Z is 23:59:59 IST — still the previous business day.
    expect(r.rows[0]?.before).toBe('2026-03-14');
    // 18:30:00Z is exactly midnight IST — already the next day.
    expect(r.rows[0]?.at).toBe('2026-03-15');
    expect(r.rows[0]?.after).toBe('2026-03-15');
  });

  it('keeps a midday UTC timestamp on the same IST day', async () => {
    // 05:00 UTC is 10:30 IST — same calendar day.
    const r = await db.query<{ d: string }>(
      "SELECT business_date('2026-03-14T05:00:00Z'::timestamptz)::text AS d",
    );
    expect(r.rows[0]?.d).toBe('2026-03-14');
  });

  it('is declared IMMUTABLE so it can back generated columns and indexes', async () => {
    const r = await db.query<{ provolatile: string }>(
      "SELECT provolatile FROM pg_proc WHERE proname = 'business_date'",
    );
    expect(r.rows[0]?.provolatile).toBe('i');
  });
});

describe('touch_updated_at — optimistic-concurrency trigger', () => {
  beforeAll(async () => {
    await runMigrations({ pool: db });
    await db.query(`
      CREATE TABLE trigger_scratch (
        id integer PRIMARY KEY,
        label text NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now(),
        version integer NOT NULL DEFAULT 1
      )
    `);
    await db.query(`
      CREATE TRIGGER trigger_scratch_touch BEFORE UPDATE ON trigger_scratch
      FOR EACH ROW WHEN (NEW.updated_at IS NOT DISTINCT FROM OLD.updated_at)
      EXECUTE FUNCTION touch_updated_at()
    `);
    await db.query(`
      CREATE TABLE trigger_scratch_noversion (
        id integer PRIMARY KEY,
        label text NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await db.query(`
      CREATE TRIGGER trigger_scratch_noversion_touch BEFORE UPDATE ON trigger_scratch_noversion
      FOR EACH ROW WHEN (NEW.updated_at IS NOT DISTINCT FROM OLD.updated_at)
      EXECUTE FUNCTION touch_updated_at()
    `);
  });

  afterAll(async () => {
    await db.query('DROP TABLE IF EXISTS trigger_scratch');
    await db.query('DROP TABLE IF EXISTS trigger_scratch_noversion');
  });

  it('bumps version and updated_at on a plain UPDATE', async () => {
    await db.query(
      "INSERT INTO trigger_scratch (id, label) VALUES (1, 'before')",
    );
    const before = await db.query<{ updated_at: string; version: number }>(
      'SELECT updated_at::text AS updated_at, version FROM trigger_scratch WHERE id = 1',
    );
    const t0 = before.rows[0] as { updated_at: string; version: number };
    expect(t0.version).toBe(1);

    // The trigger stamps now(); give the clock room to advance.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await db.query("UPDATE trigger_scratch SET label = 'after' WHERE id = 1");

    const after = await db.query<{ updated_at: string; version: number }>(
      'SELECT updated_at::text AS updated_at, version FROM trigger_scratch WHERE id = 1',
    );
    const row = after.rows[0] as { updated_at: string; version: number };
    expect(row.version).toBe(2);
    expect(new Date(row.updated_at).getTime()).toBeGreaterThan(
      new Date(t0.updated_at).getTime(),
    );
  });

  it('leaves version alone when the caller already set updated_at', async () => {
    // Caller-driven timestamp — a backfill or sync replay — keeps its
    // value and does not count as a business change.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await db.query(
      "UPDATE trigger_scratch SET label = 'replay', updated_at = '2026-01-01T00:00:00Z'::timestamptz WHERE id = 1",
    );
    const row = await db.query<{ updated_at: string; version: number }>(
      'SELECT updated_at::text AS updated_at, version FROM trigger_scratch WHERE id = 1',
    );
    expect(row.rows[0]?.updated_at).toBe('2026-01-01 00:00:00+00');
    expect(row.rows[0]?.version).toBe(2);
  });

  it('attaches safely to a table without a version column', async () => {
    await db.query("INSERT INTO trigger_scratch_noversion (id, label) VALUES (1, 'before')");
    await new Promise((resolve) => setTimeout(resolve, 20));
    await db.query(
      "UPDATE trigger_scratch_noversion SET label = 'after' WHERE id = 1",
    );
    const row = await db.query<{ updated_at: string }>(
      'SELECT updated_at::text AS updated_at FROM trigger_scratch_noversion WHERE id = 1',
    );
    expect(new Date(row.rows[0]?.updated_at ?? '').getTime()).toBeGreaterThan(0);
  });
});
