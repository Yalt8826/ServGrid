import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import type { FastifyInstance } from 'fastify';
import {
  employeeListResponseSchema,
  errorEnvelopeSchema,
  type ErrorCode,
  type ErrorEnvelope,
  type LoginResponse,
  type Role,
} from '@servgrid/shared';
import { loadConfig, type Config } from '../../src/config.js';
import { closePool } from '../../src/db/pool.js';
import { runMigrations } from '../../src/db/migrate.js';
import { hashPassword } from '../../src/lib/password.js';
import { buildServer } from '../../src/server.js';
import { ULID, validEnv } from '../helpers/env.js';

/**
 * The authorisation matrix suite (PHASE-0-FOUNDATION.md T0.10,
 * PLAN-BACKEND.md §5): every endpoint that exists, probed as every role
 * and anonymously, asserting the exact status and error code rather than
 * assuming a refusal. This is the suite that protects the revenue
 * guarantee — it grows in every subsequent phase and is never allowed to
 * shrink. Adding an endpoint without a row here fails the shrink guard
 * at the bottom of this file.
 *
 * Where a refusal is expected, the row pins *which* refusal: 403
 * FORBIDDEN for a role the matrix gives nothing on the cell, 401
 * UNAUTHENTICATED for a missing or unverifiable token. A probe that is
 * allowed asserts 200 and, where cheap, a body fact that proves the
 * right row came back.
 */

function databaseUrl(): string {
  return process.env.DATABASE_URL ?? 'postgres://servgrid:servgrid@localhost:5432/servgrid';
}

function adminUrlFor(url: string): string {
  const parsed = new URL(url);
  parsed.pathname = '/postgres';
  return parsed.toString();
}

const SCRATCH_DB = 'servgrid_authz_matrix_test';
const PASSWORD = 'mv-matrix-t10-81';

const ROLES: readonly Role[] = ['owner', 'dispatcher', 'technician', 'sales_rep'];
type Actor = Role | null; // null = anonymous — no Authorization header at all
const ACTORS: readonly Actor[] = [...ROLES, null];

interface Expectation {
  status: number;
  code?: ErrorCode;
}
const OK: Expectation = { status: 200 };
const FORBIDDEN: Expectation = { status: 403, code: 'FORBIDDEN' };
const UNAUTHENTICATED: Expectation = { status: 401, code: 'UNAUTHENTICATED' };

const LOGIN_DEVICE = {
  installId: 'install-t10',
  platform: 'android',
  appVersion: '0.1.0',
  osVersion: '14',
  manufacturer: 'Xiaomi',
  model: 'Redmi Note 12',
};

let admin: Pool;
let db: Pool;
let app: FastifyInstance;
let config: Config;

const tokens: Partial<Record<Role, string>> = {};
const selfIds: Partial<Record<Role, string>> = {};
const usernames: Partial<Record<Role, string>> = {};
let subject: { id: string };

async function seedEmployee(role: Role, username = `emp.t10.${randomBytes(4).toString('hex')}`): Promise<{ id: string; username: string }> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO employees (username, password_hash, full_name, role)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [username, await hashPassword(PASSWORD), `Test ${username}`, role],
  );
  return { id: r.rows[0]!.id, username };
}

/** Login via the front door — the same path every probe's subject takes. */
async function loginAs(username: string, password = PASSWORD): Promise<LoginResponse> {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: { username, password, device: LOGIN_DEVICE },
  });
  expect(res.statusCode, `login as ${username} should succeed`).toBe(200);
  return res.json<LoginResponse>();
}

function bearer(actor: Actor): Record<string, string> {
  return actor && tokens[actor] ? { authorization: `Bearer ${tokens[actor]}` } : {};
}

function envelopeOf(status: number, body: string): ErrorEnvelope['error'] {
  expect(status).toBeGreaterThanOrEqual(400);
  const parsed = errorEnvelopeSchema.parse(JSON.parse(body)) as unknown as ErrorEnvelope;
  expect(parsed.error.requestId).toMatch(ULID);
  return parsed.error;
}

/** Current version of the subject row — the owner PATCH probe chains off the live value. */
async function subjectVersion(): Promise<number> {
  const res = await app.inject({
    method: 'GET',
    url: `/v1/employees/${subject.id}`,
    headers: bearer('owner'),
  });
  expect(res.statusCode).toBe(200);
  return res.json<{ version: number }>().version;
}

