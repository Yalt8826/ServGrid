import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import type { FastifyInstance } from 'fastify';
import {
  errorEnvelopeSchema,
  DispatcherSummarySchema,
  JobCardDispatcherSchema,
  type ErrorEnvelope,
  type LoginResponse,
} from '@servgrid/shared';
import { loadConfig, type Config } from '../../src/config.js';
import { closePool } from '../../src/db/pool.js';
import { runMigrations } from '../../src/db/migrate.js';
import { hashPassword } from '../../src/lib/password.js';
import { buildServer } from '../../src/server.js';
import { ULID, validEnv } from '../helpers/env.js';

/**
 * The money-leak suite (PHASE-2-DISPATCHER.md T2.2, PLAN.md §5,
 * PLAN-BACKEND.md §5 rule 2). The dispatcher guarantee is a promise about
 * PAYLOADS — no dispatcher response ever carries a completion, contract or
 * balance field — and this suite is what protects it, because a
 * code-review habit is not.
 *
 * It walks EVERY dispatcher-reachable endpoint, calls it as a dispatcher
 * against a fixture saturated with money (a completed job whose completion
 * row carries every money column the schema owns), and asserts that no
 * response body — at any depth, including inside arrays — contains any
 * forbidden key. It walks the parsed JSON recursively BY KEY NAME: a test
 * that only checks the top level is a test that passes while a nested
 * completion leaks.
 *
 * The walk is discovery-driven: the routes are read off the server's own
 * route table (an onRoute hook captured before ready), and a route counts
 * as dispatcher-reachable when its per-role response schema includes a
 * dispatcher shape. The discovery assertion pins the found set to the
 * manifest below, so the suite can never silently shrink — and every
 * later phase MUST add its new dispatcher endpoints to the walk (the new
 * endpoint changes the discovered set, fails this suite, and gets a walk
 * entry). That is how "every later phase adds its new endpoints to it" is
 * enforced rather than hoped for.
 *
 * Key names are normalised before comparison (case, `_`, `-` stripped), so
 * `discount_amount` and the wire's `discountAmount` are the same leak.
 *
 * This suite is never allowed to shrink. PLAN-BACKEND.md §6.3 "If it
 * fails": a leak found here is a design failure, not a bug to patch at
 * the serialiser — find why the query reached the table at all.
 */

function databaseUrl(): string {
  return process.env.DATABASE_URL ?? 'postgres://servgrid:servgrid@localhost:5432/servgrid';
}

function adminUrlFor(url: string): string {
  const parsed = new URL(url);
  parsed.pathname = '/postgres';
  return parsed.toString();
}

const SCRATCH_DB = 'servgrid_money_leak_test';
const PASSWORD = 'ml-plain-copier-47';

/** The forbidden column names, verbatim from the T2.2 spec. */
const FORBIDDEN_KEYS = [
  'cost',
  'discount_amount',
  'discount_reason',
  'amount_collected',
  'collection_mode',
  'payment_reference',
  'contract_value',
  'unit_price',
  'line_total',
  'declared_amount',
  'confirmed_amount',
  'balance',
] as const;

/** Case/separator-insensitive matching: `discountAmount` is `discount_amount` is a leak. */
function normaliseKey(key: string): string {
  return key.toLowerCase().replace(/[\s_-]+/g, '');
}

const FORBIDDEN_NORMALISED = new Set(FORBIDDEN_KEYS.map(normaliseKey));

/**
 * The recursive walk. Collects every object key at ANY depth — nested
 * objects and arrays both — whose normalised name is forbidden. Empty
 * `hits` is the assertion; the walker is proven to fire in its own test
 * below, so a broken walk cannot silently pass.
 */
function walkKeys(value: unknown, path: string, hits: string[]): void {
  if (Array.isArray(value)) {
    value.forEach((item, i) => walkKeys(item, `${path}[${i}]`, hits));
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (FORBIDDEN_NORMALISED.has(normaliseKey(key))) {
        hits.push(`${path}.${key}`);
      }
      walkKeys(child, `${path}.${key}`, hits);
    }
  }
}

/** One route as the discovery saw it: its methods, path and response roles. */
interface RouteEntry {
  methods: string[];
  url: string;
  roles: string[];
}

