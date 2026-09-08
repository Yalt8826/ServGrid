import { closePool } from './pool.js';
import { consoleLogger, runMigrations } from './migrate.js';

/**
 * Standalone migration runner — the production release step
 * (PLAN-DATA-MODEL.md §1 tooling). Usage:
 *
 *   pnpm -F api migrate          # apply all pending
 *   pnpm -F api migrate -- --down # revert the last applied migration
 *
 * In dev, `pnpm -F api dev` migrates on boot instead; in production this
 * runs as its own release step before the new API version starts.
 */
const direction = process.argv.includes('--down') ? 'down' : 'up';

runMigrations({ direction, logger: consoleLogger })
  .then(() => closePool())
  .then(() => {
    console.log(`migrate: ${direction} complete.`);
    process.exit(0);
  })
  .catch((error: unknown) => {
    console.error('migrate: FAILED —', error instanceof Error ? error.message : error);
    void closePool().finally(() => process.exit(1));
  });
