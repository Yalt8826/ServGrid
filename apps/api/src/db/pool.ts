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
export async function query<R extends QueryResultRow = QueryResultRow>(
  text: string,
  values?: readonly unknown[],
): Promise<QueryResult<R>> {
  const startedAt = performance.now();
  try {
    return await getPool().query<R>(text, values as unknown[]);
  } finally {
    const durationMs = performance.now() - startedAt;
    if (slowQueryObserver && durationMs > SLOW_QUERY_THRESHOLD_MS) {
      slowQueryObserver({ text, durationMs: Math.round(durationMs) });
    }
  }
}

/** PLAN-BACKEND.md §13: anything slower than this is logged. */
export const SLOW_QUERY_THRESHOLD_MS = 200;

export type SlowQueryObserver = (info: { text: string; durationMs: number }) => void;

let slowQueryObserver: SlowQueryObserver | null = null;

/** The server installs its logger here; `null` detaches (tests). */
export function observeSlowQueries(observer: SlowQueryObserver | null): void {
  slowQueryObserver = observer;
}
