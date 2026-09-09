import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import type { FastifyInstance } from 'fastify';
import {
  FEATURE_FLAGS,
  errorEnvelopeSchema,
  type ErrorEnvelope,
  type LoginResponse,
  type RefreshResponse,
} from '@servgrid/shared';
import { loadConfig, type Config } from '../../src/config.js';
import { closePool } from '../../src/db/pool.js';
import { runMigrations } from '../../src/db/migrate.js';
import { hashPassword, verifyPassword, ARGON2ID_HASH_PREFIX } from '../../src/lib/password.js';
import { UNAUTHENTICATED_MESSAGE, signAccessToken } from '../../src/plugins/auth.js';
import { CURRENT_CONSENT_VERSION } from '../../src/modules/auth/service.js';
import { buildServer } from '../../src/server.js';
import { ULID, validEnv } from '../helpers/env.js';

/**
 * Auth integration suite (PHASE-0-FOUNDATION.md T0.7, PLAN-BACKEND.md §4):
 * login, refresh rotation, reuse detection, password change, rate limit,
 * and the 401 contract. Runs against a scratch database built from the
 * real migrations — reuse detection is exactly the kind of thing a mocked
 * database cannot be trusted to prove (PLAN-BACKEND.md §14).
 *
 * Every test creates its own employee: the login rate limiter keys on
 * username + IP, and inject() always presents the same IP, so a shared
 * username would couple tests through the limiter's 60-second window.
 */

function databaseUrl(): string {
  return process.env.DATABASE_URL ?? 'postgres://servgrid:servgrid@localhost:5432/servgrid';
}

function adminUrlFor(url: string): string {
  const parsed = new URL(url);
  parsed.pathname = '/postgres';
  return parsed.toString();
}

const SCRATCH_DB = 'servgrid_auth_test';

const PASSWORD = 'mv-sunny-workshop-42';
const NEW_PASSWORD = 'brave-monsoon-cable-77';

let admin: Pool;
let db: Pool;
let app: FastifyInstance;
let config: Config;

/** A fresh employee with the suite password. Unique username per call —
 * see the rate-limiter note in the file header. */
