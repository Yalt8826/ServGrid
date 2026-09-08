import { closePool, getPool } from './pool.js';
import { consoleLogger, runMigrations } from './migrate.js';

/**
 * CI migration rehearsal (PLAN-BACKEND.md §13, gate 5): run the set
 * up → down → up on a clean database and fail on any error.
 *
 * Down-migrations are never run in production (PLAN-EXECUTION.md Part
 * I), but they are how a developer resets locally, and an untested one
 * fails at the worst moment. The final up is smoke-checked: the helpers
 * must exist and answer a query, so a rehearsal that leaves an unusable
 * schema still fails the gate.
 *
 * Point DATABASE_URL at a clean, disposable Postgres 16 — never at a
 * database anything cares about: the first step of the rehearsal rolls
 * the whole set back down.
 */
export async function rehearseMigrations(): Promise<void> {
  const started = Date.now();
  const pool = getPool();
  await runMigrations({ direction: 'up', logger: consoleLogger });
  await runMigrations({ direction: 'down', logger: consoleLogger });
  await runMigrations({ direction: 'up', logger: consoleLogger });

  const applied = await pool.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM pgmigrations',
  );
  const count = Number(applied.rows[0]?.count ?? '0');
  if (count < 1) {
    throw new Error(`rehearsal ended with ${count} applied migrations — expected the full set`);
  }
  // The final schema must be usable, not merely recorded as applied.
  const probe = await pool.query<{ business_date: string }>(
    "SELECT business_date('2026-03-14T20:30:00Z'::timestamptz)::text AS business_date",
  );
  if (probe.rows[0]?.business_date !== '2026-03-15') {
    throw new Error(
      `final-up smoke check failed: business_date returned ${probe.rows[0]?.business_date}`,
    );
  }
  console.log(
    `rehearse: up → down → up OK — ${count} migration(s) applied, schema usable (${Date.now() - started}ms).`,
  );
}

const invokedDirectly = process.argv[1]?.replace(/\\/g, '/').endsWith('rehearse.ts');
if (invokedDirectly) {
  rehearseMigrations()
    .then(() => closePool())
    .then(() => process.exit(0))
    .catch((error: unknown) => {
      console.error('rehearse: FAILED —', error instanceof Error ? error.message : error);
      void closePool().finally(() => process.exit(1));
    });
}
