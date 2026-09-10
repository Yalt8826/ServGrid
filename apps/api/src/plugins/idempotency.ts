import { createHash } from 'node:crypto';
import fp from 'fastify-plugin';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest, RouteOptions } from 'fastify';
import type { PoolClient } from 'pg';
import { canonicalJson } from '@servgrid/shared';
import { AppError } from './errors.js';
import { runInRequestTx } from '../db/ambient-tx.js';
import { getPool } from '../db/pool.js';

/**
 * Idempotency plugin (PLAN-BACKEND.md §3.2, PLAN-DATA-MODEL.md §3.9).
 * Every authenticated `POST`/`PATCH`/`DELETE` that carries an
 * `Idempotency-Key` is wrapped: a replayed request gets the original
 * response back verbatim instead of executing twice. This is the
 * server half of the offline outbox — the handset generates the key
 * once, at enqueue, and keeps it across every retry.
 *
 * The five paths, each matched to one failure:
 *
 *  1. Claim — `INSERT … ON CONFLICT (employee_id, key) DO NOTHING`,
 *     committed on its own, with `locked_at = now()`. The claim must be
 *     durable *before* the handler runs: it is what lets a concurrent
 *     duplicate get a fast 409 instead of blocking on the winner's
 *     uncommitted work.
 *  2. Claim won → the handler runs inside a request transaction
 *     (db/ambient-tx.ts — services join it through `withTransaction`
 *     and `query`), then the same transaction stores `response_status`
 *     + `response_body` and clears `locked_at`. Business rows and the
 *     stored response therefore commit together: a crash loses both, a
 *     commit keeps both — never a response for work that rolled back.
 *  3. Claim lost, hash matches, response stored → replay the stored
 *     response verbatim. The reconnect case.
 *  4. Claim lost, `request_hash` differs → `422 IDEMPOTENCY_KEY_REUSED`.
 *     Same key with a different body is a client bug, and the one case
 *     where a silent replay would be actively wrong.
 *  5. Claim lost, response absent, `locked_at` recent → `409
 *     IDEMPOTENCY_IN_FLIGHT` with `Retry-After: 2`. A `locked_at` older
 *     than the in-flight window means the claiming request died between
 *     claim and commit, so the key is reclaimed and re-run — a crash
 *     must not poison the key forever.
 *
 * Failure handling keeps that promise: when the handler throws (or
 * answers ≥ 400) the request transaction rolls back and the claim row is
 * deleted, so the key is free and a retry genuinely re-executes.
 *
 * `request_hash` is sha256 of `canonicalJson(body)` from
 * packages/shared — the client and the server must agree byte for byte.
 * The multipart exception is T1.10: attachments hash
 * `fileChecksum + ownerType + ownerId + kind` instead, because a
 * multipart stream's boundary changes between retries of the same file.
 *
 * [impl] Two decisions worth flagging in review:
 *  - The guard keys on the presence of the `Idempotency-Key` header plus
 *    an authenticated actor, not on `context.source === 'mobile'`: the
 *    app currently sends `X-Source` while request-context reads
 *    `x-client-source`, so the source header cannot yet be trusted to
 *    identify a handset. A keyless mutation passes through ungated, so
 *    web/system callers and scripts keep working.
 *  - `response_body` is stored as a jsonb *string scalar* holding the
 *    exact serialized payload (`to_json($n::text)`). jsonb normalises
 *    object key order, so storing the parsed body would make a replay
 *    differ byte-for-byte from the original; the scalar round-trips the
 *    original bytes exactly (`response_body #>> '{}'`).
 */

export const MUTATION_METHODS = new Set(['POST', 'PATCH', 'DELETE']);

/** A claim older than this is dead, not in flight (§3.2 "recent"). The
 * window only has to exceed the slowest legitimate handler comfortably;
 * past it, a retrying client is better served by a fresh attempt than by
 * an unbounded 409. */
export const IN_FLIGHT_WINDOW_SECONDS = 30;

/** §3.2: the 409 tells the client when to come back. */
export const IN_FLIGHT_RETRY_AFTER_SECONDS = 2;

export const IDEMPOTENCY_IN_FLIGHT_MESSAGE =
  'This update is already being saved. It will go through in a moment — nothing was lost.';

export const IDEMPOTENCY_KEY_REUSED_MESSAGE =
  'This queued update does not match what was sent with it before. Re-open it and save again.';

const MAX_KEY_LENGTH = 200;

const KEY_REJECTED_MESSAGE =
  'The retry reference on this queued update is malformed. Re-sync and send it again.';

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function errorEnvelope(code: 'IDEMPOTENCY_IN_FLIGHT', message: string, requestId: string): string {
  return JSON.stringify({ error: { code, message, requestId } });
}

