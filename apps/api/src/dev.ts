import { closePool, getPool } from './db/pool.js';
import { consoleLogger, runMigrations } from './db/migrate.js';

/**
 * Dev entrypoint. Until T0.6 lands the Fastify server, this exercises
 * the exact boot sequence the API will run — env → pool → migrate →
 * serve — and exits 0 when the stack is sound:
 *
 *   cp .env.example .env   # then
 *   pnpm -F api dev
 */
async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    throw new Error(
      'DATABASE_URL is not set — copy .env.example to .env or export it (compose defaults: postgres://servgrid:servgrid@localhost:5432/servgrid).',
    );
  }
  const pool = getPool();
  const probe = await pool.query<{ server: string }>('SELECT version() AS server');
  console.log(`dev: connected — ${(probe.rows[0]?.server ?? '?').split(',')[0]}`);
  await runMigrations({ logger: consoleLogger });
  console.log('dev: migrations up to date. (API server arrives with T0.6.)');
}

main()
  .then(() => closePool())
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error('dev: FAILED —', error instanceof Error ? error.message : error);
    void closePool().finally(() => process.exit(1));
  });
