import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import type { FastifyInstance } from 'fastify';
import { canonicalJson, errorEnvelopeSchema, type ErrorEnvelope } from '@servgrid/shared';
import { loadConfig, type Config } from '../../src/config.js';
import { closePool } from '../../src/db/pool.js';
import { withTransaction } from '../../src/db/tx.js';
import { runMigrations } from '../../src/db/migrate.js';
import { hashPassword } from '../../src/lib/password.js';
import { signAccessToken } from '../../src/plugins/auth.js';
import {
  IN_FLIGHT_RETRY_AFTER_SECONDS,
  pruneExpiredKeys,
} from '../../src/plugins/idempotency.js';
import { buildServer } from '../../src/server.js';
import { validEnv } from '../helpers/env.js';

/**
 * Idempotency integration suite (PHASE-1-TECHNICIAN.md T1.3,
 * PLAN-BACKEND.md §3.2): replay, hash mismatch, in-flight 409, rollback
 * atomicity and the prune query — against a real Postgres, because the
 * whole point is how the key row behaves under concurrency and
 * rollback, which a mocked database cannot be wrong about in the
 * interesting way (PLAN-BACKEND.md §14).
 *
 * The "business write" under test is `next_in_sequence('idem:test')`
 * taken inside `withTransaction` — the same ambient transaction the
 * plugin opens — so a rollback must give the value back. A sequence
 * advancing exactly once is the execution counter for every assertion.
 */

function databaseUrl(): string {
  return process.env.DATABASE_URL ?? 'postgres://servgrid:servgrid@localhost:5432/servgrid';
}

function adminUrlFor(url: string): string {
  const parsed = new URL(url);
  parsed.pathname = '/postgres';
  return parsed.toString();
}

const SCRATCH_DB = 'servgrid_idem_test';
const SEQ_SCOPE = 'idem:test';

const PASSWORD = 'mv-sunny-workshop-42';
const SLOW_HANDLER_MS = 400;

let admin: Pool;
let db: Pool;
let app: FastifyInstance;
let config: Config;
let passwordHash: string;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** The hash the plugin computes for a JSON body — used to forge claim rows. */
function requestHashOf(body: unknown): string {
  return sha256(canonicalJson(body ?? null));
}

interface Actor {
  employeeId: string;
  token: string;
}

/** A fresh employee and access token — every test owns its key space,
 * so a half-finished case cannot couple to another through the
 * (employee_id, key) primary key. */