async function seedEmployee(role: 'technician' | 'dispatcher' | 'owner' = 'technician'): Promise<{ username: string; employeeId: string }> {
  const username = `auth.t7.${randomBytes(4).toString('hex')}`;
  const r = await db.query<{ id: string }>(
    `INSERT INTO employees (username, password_hash, full_name, role)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [username, await hashPassword(PASSWORD), `Test ${username}`, role],
  );
  return { username, employeeId: r.rows[0]!.id };
}

/** A fresh employee, logged in; the common fixture of this suite. */
async function loggedIn(role: 'technician' | 'dispatcher' | 'owner' = 'technician', installId = 'install-A') {
  const { username, employeeId } = await seedEmployee(role);
  const res = await app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: loginBody(username, installId),
  });
  expect(res.statusCode).toBe(200);
  return { username, employeeId, login: res.json<LoginResponse>() };
}

function loginBody(username: string, installId = 'install-A', password = PASSWORD, appVersion = '0.1.0') {
  return {
    username,
    password,
    device: {
      installId,
      platform: 'android',
      appVersion,
      osVersion: '14',
      manufacturer: 'Xiaomi',
      model: 'Redmi Note 12',
    },
  };
}

function sha256(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function decodeJwt(token: string): Record<string, unknown> {
  const payload = token.split('.')[1]!;
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
}

async function refresh(rawToken: string) {
  return app.inject({ method: 'POST', url: '/v1/auth/refresh', payload: { refreshToken: rawToken } });
}

function envelopeOf(status: number, body: string): ErrorEnvelope['error'] {
  expect(status).toBeGreaterThanOrEqual(400);
  const parsed = errorEnvelopeSchema.parse(JSON.parse(body)) as unknown as ErrorEnvelope;
  const error = parsed.error;
  expect(error.requestId).toMatch(ULID);
  return error;
}

/** The whole chain at and below `tokenHash`, via the successor walk —
 * the same direction `revokeChainFrom` must take. */
async function chainRows(tokenHash: string): Promise<Array<{ token_hash: string; revoked_at: Date | null; replaced_by: string | null }>> {
  const r = await db.query<{
    token_hash: string;
    revoked_at: Date | null;
    replaced_by: string | null;
  }>(
    `WITH RECURSIVE chain AS (
       SELECT id, token_hash, revoked_at, replaced_by FROM refresh_tokens WHERE token_hash = $1
       UNION ALL
       SELECT rt.id, rt.token_hash, rt.revoked_at, rt.replaced_by
       FROM refresh_tokens rt JOIN chain c ON c.replaced_by = rt.id
     )
     SELECT token_hash, revoked_at, replaced_by FROM chain`,
    [tokenHash],
  );
  return r.rows;
}

beforeAll(async () => {
  admin = new Pool({ connectionString: adminUrlFor(databaseUrl()), max: 2 });
  await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${SCRATCH_DB}`);

  const scratchUrl = new URL(databaseUrl());
  scratchUrl.pathname = `/${SCRATCH_DB}`;
  // The auth service reads through the process-wide pool (db/pool.ts);
  // point it at the scratch database before the first request.
  process.env.DATABASE_URL = scratchUrl.toString();
  db = new Pool({ connectionString: scratchUrl.toString(), max: 5 });
  await runMigrations({ pool: db });

  config = loadConfig(validEnv({ DATABASE_URL: scratchUrl.toString() }));
  app = buildServer(config, { logger: false });
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

describe('POST /v1/auth/login', () => {
  it('issues both tokens for a good password, stores argon2id at the OWASP baseline, and sets last_login_at', async () => {
    const { username, employeeId } = await seedEmployee();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: loginBody(username),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<LoginResponse>();

    // Access token: HS256 JWT, 15 minutes, claims { sub, role, deviceId, jti }.
    const [headerPart, payloadPart, signaturePart] = body.accessToken.split('.');
    expect([headerPart, payloadPart, signaturePart]).not.toContain(undefined);
    expect(JSON.parse(Buffer.from(headerPart!, 'base64url').toString('utf8'))).toEqual({
      alg: 'HS256',
      typ: 'JWT',
    });
    const claims = decodeJwt(body.accessToken);
    expect(claims.sub).toBe(employeeId);
    expect(claims.role).toBe('technician');
    expect(typeof claims.deviceId).toBe('string');
    expect(typeof claims.jti).toBe('string');
    expect((claims.exp as number) - (claims.iat as number)).toBe(15 * 60);

    // Refresh token: opaque, 256 bits of entropy, base64url of 32 bytes.
    expect(body.refreshToken).toMatch(/^[A-Za-z0-9_-]{43}$/);

    expect(body.employee.id).toBe(employeeId);
    expect(body.employee.username).toBe(username);
    expect(body.employee.role).toBe('technician');
    expect(body.mustChangePassword).toBe(true);
    expect(body.consent).toEqual({ required: true, version: CURRENT_CONSENT_VERSION });

    // The stored hash self-describes argon2id m=19456 t=2 p=1 — and it
    // verifies, so the row was written by the same parameters we assert.
    const stored = await db.query<{ password_hash: string }>(
      'SELECT password_hash FROM employees WHERE id = $1',
      [employeeId],
    );
    expect(stored.rows[0]!.password_hash.startsWith(ARGON2ID_HASH_PREFIX)).toBe(true);
    expect(await verifyPassword(PASSWORD, stored.rows[0]!.password_hash)).toBe(true);

    const meta = await db.query<{ last_login_at: Date | null }>(
      'SELECT last_login_at FROM employees WHERE id = $1',
      [employeeId],
    );
    expect(meta.rows[0]!.last_login_at).not.toBeNull();

    // The access token the login issued works.
    const me = await app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { authorization: `Bearer ${body.accessToken}` },
    });
    expect(me.statusCode).toBe(200);
  });

  it('rejects a wrong password and an unknown username with the same 401 — no roster enumeration', async () => {
    const { username } = await seedEmployee();

    const wrong = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: loginBody(username, 'install-X', 'not-the-password'),
    });
    const unknown = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: loginBody(`auth.t7.nobody.${randomBytes(2).toString('hex')}`),
    });

    expect(wrong.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    const wrongError = envelopeOf(wrong.statusCode, wrong.body);
    const unknownError = envelopeOf(unknown.statusCode, unknown.body);
    expect(wrongError.code).toBe('UNAUTHENTICATED');
    expect(unknownError.code).toBe('UNAUTHENTICATED');
    expect(unknownError.message).toBe(wrongError.message);
    // No 401 may read as terminal (§4) — the wrong-password message included.
    expect(wrongError.message).not.toMatch(/log ?out|sign ?out|discard/i);
  });

  it('upserts exactly one devices row for a repeat installId', async () => {
    const { username, employeeId } = await seedEmployee();

    const first = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: loginBody(username, 'same-install') });
    const second = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: loginBody(username, 'same-install', PASSWORD, '0.2.0') });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);

    const devices = await db.query<{ n: number; app_version: string }>(
      `SELECT count(*)::int AS n, min(app_version) AS app_version FROM devices
       WHERE employee_id = $1 AND install_id = 'same-install'`,
      [employeeId],
    );
    expect(devices.rows[0]!.n).toBe(1);
    // The second login's diagnostics won the upsert.
    expect(devices.rows[0]!.app_version).toBe('0.2.0');

    const tokens = await db.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM refresh_tokens WHERE employee_id = $1',
      [employeeId],
    );
    expect(tokens.rows[0]!.n).toBe(2);
  });
});

