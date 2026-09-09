import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import type { FastifyInstance } from 'fastify';
import {
  employeeAdminSchema,
  employeeDetailResponseSchema,
  employeeListResponseSchema,
  employeePublicSchema,
  errorEnvelopeSchema,
  type ErrorEnvelope,
  type LoginResponse,
} from '@servgrid/shared';
import { loadConfig, type Config } from '../../src/config.js';
import { closePool } from '../../src/db/pool.js';
import { runMigrations } from '../../src/db/migrate.js';
import { hashPassword } from '../../src/lib/password.js';
import { buildServer } from '../../src/server.js';
import { OWNER_ONLY_MESSAGE } from '../../src/modules/employees/routes.js';
import { ULID, validEnv } from '../helpers/env.js';

/**
 * Employee-admin authorisation matrix (PHASE-0-FOUNDATION.md T0.8,
 * PLAN-BACKEND.md §4.1): all six endpoints × every role. Owner only,
 * except `GET /v1/employees/me` — and `/me` means *self*, keyed off the
 * token, never off the path: a non-owner asking for his own row by id
 * gets the same 403 as one asking for someone else's.
 */

function databaseUrl(): string {
  return process.env.DATABASE_URL ?? 'postgres://servgrid:servgrid@localhost:5432/servgrid';
}

function adminUrlFor(url: string): string {
  const parsed = new URL(url);
  parsed.pathname = '/postgres';
  return parsed.toString();
}

const SCRATCH_DB = 'servgrid_authz_employees_test';
const PASSWORD = 'mv-employee-admin-81';

type Role = 'owner' | 'dispatcher' | 'technician' | 'sales_rep';
const ROLES: readonly Role[] = ['owner', 'dispatcher', 'technician', 'sales_rep'];

let admin: Pool;
let db: Pool;
let app: FastifyInstance;
let config: Config;

const tokens: Partial<Record<Role, string>> = {};
const selfIds: Partial<Record<Role, string>> = {};
let subject: { id: string; username: string };

/** A fresh employee with the suite password, unique username per call. */
async function seedEmployee(role: Role, username = `emp.t8.${randomBytes(4).toString('hex')}`): Promise<{ id: string; username: string }> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO employees (username, password_hash, full_name, role)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [username, await hashPassword(PASSWORD), `Test ${username}`, role],
  );
  return { id: r.rows[0]!.id, username };
}

/** Seed + login, the common fixture. Returns the bearer token for the role. */
async function loggedIn(role: Role, installId = 'install-A'): Promise<void> {
  const { username } = await seedEmployee(role);
  const res = await app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: {
      username,
      password: PASSWORD,
      device: {
        installId,
        platform: 'android',
        appVersion: '0.1.0',
        osVersion: '14',
        manufacturer: 'Xiaomi',
        model: 'Redmi Note 12',
      },
    },
  });
  expect(res.statusCode, `login as ${role} should succeed`).toBe(200);
  const body = res.json<LoginResponse>();
  tokens[role] = body.accessToken;
  selfIds[role] = body.employee.id;
}

function bearer(role: Role | null): Record<string, string> {
  return role && tokens[role] ? { authorization: `Bearer ${tokens[role]}` } : {};
}

function envelopeOf(status: number, body: string): ErrorEnvelope['error'] {
  expect(status).toBeGreaterThanOrEqual(400);
  const parsed = errorEnvelopeSchema.parse(JSON.parse(body)) as unknown as ErrorEnvelope;
  expect(parsed.error.requestId).toMatch(ULID);
  return parsed.error;
}

/** Current version of the subject row — PATCH tests chain off the live value. */
async function subjectVersion(): Promise<number> {
  const res = await app.inject({
    method: 'GET',
    url: `/v1/employees/${subject.id}`,
    headers: bearer('owner'),
  });
  expect(res.statusCode).toBe(200);
  return res.json<{ version: number }>().version;
}

