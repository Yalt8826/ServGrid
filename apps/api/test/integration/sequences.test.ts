import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { runMigrations } from '../../src/db/migrate.js';

/**
 * Migration 004 integration suite (PHASE-0-FOUNDATION.md T0.4):
 * `sequences` + `next_in_sequence()` (PLAN-DATA-MODEL.md §3.9).
 *
 * Runs against the real Postgres 16 from `docker compose up db` — no
 * mocked database anywhere (PLAN-BACKEND.md §14). The suite builds its
 * own scratch database from the server's admin connection and drops it
 * afterwards; a failed run leaves nothing behind.
 *
 * The allocation primitive is one atomic
 * INSERT ... ON CONFLICT DO UPDATE ... RETURNING statement. Proving it
 * safe takes real concurrency: the 50-allocation test runs as 50
 * parallel pool clients, so the upserts race on the server exactly the
 * way two handsets allocating a job number would. A rewrite as
 * SELECT ... FOR UPDATE plus UPDATE shows up here as duplicates.
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

const SCRATCH_DB = 'servgrid_sequences_test';

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

describe('next_in_sequence — concurrent allocation (PLAN-DATA-MODEL.md §3.9)', () => {
  it('gives 50 parallel clients 50 distinct values, 1..50 with no gaps between successes', async () => {
    // A dedicated pool wide enough that every call gets its own client:
    // one shared client would serialise the calls and prove nothing.
    const url = new URL(databaseUrl());
    url.pathname = `/${SCRATCH_DB}`;
    const burst = new Pool({ connectionString: url.toString(), max: 50 });
    try {
      const results = await Promise.all(
        Array.from({ length: 50 }, () =>
          burst.query<{ current_value: string }>(
            'SELECT next_in_sequence($1) AS current_value',
            ['job:2627'],
          ),
        ),
      );
      const values = results.map((r) => Number(r.rows[0]!.current_value));

      // The Done-when: zero duplicates across 50 concurrent allocations.
      expect(new Set(values).size).toBe(50);
      // The scope was empty, so the values must be exactly 1..50 — also
      // proves no allocation silently rolled back and retried.
      expect(Math.min(...values)).toBe(1);
      expect(Math.max(...values)).toBe(50);

      const row = await db.query<{ current_value: string }>(
        'SELECT current_value FROM sequences WHERE scope = $1',
        ['job:2627'],
      );
      expect(Number(row.rows[0]?.current_value)).toBe(50);
    } finally {
      await burst.end();
    }
  });

  it('keeps scopes independent — job:2628 starts at 1 while job:2627 stays at 50', async () => {
    // The per-fiscal-year reset lives in the scope key: the first
    // allocation of FY 2027–28 must not continue FY 2026–27's counter.
    const rollover = await db.query<{ current_value: string }>(
      'SELECT next_in_sequence($1) AS current_value',
      ['job:2628'],
    );
    expect(Number(rollover.rows[0]?.current_value)).toBe(1);

    const prior = await db.query<{ current_value: string }>(
      'SELECT current_value FROM sequences WHERE scope = $1',
      ['job:2627'],
    );
    expect(Number(prior.rows[0]?.current_value)).toBe(50);
  });
});

describe('next_in_sequence — implicit scope creation (§9 open item 5, rollover path)', () => {
  it('creates a scope that does not exist and returns 1 on the first call', async () => {
    // No INSERT anywhere for 'payment:2627' — the function itself must
    // create the row. This is what happens at every fiscal-year
    // rollover, so it may not depend on seed data or a manual step.
    const first = await db.query<{ current_value: string }>(
      'SELECT next_in_sequence($1) AS current_value',
      ['payment:2627'],
    );
    expect(Number(first.rows[0]?.current_value)).toBe(1);
  });

  it('increments from there on subsequent calls', async () => {
    const second = await db.query<{ current_value: string }>(
      'SELECT next_in_sequence($1) AS current_value',
      ['payment:2627'],
    );
    const third = await db.query<{ current_value: string }>(
      'SELECT next_in_sequence($1) AS current_value',
      ['payment:2627'],
    );
    expect(Number(second.rows[0]?.current_value)).toBe(2);
    expect(Number(third.rows[0]?.current_value)).toBe(3);
  });
});