describe('POST /v1/auth/refresh — rotation and reuse detection', () => {
  it('rotates: the old row is revoked with replaced_by set, and the new token works', async () => {
    const { login: first } = await loggedIn();

    const res = await refresh(first.refreshToken);
    expect(res.statusCode).toBe(200);
    const second = res.json<RefreshResponse>();
    expect(second.refreshToken).not.toBe(first.refreshToken);
    expect(second.accessToken).not.toBe(first.accessToken);

    const rows = await db.query<{ id: string; revoked_at: Date | null; replaced_by: string | null; token_hash: string }>(
      'SELECT id, revoked_at, replaced_by, token_hash FROM refresh_tokens WHERE token_hash = $1',
      [sha256(first.refreshToken)],
    );
    const oldRow = rows.rows[0]!;
    expect(oldRow.revoked_at).not.toBeNull();
    expect(oldRow.replaced_by).not.toBeNull();

    const newRow = (
      await db.query<{ id: string; revoked_at: Date | null; token_hash: string }>(
        'SELECT id, revoked_at, token_hash FROM refresh_tokens WHERE id = $1',
        [oldRow.replaced_by],
      )
    ).rows[0]!;
    expect(newRow.token_hash).toBe(sha256(second.refreshToken));
    expect(newRow.revoked_at).toBeNull();

    // The new pair is live end to end.
    const me = await app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { authorization: `Bearer ${second.accessToken}` },
    });
    expect(me.statusCode).toBe(200);
    const again = await refresh(second.refreshToken);
    expect(again.statusCode).toBe(200);
  });

  it('replaying a revoked token revokes the whole chain — proven on a three-deep rotation', async () => {
    const { login: gen0 } = await loggedIn('technician', 'install-chain');

    // Three rotations: gen0 → gen1 → gen2 → gen3. The youngest is gen3.
    const gen1 = (await refresh(gen0.refreshToken)).json<RefreshResponse>();
    const gen2 = (await refresh(gen1.refreshToken)).json<RefreshResponse>();
    const gen3 = (await refresh(gen2.refreshToken)).json<RefreshResponse>();
    expect(gen1.refreshToken).toBeDefined();
    expect(gen2.refreshToken).toBeDefined();
    expect(gen3.refreshToken).toBeDefined();
    expect(gen3.refreshToken).not.toBe(gen2.refreshToken);

    // An attacker replays gen1 (already rotated away). This is the test
    // that matters: everything descended from gen1 must die, not just
    // the row that was presented.
    const replay = await refresh(gen1.refreshToken);
    expect(replay.statusCode).toBe(401);
    const error = envelopeOf(replay.statusCode, replay.body);
    expect(error.code).toBe('TOKEN_REUSED');
    expect(error.message).not.toMatch(/log ?out|sign ?out|discard/i);

    const chain = await chainRows(sha256(gen1.refreshToken));
    expect(chain).toHaveLength(3); // gen1, gen2, gen3
    for (const row of chain) {
      expect(row.revoked_at, 'a descendant survived the chain revocation').not.toBeNull();
    }
    // The ancestors were already revoked at rotation time.
    const root = await db.query<{ revoked_at: Date | null }>(
      'SELECT revoked_at FROM refresh_tokens WHERE token_hash = $1',
      [sha256(gen0.refreshToken)],
    );
    expect(root.rows[0]!.revoked_at).not.toBeNull();

    // And the freshest descendant token stops working too.
    const stale = await refresh(gen3.refreshToken);
    expect(stale.statusCode).toBe(401);
    expect(envelopeOf(stale.statusCode, stale.body).code).toBe('TOKEN_REUSED');

    // The presented-anyway replay of gen1 keeps answering the same way.
    const replayAgain = await refresh(gen1.refreshToken);
    expect(replayAgain.statusCode).toBe(401);
  });

  it('answers an unknown refresh token with a plain UNAUTHENTICATED, not TOKEN_REUSED', async () => {
    const res = await refresh(randomBytes(32).toString('base64url'));
    expect(res.statusCode).toBe(401);
    expect(envelopeOf(res.statusCode, res.body).code).toBe('UNAUTHENTICATED');
  });
});