beforeAll(async () => {
  admin = new Pool({ connectionString: adminUrlFor(databaseUrl()), max: 2 });
  await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${SCRATCH_DB}`);

  const scratchUrl = new URL(databaseUrl());
  scratchUrl.pathname = `/${SCRATCH_DB}`;
  process.env.DATABASE_URL = scratchUrl.toString();
  db = new Pool({ connectionString: scratchUrl.toString(), max: 5 });
  await runMigrations({ pool: db });

  config = loadConfig(validEnv({ DATABASE_URL: scratchUrl.toString() }));
  app = buildServer(config, { logger: false });
  await app.ready();

  await loggedIn('owner');
  await loggedIn('dispatcher', 'install-d');
  await loggedIn('technician', 'install-t');
  await loggedIn('sales_rep', 'install-s');
  subject = await seedEmployee('technician');
});

afterAll(async () => {
  await app?.close();
  await db?.end();
  await closePool();
  if (admin) {
    await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
    await admin.end();
  }
});

describe('authorisation matrix — six endpoints × four roles', () => {
  const subjectUrl = () => `/v1/employees/${subject.id}`;

  /** One probe per endpoint; `patch` reads the live version for If-Match. */
  async function probe(endpoint: 'list' | 'create' | 'get' | 'patch' | 'reset' | 'me', role: Role | null) {
    const headers = bearer(role);
    switch (endpoint) {
      case 'list':
        return app.inject({ method: 'GET', url: '/v1/employees', headers });
      case 'create':
        return app.inject({
          method: 'POST',
          url: '/v1/employees',
          headers,
          payload: {
            username: `emp.t8.${randomBytes(4).toString('hex')}`,
            fullName: 'Matrix Probe',
            role: 'technician',
            tempPassword: 'temporary-pass-1',
          },
        });
      case 'get':
        return app.inject({ method: 'GET', url: subjectUrl(), headers });
      case 'patch':
        return app.inject({
          method: 'PATCH',
          url: subjectUrl(),
          headers: { ...headers, 'if-match': String(await subjectVersion()) },
          payload: { fullName: 'Matrix Patched' },
        });
      case 'reset':
        return app.inject({
          method: 'POST',
          url: `${subjectUrl()}/password`,
          headers,
          payload: { tempPassword: 'reset-pass-99' },
        });
      case 'me':
        return app.inject({ method: 'GET', url: '/v1/employees/me', headers });
    }
  }

  it('owner is allowed everywhere', async () => {
    for (const endpoint of ['list', 'create', 'get', 'patch', 'reset', 'me'] as const) {
      const res = await probe(endpoint, 'owner');
      expect(res.statusCode, `${endpoint} should succeed for owner`).toBe(200);
    }
  });

  for (const role of ['dispatcher', 'technician', 'sales_rep'] as const) {
    it(`${role} gets 403 on all five owner endpoints`, async () => {
      for (const endpoint of ['list', 'create', 'get', 'patch', 'reset'] as const) {
        const res = await probe(endpoint, role);
        expect(res.statusCode, `${endpoint} should refuse ${role}`).toBe(403);
        const error = envelopeOf(res.statusCode, res.body);
        expect(error.code).toBe('FORBIDDEN');
        expect(error.message).toBe(OWNER_ONLY_MESSAGE);
      }
    });

    it(`${role} gets 403 on their own row's path too — /me is the only self service`, async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/employees/${selfIds[role]}`,
        headers: bearer(role),
      });
      expect(res.statusCode).toBe(403);
      expect(envelopeOf(res.statusCode, res.body).code).toBe('FORBIDDEN');
    });
  }

  it('no token is 401 on every endpoint — the owner gate never leaks before auth', async () => {
    for (const endpoint of ['list', 'create', 'get', 'patch', 'reset', 'me'] as const) {
      const res = await probe(endpoint, null);
      expect(res.statusCode, `${endpoint} without a token`).toBe(401);
      expect(envelopeOf(res.statusCode, res.body).code).toBe('UNAUTHENTICATED');
    }
  });
});