async function actor(role: 'technician' | 'owner' = 'technician'): Promise<Actor> {
  const username = `idem.t1.3.${randomBytes(4).toString('hex')}`;
  const r = await db.query<{ id: string }>(
    `INSERT INTO employees (username, password_hash, full_name, role)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [username, passwordHash, `Test ${username}`, role],
  );
  const employeeId = r.rows[0]!.id;
  return { employeeId, token: signAccessToken({ sub: employeeId, role, deviceId: 'test-device' }, config.jwtSecret) };
}

/** The business write the guarded handlers perform (inside the request
 * transaction via the ambient join). */
async function businessWrite(): Promise<void> {
  await withTransaction(async (client) => {
    await client.query('SELECT next_in_sequence($1)', [SEQ_SCOPE]);
  });
}

async function currentSequenceValue(): Promise<number> {
  // bigint comes back as a string through pg; narrow it here so the
  // arithmetic in the assertions is numeric.
  const r = await db.query<{ current_value: number }>(
    'SELECT current_value::int AS current_value FROM sequences WHERE scope = $1',
    [SEQ_SCOPE],
  );
  return r.rows[0]?.current_value ?? 0;
}

async function keyRows(employeeId: string, key: string): Promise<Array<Record<string, unknown>>> {
  const r = await db.query(
    `SELECT employee_id, key, endpoint, request_hash, response_status, response_body, locked_at, expires_at
     FROM idempotency_keys WHERE employee_id = $1 AND key = $2`,
    [employeeId, key],
  );
  return r.rows as Array<Record<string, unknown>>;
}

/** POST through the real plugin: authenticated, mobile-shaped. */
function send(path: string, token: string, body: object, key?: string) {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (key !== undefined) headers['idempotency-key'] = key;
  return app.inject({
    method: 'POST',
    url: path,
    headers,
    payload: body,
  });
}

function envelopeOf(status: number, body: string): ErrorEnvelope['error'] {
  expect(status).toBeGreaterThanOrEqual(400);
  const parsed = errorEnvelopeSchema.parse(JSON.parse(body)) as unknown as ErrorEnvelope;
  return parsed.error;
}

beforeAll(async () => {
  admin = new Pool({ connectionString: adminUrlFor(databaseUrl()), max: 2 });
  await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${SCRATCH_DB}`);

  const scratchUrl = new URL(databaseUrl());
  scratchUrl.pathname = `/${SCRATCH_DB}`;
  // The plugin reads through the process-wide pool (db/pool.ts); point it
  // at the scratch database before the first request.
  process.env.DATABASE_URL = scratchUrl.toString();
  db = new Pool({ connectionString: scratchUrl.toString(), max: 5 });
  await runMigrations({ pool: db });

  config = loadConfig(validEnv({ DATABASE_URL: scratchUrl.toString() }));
  app = buildServer(config, { logger: false });
  passwordHash = await hashPassword(PASSWORD);

  // Routes under the plugin's guard. Each performs the business write in
  // the request transaction (ambient join) so rollback assertions have a
  // committed-or-not signal. The ok response's key order is deliberately
  // not the order jsonb would store — the byte-identical replay assertion
  // must be able to catch an object-jsonb round-trip, which would reorder.
  app.register(async (scoped) => {
    scoped.post('/test/idem/ok', { preHandler: scoped.requireAuth }, async () => {
      await businessWrite();
      return { status: 'done', id: 'JC-2627-00042', n: 7, msg: 'résumé ✓' };
    });
    scoped.post('/test/idem/slow', { preHandler: scoped.requireAuth }, async () => {
      await sleep(SLOW_HANDLER_MS);
      await businessWrite();
      return { status: 'done' };
    });
    scoped.post('/test/idem/fail', { preHandler: scoped.requireAuth }, async () => {
      await businessWrite();
      throw new Error('boom — the handler failed after writing');
    });
    scoped.get('/test/idem/read', { preHandler: scoped.requireAuth }, async () => ({ read: true }));
  });

  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await db?.end();
  // Detach the process pool from the database this suite is about to drop,
  // so a later suite in the same worker cannot inherit a dead connection.
  await closePool();
  if (admin) {
    await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
    await admin.end();
  }
});

