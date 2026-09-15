import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import sharp from 'sharp';
import type { FastifyInstance } from 'fastify';
import {
  CashHandoverSchema,
  cashQueueRowSchema,
  deviceDiagnosticSchema,
  employeeListResponseSchema,
  errorEnvelopeSchema,
  pingBatchResultSchema,
  trackingHealthSchema,
  type ErrorCode,
  type ErrorEnvelope,
  type LoginResponse,
  type Role,
} from '@servgrid/shared';
import { loadConfig, type Config } from '../../src/config.js';
import { closePool } from '../../src/db/pool.js';
import { runMigrations } from '../../src/db/migrate.js';
import { ownerAttentionResponseSchema, ownerDashboardResponseSchema } from '../../src/modules/dashboard/schemas.js';
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
/** A unit at the matrix customer, for the §6.4 stack probes. */
let stackItemId = '';
/** Catalogue rows for the owner-only PATCH probes. */
let matrixProductId = '';
let matrixServiceRowId = '';
/** A company the matrix sales_rep OWNS — the row-scoped company probes' target (T3.2). */
let matrixCompanyId = '';
/** An attachment on the matrix technician's job, for the GET probe. */
let matrixAttachmentId = '';
/** A locate-now request by the matrix owner, for the GET probe (T4.4). */
let matrixLocationRequestId = '';

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

/**
 * A submitted declaration on a DISTINCT day per owner-action probe
 * (T4.2): confirm, dispute and reopen each need their own row, and the
 * (employee, business_date) constraint makes a second seed for one day a
 * no-op that would hand the next probe an already-signed-off row.
 */
async function seedHandoverOnDay(employeeId: string, offsetDays: number): Promise<string> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO cash_reconciliations (employee_id, business_date, declared_amount, declared_at)
     VALUES ($1, business_date(now()) + $2::int, '2500.00', now()) RETURNING id`,
    [employeeId, offsetDays],
  );
  return r.rows[0]!.id;
}

/** Signed off exactly as the confirm endpoint would leave it — the reopen probe's target. */
async function confirmHandoverInDb(id: string): Promise<void> {
  await db.query(
    `UPDATE cash_reconciliations
     SET status = 'confirmed', confirmed_amount = declared_amount,
         confirmed_by = $2, confirmed_at = now()
     WHERE id = $1`,
    [id, selfIds.owner],
  );
}

async function seedJobAssignedToTechnician(): Promise<string> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO job_cards (job_number, customer_id, service_id, title, status, assigned_to, assigned_at)
     VALUES ($1, $2, $3, 'Matrix probe job', 'assigned', $4, now()) RETURNING id`,
    [`JC-T10-${randomBytes(4).toString('hex')}`, customerId, serviceId, selfIds.technician],
  );
  return r.rows[0]!.id;
}