describe('GET /v1/employees/me — self only, from the token', () => {
  it('returns the caller his own row, whoever he is', async () => {
    for (const role of ROLES) {
      const res = await app.inject({ method: 'GET', url: '/v1/employees/me', headers: bearer(role) });
      expect(res.statusCode, role).toBe(200);
      const employee = employeePublicSchema.parse(res.json());
      expect(employee.id).toBe(selfIds[role]);
      expect(employee.role).toBe(role);
    }
  });

  it('never returns another employee — two callers, two rows, no overlap', async () => {
    const ownerRow = employeePublicSchema.parse(
      (await app.inject({ method: 'GET', url: '/v1/employees/me', headers: bearer('owner') })).json(),
    );
    const repRow = employeePublicSchema.parse(
      (await app.inject({ method: 'GET', url: '/v1/employees/me', headers: bearer('sales_rep') })).json(),
    );
    expect(ownerRow.id).not.toBe(repRow.id);
    expect(repRow.id).toBe(selfIds.sales_rep);
  });
});

describe('GET /v1/employees — the roster', () => {
  it('returns every employee as the admin shape (isActive, version, createdAt)', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/employees', headers: bearer('owner') });
    expect(res.statusCode).toBe(200);
    const roster = employeeListResponseSchema.parse(res.json());
    const ids = roster.map((row) => row.id);
    for (const role of ROLES) expect(ids, `${role} should be on the roster`).toContain(selfIds[role]);
    expect(ids).toContain(subject.id);
  });

  it('filters by role[] and isActive', async () => {
    const techs = await app.inject({
      method: 'GET',
      url: '/v1/employees?role=technician&isActive=true',
      headers: bearer('owner'),
    });
    const parsed = employeeListResponseSchema.parse(techs.json());
    expect(parsed.length).toBeGreaterThanOrEqual(2); // the matrix technician + the subject
    for (const row of parsed) {
      expect(row.role).toBe('technician');
      expect(row.isActive).toBe(true);
    }

    const nobody = await app.inject({
      method: 'GET',
      url: '/v1/employees?role=sales_rep&isActive=false',
      headers: bearer('owner'),
    });
    expect(employeeListResponseSchema.parse(nobody.json())).toEqual([]);

    const multi = await app.inject({
      method: 'GET',
      url: '/v1/employees?role=owner&role=dispatcher',
      headers: bearer('owner'),
    });
    const roles = new Set(employeeListResponseSchema.parse(multi.json()).map((row) => row.role));
    expect([...roles].sort()).toEqual(['dispatcher', 'owner']);
  });
});

describe('POST /v1/employees — accounts exist before anyone can log in', () => {
  it('creates the account with must_change_password, and the temp password opens the front door', async () => {
    const username = `emp.t8.${randomBytes(4).toString('hex')}`;
    const tempPassword = 'hand-held-secret-7';
    const res = await app.inject({
      method: 'POST',
      url: '/v1/employees',
      headers: bearer('owner'),
      payload: { username, fullName: 'Created By Test', phone: '9800000001', role: 'technician', tempPassword },
    });
    expect(res.statusCode).toBe(200);
    const created = employeeAdminSchema.parse(res.json());
    expect(created.username).toBe(username);
    expect(created.mustChangePassword).toBe(true);
    expect(created.isActive).toBe(true);
    expect(created.version).toBe(1);

    // The whole point of the endpoint being Phase 0: the account can log in.
    const login = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: {
        username,
        password: tempPassword,
        device: {
          installId: 'install-new',
          platform: 'android',
          appVersion: '0.1.0',
          osVersion: '14',
          manufacturer: 'Xiaomi',
          model: 'Redmi Note 12',
        },
      },
    });
    expect(login.statusCode).toBe(200);
    expect(login.json<LoginResponse>().mustChangePassword).toBe(true);
  });

  it('refuses a duplicate username with 409 DUPLICATE_ENTITY naming the existing row', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/employees',
      headers: bearer('owner'),
      payload: {
        username: subject.username,
        fullName: 'Second Of The Same Name',
        role: 'technician',
        tempPassword: 'another-temp-pass',
      },
    });
    expect(res.statusCode).toBe(409);
    const error = envelopeOf(res.statusCode, res.body);
    expect(error.code).toBe('DUPLICATE_ENTITY');
    expect((error.details as { existing: { id: string } }).existing.id).toBe(subject.id);
  });
});