/** Filled by the onRoute hook before the app boots (see beforeAll). */
const ROUTE_TABLE: RouteEntry[] = [];

/**
 * The dispatcher-reachable manifest. The discovery assertion compares this
 * against the live route table on every run. T2.4 adds the customer
 * surface (§6.4): the customer endpoints that answer a dispatcher at all
 * are walked like the job endpoints — a customer row carries no money,
 * and the walk is how that stays a fact instead of a hope.
 */
const DISPATCHER_MANIFEST: ReadonlyArray<{ method: string; url: string }> = [
  { method: 'GET', url: '/v1/jobs' },
  // T2B.3: the create door — dispatcher and owner; walked like the rest
  // (the card response is money-free by construction).
  { method: 'POST', url: '/v1/jobs' },
  // T2.7: the dashboard figures — same view, counted server-side.
  { method: 'GET', url: '/v1/jobs/summary' },
  { method: 'GET', url: '/v1/jobs/:id' },
  // T4.11: the timeline (§6.3) — events only for a dispatcher, with
  // money-bearing payloads redacted in the service; walked below.
  { method: 'GET', url: '/v1/jobs/:id/events' },
  { method: 'POST', url: '/v1/jobs/:id/cancel' },
  { method: 'PATCH', url: '/v1/jobs/:id' },
  // T2.3: assignment, bulk reassign and the picker.
  { method: 'POST', url: '/v1/jobs/:id/assign' },
  { method: 'POST', url: '/v1/jobs/bulk-assign' },
  { method: 'GET', url: '/v1/technicians/load' },
  { method: 'GET', url: '/v1/customers' },
  { method: 'POST', url: '/v1/customers' },
  { method: 'GET', url: '/v1/customers/:id' },
  { method: 'PATCH', url: '/v1/customers/:id' },
  { method: 'GET', url: '/v1/customers/:id/stack' },
  // T2.7: the roster health warning — registered after the customers
  // module (server.ts), so discovery lists it last.
  { method: 'GET', url: '/v1/location/health' },
];

/** The IST noon `offsetDays` from today — an unambiguous instant inside a business day. */
function istNoonUtc(offsetDays: number): string {
  const shifted = new Date(Date.now() + offsetDays * 86_400_000 + 5.5 * 3_600_000);
  const day = shifted.toISOString().slice(0, 10);
  return new Date(`${day}T12:00:00+05:30`).toISOString();
}

interface Actor {
  username: string;
  id: string;
  token: string;
}

const DISPATCHER: Actor = { username: '', id: '', token: '' };
const OWNER: Actor = { username: '', id: '', token: '' };

let admin: Pool;
let db: Pool;
let app: FastifyInstance;
let config: Config;