describe('POST /v1/auth/logout', () => {
  it('revokes the presented token; a second logout stays green', async () => {
    const { login: session } = await loggedIn('technician', 'install-logout');

    const first = await app.inject({ method: 'POST', url: '/v1/auth/logout', payload: { refreshToken: session.refreshToken } });
    expect(first.statusCode).toBe(200);
    const after = await refresh(session.refreshToken);
    expect(after.statusCode).toBe(401);

    const second = await app.inject({ method: 'POST', url: '/v1/auth/logout', payload: { refreshToken: session.refreshToken } });
    expect(second.statusCode).toBe(200);
  });
});

describe('POST /v1/auth/password', () => {
  it('revokes every refresh token for the employee — both devices go dark', async () => {
    const { employeeId, username, login: deviceA } = await loggedIn('technician', 'install-a');
    const deviceB = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: loginBody(username, 'install-b') });
    expect(deviceB.statusCode).toBe(200);

    const change = await app.inject({
      method: 'POST',
      url: '/v1/auth/password',
      headers: { authorization: `Bearer ${deviceA.accessToken}` },
      payload: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
    });
    expect(change.statusCode).toBe(200);
    expect(change.json()).toEqual({ ok: true });

    const live = await db.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM refresh_tokens WHERE employee_id = $1 AND revoked_at IS NULL',
      [employeeId],
    );
    expect(live.rows[0]!.n).toBe(0);
    expect((await refresh(deviceA.refreshToken)).statusCode).toBe(401);
    expect((await refresh(deviceB.json<LoginResponse>().refreshToken)).statusCode).toBe(401);

    // The flag clears and the new password is the one that works.
    const oldLogin = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: loginBody(username, 'install-a') });
    expect(oldLogin.statusCode).toBe(401);
    const newLogin = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: loginBody(username, 'install-a', NEW_PASSWORD) });
    expect(newLogin.statusCode).toBe(200);
    expect(newLogin.json<LoginResponse>().mustChangePassword).toBe(false);
  });

  it('refuses a wrong current password as 422 — 401 stays reserved for token problems', async () => {
    const { login: session } = await loggedIn('technician', 'install-a');
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/password',
      headers: { authorization: `Bearer ${session.accessToken}` },
      payload: { currentPassword: 'not-it', newPassword: NEW_PASSWORD },
    });
    expect(res.statusCode).toBe(422);
    expect(envelopeOf(res.statusCode, res.body).code).toBe('VALIDATION_FAILED');
  });

  it('requires an access token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/password',
      payload: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
    });
    expect(res.statusCode).toBe(401);
    expect(envelopeOf(res.statusCode, res.body).code).toBe('UNAUTHENTICATED');
  });
});

describe('login rate limit — 5/min per username + IP', () => {
  it('lets five attempts through and rate-limits the sixth', async () => {
    const { username } = await seedEmployee();

    for (let attempt = 1; attempt <= 5; attempt++) {
      const res = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: loginBody(username, `attempt-${attempt}`) });
      expect(res.statusCode, `attempt ${attempt} should pass`).toBe(200);
    }
    const sixth = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: loginBody(username, 'attempt-6') });
    expect(sixth.statusCode).toBe(429);
    const error = envelopeOf(sixth.statusCode, sixth.body);
    expect(error.code).toBe('RATE_LIMITED');
    expect(sixth.headers['retry-after']).toBeDefined();
  });

  it('counts failed attempts too, and leaves other usernames untouched', async () => {
    const { username } = await seedEmployee();
    for (let attempt = 1; attempt <= 5; attempt++) {
      const res = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: loginBody(username, 'install', 'wrong') });
      expect(res.statusCode).toBe(401);
    }
    const sixth = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: loginBody(username, 'install') });
    expect(sixth.statusCode).toBe(429);

    const other = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: loginBody((await seedEmployee()).username),
    });
    expect(other.statusCode).toBe(200);
  });
});