/**
 * The claim: insert the guard row, or — if the key already exists but is
 * an expired, response-less husk — take it over in the same statement.
 * A live row (not expired, or still holding a response) leaves the
 * statement empty-handed and the caller resolves paths 3–5. The expiry
 * reclamation must not swallow a row that still carries a response: an
 * old key with a stored answer replays (path 3) even past `expires_at`,
 * until the nightly prune removes it.
 */
const CLAIM_SQL = `
  INSERT INTO idempotency_keys AS k (employee_id, key, endpoint, request_hash, locked_at)
  VALUES ($1, $2, $3, $4, now())
  ON CONFLICT (employee_id, key) DO UPDATE
    SET endpoint = EXCLUDED.endpoint,
        request_hash = EXCLUDED.request_hash,
        locked_at = now(),
        response_status = NULL,
        response_body = NULL,
        expires_at = now() + interval '30 days'
    WHERE k.expires_at < now() AND k.response_status IS NULL
  RETURNING locked_at::text AS claim_token
`;

/** Path 3–5 input: the committed row a lost claim collided with. */
const FETCH_SQL = `
  SELECT request_hash,
         response_status,
         response_body #>> '{}' AS response_text,
         locked_at,
         locked_at::text AS lock_token
  FROM idempotency_keys
  WHERE employee_id = $1 AND key = $2
`;

/** Take over a claim whose owner died: only succeeds if the row still
 * carries exactly the `locked_at` the loser observed. */
const RECLAIM_SQL = `
  UPDATE idempotency_keys
  SET locked_at = now()
  WHERE employee_id = $1 AND key = $2
    AND response_status IS NULL AND locked_at = $3::timestamptz
  RETURNING locked_at::text AS claim_token
`;

/** Path 2's final act, inside the request transaction: the response and
 * the business rows commit together. The `locked_at` predicate is the
 * ownership check — a request that overran the in-flight window and had
 * its claim reclaimed must not stamp its response onto someone else's
 * run (it rolls back instead, see the onSend settle path). */
const STORE_RESPONSE_SQL = `
  UPDATE idempotency_keys
  SET response_status = $3, response_body = to_json($4::text), locked_at = NULL
  WHERE employee_id = $1 AND key = $2
    AND response_status IS NULL AND locked_at = $5::timestamptz
`;

/** Free the key after a failure, so the retry re-executes. Ownership
 * predicate as in STORE_RESPONSE_SQL: never delete a reclaim's claim. */
const RELEASE_CLAIM_SQL = `
  DELETE FROM idempotency_keys
  WHERE employee_id = $1 AND key = $2
    AND response_status IS NULL AND locked_at = $3::timestamptz
`;

/** The nightly prune (PLAN-DATA-MODEL.md §3.9: "rows are … pruned
 * wholesale past expires_at"). Exported for the scheduled jobs runner;
 * the `expires_at` index from migration 004 makes it a range scan. */
export async function pruneExpiredKeys(): Promise<number> {
  const result = await getPool().query<{ n: number }>(
    `WITH gone AS (
       DELETE FROM idempotency_keys WHERE expires_at < now() RETURNING 1
     )
     SELECT count(*)::int AS n FROM gone`,
  );
  return result.rows[0]?.n ?? 0;
}

interface WorkState {
  client: PoolClient;
  employeeId: string;
  key: string;
  claimToken: string;
  /** 'work' until the onSend/onRequestAbort settle path commits or
   * rolls back; guards the single-release invariant. */
  phase: 'work' | 'settled';
}

/** The route handler shape this plugin wraps — no instance `this`, a
 * promise result, nothing Fastify-specific beyond the pair. */
type PlainHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

declare module 'fastify' {
  interface FastifyRequest {
    /** Set while a claimed request's transaction is open. */
    idempotency: WorkState | null;
  }
  interface FastifyContextConfig {
    /**
     * Per-route hash input for `request_hash` (§3.2). The default hashes
     * `canonicalJson(body)`; a multipart upload has no JSON body and an
     * unstable boundary string, so `POST /v1/attachments` provides
     * `fileChecksum + ownerType + ownerId + kind` instead — the route's
     * preHandlers have run by the time this is read, so the payload is
     * parsed and its checksum field known before the claim is made.
     */
    idempotencyRequestHashPayload?: (request: FastifyRequest) => string;
  }
}

/**
 * Appended after each mutation route's own preHandler chain (so
 * `requireAuth` has already run and `request.auth` is set — an
 * instance-level addHook('preHandler') would run before the route's
 * hooks, see fastify/lib/route.js: instance hooks concat ahead of route
 * options).
 */