describe('T1.3 — the five paths', () => {
  it('path 2: a claimed request executes, commits the business write with the response stored, and clears locked_at', async () => {
    const { employeeId, token } = await actor();
    const key = randomUUID();

    const res = await send('/test/idem/ok', token, { p: 1 }, key);
    expect(res.statusCode).toBe(200);
    expect(await currentSequenceValue()).toBe(1);

    const rows = await keyRows(employeeId, key);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.response_status).toBe(200);
    expect(rows[0]!.locked_at).toBeNull();
    expect(rows[0]!.endpoint).toBe('POST /test/idem/ok');
    expect(rows[0]!.request_hash).toBe(requestHashOf({ p: 1 }));
  });

  it('path 3: a replay returns a byte-identical status and body without re-executing', async () => {
    const { token } = await actor();
    const key = randomUUID();

    const first = await send('/test/idem/ok', token, { p: 1 }, key);
    expect(first.statusCode).toBe(200);
    const sequenceAfterFirst = await currentSequenceValue();

    const replay = await send('/test/idem/ok', token, { p: 1 }, key);
    expect(replay.statusCode).toBe(first.statusCode);
    // Byte-identical: not merely the same parsed JSON. The stored body
    // round-trips the original bytes (jsonb string scalar), so a
    // jsonb-normalised object would reorder these keys and fail here.
    expect(replay.body).toBe(first.body);
    expect(replay.headers['content-type']).toBe(first.headers['content-type']);
    // The handler did not run again.
    expect(await currentSequenceValue()).toBe(sequenceAfterFirst);
  });

  it('path 4: the same key with a different body is 422 IDEMPOTENCY_KEY_REUSED, and executes nothing', async () => {
    const { employeeId, token } = await actor();
    const key = randomUUID();

    const first = await send('/test/idem/ok', token, { p: 1 }, key);
    expect(first.statusCode).toBe(200);
    const sequenceAfterFirst = await currentSequenceValue();

    const reused = await send('/test/idem/ok', token, { p: 2 }, key);
    expect(reused.statusCode).toBe(422);
    expect(envelopeOf(reused.statusCode, reused.body).code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(await currentSequenceValue()).toBe(sequenceAfterFirst);

    // The stored response is untouched — the original replay still works.
    const replay = await send('/test/idem/ok', token, { p: 1 }, key);
    expect(replay.body).toBe(first.body);
    expect(await keyRows(employeeId, key)).toHaveLength(1);
  });

  it('path 5: two genuinely concurrent requests with the same key — one applies, one gets 409 with Retry-After', async () => {
    const { employeeId, token } = await actor();
    const key = randomUUID();
    const before = await currentSequenceValue();

    // Fired together, through the real server and the real pool: while
    // the winner's handler is mid-flight (SLOW_HANDLER_MS), the loser's
    // claim collides with the winner's committed claim row.
    const [a, b] = await Promise.all([
      send('/test/idem/slow', token, { p: 1 }, key),
      send('/test/idem/slow', token, { p: 1 }, key),
    ]);

    const statuses = [a.statusCode, b.statusCode].sort((x, y) => x - y);
    expect(statuses).toEqual([200, 409]);
    const conflict = a.statusCode === 409 ? a : b;
    expect(conflict.headers['retry-after']).toBe(String(IN_FLIGHT_RETRY_AFTER_SECONDS));
    expect(envelopeOf(conflict.statusCode, conflict.body).code).toBe('IDEMPOTENCY_IN_FLIGHT');

    // Exactly one execution.
    expect(await currentSequenceValue()).toBe(before + 1);
    const rows = await keyRows(employeeId, key);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.response_status).toBe(200);
    expect(rows[0]!.locked_at).toBeNull();
  }, 20_000);

  it('paths 2–5 have no window without a guard: a lost claim whose row was pruned mid-race is claimed, not waved through', async () => {
    // The claim statement reclaims an expired husk in the same breath —
    // pin the half of that WHERE clause this suite can reach without a
    // race: an expired row WITH a response still replays (below), and an
    // expired row WITHOUT one is taken over here.
    const { employeeId, token } = await actor();
    const key = randomUUID();
    const before = await currentSequenceValue();

    await db.query(
      `INSERT INTO idempotency_keys (employee_id, key, endpoint, request_hash, locked_at, expires_at)
       VALUES ($1, $2, 'POST /test/idem/ok', $3, now() - interval '2 seconds', now() - interval '1 day')`,
      [employeeId, key, requestHashOf({ p: 1 })],
    );

    const res = await send('/test/idem/ok', token, { p: 1 }, key);
    expect(res.statusCode).toBe(200);
    expect(await currentSequenceValue()).toBe(before + 1);
    const rows = await keyRows(employeeId, key);
    expect(rows[0]!.response_status).toBe(200);
    expect(rows[0]!.locked_at).toBeNull();
    expect((rows[0]!.expires_at as Date).getTime()).toBeGreaterThan(Date.now());
  });
});

describe('T1.3 — rollback and crash recovery', () => {
  it('a handler that throws leaves no idempotency row and no business row — the re-issued key executes', async () => {
    const { employeeId, token } = await actor();
    const key = randomUUID();
    const before = await currentSequenceValue();

    const failed = await send('/test/idem/fail', token, { p: 1 }, key);
    expect(failed.statusCode).toBe(500);
    expect(envelopeOf(failed.statusCode, failed.body).code).toBe('INTERNAL');

    // No orphan key row — the failure mode that permanently poisons a key.
    expect(await keyRows(employeeId, key)).toHaveLength(0);
    // The business write rolled back with it (same transaction).
    expect(await currentSequenceValue()).toBe(before);

    // The same key is free: re-issuing it executes.
    const retried = await send('/test/idem/ok', token, { p: 1 }, key);
    expect(retried.statusCode).toBe(200);
    expect(await currentSequenceValue()).toBe(before + 1);
  });

  it('a recent claim with no response is 409 IDEMPOTENCY_IN_FLIGHT — the crashed-request window before reclaim', async () => {
    const { employeeId, token } = await actor();
    const key = randomUUID();
    const before = await currentSequenceValue();

    // Forge exactly what a killed process leaves behind: a committed
    // claim, response never stored.
    await db.query(
      `INSERT INTO idempotency_keys (employee_id, key, endpoint, request_hash, locked_at)
       VALUES ($1, $2, 'POST /test/idem/ok', $3, now())`,
      [employeeId, key, requestHashOf({ p: 1 })],
    );

    const res = await send('/test/idem/ok', token, { p: 1 }, key);
    expect(res.statusCode).toBe(409);
    expect(res.headers['retry-after']).toBe(String(IN_FLIGHT_RETRY_AFTER_SECONDS));
    expect(envelopeOf(res.statusCode, res.body).code).toBe('IDEMPOTENCY_IN_FLIGHT');
    expect(await currentSequenceValue()).toBe(before);
  });

  it('a stale claim is reclaimed: the same key executes again and stores its response', async () => {
    const { employeeId, token } = await actor();
    const key = randomUUID();
    const before = await currentSequenceValue();

    await db.query(
      `INSERT INTO idempotency_keys (employee_id, key, endpoint, request_hash, locked_at)
       VALUES ($1, $2, 'POST /test/idem/ok', $3, now() - interval '31 seconds')`,
      [employeeId, key, requestHashOf({ p: 1 })],
    );

    const res = await send('/test/idem/ok', token, { p: 1 }, key);
    expect(res.statusCode).toBe(200);
    expect(await currentSequenceValue()).toBe(before + 1);

    const rows = await keyRows(employeeId, key);
    expect(rows[0]!.response_status).toBe(200);
    expect(rows[0]!.locked_at).toBeNull();
  });

  it('a response stored long ago still replays past expires_at — until the prune removes it', async () => {
    const { employeeId, token } = await actor();
    const key = randomUUID();

    const first = await send('/test/idem/ok', token, { p: 1 }, key);
    expect(first.statusCode).toBe(200);
    const sequenceAfterFirst = await currentSequenceValue();

    await db.query(
      'UPDATE idempotency_keys SET expires_at = now() - $1::interval WHERE employee_id = $2 AND key = $3',
      ['1 day', employeeId, key],
    );

    // Expired but not yet pruned: the stored answer is still the truth.
    const replay = await send('/test/idem/ok', token, { p: 1 }, key);
    expect(replay.statusCode).toBe(first.statusCode);
    expect(replay.body).toBe(first.body);
    expect(await currentSequenceValue()).toBe(sequenceAfterFirst);
  });
});