describe('GET /v1/employees/:id — detail with device diagnostics', () => {
  it('shows the devices the employee has installed on, with the four diagnostics', async () => {
    // The matrix technician logged in once — one device row exists for him.
    const res = await app.inject({
      method: 'GET',
      url: `/v1/employees/${selfIds.technician}`,
      headers: bearer('owner'),
    });
    expect(res.statusCode).toBe(200);
    const detail = employeeDetailResponseSchema.parse(res.json());
    expect(detail.id).toBe(selfIds.technician);
    expect(detail.devices).toHaveLength(1);
    expect(detail.devices[0]!.installId).toBe('install-t');
    expect(detail.devices[0]!.locationPermission).toBe('none'); // unconfirmed is a value, not a null
    expect(detail.devices[0]!.notificationsEnabled).toBe(false);
  });

  it('404s an id that does not exist — and one that is not even a uuid', async () => {
    const missing = '11111111-1111-4111-8111-111111111111';
    const byId = await app.inject({ method: 'GET', url: `/v1/employees/${missing}`, headers: bearer('owner') });
    expect(byId.statusCode).toBe(404);
    const malformed = await app.inject({ method: 'GET', url: '/v1/employees/not-a-uuid', headers: bearer('owner') });
    expect(malformed.statusCode).toBe(404);
    expect(envelopeOf(malformed.statusCode, malformed.body).code).toBe('NOT_FOUND');
  });
});

describe('PATCH /v1/employees/:id — If-Match, and the stubbed preconditions', () => {
  it('renames under If-Match and bumps version', async () => {
    const before = await subjectVersion();
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/employees/${subject.id}`,
      headers: { ...bearer('owner'), 'if-match': String(before) },
      payload: { fullName: 'Renamed Subject', phone: '9800000002' },
    });
    expect(res.statusCode).toBe(200);
    const updated = employeeAdminSchema.parse(res.json());
    expect(updated.fullName).toBe('Renamed Subject');
    expect(updated.phone).toBe('9800000002');
    expect(updated.version).toBe(before + 1);
  });

  it('refuses a stale If-Match with 409 VERSION_CONFLICT', async () => {
    const current = await subjectVersion();
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/employees/${subject.id}`,
      headers: { ...bearer('owner'), 'if-match': String(current - 1) },
      payload: { fullName: 'Loser Of A Race' },
    });
    expect(res.statusCode).toBe(409);
    expect(envelopeOf(res.statusCode, res.body).code).toBe('VERSION_CONFLICT');
  });

  it('refuses a missing If-Match with 422 — the guard is not optional', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/employees/${subject.id}`,
      headers: bearer('owner'),
      payload: { fullName: 'No Guard' },
    });
    expect(res.statusCode).toBe(422);
    expect(envelopeOf(res.statusCode, res.body).code).toBe('VALIDATION_FAILED');
  });

  it('refuses deactivation with 409 EMPLOYEE_HAS_OPEN_WORK and an empty details array — the T4.5 stub', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/employees/${subject.id}`,
      headers: { ...bearer('owner'), 'if-match': String(await subjectVersion()) },
      payload: { isActive: false },
    });
    expect(res.statusCode).toBe(409);
    const error = envelopeOf(res.statusCode, res.body);
    expect(error.code).toBe('EMPLOYEE_HAS_OPEN_WORK');
    expect(error.details).toEqual([]); // empty now; Phase 4 lists the blocking rows
  });

  it('refuses a real role change under the same gate — a no-op role write passes', async () => {
    const promote = await app.inject({
      method: 'PATCH',
      url: `/v1/employees/${subject.id}`,
      headers: { ...bearer('owner'), 'if-match': String(await subjectVersion()) },
      payload: { role: 'dispatcher' },
    });
    expect(promote.statusCode).toBe(409);
    expect(envelopeOf(promote.statusCode, promote.body).code).toBe('EMPLOYEE_HAS_OPEN_WORK');

    const sameRole = await app.inject({
      method: 'PATCH',
      url: `/v1/employees/${subject.id}`,
      headers: { ...bearer('owner'), 'if-match': String(await subjectVersion()) },
      payload: { role: 'technician' },
    });
    expect(sameRole.statusCode).toBe(200);
  });
});