async function idempotencyPreHandler(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (request.auth === null) return; // pre-auth surface — login/refresh are rate-limited, not keyed

  const header = request.headers['idempotency-key'];
  const key = typeof header === 'string' ? header.trim() : '';
  if (!key) return; // no key, no guard — web/system callers and scripts pass through
  if (key.length > MAX_KEY_LENGTH) {
    throw new AppError('VALIDATION_FAILED', KEY_REJECTED_MESSAGE);
  }

  const employeeId = request.auth.sub;
  const endpoint = `${request.method} ${request.routeOptions.url ?? request.url}`;
  // A missing body (DELETE) hashes canonicalJson(null) — stable across retries.
  // Multipart uploads supply their own stable input (see FastifyContextConfig).
  const hashPayload = request.routeOptions.config.idempotencyRequestHashPayload;
  const requestHash = sha256(
    hashPayload ? hashPayload(request) : canonicalJson(request.body ?? null),
  );

  const claim = await getPool().query<{ claim_token: string }>(CLAIM_SQL, [
    employeeId,
    key,
    endpoint,
    requestHash,
  ]);
  if (claim.rows.length === 1) {
    await beginWork(request, employeeId, key, claim.rows[0]!.claim_token);
    return;
  }

  const existing = (
    await getPool().query<{
      request_hash: string;
      response_status: number | null;
      response_text: string | null;
      locked_at: Date | null;
      lock_token: string | null;
    }>(FETCH_SQL, [employeeId, key])
  ).rows[0];
  if (!existing) {
    // The row vanished between the claim conflict and the fetch — a
    // losing sibling just released it after a failure. Claim once more;
    // if that is gone too, someone is actively working the key.
    const retry = await getPool().query<{ claim_token: string }>(CLAIM_SQL, [
      employeeId,
      key,
      endpoint,
      requestHash,
    ]);
    if (retry.rows.length === 1) {
      await beginWork(request, employeeId, key, retry.rows[0]!.claim_token);
      return;
    }
    reply.header('retry-after', String(IN_FLIGHT_RETRY_AFTER_SECONDS));
    throw new AppError('IDEMPOTENCY_IN_FLIGHT', IDEMPOTENCY_IN_FLIGHT_MESSAGE);
  }

  if (existing.request_hash !== requestHash) {
    // Same key, different body: a client bug, and the one case where
    // replaying would be actively wrong (§3.2 path 4).
    throw new AppError('IDEMPOTENCY_KEY_REUSED', IDEMPOTENCY_KEY_REUSED_MESSAGE);
  }

  if (existing.response_status !== null) {
    // Reconnect case: byte-identical replay of the original response
    // (§3.2 path 3). The handler does not run.
    request.log.info({ endpoint, key }, 'idempotency: replaying stored response');
    reply
      .status(existing.response_status)
      .type('application/json; charset=utf-8')
      .send(existing.response_text);
    return;
  }

  const lockedAt = existing.locked_at;
  if (lockedAt !== null && Date.now() - lockedAt.getTime() < IN_FLIGHT_WINDOW_SECONDS * 1000) {
    // Still in flight somewhere (§3.2 path 5).
    reply.header('retry-after', String(IN_FLIGHT_RETRY_AFTER_SECONDS));
    throw new AppError('IDEMPOTENCY_IN_FLIGHT', IDEMPOTENCY_IN_FLIGHT_MESSAGE);
  }

  // Stale claim: the previous attempt died between claim and commit.
  // Reclaim it and run — a crash must not poison the key.
  const reclaim = await getPool().query<{ claim_token: string }>(RECLAIM_SQL, [
    employeeId,
    key,
    existing.lock_token,
  ]);
  if (reclaim.rows.length === 1) {
    request.log.info({ endpoint, key }, 'idempotency: reclaimed stale claim');
    await beginWork(request, employeeId, key, reclaim.rows[0]!.claim_token);
    return;
  }
  // Lost the reclaim race — the other request holds the key now.
  reply.header('retry-after', String(IN_FLIGHT_RETRY_AFTER_SECONDS));
  throw new AppError('IDEMPOTENCY_IN_FLIGHT', IDEMPOTENCY_IN_FLIGHT_MESSAGE);
}

/** Open the request transaction the handler and every ambient query
 * will run in. The handler itself is wrapped into that context by the
 * onRoute handler wrapper (`runInRequestTx`) — a preHandler cannot do
 * it, because Fastify resumes the lifecycle in the async context
 * captured before the hooks ran. On a BEGIN failure the claim is
 * released — a claim with nobody working it is exactly the orphan this
 * plugin exists to prevent. */
