import { AsyncLocalStorage } from 'node:async_hooks';
import type { PoolClient } from 'pg';

/**
 * The request-scoped transaction opened by the idempotency plugin
 * (PLAN-BACKEND.md §3.2: the key row's response and the business rows
 * must commit together).
 *
 * The plugin wraps each mutation route's handler in `runInRequestTx`
 * with the transaction's client; `withTransaction` and `query` join it
 * when a caller passes no explicit client. That makes the join
 * structural — a service cannot forget to thread the client through,
 * and the transaction it writes in is the one whose COMMIT also stores
 * the stored response.
 *
 * The store is entered by *wrapping the handler*, not by `enterWith`
 * inside a preHandler hook: Fastify resumes its lifecycle in the async
 * context captured before the hooks ran, so an `enterWith` in a
 * preHandler is invisible to the handler that follows.
 */

const storage = new AsyncLocalStorage<{ client: PoolClient }>();

/** Run `fn` — a route handler — inside the request transaction's async
 * context, so every query it initiates joins the plugin's transaction. */
export function runInRequestTx<T>(client: PoolClient, fn: () => Promise<T>): Promise<T> {
  return storage.run({ client }, fn);
}

/** The open request transaction's client, or undefined outside one. */
export function currentRequestTx(): PoolClient | undefined {
  return storage.getStore()?.client;
}