describe('POST /v1/employees/:id/password — owner resets someone', () => {
  it('revokes every session, invalidates the old password, and forces a change on next login', async () => {
    // A fresh employee logs in so there are live tokens to lose.
    const { id, username } = await seedEmployee('dispatcher', `emp.t8.${randomBytes(4).toString('hex')}`);
    const loginBody = (password: string) => ({
      username,
      password,
      device: {
        installId: 'install-reset',
        platform: 'android',
        appVersion: '0.1.0',
        osVersion: '14',
        manufacturer: 'Xiaomi',
        model: 'Redmi Note 12',
      },
    });
    const first = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: loginBody(PASSWORD) });
    expect(first.statusCode).toBe(200);
    const session = first.json<LoginResponse>();

    const tempPassword = 'owner-issued-pass-3';
    const res = await app.inject({
      method: 'POST',
      url: `/v1/employees/${id}/password`,
      headers: bearer('owner'),
      payload: { tempPassword },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });

    // Every refresh token for the account is dead.
    const live = await db.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM refresh_tokens WHERE employee_id = $1 AND revoked_at IS NULL',
      [id],
    );
    expect(live.rows[0]!.n).toBe(0);
    const replay = await app.inject({ method: 'POST', url: '/v1/auth/refresh', payload: { refreshToken: session.refreshToken } });
    expect(replay.statusCode).toBe(401);

    const oldLogin = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: loginBody(PASSWORD) });
    expect(oldLogin.statusCode).toBe(401);
    const newLogin = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: loginBody(tempPassword) });
    expect(newLogin.statusCode).toBe(200);
    expect(newLogin.json<LoginResponse>().mustChangePassword).toBe(true);
  });

  it('404s an unknown employee', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/employees/11111111-1111-4111-8111-111111111111/password',
      headers: bearer('owner'),
      payload: { tempPassword: 'nobody-home-pass' },
    });
    expect(res.statusCode).toBe(404);
    expect(envelopeOf(res.statusCode, res.body).code).toBe('NOT_FOUND');
  });
});

describe('PATCH deactivation preconditions — the Phase 4 contract, stubbed', () => {
  // TODO(T4.5): unskip when migrations 007 (job_cards) and 010
  // (cash_reconciliations) exist; the seeding SQL is written then. The
  // contract it will pin (PLAN-BACKEND.md §4.1, PLAN-GAPS.md G15):
  //
  // 1. given one open job assigned to the employee, PATCH isActive:false
  //    answers 409 EMPLOYEE_HAS_OPEN_WORK with *that job* in details;
  // 2. given a company he owns (owner_rep_id), details names the company;
  // 3. given a cash reconciliation still submitted/disputed, details
  //    names the reconciliation;
  // 4. with all three clear, the same PATCH succeeds — every refresh
  //    token revoked, devices marked inactive, completions/payments
  //    untouched, and the row out of v_employee_tracking_health.
  //
  // Phase 0 ships the refusal half of (1)-(3) as an empty details array —
  // pinned live, unskipped, by the stub tests above.
  it.skip('refuses with the blocking rows listed, then succeeds once they are resolved (needs migrations 007/010 — completed in T4.5)', async () => {
    throw new Error('T4.5 — unskip when job_cards (007) and cash_reconciliations (010) exist');
  });
});
