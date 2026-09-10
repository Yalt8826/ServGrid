import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { currentRequestTx } from './ambient-tx.js';
import { getPool } from './pool.js';

/**
 * Transaction and advisory-lock helpers (PLAN-BACKEND.md §2 db/tx.ts).
 *
 * Both accept an optional outer `client`. When one is passed we are
 * already inside a caller's transaction: nested `withTransaction` uses a
 * SAVEPOINT (a failure rolls back to the savepoint, not the caller's
 * work) and `withAdvisoryLock` switches to the transaction-scoped
 * `pg_advisory_xact_lock`, which releases with the surrounding
 * COMMIT/ROLLBACK instead of leaking a session lock onto the shared
 * client.
 *
 * With no explicit client, `withTransaction` joins the request
 * transaction the idempotency plugin opened (db/ambient-tx.ts) when one
 * is open — the caller's work lands inside the same COMMIT as the stored
 * response, without every service having to thread a client through.
 */
export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>,
  client?: PoolClient,
): Promise<T> {
  const owner = client ?? currentRequestTx();
  if (owner) {
    await owner.query('SAVEPOINT nested_tx');
    try {
      const result = await fn(owner);
      await owner.query('RELEASE SAVEPOINT nested_tx');
      return result;
    } catch (error) {
      await owner.query('ROLLBACK TO SAVEPOINT nested_tx');
      await owner.query('RELEASE SAVEPOINT nested_tx');
      throw error;
    }
  }

  const acquired = await getPool().connect();
  try {
    await acquired.query('BEGIN');
    try {
      const result = await fn(acquired);
      await acquired.query('COMMIT');
      return result;
    } catch (error) {
      await acquired.query('ROLLBACK');
      throw error;
    }
  } finally {
    acquired.release();
  }
}

/** Advisory keys are a single bigint or two int4 columns; a string key
 * hashes (md5) into the two-int4 form deterministically. */
function advisoryKey(key: string | number | readonly number[]): number | [number, number] {
  if (typeof key === 'number') {
    return key;
  }
  if (typeof key === 'string') {
    const digest = createHash('md5').update(key, 'utf8').digest('hex');
    const hi = Number.parseInt(digest.slice(0, 8), 16) | 0; // |0 → signed int32
    const lo = Number.parseInt(digest.slice(8, 16), 16) | 0;
    return [hi, lo];
  }
  return key.length === 1 ? (key[0] as number) : [key[0] as number, key[1] as number];
}

async function acquireLock(client: PoolClient, pgKey: number | [number, number]): Promise<void> {
  if (Array.isArray(pgKey)) {
    await client.query('SELECT pg_advisory_lock($1, $2)', pgKey);
  } else {
    await client.query('SELECT pg_advisory_lock($1)', [pgKey]);
  }
}

async function releaseLock(client: PoolClient, pgKey: number | [number, number]): Promise<void> {
  if (Array.isArray(pgKey)) {
    await client.query('SELECT pg_advisory_unlock($1, $2)', pgKey);
  } else {
    await client.query('SELECT pg_advisory_unlock($1)', [pgKey]);
  }
}

export async function withAdvisoryLock<T>(
  key: string | number | readonly number[],
  fn: (client: PoolClient) => Promise<T>,
  client?: PoolClient,
): Promise<T> {
  const pgKey = advisoryKey(key);

  if (client) {
    // Transaction-scoped: released at the surrounding COMMIT/ROLLBACK.
    if (Array.isArray(pgKey)) {
      await client.query('SELECT pg_advisory_xact_lock($1, $2)', pgKey);
    } else {
      await client.query('SELECT pg_advisory_xact_lock($1)', [pgKey]);
    }
    return fn(client);
  }

  const acquired = await getPool().connect();
  try {
    await acquireLock(acquired, pgKey);
    try {
      return await fn(acquired);
    } finally {
      await releaseLock(acquired, pgKey);
    }
  } finally {
    acquired.release();
  }
}
