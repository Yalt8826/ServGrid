import { Pool, type QueryResult, type QueryResultRow } from 'pg';

/**
 * The single pg.Pool for the API process (PLAN-BACKEND.md §2). Every
 * module gets connections through here so pool sizing, timeouts and the
 * graceful-shutdown path stay in one place.
 */
let pool: Pool | undefined;

export interface PoolConfig {
  connectionString: string;
  max?: number;
}

export function getPool(config?: PoolConfig): Pool {
  if (!pool) {
    const connectionString = config?.connectionString ?? process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error(
        'DATABASE_URL is not set — copy .env.example to .env or export it (compose defaults: postgres://servgrid:servgrid@localhost:5432/servgrid).',
      );
    }
    pool = new Pool({
      connectionString,
      max: config?.max ?? 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
  }
  return pool;
}

/** Graceful shutdown: stop accepting checkouts and close idle sockets. */
export async function closePool(): Promise<void> {
  if (pool) {
    const closing = pool;
    pool = undefined;
    await closing.end();
  }
}

/** Tagged-parameter query through the shared pool (no ORM — hand-written SQL). */
export function query<R extends QueryResultRow = QueryResultRow>(
  text: string,
  values?: readonly unknown[],
): Promise<QueryResult<R>> {
  return getPool().query<R>(text, values as unknown[]);
}