async function beginWork(
  request: FastifyRequest,
  employeeId: string,
  key: string,
  claimToken: string,
): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
  } catch (error) {
    client.release();
    await releaseClaim(request, employeeId, key, claimToken);
    throw error;
  }
  request.idempotency = { client, employeeId, key, claimToken, phase: 'work' };
}

async function releaseClaim(
  request: FastifyRequest,
  employeeId: string,
  key: string,
  claimToken: string,
): Promise<void> {
  try {
    await getPool().query(RELEASE_CLAIM_SQL, [employeeId, key, claimToken]);
  } catch (error) {
    // A claim that survives a failed release ages into the stale-reclaim
    // path — recoverable by design, so only log.
    request.log.warn({ err: error, key }, 'idempotency: claim release failed');
  }
}

/**
 * Settle the work transaction. Success commits the business rows and the
 * stored response together; anything else rolls both back and frees the
 * key. Runs from onSend (every rendered reply) and onRequestAbort (a
 * vanished client — the handler's writes must not outlive it).
 *
 * The stored body is the exact serialized payload, so a replay (§3.2
 * path 3) is byte-identical to the original response.
 */
async function settle(
  request: FastifyRequest,
  reply: FastifyReply,
  payload: unknown,
): Promise<string | undefined> {
  const state = request.idempotency;
  if (!state || state.phase === 'settled') return undefined;
  state.phase = 'settled';
  const { client, employeeId, key, claimToken } = state;
  try {
    if (reply.statusCode < 400) {
      const stored = await client.query(STORE_RESPONSE_SQL, [
        employeeId,
        key,
        reply.statusCode,
        payloadText(payload),
        claimToken,
      ]);
      if (stored.rowCount === 1) {
        await client.query('COMMIT');
        return undefined;
      }
      // The claim was reclaimed under a request that overran the
      // in-flight window; another attempt owns the key. Roll our work
      // back — it must not double-apply — and send the caller to the
      // back of that queue.
      await client.query('ROLLBACK');
      request.log.warn(
        { endpoint: `${request.method} ${request.url}`, key },
        'idempotency: claim lost before commit',
      );
      reply.status(409);
      reply.header('retry-after', String(IN_FLIGHT_RETRY_AFTER_SECONDS));
      reply.type('application/json; charset=utf-8');
      return errorEnvelope('IDEMPOTENCY_IN_FLIGHT', IDEMPOTENCY_IN_FLIGHT_MESSAGE, request.id);
    }
    // Failure: roll the business rows back and free the key so the
    // client's retry re-executes (§3.2 — no orphan key row).
    await client.query('ROLLBACK');
    await releaseClaim(request, employeeId, key, claimToken);
    return undefined;
  } finally {
    client.release();
  }
}

/** The serialized response body as sent. JSON routes hand onSend a
 * string; anything else is reduced to text deterministically. */
function payloadText(payload: unknown): string {
  if (typeof payload === 'string') return payload;
  if (Buffer.isBuffer(payload)) return payload.toString('utf8');
  return JSON.stringify(payload ?? null);
}

export const idempotencyPlugin: FastifyPluginAsync = fp(
  async (app) => {
    app.decorateRequest('idempotency', null);

    app.addHook('onRoute', (routeOptions: RouteOptions) => {
      const methods = Array.isArray(routeOptions.method) ? routeOptions.method : [routeOptions.method];
      if (!methods.some((method) => MUTATION_METHODS.has(method))) return;
      const existing = routeOptions.preHandler
        ? Array.isArray(routeOptions.preHandler)
          ? routeOptions.preHandler
          : [routeOptions.preHandler]
        : [];
      routeOptions.preHandler = [...existing, idempotencyPreHandler];

      // The claimed handler runs inside the claim's transaction context,
      // so its writes (withTransaction, query) land in the same COMMIT
      // as the stored response.
      const original = routeOptions.handler as PlainHandler;
      routeOptions.handler = async (request, reply) => {
        const state = request.idempotency;
        if (!state) return original(request, reply);
        return runInRequestTx(state.client, () => original(request, reply));
      };
    });

    app.addHook('onSend', async (request, reply, payload) => {
      if (!request.idempotency) return payload;
      return settle(request, reply, payload);
    });

    app.addHook('onRequestAbort', async (request) => {
      const state = request.idempotency;
      if (!state || state.phase === 'settled') return;
      state.phase = 'settled';
      try {
        await state.client.query('ROLLBACK');
        await releaseClaim(request, state.employeeId, state.key, state.claimToken);
      } catch (error) {
        request.log.warn({ err: error, key: state.key }, 'idempotency: abort rollback failed');
      } finally {
        state.client.release();
      }
    });
  },
  { name: 'idempotency', fastify: '5.x', dependencies: ['request-context', 'auth', 'errors'] },
);
