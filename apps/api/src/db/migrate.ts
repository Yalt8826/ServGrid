import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runner } from 'node-pg-migrate';
import type { Pool } from 'pg';
import { getPool } from './pool.js';

/**
 * node-pg-migrate runner over plain SQL migrations (PLAN-BACKEND.md §2,
 * PLAN-DATA-MODEL.md §1 tooling). Runs on boot in dev (`pnpm -F api dev`)
 * and as a separate release step in prod (`pnpm -F api migrate`); the CI
 * gate rehearses up → down → up on a clean database via rehearse.ts.
 * No ORM migrations — the schema carries CHECK constraints, generated
 * columns and views an ORM DSL cannot express honestly.
 */
export const MIGRATIONS_TABLE = 'pgmigrations';

const DEFAULT_MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

// Derive every node-pg-migrate type from the runner's own signature so a
// major bump surfaces here as a type error instead of a runtime surprise.
type RunnerOptions = Parameters<typeof runner>[0];
export type MigrationDirection = RunnerOptions['direction'];
export type MigrationLogger = NonNullable<RunnerOptions['logger']>;

export const consoleLogger: MigrationLogger = {
  debug: () => undefined,
  info: (message: string) => console.log(`migrate: ${message}`),
  warn: (message: string) => console.warn(`migrate: ${message}`),
  error: (message: string) => console.error(`migrate: ${message}`),
};

const silentLogger: MigrationLogger = {
  debug: () => undefined,
  info: (_message: string) => undefined,
  warn: (_message: string) => undefined,
  error: (_message: string) => undefined,
};

export interface RunMigrationsOptions {
  direction?: MigrationDirection;
  logger?: MigrationLogger;
  migrationsDir?: string;
  /** Defaults to the process-wide pool; callers with their own target
   * (the CI rehearsal, integration tests) pass an explicit Pool. */
  pool?: Pool;
}

export async function runMigrations(options: RunMigrationsOptions = {}): Promise<void> {
  const {
    direction = 'up',
    logger = silentLogger,
    migrationsDir = DEFAULT_MIGRATIONS_DIR,
    pool = getPool(),
  } = options;
  if (!existsSync(migrationsDir)) {
    throw new Error(`migrations directory not found: ${migrationsDir}`);
  }
  // node-pg-migrate takes a connected client and leaves it open; checking
  // it out from the target pool keeps one connection budget and lets the
  // rehearsal and tests aim the runner at their own database.
  const client = await pool.connect();
  try {
    const runnerOptions: RunnerOptions = {
      dbClient: client,
      dir: migrationsDir,
      direction,
      migrationsTable: MIGRATIONS_TABLE,
      count: Infinity,
      logger,
      // Plain-SQL migrations, one file per direction, paired by the
      // loader into a single unit: 001_x.up.sql + 001_x.down.sql.
      // The default strategy treats each .sql file as its own
      // migration with no down side, which would fail the
      // up → down → up gate.
      migrationLoaderStrategies: [{ extensions: ['.sql'], loader: 'sql' }],
      // PLAN-DATA-MODEL.md §1: "numbers record the order migrations were
      // written, phases record when they run". 015 ships in Phase 2B,
      // before 012 and 014; 016 shipped in Phase 1, before 011 and 013.
      // node-pg-migrate's default order check refuses every one of those
      // ("Not run migration 011_… is preceding already run migration
      // 016_…") — it stopped the dev database at 010 + 016 the day Phase 2
      // merged. Each migration depends only on lower-numbered ones that
      // already shipped, which is the property the check was standing in for.
      checkOrder: false,
    };
    await runner(runnerOptions);
  } finally {
    client.release();
  }
}
