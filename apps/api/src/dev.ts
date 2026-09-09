import { loadConfig, loadDotEnv } from './config.js';
import { closePool, getPool } from './db/pool.js';
import { consoleLogger, runMigrations } from './db/migrate.js';
import { startServer } from './server.js';

/**
 * Dev entrypoint — the boot sequence the API runs, in order:
 * env → config → pool → migrate → serve. Config failures stop it before
 * anything listens.
 *
 *   cp .env.example .env   # then
 *   pnpm -F api dev
 */
async function main(): Promise<void> {
  loadDotEnv();
  const config = loadConfig();
  const pool = getPool({ connectionString: config.databaseUrl });
  const probe = await pool.query<{ server: string }>('SELECT version() AS server');
  console.log(`dev: connected — ${(probe.rows[0]?.server ?? '?').split(',')[0]}`);
  await runMigrations({ logger: consoleLogger });
  console.log('dev: migrations up to date.');
  await startServer(config);
}

main().catch((error: unknown) => {
  console.error('dev: FAILED —', error instanceof Error ? error.message : error);
  void closePool().finally(() => process.exit(1));
});