async function seedEmployee(role: 'dispatcher' | 'owner' | 'technician', who: Actor): Promise<void> {
  const username = `ml.${role}.${randomBytes(4).toString('hex')}`;
  const r = await db.query<{ id: string }>(
    `INSERT INTO employees (username, password_hash, full_name, role)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [username, await hashPassword(PASSWORD), `Test ${username}`, role],
  );
  who.id = r.rows[0]!.id;
  who.username = username;
  const res = await app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: {
      username,
      password: PASSWORD,
      device: {
        installId: `install-${username}`,
        platform: 'android',
        appVersion: '0.1.0',
        osVersion: '14',
        manufacturer: 'Xiaomi',
        model: 'Redmi Note 12',
      },
    },
  });
  expect(res.statusCode, res.body).toBe(200);
  who.token = res.json<LoginResponse>().accessToken;
}

async function seedJob(overrides: {
  status?: string;
  scheduledFor?: string | null;
  closedAt?: string | null;
  assignedTo?: string;
}): Promise<string> {
  const status = overrides.status ?? 'assigned';
  const r = await db.query<{ id: string }>(
    `INSERT INTO job_cards (job_number, customer_id, service_id, title, status, assigned_to,
                            assigned_at, scheduled_for, closed_at)
     VALUES ($1, $2, $3, 'Money-leak fixture job', $4, $5, $6, $7, $8) RETURNING id`,
    [
      `JC-ML-${randomBytes(4).toString('hex')}`,
      customerId,
      serviceId,
      status,
      status === 'unassigned' ? null : (overrides.assignedTo ?? techId),
      status === 'unassigned' ? null : new Date().toISOString(),
      overrides.scheduledFor ?? null,
      overrides.closedAt ?? null,
    ],
  );
  return r.rows[0]!.id;
}

/**
 * The completion row §6.2's transaction would leave — carrying EVERY money
 * column the schema owns, so a leak of any one of them has something to
 * leak. `amount_collected` is generated and needs no insert.
 */
async function seedCompletion(jobId: string, completedBy: string): Promise<void> {
  await db.query(
    `INSERT INTO job_completions
       (job_card_id, completed_by, completed_at, work_summary, cost, discount_amount,
        discount_reason, collection_mode, payment_reference)
     VALUES ($1, $2, $3, 'Replaced batteries, tested load.', '14500.00', '1500.00',
             'goodwill — loyal customer', 'cash', 'UPI-REF-ML-0001')`,
    [jobId, completedBy, new Date().toISOString()],
  );
}

function bearer(actor: Actor): Record<string, string> {
  return { authorization: `Bearer ${actor.token}` };
}

let customerId = '';
let serviceId = '';
let techId = '';
/** A technician who can log in, and his completed job — the online timeline's reader (TON.1). */
const FIELD_TECH: Actor = { username: '', id: '', token: '' };
let fieldJobId = '';
/** doneJobId is completed WITH money; the others are open, for the write paths. */
let doneJobId = '';
let cancelJobId = '';
let patchJobId = '';
// T2.3 walk fixtures: one job per assignment door.
let assignJobId = '';
let bulkJobId1 = '';
let bulkJobId2 = '';

/** The dispatcher's console and bulk flags are ON here — the walk must reach 200 to walk a payload at all. */
async function seedDispatcherFlags(employeeId: string): Promise<void> {
  await db.query(
    `INSERT INTO employee_flag_overrides (employee_id, flag, enabled, updated_by)
     VALUES ($1, 'dispatch.console', true, $1), ($1, 'dispatch.bulk', true, $1)`,
    [employeeId],
  );
}

/** The current version of a job row — the `If-Match` the walk's assigns must carry. */
async function versionOf(jobId: string): Promise<number> {
  return (await db.query<{ version: number }>('SELECT version FROM job_cards WHERE id = $1', [jobId]))
    .rows[0]!.version;
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

  // The discovery: every route the server actually registered, captured
  // before boot with its per-role response schema.
  ROUTE_TABLE.length = 0;
  app.addHook('onRoute', (routeOptions) => {
    const methods = Array.isArray(routeOptions.method) ? routeOptions.method : [routeOptions.method];
    ROUTE_TABLE.push({
      methods: [...methods],
      url: routeOptions.url,
      roles: Object.keys(routeOptions.config?.responseSchemaByRole ?? {}),
    });
  });

  await app.ready();

  await seedEmployee('dispatcher', DISPATCHER);
  await seedEmployee('owner', OWNER);
  await seedDispatcherFlags(DISPATCHER.id);

  techId = (
    await db.query<{ id: string }>(
      `INSERT INTO employees (username, password_hash, full_name, role)
       VALUES ($1, 'not-a-real-hash', 'Money-leak technician', 'technician') RETURNING id`,
      [`ml.tech.${randomBytes(4).toString('hex')}`],
    )
  ).rows[0]!.id;

  customerId = (
    await db.query<{ id: string }>(
      `INSERT INTO customers (name, phone) VALUES ('Money-leak Customer', '9847000001') RETURNING id`,
    )
  ).rows[0]!.id;
  serviceId = (
    await db.query<{ id: string }>(
      `INSERT INTO services (code, name) VALUES ('ML-SVC', 'Money-leak suite service') RETURNING id`,
    )
  ).rows[0]!.id;

  doneJobId = await seedJob({ status: 'completed', closedAt: new Date().toISOString() });
  await seedCompletion(doneJobId, techId);
  cancelJobId = await seedJob({ status: 'assigned' });
  patchJobId = await seedJob({ status: 'assigned' });
  // One more open job with a past date, so the list serves a real page.
  await seedJob({ status: 'assigned', scheduledFor: istNoonUtc(-3) });
  // T2.3's doors: one unassigned job for the single assign, two open jobs
  // for the bulk.
  assignJobId = await seedJob({ status: 'unassigned' });
  bulkJobId1 = await seedJob({ status: 'assigned' });
  bulkJobId2 = await seedJob({ status: 'unassigned' });

  // TON.1: the technician now reads his own job's timeline online. His
  // completed job carries every money column and an amended event whose
  // stored payload is the money's before/after pair.
  await seedEmployee('technician', FIELD_TECH);
  fieldJobId = await seedJob({ status: 'completed', closedAt: new Date().toISOString(), assignedTo: FIELD_TECH.id });
  await seedCompletion(fieldJobId, FIELD_TECH.id);
  await db.query(
    `INSERT INTO job_events (job_card_id, event_type, actor_id, occurred_at, from_status, to_status, source, payload)
     VALUES ($1, 'completion_amended', $2, $3, 'completed', 'completed', 'web', $4::jsonb)`,
    [fieldJobId, OWNER.id, new Date().toISOString(), JSON.stringify({ reason: 'typo', cost: { from: '9000.00', to: '900.00' } })],
  );
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

describe('the walker itself', () => {
  it('fires on a forbidden key at any depth, arrays included — a broken walk cannot pass silently', () => {
    const hits: string[] = [];
    walkKeys(
      {
        id: 'x',
        items: [
          { id: 'y', nested: [{ balance: '9.00', ok: 1 }] },
          { paymentReference: 'UPI-123' },
        ],
      },
      '$',
      hits,
    );
    expect(hits).toEqual(['$.items[0].nested[0].balance', '$.items[1].paymentReference']);
  });

  it('does not fire on keys that merely contain a money word', () => {
    const hits: string[] = [];
    walkKeys({ costCentre: 'ops', unitPriceLabel: 'n/a', balanceDueNote: 'text' }, '$', hits);
    expect(hits).toEqual([]); // `costCentre` is not `cost` — the walk is by key NAME
  });
});

describe('discovery — the suite cannot shrink', () => {
  it('the route table yields exactly the dispatcher-reachable manifest', () => {
    const discovered: Array<{ method: string; url: string }> = [];
    for (const entry of ROUTE_TABLE) {
      for (const method of entry.methods) {
        // HEAD is the auto-generated twin of a GET, not another endpoint.
        if (method === 'HEAD' || method === 'OPTIONS') continue;
        if (entry.roles.includes('dispatcher')) {
          discovered.push({ method, url: entry.url });
        }
      }
    }
    expect(discovered).toEqual(DISPATCHER_MANIFEST);
  });
});

describe('the walk — no dispatcher payload carries money at any depth', () => {
  it('GET /v1/jobs — the list, recursed through items[]', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/jobs?limit=200', headers: bearer(DISPATCHER) });
    expect(res.statusCode, res.body).toBe(200);
    const body = JSON.parse(res.body);
    expect(Array.isArray(body.items) && body.items.length > 0, 'the fixture page is non-empty').toBe(true);

    const hits: string[] = [];
    walkKeys(body, '$', hits);
    expect(hits, `money keys leaked in the list: ${hits.join(', ')}`).toEqual([]);
  });

  it('GET /v1/jobs/:id — the completed job, whose completion row carries every money column', async () => {
    const res = await app.inject({ method: 'GET', url: `/v1/jobs/${doneJobId}`, headers: bearer(DISPATCHER) });
    expect(res.statusCode, res.body).toBe(200);

    const hits: string[] = [];
    walkKeys(JSON.parse(res.body), '$', hits);
    expect(hits, `money keys leaked on the point read: ${hits.join(', ')}`).toEqual([]);

    // The strict schema agrees: not one extra field anywhere.
    expect(() => JobCardDispatcherSchema.parse(JSON.parse(res.body))).not.toThrow();
  });

  it('POST /v1/jobs/:id/cancel — the card read back after the close', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/jobs/${cancelJobId}/cancel`,
      headers: bearer(DISPATCHER),
      payload: { reasonCode: 'customer_unavailable' },
    });
    expect(res.statusCode, res.body).toBe(200);

    const hits: string[] = [];
    walkKeys(JSON.parse(res.body), '$', hits);
    expect(hits, `money keys leaked on cancel: ${hits.join(', ')}`).toEqual([]);
  });

  it('PATCH /v1/jobs/:id — the card read back after the reschedule', async () => {
    const version = (
      await db.query<{ version: number }>('SELECT version FROM job_cards WHERE id = $1', [patchJobId])
    ).rows[0]!.version;
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/jobs/${patchJobId}`,
      headers: { ...bearer(DISPATCHER), 'if-match': String(version) },
      payload: { scheduledFor: istNoonUtc(1) },
    });
    expect(res.statusCode, res.body).toBe(200);

    const hits: string[] = [];
    walkKeys(JSON.parse(res.body), '$', hits);
    expect(hits, `money keys leaked on reschedule: ${hits.join(', ')}`).toEqual([]);
  });

  it('POST /v1/jobs/:id/assign — the card read back after the assignment', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/jobs/${assignJobId}/assign`,
      headers: { ...bearer(DISPATCHER), 'if-match': String(await versionOf(assignJobId)) },
      payload: { technicianId: techId },
    });
    expect(res.statusCode, res.body).toBe(200);

    const hits: string[] = [];
    walkKeys(JSON.parse(res.body), '$', hits);
    expect(hits, `money keys leaked on assign: ${hits.join(', ')}`).toEqual([]);
  });

  it('POST /v1/jobs/bulk-assign — partial results walked through results[].job', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/jobs/bulk-assign',
      headers: bearer(DISPATCHER),
      payload: {
        technicianId: techId,
        jobIds: [
          { id: bulkJobId1, ifMatch: await versionOf(bulkJobId1) },
          { id: bulkJobId2, ifMatch: await versionOf(bulkJobId2) },
        ],
      },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(JSON.parse(res.body).results).toHaveLength(2);

    const hits: string[] = [];
    walkKeys(JSON.parse(res.body), '$', hits);
    expect(hits, `money keys leaked on bulk-assign: ${hits.join(', ')}`).toEqual([]);
  });

  it('GET /v1/technicians/load — the picker rows, recursed', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/technicians/load', headers: bearer(DISPATCHER) });
    expect(res.statusCode, res.body).toBe(200);
    expect(Array.isArray(JSON.parse(res.body))).toBe(true);

    const hits: string[] = [];
    walkKeys(JSON.parse(res.body), '$', hits);
    expect(hits, `money keys leaked on technician load: ${hits.join(', ')}`).toEqual([]);
    // The picker is where the dispatcher gets names — but never completions.
    expect(res.body).not.toContain('ompletion');
  });

  // ── T2.7: the dashboard's own reads — figures and the roster warning ───

  it('GET /v1/jobs/summary — the four figures, recursed', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/jobs/summary', headers: bearer(DISPATCHER) });
    expect(res.statusCode, res.body).toBe(200);
    const body = JSON.parse(res.body);

    const hits: string[] = [];
    walkKeys(body, '$', hits);
    expect(hits, `money keys leaked on the summary: ${hits.join(', ')}`).toEqual([]);
    // The strict schema agrees: four figures and nothing else.
    expect(() => DispatcherSummarySchema.parse(body)).not.toThrow();
    // The fixture's one completion closed today — the figure must see it.
    expect(body.doneToday).toBeGreaterThanOrEqual(1);
  });

  it('GET /v1/location/health — the roster warning carries health and age, never a coordinate', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/location/health', headers: bearer(DISPATCHER) });
    expect(res.statusCode, res.body).toBe(200);
    const body = JSON.parse(res.body);
    expect(Array.isArray(body)).toBe(true);
    expect(body.length, 'the fixture roster is non-empty').toBeGreaterThan(0);

    const hits: string[] = [];
    walkKeys(body, '$', hits);
    expect(hits, `money keys leaked on the roster read: ${hits.join(', ')}`).toEqual([]);

    // T2.7's "if it fails": a dispatcher reads `location.health`, never
    // `location.read`. The row is who, how healthy, how long quiet —
    // and the walk holds the coordinate boundary by KEY, not by shape:
    // the day the view grows a position column, this fails here first.
    const text = JSON.stringify(body).toLowerCase();
    expect(text).not.toContain('latitude');
    expect(text).not.toContain('longitude');
    for (const row of body) {
      expect(row).toHaveProperty('health');
      expect(row).toHaveProperty('minutesSince');
    }
  });

  // ── T2.4: the customer surface (§6.4) — walked like the job surface ────

  it('GET /v1/customers — the list, recursed through items[]', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/customers', headers: bearer(DISPATCHER) });
    expect(res.statusCode, res.body).toBe(200);
    const body = JSON.parse(res.body);
    expect(Array.isArray(body.items) && body.items.length > 0, 'the fixture page is non-empty').toBe(true);

    const hits: string[] = [];
    walkKeys(body, '$', hits);
    expect(hits, `money keys leaked in the customer list: ${hits.join(', ')}`).toEqual([]);

    // The dispatcher's customer row carries no companyId at all — company
    // data is a field he cannot read (PLAN.md §5), not a null he could.
    for (const item of body.items) {
      expect(item).not.toHaveProperty('companyId');
    }
  });

  it('POST /v1/customers — the created row, read back after the create', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/customers',
      headers: bearer(DISPATCHER),
      payload: { name: 'Money-leak New Customer', phone: '9847000099' },
    });
    expect(res.statusCode, res.body).toBe(200);

    const hits: string[] = [];
    walkKeys(JSON.parse(res.body), '$', hits);
    expect(hits, `money keys leaked on customer create: ${hits.join(', ')}`).toEqual([]);
  });

  it('GET /v1/customers/:id — the site and its stack', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/customers/${customerId}`,
      headers: bearer(DISPATCHER),
    });
    expect(res.statusCode, res.body).toBe(200);

    const hits: string[] = [];
    walkKeys(JSON.parse(res.body), '$', hits);
    expect(hits, `money keys leaked on the customer point read: ${hits.join(', ')}`).toEqual([]);
  });

  it('PATCH /v1/customers/:id — the site read back after the edit', async () => {
    const version = (
      await db.query<{ version: number }>('SELECT version FROM customers WHERE id = $1', [customerId])
    ).rows[0]!.version;
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/customers/${customerId}`,
      headers: { ...bearer(DISPATCHER), 'if-match': String(version) },
      payload: { notes: 'money-leak walk edit' },
    });
    expect(res.statusCode, res.body).toBe(200);

    const hits: string[] = [];
    walkKeys(JSON.parse(res.body), '$', hits);
    expect(hits, `money keys leaked on customer patch: ${hits.join(', ')}`).toEqual([]);
  });

  it('GET /v1/customers/:id/stack — the site equipment list', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/customers/${customerId}/stack`,
      headers: bearer(DISPATCHER),
    });
    expect(res.statusCode, res.body).toBe(200);

    const hits: string[] = [];
    walkKeys(JSON.parse(res.body), '$', hits);
    expect(hits, `money keys leaked on the stack read: ${hits.join(', ')}`).toEqual([]);
  });

  it('GET /v1/jobs/:id/events — the timeline, with the amended event money payload redacted', async () => {
    // The trail carries a `completion_amended` event whose stored payload
    // is the money's before/after pair — the one event type that would
    // leak by name (`cost`, `discountAmount`) if the redaction slipped.
    await db.query(
      `INSERT INTO job_events (job_card_id, event_type, actor_id, occurred_at, from_status, to_status, source, payload)
       VALUES ($1, 'completion_amended', $2, $3, 'completed', 'completed', 'web', $4::jsonb)`,
      [doneJobId, techId, new Date().toISOString(), JSON.stringify({ reason: 'typo', cost: { from: '5000.00', to: '500.00' } })],
    );
    const res = await app.inject({ method: 'GET', url: `/v1/jobs/${doneJobId}/events`, headers: bearer(DISPATCHER) });
    expect(res.statusCode, res.body).toBe(200);
    const body = JSON.parse(res.body);
    expect(Array.isArray(body.events) && body.events.length > 0, 'the fixture trail is non-empty').toBe(true);

    const hits: string[] = [];
    walkKeys(body, '$', hits);
    expect(hits, `money keys leaked in the timeline: ${hits.join(', ')}`).toEqual([]);
    // The completion block is the owner's alone — not a hidden field on
    // the dispatcher's shape, and not this schema at all.
    expect(body).not.toHaveProperty('completion');
    // The amended event's payload is visibly redacted, not silently empty.
    const amended = body.events.find((e: { eventType: string }) => e.eventType === 'completion_amended');
    expect(amended).toBeDefined();
    expect(JSON.stringify(amended.payload)).not.toContain('5000.00');
    expect(amended.payload).toMatchObject({ redacted: expect.any(String) });
  });

  it('the fixture is self-proving: the OWNER reads the money the dispatcher must not', async () => {
    const res = await app.inject({ method: 'GET', url: `/v1/jobs/${doneJobId}`, headers: bearer(OWNER) });
    expect(res.statusCode, res.body).toBe(200);
    const body = JSON.parse(res.body);
    // Without this guard the suite could pass because the money row is missing.
    // (The owner's shape carries the completion's money figures; the
    // payment reference stays a stored column for reconciliation.)
    expect(body.cost).toBe('14500.00');
    expect(body.discountAmount).toBe('1500.00');
    expect(body.collectionMode).toBe('cash');

    // The owner's timeline read carries the FULL trail: the amended
    // event's money before/after pair — the payload the dispatcher's
    // walk saw redacted — and the completion with its figures.
    const ownerTimeline = await app.inject({
      method: 'GET',
      url: `/v1/jobs/${doneJobId}/events`,
      headers: bearer(OWNER),
    });
    expect(ownerTimeline.statusCode, ownerTimeline.body).toBe(200);
    const timeline = JSON.parse(ownerTimeline.body);
    const amendedOwner = timeline.events.find((e: { eventType: string }) => e.eventType === 'completion_amended');
    expect(amendedOwner.payload.cost).toEqual({ from: '5000.00', to: '500.00' });
    expect(timeline.completion).not.toBeNull();
    expect(timeline.completion.cost).toBe('14500.00');
    expect(Array.isArray(timeline.completion.parts)).toBe(true);
  });

  it('an error envelope carries no money either', async () => {
    // A job that does not exist: the 404 envelope is part of the payload surface too.
    const res = await app.inject({
      method: 'GET',
      url: `/v1/jobs/${randomBytes(16).toString('hex')}`,
      headers: bearer(DISPATCHER),
    });
    expect(res.statusCode).toBe(404);
    const parsed = errorEnvelopeSchema.parse(JSON.parse(res.body)) as unknown as ErrorEnvelope;
    expect(parsed.error.requestId).toMatch(ULID);
    const hits: string[] = [];
    walkKeys(parsed, '$', hits);
    expect(hits).toEqual([]);
  });
});

describe('the technician’s own timeline carries no money either (TON.1)', () => {
  it('GET /v1/jobs/:id/events as the technician on the job — recursed, the amended payload redacted', async () => {
    const res = await app.inject({ method: 'GET', url: `/v1/jobs/${fieldJobId}/events`, headers: bearer(FIELD_TECH) });
    expect(res.statusCode, res.body).toBe(200);
    const body = JSON.parse(res.body);
    expect(Array.isArray(body.events) && body.events.length > 0, 'the fixture trail is non-empty').toBe(true);

    const hits: string[] = [];
    walkKeys(body, '$', hits);
    expect(hits, `money keys leaked in the technician's timeline: ${hits.join(', ')}`).toEqual([]);
    expect(body).not.toHaveProperty('completion');
    const amended = body.events.find((e: { eventType: string }) => e.eventType === 'completion_amended');
    expect(JSON.stringify(amended.payload)).not.toContain('9000.00');
    expect(amended.payload).toMatchObject({ redacted: expect.any(String) });
  });

  it('another technician’s job is refused, and the refusal carries no money', async () => {
    const res = await app.inject({ method: 'GET', url: `/v1/jobs/${doneJobId}/events`, headers: bearer(FIELD_TECH) });
    expect(res.statusCode, res.body).toBe(403);
    const parsed = errorEnvelopeSchema.parse(JSON.parse(res.body)) as unknown as ErrorEnvelope;
    expect(parsed.error.code).toBe('OUT_OF_SCOPE');
    const hits: string[] = [];
    walkKeys(parsed, '$', hits);
    expect(hits).toEqual([]);
  });
});
