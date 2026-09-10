import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import sharp from 'sharp';
import type { FastifyInstance } from 'fastify';
import {
  CashHandoverSchema,
  deviceDiagnosticSchema,
  employeeListResponseSchema,
  errorEnvelopeSchema,
  pingBatchResultSchema,
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

/** A job assigned to the matrix technician, for the jobs-endpoint probes. */
let customerId = '';
let serviceId = '';
let matrixJobId = '';
/** An attachment on the matrix technician's job, for the GET probe. */
let matrixAttachmentId = '';

/** A tiny valid PNG — big enough to sniff, small enough to not care about. */
async function probePng(): Promise<Buffer> {
  return sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 1, g: 2, b: 3 } } }).png().toBuffer();
}

/** Hand-built multipart body (the same wire format light-my-request cannot easily produce). */
function multipartBody(fields: Record<string, string>, file: { data: Buffer; filename: string }): {
  payload: Buffer;
  contentType: string;
} {
  const boundary = `----servgridt10${randomBytes(8).toString('hex')}`;
  const chunks: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`, 'utf8'));
  }
  chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.filename}"\r\n\r\n`, 'utf8'));
  chunks.push(file.data, Buffer.from('\r\n', 'utf8'));
  chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  return { payload: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

/** The upload probe's form fields, checksum consistent with the bytes sent. */
function uploadFields(jobId: string, bytes: Buffer): Record<string, string> {
  return {
    ownerType: 'job_card',
    ownerId: jobId,
    kind: 'photo',
    capturedAt: '2026-09-11T09:00:00Z',
    fileChecksum: createHash('sha256').update(bytes).digest('hex'),
  };
}

/** The matrix IST business date — the same `business_date()` the §10 bounds use. */
let todayIst = '';

/**
 * A submitted declaration for the matrix actor, idempotent per
 * (employee, day) — the constraint itself makes repeat probes free.
 */
async function seedSubmittedHandover(employeeId: string): Promise<{ id: string; version: number }> {
  await db.query(
    `INSERT INTO cash_reconciliations (employee_id, business_date, declared_amount, declared_at)
     VALUES ($1, $2::date, '2500.00', now())
     ON CONFLICT (employee_id, business_date) DO NOTHING`,
    [employeeId, todayIst],
  );
  const r = await db.query<{ id: string; version: number }>(
    `SELECT id, version FROM cash_reconciliations WHERE employee_id = $1 AND business_date = $2::date`,
    [employeeId, todayIst],
  );
  return r.rows[0]!;
}

async function seedJobAssignedToTechnician(): Promise<string> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO job_cards (job_number, customer_id, service_id, title, status, assigned_to, assigned_at)
     VALUES ($1, $2, $3, 'Matrix probe job', 'assigned', $4, now()) RETURNING id`,
    [`JC-T10-${randomBytes(4).toString('hex')}`, customerId, serviceId, selfIds.technician],
  );
  return r.rows[0]!.id;
}

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
/** §6.3: the owner and dispatcher see every job, a technician his own, a sales rep nothing. */
const JOB_READERS = { owner: OK, dispatcher: OK, technician: OK, sales_rep: FORBIDDEN, anon: UNAUTHENTICATED } as const;
/** §6.3: the status move is "technician (own), owner". */
const STATUS_ACTORS = { owner: OK, dispatcher: FORBIDDEN, technician: OK, sales_rep: FORBIDDEN, anon: UNAUTHENTICATED } as const;
/** §6.3: completion is "technician (own), owner", gated on `job.money` × `create` — a dispatcher's cell there is `none` outright. */
const COMPLETION_ACTORS = { owner: OK, dispatcher: FORBIDDEN, technician: OK, sales_rep: FORBIDDEN, anon: UNAUTHENTICATED } as const;

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
    name: 'GET /v1/jobs',
    method: 'GET',
    url: '/v1/jobs',
    // Role-scoped list (§6.3): owner and dispatcher read all, a technician
    // his own, a sales rep nothing (matrix: job read none).
    probe: (actor) => app.inject({ method: 'GET', url: '/v1/jobs', headers: bearer(actor) }),
    expect: JOB_READERS,
    assertOk: (_actor, res) => {
      expect(Array.isArray(res.json<{ items: unknown[] }>().items)).toBe(true);
    },
  },
  {
    name: 'GET /v1/jobs/:id',
    method: 'GET',
    url: '/v1/jobs/:id',
    // The matrix technician's own job — the technician probe proves the
    // right row came back; the sales rep's cell is `none`, not `own`.
    probe: (actor) => app.inject({ method: 'GET', url: `/v1/jobs/${matrixJobId}`, headers: bearer(actor) }),
    expect: JOB_READERS,
    assertOk: (actor, res) => {
      if (actor === 'technician') expect(res.json<{ id: string }>().id).toBe(matrixJobId);
    },
  },
  {
    name: 'POST /v1/jobs/:id/status',
    method: 'POST',
    url: '/v1/jobs/:id/status',
    // A fresh assigned job per probe: the owner and the assignee step it
    // (200); the dispatcher's doors are assign and cancel, not the stepper;
    // the sales rep and the anonymous caller never get past the gate. The
    // body parses after requireAuth, so `anon` is 401, not 422.
    probe: async (actor) => {
      const jobId = await seedJobAssignedToTechnician();
      return app.inject({
        method: 'POST',
        url: `/v1/jobs/${jobId}/status`,
        headers: bearer(actor),
        payload: { to: 'en_route', occurredAt: new Date().toISOString() },
      });
    },
    expect: STATUS_ACTORS,
    assertOk: (actor, res) => {
      if (actor === 'technician') expect(res.json<{ status: string }>().status).toBe('en_route');
    },
  },
  {
    name: 'POST /v1/jobs/:id/complete',
    method: 'POST',
    url: '/v1/jobs/:id/complete',
    // A fresh assigned job per probe (§6.2: completing straight from
    // assigned is legal): the owner and the assignee close it; the
    // dispatcher's `job.money` is `none`, so he is 403 before the body
    // is even read; the sales rep likewise; the anonymous caller is 401.
    probe: async (actor) => {
      const jobId = await seedJobAssignedToTechnician();
      return app.inject({
        method: 'POST',
        url: `/v1/jobs/${jobId}/complete`,
        headers: bearer(actor),
        payload: { completedAt: new Date().toISOString(), workSummary: 'Matrix probe completion.' },
      });
    },
    expect: COMPLETION_ACTORS,
    assertOk: (actor, res) => {
      if (actor === 'technician') expect(res.json<{ status: string }>().status).toBe('completed');
    },
  },
  {
    name: 'POST /v1/devices',
    method: 'POST',
    url: '/v1/devices',
    // Self-service by construction (§8): employee_id comes from the token,
    // never the body, so every authenticated role registers its own device
    // — there is no `device` resource in the matrix to refuse a cell with,
    // and the row cannot name anyone but the caller.
    probe: (actor) =>
      app.inject({
        method: 'POST',
        url: '/v1/devices',
        headers: bearer(actor),
        payload: {
          installId: `matrix-${String(actor)}-${randomBytes(3).toString('hex')}`,
          platform: 'android',
          appVersion: '0.1.0',
          osVersion: '14',
          manufacturer: 'Xiaomi',
          model: 'Redmi Note 12',
          locationPermission: 'background',
        },
      }),
    expect: { ...ALL_ROLES_OK, anon: UNAUTHENTICATED },
    assertOk: (actor, res) => {
      const device = deviceDiagnosticSchema.parse(res.json());
      expect(device.installId.startsWith(`matrix-${String(actor)}`)).toBe(true);
    },
  },
  {
    name: 'POST /v1/location/pings',
    method: 'POST',
    url: '/v1/location/pings',
    // The matrix's `location.send` cell (§5): the tracked field roles
    // send, the owner is `all`, and a dispatcher's cell is `none` — he
    // may know a device went quiet, never where anyone is. The body is
    // parsed after requireAuth, so `anon` is 401, not 422. A per-ping
    // rejection is still HTTP 200 (§8), so the accepted probes assert
    // only that every ping got an outcome.
    probe: (actor) =>
      app.inject({
        method: 'POST',
        url: '/v1/location/pings',
        headers: bearer(actor),
        payload: {
          pings: [
            {
              recordedAt: new Date().toISOString(),
              latitude: 12.9716,
              longitude: 77.5946,
              accuracyM: 20,
              source: 'scheduled',
            },
          ],
        },
      }),
    expect: { owner: OK, dispatcher: FORBIDDEN, technician: OK, sales_rep: OK, anon: UNAUTHENTICATED },
    assertOk: (_actor, res) => {
      const result = pingBatchResultSchema.parse(res.json());
      expect(result.accepted + result.rejected.length).toBe(1);
    },
  },
  {
    name: 'POST /v1/attachments',
    method: 'POST',
    url: '/v1/attachments',
    // §9: attachments on a job are governed by the `job` update cell, so
    // the owner and the dispatcher (all), and the assignee technician
    // (own), may upload to the matrix technician's job; the sales rep
    // (none) may not. Each probe uploads its own tiny PNG under its own
    // Idempotency-Key; the body parses after requireAuth, so `anon` is
    // 401, not 422.
    probe: async (actor) => {
      const bytes = await probePng();
      const body = multipartBody(uploadFields(matrixJobId, bytes), {
        data: bytes,
        filename: 'probe.png',
      });
      return app.inject({
        method: 'POST',
        url: '/v1/attachments',
        headers: {
          ...bearer(actor),
          'content-type': body.contentType,
          'idempotency-key': randomUUID(),
        },
        payload: body.payload,
      });
    },
    expect: {
      owner: OK,
      dispatcher: OK,
      technician: OK,
      sales_rep: FORBIDDEN,
      anon: UNAUTHENTICATED,
    },
    assertOk: (_actor, res) => {
      const created = res.json<{ id: string; storageKey: string }>();
      expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(created.storageKey).toMatch(/^job_card\//);
    },
  },
  {
    name: 'GET /v1/attachments/:id',
    method: 'GET',
    url: '/v1/attachments/:id',
    // §9: the read follows the `job` read cell — owner and dispatcher
    // all, the matrix technician own (his job's attachment), the sales
    // rep none. A 302 with an empty body and a Location header is the
    // success shape: permission-checked, then handed a presigned URL —
    // never proxied bytes.
    probe: (actor) =>
      app.inject({ method: 'GET', url: `/v1/attachments/${matrixAttachmentId}`, headers: bearer(actor) }),
    expect: {
      owner: { status: 302 },
      dispatcher: { status: 302 },
      technician: { status: 302 },
      sales_rep: FORBIDDEN,
      anon: UNAUTHENTICATED,
    },
    assertOk: (_actor, res) => {
      expect(res.body).toBe('');
      const location = res.headers['location'];
      expect(typeof location).toBe('string');
      expect((location as string).includes('X-Amz-Signature')).toBe(true);
    },
  },
  {
    name: 'POST /v1/cash/handovers',
    method: 'POST',
    url: '/v1/cash/handovers',
    // §10 (T1.11): technician and sales rep declare their own; the owner's
    // cash.declare create cell is `none` (he confirms and reopens, he never
    // declares) and the dispatcher has no cash cell at all.
    probe: (actor) =>
      app.inject({
        method: 'POST',
        url: '/v1/cash/handovers',
        headers: bearer(actor),
        payload: { businessDate: todayIst, declaredAmount: '1500' },
      }),
    expect: { owner: FORBIDDEN, dispatcher: FORBIDDEN, technician: OK, sales_rep: OK, anon: UNAUTHENTICATED },
    assertOk: (_actor, res) => {
      expect(CashHandoverSchema.parse(res.json()).status).toBe('submitted');
    },
  },
  {
    name: 'GET /v1/cash/handovers/me',
    method: 'GET',
    url: '/v1/cash/handovers/me',
    // Own history keyed off the token. The dispatcher's cash read cell is
    // `none`; the owner reads all — an empty history, since he cannot
    // declare — and so passes the same gate.
    probe: async (actor) => {
      if (actor === 'technician' || actor === 'sales_rep') await seedSubmittedHandover(selfIds[actor]!);
      return app.inject({ method: 'GET', url: '/v1/cash/handovers/me', headers: bearer(actor) });
    },
    expect: { owner: OK, dispatcher: FORBIDDEN, technician: OK, sales_rep: OK, anon: UNAUTHENTICATED },
    assertOk: (_actor, res) => {
      expect(Array.isArray(res.json())).toBe(true);
    },
  },
  {
    name: 'PATCH /v1/cash/handovers/:id',
    method: 'PATCH',
    url: '/v1/cash/handovers/:id',
    // §10 (T1.11): the declaring employee only, while his row is
    // submitted. Refused probes carry If-Match anyway, proving the 403
    // comes from the gate before the guard's 422 could.
    probe: async (actor) => {
      if (actor === 'technician' || actor === 'sales_rep') {
        const row = await seedSubmittedHandover(selfIds[actor]!);
        return app.inject({
          method: 'PATCH',
          url: `/v1/cash/handovers/${row.id}`,
          headers: { ...bearer(actor), 'if-match': String(row.version) },
          payload: { declaredAmount: '2600' },
        });
      }
      return app.inject({
        method: 'PATCH',
        url: `/v1/cash/handovers/${randomUUID()}`,
        headers: { ...bearer(actor), 'if-match': '1' },
        payload: { declaredAmount: '2600' },
      });
    },
    expect: { owner: FORBIDDEN, dispatcher: FORBIDDEN, technician: OK, sales_rep: OK, anon: UNAUTHENTICATED },
    assertOk: (_actor, res) => {
      expect(CashHandoverSchema.parse(res.json()).version).toBe(2);
    },
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

  // The jobs-endpoint probes need a real job (migration 007) assigned to
  // the matrix technician.
  customerId = (
    await db.query<{ id: string }>(
      `INSERT INTO customers (name, phone) VALUES ('Matrix T10 Customer', '9840000001') RETURNING id`,
    )
  ).rows[0]!.id;
  serviceId = (
    await db.query<{ id: string }>(
      `INSERT INTO services (code, name) VALUES ('T10-MATRIX', 'Matrix suite service') RETURNING id`,
    )
  ).rows[0]!.id;
  matrixJobId = await seedJobAssignedToTechnician();

  // The GET /v1/attachments/:id probe needs an attachment on the matrix
  // technician's job — landed once, through the API itself, exactly the
  // way a real upload arrives.
  const bytes = await probePng();
  const body = multipartBody(uploadFields(matrixJobId, bytes), { data: bytes, filename: 'fixture.png' });
  const uploaded = await app.inject({
    method: 'POST',
    url: '/v1/attachments',
    headers: {
      authorization: `Bearer ${tokens.technician}`,
      'content-type': body.contentType,
      'idempotency-key': randomUUID(),
    },
    payload: body.payload,
  });
  expect(uploaded.statusCode, uploaded.body).toBe(200);
  matrixAttachmentId = uploaded.json<{ id: string }>().id;
  todayIst = (await db.query<{ d: string }>('SELECT business_date(now())::text AS d')).rows[0]!.d;
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
        // Any 2xx counts as a success shape worth asserting on — the
        // attachments GET answers 302, not 200 (§9), and its Location
        // needs the check as much as a 200's body does.
        if (want.status >= 200 && want.status < 300 && endpoint.assertOk) endpoint.assertOk(actor, res);
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