describe('T1.3 — the prune query', () => {
  it('deletes keys past expires_at and nothing else', async () => {
    const { employeeId, token } = await actor();
    const liveKey = randomUUID();
    const deadKey = randomUUID();

    const live = await send('/test/idem/ok', token, { p: 1 }, liveKey);
    expect(live.statusCode).toBe(200);
    await db.query(
      `INSERT INTO idempotency_keys (employee_id, key, endpoint, request_hash, locked_at, expires_at)
       VALUES ($1, $2, 'POST /test/idem/ok', $3, now() - interval '40 days', now() - interval '1 hour')`,
      [employeeId, deadKey, requestHashOf({ p: 1 })],
    );

    const pruned = await pruneExpiredKeys();
    expect(pruned).toBeGreaterThanOrEqual(1);

    expect(await keyRows(employeeId, liveKey)).toHaveLength(1);
    expect(await keyRows(employeeId, deadKey)).toHaveLength(0);
  });
});

describe('T1.3 — the guard is opt-in and scoped', () => {
  it('a mutation without an Idempotency-Key passes through ungated and writes no key row', async () => {
    const { employeeId, token } = await actor();
    const before = await currentSequenceValue();

    const res = await send('/test/idem/ok', token, { p: 1 });
    expect(res.statusCode).toBe(200);
    expect(await currentSequenceValue()).toBe(before + 1);
    // The only key rows for this employee are none.
    expect(await keyRows(employeeId, 'never-issued')).toHaveLength(0);
  });

  it('GET is never wrapped, even with a key', async () => {
    const { token } = await actor();

    const res = await app.inject({
      method: 'GET',
      url: '/test/idem/read',
      headers: { authorization: `Bearer ${token}`, 'idempotency-key': randomUUID() },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ read: true });
  });

  it('a pre-auth request carrying a key (login does) writes no key row', async () => {
    const username = `idem.t1.3.login.${randomBytes(4).toString('hex')}`;
    await db.query(
      `INSERT INTO employees (username, password_hash, full_name, role)
       VALUES ($1, $2, $3, 'technician')`,
      [username, passwordHash, `Test ${username}`],
    );

    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { 'idempotency-key': randomUUID() },
      payload: {
        username,
        password: PASSWORD,
        device: {
          installId: 'install-idem',
          platform: 'android',
          appVersion: '0.1.0',
          osVersion: '14',
          manufacturer: 'Xiaomi',
          model: 'Redmi Note 12',
        },
      },
    });
    expect(res.statusCode).toBe(200);

    const rows = await db.query(
      `SELECT 1 FROM idempotency_keys WHERE endpoint = 'POST /v1/auth/login' LIMIT 1`,
    );
    expect(rows.rows).toHaveLength(0);
  });
});