describe('the 401 contract (§4) — recoverable, never terminal', () => {
  it('an expired access token is UNAUTHENTICATED with the standard envelope, no Clear-Site-Data, no logout directive', async () => {
    const { employeeId, login: session } = await loggedIn('technician', 'install-expired');
    const claims = decodeJwt(session.accessToken);

    const expired = signAccessToken(
      { sub: employeeId, role: 'technician', deviceId: claims.deviceId as string, jti: 'expired-token' },
      config.jwtSecret,
      -10,
    );
    const res = await app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { authorization: `Bearer ${expired}` },
    });

    expect(res.statusCode).toBe(401);
    expect(res.headers['clear-site-data']).toBeUndefined();
    const error = envelopeOf(res.statusCode, res.body);
    expect(Object.keys(error).sort()).toEqual(['code', 'message', 'requestId']);
    expect(error.code).toBe('UNAUTHENTICATED');
    expect(error.message).toBe(UNAUTHENTICATED_MESSAGE);
    // Nothing a naive client could read as a terminal rejection.
    expect(error.message).not.toMatch(/log ?out|sign ?out|discard|give up|re-?enter/i);
  });

  it('a missing or malformed token is the same recoverable 401', async () => {
    const missing = await app.inject({ method: 'GET', url: '/v1/auth/me' });
    const malformed = await app.inject({ method: 'GET', url: '/v1/auth/me', headers: { authorization: 'Bearer not.a.jwt' } });
    const wrongScheme = await app.inject({ method: 'GET', url: '/v1/auth/me', headers: { authorization: `Basic ${Buffer.from('a:b').toString('base64')}` } });

    for (const res of [missing, malformed, wrongScheme]) {
      expect(res.statusCode).toBe(401);
      const error = envelopeOf(res.statusCode, res.body);
      expect(error.code).toBe('UNAUTHENTICATED');
      expect(error.message).toBe(UNAUTHENTICATED_MESSAGE);
      expect(res.headers['clear-site-data']).toBeUndefined();
    }
  });
});

describe('GET /v1/auth/me', () => {
  it('returns the actor, the role permission snapshot, all-off feature flags, and consent state', async () => {
    const { login: session } = await loggedIn('dispatcher', 'install-me');

    const res = await app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { authorization: `Bearer ${session.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      employee: { role: string; username: string };
      permissions: Record<string, Record<string, string>>;
      featureFlags: Record<string, boolean>;
      consent: { required: boolean; version: string };
    }>();

    expect(body.employee.role).toBe('dispatcher');
    // Spot-check the load-bearing cells — the revenue guarantee and the
    // location split (PLAN-BACKEND.md §5).
    expect(body.permissions['job.money']?.read).toBe('none');
    expect(body.permissions['location.read']?.read).toBe('none');
    expect(body.permissions['location.health']?.read).toBe('all');
    expect(body.permissions.job?.read).toBe('all');

    expect(Object.keys(body.featureFlags).sort()).toEqual([...FEATURE_FLAGS].sort());
    for (const flag of FEATURE_FLAGS) expect(body.featureFlags[flag]).toBe(false);

    expect(body.consent).toEqual({ required: true, version: CURRENT_CONSENT_VERSION });
  });

  it('flips consent.required once the current version has been accepted', async () => {
    const { employeeId, login: session } = await loggedIn('technician', 'install-consent');

    // T0.9 ships the endpoint; until then the acceptance row is written
    // the way that endpoint will write it.
    await db.query(
      `INSERT INTO consents (employee_id, kind, version, accepted_at)
       VALUES ($1, 'location_tracking', $2, now())`,
      [employeeId, CURRENT_CONSENT_VERSION],
    );

    const res = await app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { authorization: `Bearer ${session.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ consent: { required: boolean } }>().consent.required).toBe(false);
  });
});