/** A fresh UNASSIGNED job at version 1 — the assign probes' target (T2.3). */
async function seedJobUnassigned(): Promise<string> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO job_cards (job_number, customer_id, service_id, title, status)
     VALUES ($1, $2, $3, 'Matrix probe job', 'unassigned') RETURNING id`,
    [`JC-T10-${randomBytes(4).toString('hex')}`, customerId, serviceId],
  );
  return r.rows[0]!.id;
}

/**
 * A COMPLETED job with its completion row — the amend probe's target
 * (T4.3). No covering `cash_reconciliations` row is seeded, so the day is
 * open and the owner's probe reaches 200; the 409 path (a confirmed day)
 * is integration/amendment.test.ts's subject.
 */
async function seedCompletedJobWithCompletion(): Promise<string> {
  const jobId = (
    await db.query<{ id: string }>(
      `INSERT INTO job_cards (job_number, customer_id, service_id, title, status,
                              assigned_to, assigned_at, scheduled_for, closed_at)
       VALUES ($1, $2, $3, 'Matrix probe job', 'completed', $4, $5, $5, $5) RETURNING id`,
      [
        `JC-T10-${randomBytes(4).toString('hex')}`,
        customerId,
        serviceId,
        selfIds.technician,
        new Date().toISOString(),
      ],
    )
  ).rows[0]!.id;
  await db.query(
    `INSERT INTO job_completions
       (job_card_id, completed_by, completed_at, work_summary, cost, collection_mode)
     VALUES ($1, $2, now(), 'Matrix probe completion.', 100, 'cash')`,
    [jobId, selfIds.technician],
  );
  return jobId;
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
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
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
/** §6.2b (T4.3): amendment is "owner only" — the `job.money` × `update` cell, which only the owner holds (a technician's is write-once at completion, a dispatcher's and a rep's `none`). */
const AMEND_COMPLETION_ACTORS = { owner: OK, dispatcher: FORBIDDEN, technician: FORBIDDEN, sales_rep: FORBIDDEN, anon: UNAUTHENTICATED } as const;
/** §6.3: cancellation is "dispatcher, owner, technician (own)" — the `job` × `update` cell, which a sales rep does not hold. */
const CANCEL_ACTORS = { owner: OK, dispatcher: OK, technician: OK, sales_rep: FORBIDDEN, anon: UNAUTHENTICATED } as const;
/** §6.3: rescheduling (PATCH of scheduled_for) is "dispatcher, owner" — on site, the technician cancels with a new date instead. */
const RESCHEDULE_ACTORS = { owner: OK, dispatcher: OK, technician: FORBIDDEN, sales_rep: FORBIDDEN, anon: UNAUTHENTICATED } as const;
/** §6.3 (T2.3): assignment and bulk reassign are "dispatcher, owner" — the `job.assign` cell, which a technician and a rep do not hold. */
const ASSIGN_ACTORS = { owner: OK, dispatcher: OK, technician: FORBIDDEN, sales_rep: FORBIDDEN, anon: UNAUTHENTICATED } as const;
/** §7 (TON.1): the work read is the technician's own list — the office reads the job list instead. */
const TECHNICIAN_WORK_ACTORS = { owner: FORBIDDEN, dispatcher: FORBIDDEN, technician: OK, sales_rep: FORBIDDEN, anon: UNAUTHENTICATED } as const;
/** §11/PLAN.md §5: the rep works his accounts plus the house accounts (`own` on company), the
 * owner sees all — a dispatcher holds no company cell at all, a technician neither. */
const COMPANY_ACTORS = { owner: OK, dispatcher: FORBIDDEN, technician: FORBIDDEN, sales_rep: OK, anon: UNAUTHENTICATED } as const;
/** §6.4: the customer is read by the office and, through a job, by the technician on site — never by a sales rep. */
const CUSTOMER_READERS = { owner: OK, dispatcher: OK, technician: OK, sales_rep: FORBIDDEN, anon: UNAUTHENTICATED } as const;
/** §6.4/PLAN.md §5: customers are created and edited by the office — and the dispatcher's payload
 * is stripped of `company_id` server-side (a write his matrix cell cannot carry). */
const CUSTOMER_WRITERS = { owner: OK, dispatcher: OK, technician: FORBIDDEN, sales_rep: FORBIDDEN, anon: UNAUTHENTICATED } as const;
/** §6.4/PLAN.md §5: the stack is written by the owner and, at a site he has or has had a job
 * for, by the technician — a dispatcher holds none of the `customer.stack` cell at all. */
const STACK_WRITERS = { owner: OK, dispatcher: FORBIDDEN, technician: OK, sales_rep: FORBIDDEN, anon: UNAUTHENTICATED } as const;
/** §6.4: the catalogue (products, services) is read by everyone — the completion form and the sales picker both need it. */
const CATALOG_READERS = { ...ALL_ROLES_OK, anon: UNAUTHENTICATED } as const;

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
    name: 'PUT /v1/employees/:id/flags',
    method: 'PUT',
    url: '/v1/employees/:id/flags',
    // Flag flips are employee administration (PLAN-EXECUTION.md §3): the
    // owner's T0 instrument, same `employee` update cell as PATCH above.
    probe: (actor) =>
      app.inject({
        method: 'PUT',
        url: `/v1/employees/${subject.id}/flags`,
        headers: bearer(actor),
        payload: { flag: 'tech.jobs', enabled: false },
      }),
    expect: OWNER_ONLY,
  },
  {
    name: 'GET /v1/flags',
    method: 'GET',
    url: '/v1/flags',
    probe: (actor) => app.inject({ method: 'GET', url: '/v1/flags', headers: bearer(actor) }),
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
    name: 'GET /v1/jobs/:id/events',
    method: 'GET',
    url: '/v1/jobs/:id/events',
    // The timeline (§6.3, T4.11, TON.1): the office reads every job's; the
    // technician reads his OWN job's (matrixJobId is his), in the
    // dispatcher's redacted shape; a sales rep holds no job read at all.
    // Both smaller answers carry no completion block, asserted by role.
    probe: (actor) => app.inject({ method: 'GET', url: `/v1/jobs/${matrixJobId}/events`, headers: bearer(actor) }),
    expect: { owner: OK, dispatcher: OK, technician: OK, sales_rep: FORBIDDEN, anon: UNAUTHENTICATED },
    assertOk: (actor, res) => {
      const body = res.json<{ events: unknown[]; completion?: unknown }>();
      expect(Array.isArray(body.events)).toBe(true);
      if (actor === 'dispatcher' || actor === 'technician') expect(body).not.toHaveProperty('completion');
    },
  },
  {
    name: 'GET /v1/jobs/summary',
    method: 'GET',
    url: '/v1/jobs/summary',
    // The dashboard figures (T2.7, §D1): an all-rows console read, so
    // the gate is requireAll on `job` × `read` behind `dispatch.console`
    // — a technician's `own` cell counts his day, not the desk's, and
    // is refused here.
    probe: (actor) => app.inject({ method: 'GET', url: '/v1/jobs/summary', headers: bearer(actor) }),
    expect: { owner: OK, dispatcher: OK, technician: FORBIDDEN, sales_rep: FORBIDDEN, anon: UNAUTHENTICATED },
    assertOk: (_actor, res) => {
      const body = res.json<{ overdue: number; unassigned: number; today: number; doneToday: number }>();
      for (const key of ['overdue', 'unassigned', 'today', 'doneToday'] as const) {
        expect(typeof body[key], key).toBe('number');
      }
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
    name: 'POST /v1/jobs/:id/completion/amend',
    method: 'POST',
    url: '/v1/jobs/:id/completion/amend',
    // The owner's correction of a filed completion (§6.2b, T4.3): the
    // `job.money` × `update` cell is the owner's alone — a dispatcher's
    // is `none` outright and a technician's is write-once at completion —
    // so the three field roles are 403 before the body is read and the
    // anonymous caller is 401. The `owner.amend` flag rides enabled for
    // the matrix owner (see beforeAll); its dark side is
    // integration/amendment.test.ts's subject.
    probe: async (actor) => {
      const jobId = await seedCompletedJobWithCompletion();
      return app.inject({
        method: 'POST',
        url: `/v1/jobs/${jobId}/completion/amend`,
        headers: bearer(actor),
        payload: { cost: '50', reason: 'Matrix probe amendment.' },
      });
    },
    expect: AMEND_COMPLETION_ACTORS,
    assertOk: (_actor, res) => {
      const card = res.json<{ cost: string; amountCollected: string }>();
      expect(card.cost).toBe('50.00');
      expect(card.amountCollected).toBe('50.00');
    },
  },
  {
    name: 'POST /v1/jobs/:id/cancel',
    method: 'POST',
    url: '/v1/jobs/:id/cancel',
    // A fresh assigned job per probe (§6.3): the assignee and the office
    // close it; a technician's cell is `own`, so the row check in the
    // service is what puts him inside; the sales rep holds none of the
    // `job` × `update` cell and is 403 before the body is read; the
    // anonymous caller is 401.
    probe: async (actor) => {
      const jobId = await seedJobAssignedToTechnician();
      return app.inject({
        method: 'POST',
        url: `/v1/jobs/${jobId}/cancel`,
        headers: bearer(actor),
        payload: { reasonCode: 'no_access', reasonNote: 'Matrix probe cancellation.' },
      });
    },
    expect: CANCEL_ACTORS,
    assertOk: (actor, res) => {
      if (actor !== null) expect(res.json<{ status: string }>().status).toBe('cancelled');
    },
  },
  {
    name: 'PATCH /v1/jobs/:id',
    method: 'PATCH',
    url: '/v1/jobs/:id',
    // Rescheduling (§6.3): the office's door, under `If-Match` — a fresh
    // job is at version 1, so the probe sends that; a technician, even on
    // his own job, is 403 (his on-site reschedule is cancel with a
    // `rescheduleTo`); a sales rep and the anonymous caller never pass
    // the gate.
    probe: async (actor) => {
      const jobId = await seedJobAssignedToTechnician();
      return app.inject({
        method: 'PATCH',
        url: `/v1/jobs/${jobId}`,
        headers: { ...bearer(actor), 'if-match': '1' },
        payload: { scheduledFor: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() },
      });
    },
    expect: RESCHEDULE_ACTORS,
    assertOk: (actor, res) => {
      if (actor !== null) expect(res.json<{ status: string }>().status).toBe('assigned'); // status left alone
    },
  },
  {
    name: 'POST /v1/jobs/:id/assign',
    method: 'POST',
    url: '/v1/jobs/:id/assign',
    // Assignment (§6.3, T2.3): the office's door — the `job.assign` cell
    // is the owner's and the dispatcher's; a technician and a rep hold
    // `none` and are 403 before the body is read. A fresh unassigned job
    // is at version 1, so the probe sends that; the console flag rides
    // enabled for the office roles (see beforeAll). The anonymous caller
    // is 401 at requireAuth, before the precondition is even read.
    probe: async (actor) => {
      const jobId = await seedJobUnassigned();
      return app.inject({
        method: 'POST',
        url: `/v1/jobs/${jobId}/assign`,
        headers: { ...bearer(actor), 'if-match': '1' },
        payload: { technicianId: selfIds.technician },
      });
    },
    expect: ASSIGN_ACTORS,
    assertOk: (actor, res) => {
      if (actor !== null) {
        const card = res.json<{ status: string; assignedTo: string | null }>();
        expect(card.status).toBe('assigned');
        expect(card.assignedTo).toBe(selfIds.technician);
      }
    },
  },
  {
    name: 'POST /v1/jobs/bulk-assign',
    method: 'POST',
    url: '/v1/jobs/bulk-assign',
    // Bulk reassign (§6.3, T2.3): the same `job.assign` cell, behind the
    // separate `dispatch.bulk` flag (also riding enabled here). One job
    // at version 1 — the partial-result behaviour itself is
    // integration/assign.test.ts's subject; this row pins who may call.
    probe: async (actor) => {
      const jobId = await seedJobUnassigned();
      return app.inject({
        method: 'POST',
        url: '/v1/jobs/bulk-assign',
        headers: bearer(actor),
        payload: { technicianId: selfIds.technician, jobIds: [{ id: jobId, ifMatch: 1 }] },
      });
    },
    expect: ASSIGN_ACTORS,
    assertOk: (_actor, res) => {
      const body = res.json<{ results: Array<{ ok: boolean; job?: { assignedTo: string | null } }> }>();
      expect(body.results).toHaveLength(1);
      expect(body.results[0]!.ok).toBe(true);
      expect(body.results[0]!.job!.assignedTo).toBe(selfIds.technician);
    },
  },
  {
    name: 'GET /v1/technicians/load',
    method: 'GET',
    url: '/v1/technicians/load',
    // The picker (§6.3, T2.3): dispatcher and owner read `v_technician_load`
    // — and get technician NAMES, since /v1/employees is owner-only; a
    // technician and a rep hold none of `job.assign` read. The row for the
    // matrix technician proves the right rows came back.
    probe: (actor) => app.inject({ method: 'GET', url: '/v1/technicians/load', headers: bearer(actor) }),
    expect: ASSIGN_ACTORS,
    assertOk: (_actor, res) => {
      const rows = res.json<Array<{ employeeId: string; technicianName: string }>>();
      expect(Array.isArray(rows)).toBe(true);
      expect(rows.some((row) => row.employeeId === selfIds.technician)).toBe(true);
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
    name: 'GET /v1/location/health',
    method: 'GET',
    url: '/v1/location/health',
    // §8 (T2.7): the roster warning on the dispatcher's dashboard — the
    // Phase 2 half of the health table. The gate is requireAll on
    // `location.health` × read behind `dispatch.console`: the office
    // roles hold `all`, the tracked roles hold `own` and are served by
    // /health/me, so they are refused at this door, never handed a
    // collection to enumerate. The rows carry health and last-ping age;
    // no coordinate key exists anywhere in the payload (the money-leak
    // walk holds that boundary by key, T2.7's "if it fails").
    probe: (actor) => app.inject({ method: 'GET', url: '/v1/location/health', headers: bearer(actor) }),
    expect: { owner: OK, dispatcher: OK, technician: FORBIDDEN, sales_rep: FORBIDDEN, anon: UNAUTHENTICATED },
    assertOk: (_actor, res) => {
      const rows = res.json<Array<Record<string, unknown>>>();
      expect(Array.isArray(rows)).toBe(true);
      for (const row of rows) {
        expect(row, 'a health row').toHaveProperty('health');
        expect(row).toHaveProperty('minutesSince');
        expect(row).not.toHaveProperty('latitude');
        expect(row).not.toHaveProperty('longitude');
      }
    },
  },
  {
    name: 'GET /v1/location/health/me',
    method: 'GET',
    url: '/v1/location/health/me',
    // §8 (T1.12): the health chip's self-scoped read. The route asks for
    // the `own` cell on `location.health` × read — the technician and the
    // sales rep have it; the dispatcher's `all` is the Phase 2 roster
    // surface, not this chip, and the owner's `all` is the Phase 4 console
    // — so both are 403 here whatever their cell's breadth. A 200 is the
    // actor's own single row keyed off the token.
    probe: (actor) => app.inject({ method: 'GET', url: '/v1/location/health/me', headers: bearer(actor) }),
    expect: { owner: FORBIDDEN, dispatcher: FORBIDDEN, technician: OK, sales_rep: OK, anon: UNAUTHENTICATED },
    assertOk: (actor, res) => {
      const row = trackingHealthSchema.parse(res.json());
      expect(row.employeeId).toBe(selfIds[actor!]);
    },
  },
  {
    name: 'POST /v1/location/requests',
    method: 'POST',
    url: '/v1/location/requests',
    // §8 (T4.4): locate-now — the console's write. `location.read` ×
    // create is the owner's `all` and nobody else's anything: the
    // dispatcher is refused at the door, exactly as for the roster read
    // below, because a request row names a position someone will draw.
    // The gate is requireAll behind `owner.location`; the body parses
    // after requireAuth, so `anon` is 401, not 422. No matrix device
    // holds an FCM token, so the owner's probe lands on the honest
    // no_pushable_device close — 200 with the row, never an error.
    probe: (actor) =>
      app.inject({
        method: 'POST',
        url: '/v1/location/requests',
        headers: bearer(actor),
        payload: { employeeId: subject.id, mode: 'fix' },
      }),
    expect: { owner: OK, dispatcher: FORBIDDEN, technician: FORBIDDEN, sales_rep: FORBIDDEN, anon: UNAUTHENTICATED },
    assertOk: (_actor, res) => {
      const row = res.json<Record<string, unknown>>();
      expect(row['targetEmployeeId']).toBe(subject.id);
      expect(row['mode']).toBe('fix');
      expect(['failed', 'pushed']).toContain(row['status']);
    },
  },
  {
    name: 'GET /v1/location/requests/:id',
    method: 'GET',
    url: '/v1/location/requests/:id',
    // §8 (T4.4): the poll. Owner only, same cell as the create — a
    // request row's lifecycle IS position information in waiting.
    probe: (actor) =>
      app.inject({
        method: 'GET',
        url: `/v1/location/requests/${matrixLocationRequestId}`,
        headers: bearer(actor),
      }),
    expect: { owner: OK, dispatcher: FORBIDDEN, technician: FORBIDDEN, sales_rep: FORBIDDEN, anon: UNAUTHENTICATED },
    assertOk: (_actor, res) => {
      const row = res.json<Record<string, unknown>>();
      expect(row['id']).toBe(matrixLocationRequestId);
      expect(row['targetEmployeeId']).toBe(subject.id);
    },
  },
  {
    name: 'GET /v1/location/employees',
    method: 'GET',
    url: '/v1/location/employees',
    // §8's Phase 4 row (T4.4): latest position + health per tracked
    // employee. THE coordinate surface — the one place the `location
    // .health` / `location.read` split puts coordinates on the wire — so
    // the matrix gives it to the owner alone and the walk asserts the
    // others are refused, not merely unlisted.
    probe: (actor) => app.inject({ method: 'GET', url: '/v1/location/employees', headers: bearer(actor) }),
    expect: { owner: OK, dispatcher: FORBIDDEN, technician: FORBIDDEN, sales_rep: FORBIDDEN, anon: UNAUTHENTICATED },
    assertOk: (_actor, res) => {
      const rows = res.json<Array<Record<string, unknown>>>();
      expect(Array.isArray(rows)).toBe(true);
      for (const row of rows) {
        expect(row, 'a console roster row').toHaveProperty('health');
        expect(row).toHaveProperty('position');
        expect(['technician', 'sales_rep']).toContain(row['role']);
      }
    },
  },
  {
    name: 'GET /v1/location/employees/:id/trail',
    method: 'GET',
    url: '/v1/location/employees/:id/trail',
    // §8's Phase 4 row (T4.4): a day's ordered pings. Owner alone, for
    // the same reason as the roster — the trail is coordinates in bulk.
    probe: (actor) =>
      app.inject({
        method: 'GET',
        url: `/v1/location/employees/${subject.id}/trail?date=${todayIst}`,
        headers: bearer(actor),
      }),
    expect: { owner: OK, dispatcher: FORBIDDEN, technician: FORBIDDEN, sales_rep: FORBIDDEN, anon: UNAUTHENTICATED },
    assertOk: (_actor, res) => {
      const rows = res.json<Array<Record<string, unknown>>>();
      expect(Array.isArray(rows)).toBe(true);
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
    name: 'GET /v1/technician/work',
    method: 'GET',
    url: '/v1/technician/work',
    // §7 (TON.1): the technician's working set, read online — his jobs,
    // the sites they are at, the units there and the catalogue. No cursor:
    // nothing is stored on the handset to catch up.
    probe: (actor) => app.inject({ method: 'GET', url: '/v1/technician/work', headers: bearer(actor) }),
    expect: TECHNICIAN_WORK_ACTORS,
    assertOk: (_actor, res) => {
      const body = res.json<{ jobs: unknown[]; customers: unknown[]; products: unknown[] }>();
      expect(Array.isArray(body.jobs)).toBe(true);
      expect(Array.isArray(body.customers)).toBe(true);
      expect(body).not.toHaveProperty('cursor');
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
    name: 'GET /v1/cash/queue',
    method: 'GET',
    url: '/v1/cash/queue',
    // §10 (T4.2): the owner reads the reconciliation queue over
    // v_cash_reconciliation_queue; no other role holds a cash.confirm
    // cell. The matrix owner rides with `owner.cash` lit (beforeAll) —
    // the flag's dark side is integration/cash-queue.test.ts's subject.
    probe: (actor) => app.inject({ method: 'GET', url: '/v1/cash/queue', headers: bearer(actor) }),
    expect: { owner: OK, dispatcher: FORBIDDEN, technician: FORBIDDEN, sales_rep: FORBIDDEN, anon: UNAUTHENTICATED },
    assertOk: (_actor, res) => {
      const body = res.json<{ today: string; from: string; to: string; rows: unknown[] }>();
      expect(typeof body.today).toBe('string');
      expect(Array.isArray(body.rows)).toBe(true);
    },
  },
  {
    name: 'GET /v1/cash/queue/day',
    method: 'GET',
    url: '/v1/cash/queue/day',
    // §O2 (T4.9): "View the day" — the completions and payments behind one
    // row's expected figure. A READ, so the queue read's cell and flag
    // gate it: the same owner-only answer, and the money it carries (job
    // amounts) never reaches a dispatcher through it.
    probe: (actor) =>
      app.inject({
        method: 'GET',
        url: `/v1/cash/queue/day?employeeId=${subject.id}&businessDate=2026-01-01`,
        headers: bearer(actor),
      }),
    expect: { owner: OK, dispatcher: FORBIDDEN, technician: FORBIDDEN, sales_rep: FORBIDDEN, anon: UNAUTHENTICATED },
    assertOk: (_actor, res) => {
      const body = res.json<{ employeeId: string; completions: unknown[]; cashPayments: unknown[] }>();
      expect(body.employeeId).toBe(subject.id);
      expect(Array.isArray(body.completions)).toBe(true);
      expect(Array.isArray(body.cashPayments)).toBe(true);
    },
  },
  {
    name: 'POST /v1/cash/handovers/:id/confirm',
    method: 'POST',
    url: '/v1/cash/handovers/:id/confirm',
    // §10 (T4.2): the owner confirms a submitted day. The row is seeded on
    // its own day so the three owner-action probes never share one.
    probe: async (actor) => {
      if (actor === 'owner') {
        const id = await seedHandoverOnDay(subject.id, 0);
        return app.inject({
          method: 'POST',
          url: `/v1/cash/handovers/${id}/confirm`,
          headers: bearer(actor),
          payload: { confirmedAmount: '2500' },
        });
      }
      return app.inject({
        method: 'POST',
        url: `/v1/cash/handovers/${randomUUID()}/confirm`,
        headers: bearer(actor),
        payload: { confirmedAmount: '2500' },
      });
    },
    expect: { owner: OK, dispatcher: FORBIDDEN, technician: FORBIDDEN, sales_rep: FORBIDDEN, anon: UNAUTHENTICATED },
    assertOk: (_actor, res) => {
      expect(cashQueueRowSchema.parse(res.json()).status).toBe('confirmed');
    },
  },
  {
    name: 'POST /v1/cash/handovers/:id/dispute',
    method: 'POST',
    url: '/v1/cash/handovers/:id/dispute',
    // §10 (T4.2): the owner disputes with the note the DB CHECK demands.
    probe: async (actor) => {
      if (actor === 'owner') {
        const id = await seedHandoverOnDay(subject.id, -1);
        return app.inject({
          method: 'POST',
          url: `/v1/cash/handovers/${id}/dispute`,
          headers: bearer(actor),
          payload: { ownerNote: 'matrix probe: figures do not match' },
        });
      }
      return app.inject({
        method: 'POST',
        url: `/v1/cash/handovers/${randomUUID()}/dispute`,
        headers: bearer(actor),
        payload: { ownerNote: 'matrix probe: figures do not match' },
      });
    },
    expect: { owner: OK, dispatcher: FORBIDDEN, technician: FORBIDDEN, sales_rep: FORBIDDEN, anon: UNAUTHENTICATED },
    assertOk: (_actor, res) => {
      expect(cashQueueRowSchema.parse(res.json()).status).toBe('disputed');
    },
  },
  {
    name: 'POST /v1/cash/handovers/:id/reopen',
    method: 'POST',
    url: '/v1/cash/handovers/:id/reopen',
    // §10 (T4.2): owner only, reason required — returns a signed-off day
    // to submitted. The probe's target is confirmed in place first, since
    // reopen refuses a day that is still open.
    probe: async (actor) => {
      if (actor === 'owner') {
        const id = await seedHandoverOnDay(subject.id, -2);
        await confirmHandoverInDb(id);
        return app.inject({
          method: 'POST',
          url: `/v1/cash/handovers/${id}/reopen`,
          headers: bearer(actor),
          payload: { reason: 'matrix probe: reopening' },
        });
      }
      return app.inject({
        method: 'POST',
        url: `/v1/cash/handovers/${randomUUID()}/reopen`,
        headers: bearer(actor),
        payload: { reason: 'matrix probe: reopening' },
      });
    },
    expect: { owner: OK, dispatcher: FORBIDDEN, technician: FORBIDDEN, sales_rep: FORBIDDEN, anon: UNAUTHENTICATED },
    assertOk: (_actor, res) => {
      expect(cashQueueRowSchema.parse(res.json()).status).toBe('submitted');
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
  {
    name: 'GET /v1/customers',
    method: 'GET',
    url: '/v1/customers',
    // §6.4: dispatcher and owner read every site, a technician the sites
    // his jobs touch, a sales rep nothing (matrix: customer read none).
    probe: (actor) => app.inject({ method: 'GET', url: '/v1/customers', headers: bearer(actor) }),
    expect: CUSTOMER_READERS,
    assertOk: (_actor, res) => {
      expect(Array.isArray(res.json<{ items: unknown[] }>().items)).toBe(true);
    },
  },
  {
    name: 'POST /v1/customers',
    method: 'POST',
    url: '/v1/customers',
    // §6.4: dispatcher and owner create; the dispatcher's payload has its
    // `companyId` stripped server-side (PLAN.md §5) — the stripping itself
    // is proven at the row in test/integration/customers.test.ts.
    probe: (actor) =>
      app.inject({
        method: 'POST',
        url: '/v1/customers',
        headers: bearer(actor),
        payload: { name: 'Matrix probe site', phone: `9847${randomBytes(4).toString('hex')}`.slice(0, 12) },
      }),
    expect: CUSTOMER_WRITERS,
    assertOk: (_actor, res) => {
      expect(res.json<{ id: string }>().id).toBeTruthy();
    },
  },
  {
    name: 'GET /v1/customers/:id',
    method: 'GET',
    url: '/v1/customers/:id',
    // §6.4: the matrix technician's job sits at this customer, so his
    // `assigned` read reaches it; the detail carries the site's stack.
    probe: (actor) => app.inject({ method: 'GET', url: `/v1/customers/${customerId}`, headers: bearer(actor) }),
    expect: CUSTOMER_READERS,
    assertOk: (actor, res) => {
      if (actor === 'technician') expect(res.json<{ id: string }>().id).toBe(customerId);
    },
  },
  {
    name: 'PATCH /v1/customers/:id',
    method: 'PATCH',
    url: '/v1/customers/:id',
    // §6.4: the office's edit door, under `If-Match` — a fresh customer is
    // at version 1; a technician's customer cell carries no update.
    probe: async (actor) => {
      const created = await app.inject({
        method: 'POST',
        url: '/v1/customers',
        headers: bearer('owner'),
        payload: { name: 'Matrix probe patch site', phone: `9847${randomBytes(4).toString('hex')}`.slice(0, 12) },
      });
      const id = JSON.parse(created.body).id as string;
      return app.inject({
        method: 'PATCH',
        url: `/v1/customers/${id}`,
        headers: { ...bearer(actor), 'if-match': '1' },
        payload: { notes: 'Matrix probe customer edit.' },
      });
    },
    expect: CUSTOMER_WRITERS,
  },
  {
    name: 'GET /v1/customers/:id/stack',
    method: 'GET',
    url: '/v1/customers/:id/stack',
    // §6.4: the stack is read with the site — the dispatcher's read-only
    // stack view and the technician's site read share this scope.
    probe: (actor) => app.inject({ method: 'GET', url: `/v1/customers/${customerId}/stack`, headers: bearer(actor) }),
    expect: CUSTOMER_READERS,
    assertOk: (_actor, res) => {
      // The seeded unit is what came back, not just some list.
      expect(res.json<Array<{ id: string }>>().map((i) => i.id)).toContain(stackItemId);
    },
  },
  {
    name: 'POST /v1/customers/:id/stack',
    method: 'POST',
    url: '/v1/customers/:id/stack',
    // §6.4: "add a unit" is the correction door — the owner, or the
    // technician at a site his jobs touch (this one). A dispatcher holds
    // none of `customer.stack` and is 403 before the payload is read.
    probe: (actor) =>
      app.inject({
        method: 'POST',
        url: `/v1/customers/${customerId}/stack`,
        headers: bearer(actor),
        payload: {
          freeTextName: 'Matrix probe unit',
          serialNumber: `SN-T10-${randomBytes(4).toString('hex')}`,
          quantity: 1,
        },
      }),
    expect: STACK_WRITERS,
    assertOk: (_actor, res) => {
      expect(res.json<{ id: string }>().id).toBeTruthy();
    },
  },
  {
    name: 'PATCH /v1/customers/:id/stack/:itemId',
    method: 'PATCH',
    url: '/v1/customers/:id/stack/:itemId',
    // §6.4: the correction case, under `If-Match` — a fresh unit is at
    // version 1. Same two writers as the add door.
    probe: async (actor) => {
      const seeded = await db.query<{ id: string }>(
        `INSERT INTO customer_products (customer_id, free_text_name, serial_number, quantity)
         VALUES ($1, 'Matrix probe patch unit', $2, 1) RETURNING id`,
        [customerId, `SN-T10-${randomBytes(4).toString('hex')}`],
      );
      return app.inject({
        method: 'PATCH',
        url: `/v1/customers/${customerId}/stack/${seeded.rows[0]!.id}`,
        headers: { ...bearer(actor), 'if-match': '1' },
        payload: { quantity: 2 },
      });
    },
    expect: STACK_WRITERS,
    assertOk: (_actor, res) => {
      expect(res.json<{ quantity: number }>().quantity).toBe(2);
    },
  },
  {
    name: 'DELETE /v1/customers/:id/stack/:itemId',
    method: 'DELETE',
    url: '/v1/customers/:id/stack/:itemId',
    // §6.4: soft delete — `is_active = false`, which releases the serial.
    // A fresh unit per probe, so the second role's probe is not 404ing on
    // a row the first one already deactivated.
    probe: async (actor) => {
      const seeded = await db.query<{ id: string }>(
        `INSERT INTO customer_products (customer_id, free_text_name, serial_number, quantity)
         VALUES ($1, 'Matrix probe delete unit', $2, 1) RETURNING id`,
        [customerId, `SN-T10-${randomBytes(4).toString('hex')}`],
      );
      return app.inject({
        method: 'DELETE',
        url: `/v1/customers/${customerId}/stack/${seeded.rows[0]!.id}`,
        headers: bearer(actor),
      });
    },
    expect: STACK_WRITERS,
    assertOk: (_actor, res) => {
      expect(res.json<{ ok: boolean }>().ok).toBe(true);
    },
  },
  {
    name: 'GET /v1/dashboard/owner',
    method: 'GET',
    url: '/v1/dashboard/owner',
    // T4.6: the door is `cash.confirm` × `read` — the one matrix cell that
    // is `all` for the owner and `none` for every other role, since the
    // figures count cash only the owner may confirm.
    probe: (actor) =>
      app.inject({ method: 'GET', url: '/v1/dashboard/owner', headers: bearer(actor) }),
    expect: OWNER_ONLY,
    assertOk: (_actor, res) => {
      const body = ownerDashboardResponseSchema.parse(res.json());
      expect(body.jobsPerDay).toHaveLength(30);
      expect(body.revenuePerWeek).toHaveLength(12);
    },
  },
  {
    name: 'GET /v1/dashboard/owner/attention',
    method: 'GET',
    url: '/v1/dashboard/owner/attention',
    probe: (actor) =>
      app.inject({ method: 'GET', url: '/v1/dashboard/owner/attention', headers: bearer(actor) }),
    expect: OWNER_ONLY,
    assertOk: (_actor, res) => {
      ownerAttentionResponseSchema.parse(res.json());
    },
  },
  {
    name: 'GET /v1/companies',
    method: 'GET',
    url: '/v1/companies',
    // §11: the rep's accounts plus the house accounts (`own` on company as
    // the list's WHERE fragment), the owner's all — a dispatcher holds no
    // company cell at all.
    probe: (actor) => app.inject({ method: 'GET', url: '/v1/companies', headers: bearer(actor) }),
    expect: COMPANY_ACTORS,
    assertOk: (_actor, res) => {
      expect(Array.isArray(res.json<{ items: unknown[] }>().items)).toBe(true);
    },
  },
  {
    name: 'POST /v1/companies',
    method: 'POST',
    url: '/v1/companies',
    // §11: create stamps `owner_rep_id` to the creator — a rep owns what
    // he creates; the owner's create lands a house account. The payload
    // carries no `ownerRepId`: the server decides, never the caller.
    probe: (actor) =>
      app.inject({
        method: 'POST',
        url: '/v1/companies',
        headers: bearer(actor),
        payload: { name: `Matrix probe account ${randomBytes(4).toString('hex')}` },
      }),
    expect: COMPANY_ACTORS,
    assertOk: (_actor, res) => {
      expect(res.json<{ id: string }>().id).toBeTruthy();
    },
  },
  {
    name: 'GET /v1/companies/:id',
    method: 'GET',
    url: '/v1/companies/:id',
    // §11: the matrix rep OWNS this account, so his OK proves the
    // ownership read, not a house account's visibility.
    probe: (actor) => app.inject({ method: 'GET', url: `/v1/companies/${matrixCompanyId}`, headers: bearer(actor) }),
    expect: COMPANY_ACTORS,
    assertOk: (actor, res) => {
      if (actor === 'sales_rep') expect(res.json<{ id: string; ownerRepId: string | null }>().ownerRepId).toBe(selfIds.sales_rep);
    },
  },
  {
    name: 'PATCH /v1/companies/:id',
    method: 'PATCH',
    url: '/v1/companies/:id',
    // §11: rep (own + house), owner — the probe edits a fresh HOUSE
    // account (the owner's own create lands NULL), the one shape both
    // allowed actors may edit without owning. `ownerRepId` is not a field
    // of the patch payload: ownership moves through the owner door alone.
    probe: async (actor) => {
      const created = await app.inject({
        method: 'POST',
        url: '/v1/companies',
        headers: bearer('owner'),
        payload: { name: `Matrix probe house account ${randomBytes(4).toString('hex')}` },
      });
      const id = JSON.parse(created.body).id as string;
      return app.inject({
        method: 'PATCH',
        url: `/v1/companies/${id}`,
        headers: { ...bearer(actor), 'if-match': '1' },
        payload: { notes: 'Matrix probe company edit.' },
      });
    },
    expect: COMPANY_ACTORS,
  },
  {
    name: 'PATCH /v1/companies/:id/owner',
    method: 'PATCH',
    url: '/v1/companies/:id/owner',
    // §11: OWNER ONLY — a rep cannot reassign an account, his own
    // included, which is the door check the matrix cannot express (the rep
    // holds `update: own` on company and must not reach this surface).
    // Nulling is repeatable, so the probe may run for every actor.
    probe: (actor) =>
      app.inject({
        method: 'PATCH',
        url: `/v1/companies/${matrixCompanyId}/owner`,
        headers: bearer(actor),
        payload: { ownerRepId: null },
      }),
    expect: OWNER_ONLY,
  },
  {
    name: 'GET /v1/companies/balances',
    method: 'GET',
    url: '/v1/companies/balances',
    // §11 (T3.5): the Pending tab — v_company_balances, scoped like the
    // company list (the rep's accounts plus the house accounts, the owner
    // all, the dispatcher no cell). `sales.payments` gates every caller;
    // the matrix owner and rep ride with it enabled (seeded above), the
    // flag's own switchable behaviour being integration/ledger.test.ts's.
    probe: (actor) => app.inject({ method: 'GET', url: '/v1/companies/balances', headers: bearer(actor) }),
    expect: COMPANY_ACTORS,
    assertOk: (_actor, res) => {
      expect(Array.isArray(res.json<{ items: unknown[] }>().items)).toBe(true);
    },
  },
  {
    name: 'GET /v1/companies/:id/ledger',
    method: 'GET',
    url: '/v1/companies/:id/ledger',
    // §11 (T3.5): the account's interleaved ledger. The probe reads the
    // account the matrix rep OWNS, so his OK proves the ownership scope —
    // another rep's account's ledger is OUT_OF_SCOPE (the point read's
    // verdict, asserted in integration/ledger.test.ts).
    probe: (actor) =>
      app.inject({ method: 'GET', url: `/v1/companies/${matrixCompanyId}/ledger`, headers: bearer(actor) }),
    expect: COMPANY_ACTORS,
    assertOk: (actor, res) => {
      if (actor === 'sales_rep') expect(res.json<{ companyId: string }>().companyId).toBe(matrixCompanyId);
    },
  },
  {
    name: 'GET /v1/sales',
    method: 'GET',
    url: '/v1/sales',
    // §11 (T3.3): the rep's own cards (`own` on sale as the list's WHERE
    // fragment), the owner's all — a dispatcher holds no sale cell at all.
    probe: (actor) => app.inject({ method: 'GET', url: '/v1/sales', headers: bearer(actor) }),
    expect: COMPANY_ACTORS,
    assertOk: (_actor, res) => {
      expect(Array.isArray(res.json<{ items: unknown[] }>().items)).toBe(true);
    },
  },
  {
    name: 'POST /v1/sales',
    method: 'POST',
    url: '/v1/sales',
    // §11 (T3.3): items nested in the create payload; create mints a DRAFT
    // — no number, no balance, the confirm's to mint. The server stamps
    // `sales_rep_id` to the actor; the payload carries no rep field.
    probe: (actor) =>
      app.inject({
        method: 'POST',
        url: '/v1/sales',
        headers: bearer(actor),
        payload: {
          companyId: matrixCompanyId,
          saleDate: '2026-09-13',
          items: [{ productName: 'Matrix probe line', quantity: 1, unitPrice: '10.00' }],
        },
      }),
    expect: COMPANY_ACTORS,
    assertOk: (_actor, res) => {
      const body = res.json<{ saleNumber: string | null; status: string }>();
      expect(body.status).toBe('draft');
      expect(body.saleNumber).toBeNull();
    },
  },
  {
    name: 'PATCH /v1/sales/:id',
    method: 'PATCH',
    url: '/v1/sales/:id',
    // §11 (T3.3): rep (own, DRAFT only), owner. The probe edits a fresh
    // draft the rep created — the one shape both allowed actors may edit
    // (owner `all`, rep `own`). A confirmed card is refused even for the
    // owner: void is the correction door.
    probe: async (actor) => {
      const created = await app.inject({
        method: 'POST',
        url: '/v1/sales',
        headers: bearer('sales_rep'),
        payload: {
          companyId: matrixCompanyId,
          saleDate: '2026-09-13',
          items: [{ productName: 'Matrix probe draft', quantity: 1, unitPrice: '10.00' }],
        },
      });
      const id = (JSON.parse(created.body) as { id: string }).id;
      return app.inject({
        method: 'PATCH',
        url: `/v1/sales/${id}`,
        headers: { ...bearer(actor), 'if-match': '1' },
        payload: { notes: 'Matrix probe sale edit.' },
      });
    },
    expect: COMPANY_ACTORS,
  },
  {
    name: 'POST /v1/sales/:id/confirm',
    method: 'POST',
    url: '/v1/sales/:id/confirm',
    // §11 (T3.3): the move that mints the number and lifts the balance.
    // Each probe confirms a FRESH draft (confirm is one-way), created by
    // the rep, so his OK proves the own scope and not borrowed rows.
    probe: async (actor) => {
      const created = await app.inject({
        method: 'POST',
        url: '/v1/sales',
        headers: bearer('sales_rep'),
        payload: {
          companyId: matrixCompanyId,
          saleDate: '2026-09-13',
          items: [{ productName: 'Matrix probe confirm', quantity: 1, unitPrice: '10.00' }],
        },
      });
      const id = (JSON.parse(created.body) as { id: string }).id;
      return app.inject({ method: 'POST', url: `/v1/sales/${id}/confirm`, headers: bearer(actor) });
    },
    expect: COMPANY_ACTORS,
    assertOk: (_actor, res) => {
      expect(res.json<{ saleNumber: string | null }>().saleNumber).toMatch(/^SL-\d{4}-\d{5,}$/);
    },
  },
  {
    name: 'POST /v1/sales/:id/void',
    method: 'POST',
    url: '/v1/sales/:id/void',
    // §11 (T3.3): OWNER ONLY — the door check is the role, not the matrix
    // cell: a rep holds `update: own` on sale and must not reach this
    // surface even on his own card. The probe voids a fresh rep-made
    // confirm, so the owner's OK is the only OK there is.
    probe: async (actor) => {
      const created = await app.inject({
        method: 'POST',
        url: '/v1/sales',
        headers: bearer('sales_rep'),
        payload: {
          companyId: matrixCompanyId,
          saleDate: '2026-09-13',
          items: [{ productName: 'Matrix probe void', quantity: 1, unitPrice: '10.00' }],
        },
      });
      const id = (JSON.parse(created.body) as { id: string }).id;
      await app.inject({ method: 'POST', url: `/v1/sales/${id}/confirm`, headers: bearer('sales_rep') });
      return app.inject({
        method: 'POST',
        url: `/v1/sales/${id}/void`,
        headers: bearer(actor),
        payload: { reason: 'Matrix probe void.' },
      });
    },
    expect: OWNER_ONLY,
    assertOk: (_actor, res) => {
      expect(res.json<{ status: string }>().status).toBe('void');
    },
  },
  {
    name: 'GET /v1/payments',
    method: 'GET',
    url: '/v1/payments',
    // §11 (T3.4): the Collected tab — the rep's own receipts (`own` on
    // payment is `received_by`, deliberately stricter than `own` on
    // company: a house account is visible to every rep, the money on it is
    // not), the owner's all. A dispatcher holds no payment cell at all.
    probe: (actor) => app.inject({ method: 'GET', url: '/v1/payments', headers: bearer(actor) }),
    expect: COMPANY_ACTORS,
    assertOk: (_actor, res) => {
      expect(Array.isArray(res.json<{ items: unknown[] }>().items)).toBe(true);
    },
  },
  {
    name: 'POST /v1/payments',
    method: 'POST',
    url: '/v1/payments',
    // §11 (T3.4): capture. The server stamps `received_by` to the actor
    // (whoever ACTUALLY took the money); the payload carries no rep field.
    // The number is allocated at CREATE — payments are not drafted, there
    // is no pending state to allocate at (§3.5).
    probe: (actor) =>
      app.inject({
        method: 'POST',
        url: '/v1/payments',
        headers: bearer(actor),
        payload: {
          companyId: matrixCompanyId,
          amount: '10.00',
          mode: 'cash',
          receivedAt: new Date().toISOString(),
        },
      }),
    expect: COMPANY_ACTORS,
    assertOk: (_actor, res) => {
      const body = res.json<{ paymentNumber: string; status: string }>();
      expect(body.status).toBe('collected');
      expect(body.paymentNumber).toMatch(/^PM-\d{4}-\d{5,}$/);
    },
  },
  {
    name: 'POST /v1/payments/:id/void',
    method: 'POST',
    url: '/v1/payments/:id/void',
    // §11 (T3.4): OWNER ONLY — the door check is the role, not the matrix
    // cell: a rep holds `update: own` on payment and must not reach this
    // surface even on his own collection. The probe voids a fresh rep-made
    // capture, so the owner's OK is the only OK there is.
    probe: async (actor) => {
      const created = await app.inject({
        method: 'POST',
        url: '/v1/payments',
        headers: bearer('sales_rep'),
        payload: {
          companyId: matrixCompanyId,
          amount: '10.00',
          mode: 'cash',
          receivedAt: new Date().toISOString(),
        },
      });
      const id = (JSON.parse(created.body) as { id: string }).id;
      return app.inject({
        method: 'POST',
        url: `/v1/payments/${id}/void`,
        headers: bearer(actor),
        payload: { reason: 'Matrix probe payment void.' },
      });
    },
    expect: OWNER_ONLY,
    assertOk: (_actor, res) => {
      expect(res.json<{ status: string }>().status).toBe('void');
    },
  },
  {
    name: 'GET /v1/products',
    method: 'GET',
    url: '/v1/products',
    // §6.4: the catalogue is read by everyone.
    probe: (actor) => app.inject({ method: 'GET', url: '/v1/products', headers: bearer(actor) }),
    expect: CATALOG_READERS,
    assertOk: (_actor, res) => {
      expect(Array.isArray(res.json<unknown[]>())).toBe(true);
    },
  },
  {
    name: 'POST /v1/products',
    method: 'POST',
    url: '/v1/products',
    // §6.4: written only by the owner.
    probe: (actor) =>
      app.inject({
        method: 'POST',
        url: '/v1/products',
        headers: bearer(actor),
        payload: {
          sku: `T10-SKU-${randomBytes(4).toString('hex')}`,
          name: 'Matrix probe product',
          category: 'accessory',
        },
      }),
    expect: OWNER_ONLY,
  },
  {
    name: 'PATCH /v1/products/:id',
    method: 'PATCH',
    url: '/v1/products/:id',
    // §6.4: owner-only, under `If-Match`; deactivation is
    // `isActive: false`, never a delete. The fixture product is patched
    // back and forth by name only.
    probe: async (actor) => {
      const version = (
        await db.query<{ version: number }>('SELECT version FROM products WHERE id = $1', [matrixProductId])
      ).rows[0]!.version;
      return app.inject({
        method: 'PATCH',
        url: `/v1/products/${matrixProductId}`,
        headers: { ...bearer(actor), 'if-match': String(version) },
        payload: { capacityLabel: 'Matrix probe label' },
      });
    },
    expect: OWNER_ONLY,
  },
  {
    name: 'GET /v1/services',
    method: 'GET',
    url: '/v1/services',
    // §6.4: the catalogue is read by everyone.
    probe: (actor) => app.inject({ method: 'GET', url: '/v1/services', headers: bearer(actor) }),
    expect: CATALOG_READERS,
    assertOk: (_actor, res) => {
      expect(Array.isArray(res.json<unknown[]>())).toBe(true);
    },
  },
  {
    name: 'POST /v1/services',
    method: 'POST',
    url: '/v1/services',
    // §6.4: written only by the owner.
    probe: (actor) =>
      app.inject({
        method: 'POST',
        url: '/v1/services',
        headers: bearer(actor),
        payload: { code: `T10-SVC-${randomBytes(4).toString('hex')}`, name: 'Matrix probe service' },
      }),
    expect: OWNER_ONLY,
  },
  {
    name: 'PATCH /v1/services/:id',
    method: 'PATCH',
    url: '/v1/services/:id',
    // §6.4: owner-only, under `If-Match`.
    probe: async (actor) => {
      const version = (
        await db.query<{ version: number }>('SELECT version FROM services WHERE id = $1', [matrixServiceRowId])
      ).rows[0]!.version;
      return app.inject({
        method: 'PATCH',
        url: `/v1/services/${matrixServiceRowId}`,
        headers: { ...bearer(actor), 'if-match': String(version) },
        payload: { description: 'Matrix probe service edit.' },
      });
    },
    expect: OWNER_ONLY,
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

  // The technician's job screens ship dark (PLAN-EXECUTION.md §3); the
  // work-read probe exercises ROLE authorization, so the matrix
  // technician's `tech.jobs` flag is enabled directly — the flag's own
  // behavior is integration/flags.test.ts's subject.
  await db.query(
    `INSERT INTO employee_flag_overrides (employee_id, flag, enabled)
     SELECT id, 'tech.jobs', true FROM employees WHERE username = $1`,
    [usernames.technician],
  );

  // Same for the dispatcher surface (T2.3): the assign/bulk/load probes
  // exercise ROLE authorization, so the two office roles ride with
  // `dispatch.console` and `dispatch.bulk` enabled — the flags' own
  // switchable behaviour is integration/flags.test.ts's and
  // integration/assign.test.ts's subject.
  await db.query(
    `INSERT INTO employee_flag_overrides (employee_id, flag, enabled)
     SELECT id, f.flag, true
     FROM employees
     CROSS JOIN (VALUES ('dispatch.console'), ('dispatch.bulk')) AS f(flag)
     WHERE employees.role IN ('owner', 'dispatcher')`,
  );

  // Same for the rep's cash handover (T3.6): the cash-endpoint probes
  // exercise ROLE authorization, so the matrix rep rides with `sales.cash`
  // enabled — the flag's own switchable behaviour is
  // integration/rep-cash.test.ts's subject.
  await db.query(
    `INSERT INTO employee_flag_overrides (employee_id, flag, enabled)
     SELECT id, 'sales.cash', true FROM employees WHERE role = 'sales_rep'`,
  );

  // Same for the sales cards surface (T3.3): the sale probes exercise ROLE
  // authorization, and the flag gates EVERY caller of /v1/sales, so the
  // matrix owner and rep ride with `sales.cards` enabled — the flag's own
  // switchable behaviour is integration/sales.test.ts's subject.
  await db.query(
    `INSERT INTO employee_flag_overrides (employee_id, flag, enabled)
     SELECT id, 'sales.cards', true FROM employees WHERE role IN ('owner', 'sales_rep')`,
  );

  // Same for the payments surface (T3.4): the payment probes exercise ROLE
  // authorization, and the flag gates EVERY caller of /v1/payments, so the
  // matrix owner and rep ride with `sales.payments` enabled — the flag's
  // own switchable behaviour is integration/payments.test.ts's subject.
  await db.query(
    `INSERT INTO employee_flag_overrides (employee_id, flag, enabled)
     SELECT id, 'sales.payments', true FROM employees WHERE role IN ('owner', 'sales_rep')`,
  );

  // Same for the owner's cash queue (T4.2): the queue probes exercise ROLE
  // authorization, and the flag gates EVERY caller of the reconciliation
  // surface, so the matrix owner rides with `owner.cash` enabled — the
  // flag's own switchable behaviour is integration/cash-queue.test.ts's
  // subject.
  await db.query(
    `INSERT INTO employee_flag_overrides (employee_id, flag, enabled)
     SELECT id, 'owner.cash', true FROM employees WHERE role = 'owner'`,
  );

  // Same for completion amendment (T4.3): the amend probe exercises ROLE
  // authorization (the matrix gives `job.money` × `update` to the owner
  // alone), so the owner rides with `owner.amend` enabled — the flag's own
  // switchable behaviour is integration/amendment.test.ts's subject.
  await db.query(
    `INSERT INTO employee_flag_overrides (employee_id, flag, enabled)
     SELECT id, 'owner.amend', true FROM employees WHERE role = 'owner'`,
  );

  // Same for the owner console's location reads (T4.4): the four probes
  // exercise ROLE authorization (the matrix gives `location.read` to the
  // owner alone), so the owner rides with `owner.location` enabled — the
  // flag's own switchable behaviour is integration/flags.test.ts's
  // subject, and locate-now's lifecycle is integration/locate-now
  // .test.ts's.
  await db.query(
    `INSERT INTO employee_flag_overrides (employee_id, flag, enabled)
     SELECT id, 'owner.location', true FROM employees WHERE role = 'owner'`,
  );

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

  // The company probes (T3.2) need an account the matrix sales_rep OWNS:
  // his OK on the row-scoped doors must prove the ownership scope, not a
  // house account's visibility.
  matrixCompanyId = (
    await db.query<{ id: string }>(
      `INSERT INTO companies (name, owner_rep_id) VALUES ($1, $2) RETURNING id`,
      [`Matrix T10 Account ${randomBytes(3).toString('hex')}`, selfIds.sales_rep],
    )
  ).rows[0]!.id;

  // The §6.4 stack probes need a unit standing at the matrix customer.
  stackItemId = (
    await db.query<{ id: string }>(
      `INSERT INTO customer_products (customer_id, free_text_name, serial_number, quantity)
       VALUES ($1, 'Matrix probe inverter', $2, 1) RETURNING id`,
      [customerId, `SN-T10-${randomBytes(4).toString('hex')}`],
    )
  ).rows[0]!.id;
  matrixProductId = (
    await db.query<{ id: string }>(
      `INSERT INTO products (sku, name, category) VALUES ($1, 'Matrix probe product', 'accessory') RETURNING id`,
      [`T10-SKU-${randomBytes(4).toString('hex')}`],
    )
  ).rows[0]!.id;
  matrixServiceRowId = (
    await db.query<{ id: string }>(
      `INSERT INTO services (code, name) VALUES ($1, 'Matrix probe catalogue service') RETURNING id`,
      [`T10-SVC-${randomBytes(4).toString('hex')}`],
    )
  ).rows[0]!.id;

  // The GET /v1/location/requests/:id probe needs a real request row —
  // seeded directly, with a future expiry so it polls as `pushed`
  // whatever hour the suite runs at. No FCM token exists on any matrix
  // device, so POST probes take the honest no_pushable_device door and
  // never reach the (unconfigured) FCM client.
  matrixLocationRequestId = (
    await db.query<{ id: string }>(
      `INSERT INTO location_requests
         (requested_by, target_employee_id, mode, requested_at, expires_at, pushed_at)
       VALUES ($1, $2, 'fix', now(), now() + interval '10 minutes', now())
       RETURNING id`,
      [selfIds.owner, subject.id],
    )
  ).rows[0]!.id;

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