type InjectResponse = Awaited<ReturnType<FastifyInstance['inject']>>;

interface EndpointRow {
  /** `METHOD path` — also the route the shrink guard asserts exists. */
  name: string;
  method: 'GET' | 'POST' | 'PATCH';
  url: string;
  probe(actor: Actor): Promise<InjectResponse>;
  expect: Record<Role, Expectation> & { anon: Expectation };
  /** Extra assertion on a 200 — proves the right row came back, not just some row. */
  assertOk?(actor: Actor, res: InjectResponse): void;
}

/** Every role's cell is OK where the endpoint is open to all authenticated actors. */
const ALL_ROLES_OK = { owner: OK, dispatcher: OK, technician: OK, sales_rep: OK } as const;
const OWNER_ONLY = { owner: OK, dispatcher: FORBIDDEN, technician: FORBIDDEN, sales_rep: FORBIDDEN, anon: UNAUTHENTICATED } as const;

const ENDPOINTS: EndpointRow[] = [
  {
    name: 'POST /v1/auth/login',
    method: 'POST',
    url: '/v1/auth/login',
    // The door itself: no bearer, no role gate. Each role probe uses its
    // own credentials; the anon probe shows a wrong username is a 401
    // (a failed authentication, not an authorisation outcome).
    probe: (actor) =>
      app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: {
          username: actor ? usernames[actor]! : 'nobody.t10',
          password: PASSWORD,
          device: LOGIN_DEVICE,
        },
      }),
    expect: { ...ALL_ROLES_OK, anon: UNAUTHENTICATED },
    assertOk: (actor, res) => {
      expect(res.json<LoginResponse>().employee.role).toBe(actor);
    },
  },
  {
    name: 'POST /v1/auth/refresh',
    method: 'POST',
    url: '/v1/auth/refresh',
    // Token-based, not bearer-based: the refresh token IS the credential.
    // Each role probe mints a fresh session so the rotation consumes
    // nothing the other probes need. An unknown token is 401 — the one
    // recoverable-sounding refusal (§4).
    probe: async (actor) => {
      const token = actor
        ? (await loginAs(usernames[actor]!)).refreshToken
        : randomBytes(32).toString('base64url');
      return app.inject({ method: 'POST', url: '/v1/auth/refresh', payload: { refreshToken: token } });
    },
    expect: { ...ALL_ROLES_OK, anon: UNAUTHENTICATED },
  },
  {
    name: 'POST /v1/auth/logout',
    method: 'POST',
    url: '/v1/auth/logout',
    // Best-effort by design (§4): logout revokes the presented token and
    // always answers { ok: true } — even for a token that does not
    // exist — so a retried logout on a bad link stays a success.
    probe: async (actor) => {
      const token = actor
        ? (await loginAs(usernames[actor]!)).refreshToken
        : randomBytes(32).toString('base64url');
      return app.inject({ method: 'POST', url: '/v1/auth/logout', payload: { refreshToken: token } });
    },
    expect: { owner: OK, dispatcher: OK, technician: OK, sales_rep: OK, anon: OK },
  },
  {
    name: 'POST /v1/auth/password',
    method: 'POST',
    url: '/v1/auth/password',
    // Self-service for every role (matrix: `employee` update `own`).
    // Each probe uses a dedicated employee so the main accounts keep
    // logging in with the suite password.
    probe: async (actor) => {
      if (!actor) {
        return app.inject({
          method: 'POST',
          url: '/v1/auth/password',
          headers: bearer(null),
          payload: { currentPassword: PASSWORD, newPassword: 'matrix-new-pass-9' },
        });
      }
      const seeded = await seedEmployee(actor);
      const session = await loginAs(seeded.username);
      return app.inject({
        method: 'POST',
        url: '/v1/auth/password',
        headers: { authorization: `Bearer ${session.accessToken}` },
        payload: { currentPassword: PASSWORD, newPassword: `matrix-changed-${randomBytes(3).toString('hex')}` },
      });
    },
    expect: { ...ALL_ROLES_OK, anon: UNAUTHENTICATED },
  },
  {
    name: 'GET /v1/auth/me',
    method: 'GET',
    url: '/v1/auth/me',
    probe: (actor) => app.inject({ method: 'GET', url: '/v1/auth/me', headers: bearer(actor) }),
    expect: { ...ALL_ROLES_OK, anon: UNAUTHENTICATED },
    assertOk: (actor, res) => {
      expect(res.json<{ employee: { role: Role } }>().employee.role).toBe(actor);
    },
  },
  {
    name: 'GET /v1/consents/required',
    method: 'GET',
    url: '/v1/consents/required',
    // Role-blind (§4): the consent is owed by people, not by roles.
    probe: (actor) => app.inject({ method: 'GET', url: '/v1/consents/required', headers: bearer(actor) }),
    expect: { ...ALL_ROLES_OK, anon: UNAUTHENTICATED },
  },
  {
    name: 'POST /v1/consents',
    method: 'POST',
    url: '/v1/consents',
    // Role-blind; each actor accepts what /required says he owes. The
    // UNIQUE (employee, kind, version) makes repeats free.
    probe: async (actor) => {
      if (!actor) {
        return app.inject({
          method: 'POST',
          url: '/v1/consents',
          payload: { kind: 'location_tracking', version: '2026-01-01', deviceId: null },
        });
      }
      const required = await app.inject({
        method: 'GET',
        url: '/v1/consents/required',
        headers: bearer(actor),
      });
      const owed = required.json<{ required: Array<{ kind: string; version: string }> }>().required[0];
      if (!owed) throw new Error(`${actor} should still owe the location_tracking consent`);
      return app.inject({
        method: 'POST',
        url: '/v1/consents',
        headers: bearer(actor),
        payload: { kind: owed.kind, version: owed.version, deviceId: null },
      });
    },
    expect: { ...ALL_ROLES_OK, anon: UNAUTHENTICATED },
  },
  {
    name: 'GET /v1/employees',
    method: 'GET',
    url: '/v1/employees',
    probe: (actor) => app.inject({ method: 'GET', url: '/v1/employees', headers: bearer(actor) }),
    expect: OWNER_ONLY,
    assertOk: (_actor, res) => {
      const roster = employeeListResponseSchema.parse(res.json());
      expect(roster.map((row) => row.id)).toContain(selfIds.owner);
    },
  },
  {
    name: 'POST /v1/employees',
    method: 'POST',
    url: '/v1/employees',
    probe: (actor) =>
      app.inject({
        method: 'POST',
        url: '/v1/employees',
        headers: bearer(actor),
        payload: {
          username: `emp.t10.${randomBytes(4).toString('hex')}`,
          fullName: 'Matrix Probe',
          role: 'technician',
          tempPassword: 'matrix-temp-pass-1',
        },
      }),
    expect: OWNER_ONLY,
  },
  {
    name: 'GET /v1/employees/me',
    method: 'GET',
    url: '/v1/employees/me',
    // The one self-service route on this surface (§4.1) — every role
    // gets his own row, keyed off the token, never the path.
    probe: (actor) => app.inject({ method: 'GET', url: '/v1/employees/me', headers: bearer(actor) }),
    expect: { ...ALL_ROLES_OK, anon: UNAUTHENTICATED },
    assertOk: (actor, res) => {
      if (actor) expect(res.json<{ id: string }>().id).toBe(selfIds[actor]);
    },
  },
  {
    name: 'GET /v1/employees/:id',
    method: 'GET',
    url: '/v1/employees/:id',
    probe: (actor) =>
      app.inject({ method: 'GET', url: `/v1/employees/${subject.id}`, headers: bearer(actor) }),
    expect: OWNER_ONLY,
  },
  {
    name: 'PATCH /v1/employees/:id',
    method: 'PATCH',
    url: '/v1/employees/:id',
    // Non-owner probes carry an If-Match anyway, proving the 403 comes
    // from the gate before the guard's 422 could.
    probe: async (actor) => {
      const ifMatch = actor === 'owner' ? String(await subjectVersion()) : '1';
      return app.inject({
        method: 'PATCH',
        url: `/v1/employees/${subject.id}`,
        headers: { ...bearer(actor), 'if-match': ifMatch },
        payload: { fullName: 'Matrix T10 Patch' },
      });
    },
    expect: OWNER_ONLY,
  },
  {
    name: 'POST /v1/employees/:id/password',
    method: 'POST',
    url: '/v1/employees/:id/password',
    probe: (actor) =>
      app.inject({
        method: 'POST',
        url: `/v1/employees/${subject.id}/password`,
        headers: bearer(actor),
        payload: { tempPassword: 'matrix-reset-pass-1' },
      }),
    expect: OWNER_ONLY,
  },
  {
    name: 'GET /healthz',
    method: 'GET',
    url: '/healthz',
    // Public by design — it is polled by the uptime checker unauthenticated.
    probe: () => app.inject({ method: 'GET', url: '/healthz' }),
    expect: { owner: OK, dispatcher: OK, technician: OK, sales_rep: OK, anon: OK },
    assertOk: (_actor, res) => {
      expect(res.json<{ status: string }>().status).toBe('ok');
    },
  },
];

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

  for (const role of ROLES) {
    const seeded = await seedEmployee(role);
    usernames[role] = seeded.username;
    const session = await loginAs(seeded.username);
    tokens[role] = session.accessToken;
    selfIds[role] = session.employee.id;
  }
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

describe('authorisation matrix — every endpoint × every role (T0.10)', () => {
  for (const endpoint of ENDPOINTS) {
    it(endpoint.name, async () => {
      for (const actor of ACTORS) {
        const want = endpoint.expect[actor ?? 'anon'];
        const label = `${endpoint.name} as ${actor ?? 'anonymous'}`;
        const res = await endpoint.probe(actor);
        expect(res.statusCode, label).toBe(want.status);
        if (want.code !== undefined) {
          expect(envelopeOf(res.statusCode, res.body).code, label).toBe(want.code);
        }
        if (want.status === 200 && endpoint.assertOk) endpoint.assertOk(actor, res);
      }
    });
  }
});

describe('the shrink guard — the matrix covers every registered route', () => {
  /**
   * "Every endpoint built so far appears in the authz suite" is checked,
   * not promised: the routes the server registers are reconstructed from
   * the route tree (HEAD duplicates dropped) and must equal the rows
   * above, and each row must name a route that exists. A new endpoint
   * without a matrix row fails here; a renamed one fails `hasRoute`.
   */
  function registeredRoutes(): Array<{ method: string; url: string }> {
    const routes: Array<{ method: string; url: string }> = [];
    /** Tree children print as suffixes of their parent, so walk with a prefix stack. */
    const prefixes: Array<{ depth: number; prefix: string }> = [];
    for (const line of app.printRoutes({ commonPrefix: false }).split('\n')) {
      const methods = line.match(/\(([^)]+)\)\s*$/);
      if (!methods) continue;
      const branch = line.replace(/\([^)]*\)\s*$/, '');
      const depth = (branch.match(/[\s│]/g) ?? []).length;
      const label = branch.replace(/[│├└─\s]/g, '');
      while (prefixes.length > 0 && prefixes[prefixes.length - 1]!.depth >= depth) prefixes.pop();
      const prefix = prefixes.length > 0 ? prefixes[prefixes.length - 1]!.prefix : '';
      const url = prefix + label;
      prefixes.push({ depth, prefix: url });
      for (const method of methods[1]!.split(', ')) {
        // HEAD is Fastify's automatic twin of every GET.
        //
        // OPTIONS is @fastify/cors' wildcard preflight handler, and it is
        // deliberately outside the matrix: a preflight carries no
        // credentials, reads nothing and returns no body — it answers
        // "may I ask?", never "here is the answer". Authorising it per
        // role would be authorising a question. What it *does* need is
        // its own allowlist assertions, and those live in
        // test/integration/cors.test.ts.
        if (method !== 'HEAD' && method !== 'OPTIONS') routes.push({ method, url });
      }
    }
    return routes;
  }

  it('one matrix row per registered route, no more, no fewer', () => {
    const registered = registeredRoutes().map((r) => `${r.method} ${r.url}`).sort();
    const tested = ENDPOINTS.map((e) => `${e.method} ${e.url}`).sort();
    expect(registered, 'routes the server registers').toEqual(tested);
    for (const endpoint of ENDPOINTS) {
      expect(app.hasRoute({ method: endpoint.method, url: endpoint.url }), endpoint.name).toBe(true);
    }
  });
});
