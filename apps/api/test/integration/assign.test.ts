import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import type { FastifyInstance } from 'fastify';
import {
  BulkAssignResponseSchema,
  JobCardDispatcherSchema,
  JobCardOwnerSchema,
  TechnicianLoadSchema,
  type ErrorEnvelope,
  type LoginResponse,
} from '@servgrid/shared';
import { loadConfig, type Config } from '../../src/config.js';
import { closePool } from '../../src/db/pool.js';
import { runMigrations } from '../../src/db/migrate.js';
import { hashPassword } from '../../src/lib/password.js';
import { buildServer } from '../../src/server.js';
import { validEnv } from '../helpers/env.js';

/**
 * Assignment and bulk reassign (PHASE-2-DISPATCHER.md T2.3, PLAN-BACKEND.md
 * §6.1/§6.3). Runs against a scratch database from the real migrations
 * (§14: no mocked database anywhere) and proves the five things the brief
 * names — plus the two behaviours the spec calls out in prose:
 *
 *  - two GENUINELY SIMULTANEOUS assigns of one job: one wins, the loser
 *    gets 409 VERSION_CONFLICT naming the current assignee in `details`.
 *    The proof of concurrency is in the assertion: the loser can only name
 *    the winner if it read the row AFTER the winner's commit, and the
 *    result is deterministic because `lockJobForAssign` takes the row
 *    lock BEFORE the version is compared — a lock taken after the read
 *    would be a real race three dispatchers would find on their first
 *    Monday (§6.3 "If it fails");
 *  - reassignment from `assigned` and `en_route` (resetting the status —
 *    the new technician has not set off), refused from `in_progress`
 *    naming who is on site;
 *  - bulk assign with an in_progress job in the set: partial results, the
 *    valid ones applied, the invalid one named;
 *  - assign without `If-Match` is 428 PRECONDITION_REQUIRED — never a
 *    silent success;
 *  - `GET /v1/technicians/load` returns load and NAMES (the dispatcher's
 *    only source of them — `/v1/employees` is owner-only) and no
 *    `job_completions` field;
 *  - `dispatch.bulk` switches the bulk half off WITHOUT taking the single
 *    assign down (that is the flag's whole reason to exist);
 *  - the 409 bodies name a person — asserted on the exact strings a
 *    dispatcher would read.
 */

function databaseUrl(): string {
  return process.env.DATABASE_URL ?? 'postgres://servgrid:servgrid@localhost:5432/servgrid';
}

function adminUrlFor(url: string): string {
  const parsed = new URL(url);
  parsed.pathname = '/postgres';
  return parsed.toString();
}

const SCRATCH_DB = 'servgrid_assign_test';
const PASSWORD = 'as-plain-copier-71';

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

const DISPATCHER: Actor = { username: '', id: '', token: '' }; // dispatch.console only
const DISPATCHER_BULK: Actor = { username: '', id: '', token: '' }; // console + bulk
const NO_FLAGS: Actor = { username: '', id: '', token: '' }; // neither — flags default off
const OWNER: Actor = { username: '', id: '', token: '' };
const TECH_RAVI: Actor = { username: '', id: '', token: '' }; // logged in, for the 403 door
const SALES_REP: Actor = { username: '', id: '', token: '' };

let admin: Pool;
let db: Pool;
let app: FastifyInstance;
let config: Config;

let customerId = '';
let serviceId = '';
const RAVI = { id: '', name: 'Ravi Kumar' };
const ANITHA = { id: '', name: 'Anitha R' };
const SURESH = { id: '', name: 'Suresh N' };

async function seedLoginEmployee(role: string, fullName: string, who: Actor): Promise<void> {
  const username = `t23.${role}.${randomBytes(4).toString('hex')}`;
  who.id = (
    await db.query<{ id: string }>(
      `INSERT INTO employees (username, password_hash, full_name, role)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [username, await hashPassword(PASSWORD), fullName, role],
    )
  ).rows[0]!.id;
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

/** A technician WITHOUT a login — the picker's target, not an actor. */
async function seedTechnician(fullName: string): Promise<string> {
  return (
    await db.query<{ id: string }>(
      `INSERT INTO employees (username, password_hash, full_name, role)
       VALUES ($1, 'not-a-real-hash', $2, 'technician') RETURNING id`,
      [`t23.tech.${randomBytes(4).toString('hex')}`, fullName],
    )
  ).rows[0]!.id;
}

async function seedFlags(employeeId: string, flags: ReadonlyArray<'dispatch.console' | 'dispatch.bulk'>): Promise<void> {
  for (const flag of flags) {
    await db.query(
      `INSERT INTO employee_flag_overrides (employee_id, flag, enabled, updated_by)
       VALUES ($1, $2, true, $1)`,
      [employeeId, flag],
    );
  }
}

async function seedJob(opts: {
  jobNumber: string;
  status: 'unassigned' | 'assigned' | 'en_route' | 'in_progress';
  assignedTo?: string | null;
  scheduledFor?: string;
}): Promise<string> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO job_cards (job_number, customer_id, service_id, title, status, assigned_to, assigned_at, scheduled_for)
     VALUES ($1, $2, $3, 'Assign suite fixture job', $4, $5, $6, $7) RETURNING id`,
    [
      opts.jobNumber,
      customerId,
      serviceId,
      opts.status,
      opts.status === 'unassigned' ? (opts.assignedTo ?? null) : (opts.assignedTo ?? RAVI.id),
      opts.status === 'unassigned' ? null : new Date().toISOString(),
      opts.scheduledFor ?? null,
    ],
  );
  return r.rows[0]!.id;
}

function bearer(actor: Actor): Record<string, string> {
  return { authorization: `Bearer ${actor.token}` };
}

async function versionOf(jobId: string): Promise<number> {
  return (await db.query<{ version: number }>('SELECT version FROM job_cards WHERE id = $1', [jobId]))
    .rows[0]!.version;
}

async function jobRowOf(jobId: string): Promise<{ status: string; assigned_to: string | null; version: number }> {
  return (
    await db.query<{ status: string; assigned_to: string | null; version: number }>(
      'SELECT status, assigned_to, version FROM job_cards WHERE id = $1',
      [jobId],
    )
  ).rows[0]!;
}

async function eventsOf(jobId: string): Promise<Array<{ event_type: string; actor_id: string; from_status: string | null; to_status: string }>> {
  return (
    await db.query<{ event_type: string; actor_id: string; from_status: string | null; to_status: string }>(
      `SELECT event_type, actor_id, from_status, to_status FROM job_events
       WHERE job_card_id = $1 ORDER BY occurred_at, id`,
      [jobId],
    )
  ).rows;
}

function envelopeOf(status: number, body: string): ErrorEnvelope['error'] {
  expect(status).toBeGreaterThanOrEqual(400);
  const parsed = JSON.parse(body) as ErrorEnvelope;
  expect(parsed.error.requestId).toBeTruthy();
  return parsed.error;
}

/** The parsed bulk body — the shared schema factory erases to ZodTypeAny, so the test pins the shape. */
type ParsedBulkResponse = {
  results: Array<
    | { jobId: string; jobNumber: string; ok: true; job: { assignedTo: string | null; version: number; status: string } }
    | { jobId: string; jobNumber: string; ok: false; code: 'NOT_FOUND' | 'VERSION_CONFLICT' | 'ILLEGAL_TRANSITION'; message: string }
  >;
};

const parseBulk = (body: string): ParsedBulkResponse =>
  BulkAssignResponseSchema(JobCardDispatcherSchema).parse(JSON.parse(body)) as ParsedBulkResponse;

const JOB = {
  concurrent: 'JC-AS-0001', // unassigned — the plain first assignment
  race: 'JC-AS-0007', // unassigned — the two-client race, its own card
  assigned: 'JC-AS-0002', // assigned to RAVI — reassign from `assigned`
  enRoute: 'JC-AS-0003', // assigned to RAVI — reassign from `en_route` (resets)
  inProgress: 'JC-AS-0004', // assigned to RAVI — refused, naming him
  unassignedPlain: 'JC-AS-0005', // no-If-Match and flag tests
  ownerAssign: 'JC-AS-0006', // unassigned — the owner's door
  bulkUnassigned: 'JC-AS-0101',
  bulkAssigned: 'JC-AS-0102', // assigned to RAVI
  bulkInProgress: 'JC-AS-0103', // assigned to ANITHA — the named refusal
  bulkStale: 'JC-AS-0104', // assigned to RAVI — stale If-Match entry
};

let J: Record<keyof typeof JOB, string>;

beforeAll(async () => {
  admin = new Pool({ connectionString: adminUrlFor(databaseUrl()), max: 2 });
  await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${SCRATCH_DB}`);

  const scratchUrl = new URL(databaseUrl());
  scratchUrl.pathname = `/${SCRATCH_DB}`;
  process.env.DATABASE_URL = scratchUrl.toString();
  db = new Pool({ connectionString: scratchUrl.toString(), max: 10 });
  await runMigrations({ pool: db });

  config = loadConfig(validEnv({ DATABASE_URL: scratchUrl.toString() }));
  app = buildServer(config, { logger: false });
  await app.ready();

  await seedLoginEmployee('dispatcher', 'Assign suite dispatcher', DISPATCHER);
  await seedFlags(DISPATCHER.id, ['dispatch.console']);
  await seedLoginEmployee('dispatcher', 'Assign suite bulk dispatcher', DISPATCHER_BULK);
  await seedFlags(DISPATCHER_BULK.id, ['dispatch.console', 'dispatch.bulk']);
  await seedLoginEmployee('dispatcher', 'Assign suite dark dispatcher', NO_FLAGS);
  await seedLoginEmployee('owner', 'Assign suite owner', OWNER);
  await seedFlags(OWNER.id, ['dispatch.console', 'dispatch.bulk']);
  await seedLoginEmployee('technician', 'Ravi Kumar', TECH_RAVI);
  await seedLoginEmployee('sales_rep', 'Assign suite rep', SALES_REP);

  RAVI.id = await seedTechnician(RAVI.name);
  ANITHA.id = await seedTechnician(ANITHA.name);
  SURESH.id = await seedTechnician(SURESH.name);

  customerId = (
    await db.query<{ id: string }>(
      `INSERT INTO customers (name, phone) VALUES ('Assign Suite Customer', '9846000001') RETURNING id`,
    )
  ).rows[0]!.id;
  serviceId = (
    await db.query<{ id: string }>(
      `INSERT INTO services (code, name) VALUES ('AS-SVC', 'Assign suite service') RETURNING id`,
    )
  ).rows[0]!.id;

  // Noon IST today, so the in_progress fixtures carry a real active_since
  // and the load row has an open job today.
  const today = istNoonUtc(0);

  J = {
    concurrent: await seedJob({ jobNumber: JOB.concurrent, status: 'unassigned' }),
    race: await seedJob({ jobNumber: JOB.race, status: 'unassigned' }),
    assigned: await seedJob({ jobNumber: JOB.assigned, status: 'assigned', assignedTo: RAVI.id }),
    enRoute: await seedJob({ jobNumber: JOB.enRoute, status: 'en_route', assignedTo: RAVI.id, scheduledFor: today }),
    inProgress: await seedJob({ jobNumber: JOB.inProgress, status: 'in_progress', assignedTo: RAVI.id, scheduledFor: today }),
    unassignedPlain: await seedJob({ jobNumber: JOB.unassignedPlain, status: 'unassigned' }),
    ownerAssign: await seedJob({ jobNumber: JOB.ownerAssign, status: 'unassigned' }),
    bulkUnassigned: await seedJob({ jobNumber: JOB.bulkUnassigned, status: 'unassigned' }),
    bulkAssigned: await seedJob({ jobNumber: JOB.bulkAssigned, status: 'assigned', assignedTo: RAVI.id }),
    bulkInProgress: await seedJob({ jobNumber: JOB.bulkInProgress, status: 'in_progress', assignedTo: ANITHA.id, scheduledFor: today }),
    bulkStale: await seedJob({ jobNumber: JOB.bulkStale, status: 'assigned', assignedTo: RAVI.id }),
  };
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

describe('POST /v1/jobs/:id/assign — the working half (dispatch.console)', () => {
  it('assigns an unassigned job to an active technician and emits `assigned`', async () => {
    const before = await versionOf(J.concurrent);
    const res = await app.inject({
      method: 'POST',
      url: `/v1/jobs/${J.concurrent}/assign`,
      headers: { ...bearer(DISPATCHER), 'if-match': String(before) },
      payload: { technicianId: RAVI.id },
    });
    expect(res.statusCode, res.body).toBe(200);

    const card = JobCardDispatcherSchema.parse(JSON.parse(res.body));
    expect(card.status).toBe('assigned');
    expect(card.assignedTo).toBe(RAVI.id);
    expect(card.version).toBe(before + 1);

    const row = await jobRowOf(J.concurrent);
    expect(row.status).toBe('assigned');
    expect(row.assigned_to).toBe(RAVI.id);
    const events = await eventsOf(J.concurrent);
    expect(events).toHaveLength(1);
    expect(events[0]!.event_type).toBe('assigned');
    expect(events[0]!.actor_id).toBe(DISPATCHER.id);
    expect(events[0]!.from_status).toBe('unassigned');
    expect(events[0]!.to_status).toBe('assigned');
  });

  it('reassigns from `assigned` — legal, emits `reassigned`, names the previous technician', async () => {
    const before = await versionOf(J.assigned);
    const res = await app.inject({
      method: 'POST',
      url: `/v1/jobs/${J.assigned}/assign`,
      headers: { ...bearer(DISPATCHER), 'if-match': String(before) },
      payload: { technicianId: ANITHA.id },
    });
    expect(res.statusCode, res.body).toBe(200);

    const card = JobCardDispatcherSchema.parse(JSON.parse(res.body));
    expect(card.status).toBe('assigned');
    expect(card.assignedTo).toBe(ANITHA.id);

    const events = await eventsOf(J.assigned);
    expect(events).toHaveLength(1);
    expect(events[0]!.event_type).toBe('reassigned');
    expect(events[0]!.from_status).toBe('assigned');
  });

  it('reassigns from `en_route` — succeeds and RESETS the status to `assigned`', async () => {
    const before = await versionOf(J.enRoute);
    const res = await app.inject({
      method: 'POST',
      url: `/v1/jobs/${J.enRoute}/assign`,
      headers: { ...bearer(DISPATCHER), 'if-match': String(before) },
      payload: { technicianId: ANITHA.id },
    });
    expect(res.statusCode, res.body).toBe(200);

    // The point of the reset: the new technician has not set off.
    const card = JobCardDispatcherSchema.parse(JSON.parse(res.body));
    expect(card.status).toBe('assigned');
    expect(card.assignedTo).toBe(ANITHA.id);

    const row = await jobRowOf(J.enRoute);
    expect(row.status).toBe('assigned');
    expect(row.assigned_to).toBe(ANITHA.id);
    const events = await eventsOf(J.enRoute);
    expect(events[0]!.event_type).toBe('reassigned');
    expect(events[0]!.from_status).toBe('en_route');
    expect(events[0]!.to_status).toBe('assigned');
  });

  it('refuses from `in_progress` with 409 naming who is on site', async () => {
    const before = await versionOf(J.inProgress);
    const res = await app.inject({
      method: 'POST',
      url: `/v1/jobs/${J.inProgress}/assign`,
      headers: { ...bearer(DISPATCHER), 'if-match': String(before) },
      payload: { technicianId: ANITHA.id },
    });
    expect(res.statusCode, res.body).toBe(409);

    const error = envelopeOf(res.statusCode, res.body);
    expect(error.code).toBe('ILLEGAL_TRANSITION');
    // Done-when: the 409 body names the assignee — the string a user reads.
    expect(error.message).toContain(RAVI.name);
    const details = error.details as { onSite: { id: string; name: string } | null };
    expect(details.onSite).not.toBeNull();
    expect(details.onSite!.id).toBe(RAVI.id);
    expect(details.onSite!.name).toBe(RAVI.name);

    // And the refusal changed nothing: he keeps the job he started.
    const row = await jobRowOf(J.inProgress);
    expect(row.status).toBe('in_progress');
    expect(row.assigned_to).toBe(RAVI.id);
    expect(row.version).toBe(before);
  });

  it('a stale If-Match loses with 409 VERSION_CONFLICT naming the current assignee', async () => {
    // Sequential rehearsal of the race: the request acts on version 1 of a
    // job already at version 2 (here: bumped by a reassign, as the winning
    // dispatcher would have).
    const current = await versionOf(J.bulkStale);
    await app.inject({
      method: 'POST',
      url: `/v1/jobs/${J.bulkStale}/assign`,
      headers: { ...bearer(DISPATCHER), 'if-match': String(current) },
      payload: { technicianId: ANITHA.id },
    });
    const bumped = await versionOf(J.bulkStale);
    expect(bumped).toBe(current + 1);

    const stale = await app.inject({
      method: 'POST',
      url: `/v1/jobs/${J.bulkStale}/assign`,
      headers: { ...bearer(DISPATCHER), 'if-match': String(current) },
      payload: { technicianId: ANITHA.id },
    });
    expect(stale.statusCode, stale.body).toBe(409);

    const error = envelopeOf(stale.statusCode, stale.body);
    expect(error.code).toBe('VERSION_CONFLICT');
    expect(error.message).toContain(ANITHA.name);
    const details = error.details as { currentVersion: number; currentAssignee: { id: string; name: string } | null };
    expect(details.currentVersion).toBe(bumped);
    expect(details.currentAssignee).not.toBeNull();
    expect(details.currentAssignee!.id).toBe(ANITHA.id);
    expect(details.currentAssignee!.name).toBe(ANITHA.name);
  });

  it('without If-Match is 428 PRECONDITION_REQUIRED — never a silent success', async () => {
    for (const ifMatch of [undefined, '', 'not-a-number', '0']) {
      const headers = bearer(DISPATCHER);
      if (ifMatch !== undefined) headers['if-match'] = ifMatch;
      const res = await app.inject({
        method: 'POST',
        url: `/v1/jobs/${J.unassignedPlain}/assign`,
        headers,
        payload: { technicianId: RAVI.id },
      });
      expect(res.statusCode, `if-match: ${String(ifMatch)}`).toBe(428);
      expect(envelopeOf(res.statusCode, res.body).code).toBe('PRECONDITION_REQUIRED');
    }
    // The job is still sitting in the queue, unassigned.
    const row = await jobRowOf(J.unassignedPlain);
    expect(row.status).toBe('unassigned');
    expect(row.assigned_to).toBeNull();
  });

  it('the assignee must be an active technician — 422 for anyone else', async () => {
    const before = await versionOf(J.unassignedPlain);
    for (const technicianId of [crypto.randomUUID(), OWNER.id]) {
      const res = await app.inject({
        method: 'POST',
        url: `/v1/jobs/${J.unassignedPlain}/assign`,
        headers: { ...bearer(DISPATCHER), 'if-match': String(before) },
        payload: { technicianId },
      });
      expect(res.statusCode, res.body).toBe(422);
      expect(envelopeOf(res.statusCode, res.body).code).toBe('VALIDATION_FAILED');
    }
    const row = await jobRowOf(J.unassignedPlain);
    expect(row.status).toBe('unassigned');
  });

  it('the owner assigns too; a technician and a sales rep are 403 at the door', async () => {
    const ownerVersion = await versionOf(J.ownerAssign);
    const ownerRes = await app.inject({
      method: 'POST',
      url: `/v1/jobs/${J.ownerAssign}/assign`,
      headers: { ...bearer(OWNER), 'if-match': String(ownerVersion) },
      payload: { technicianId: SURESH.id },
    });
    expect(ownerRes.statusCode, ownerRes.body).toBe(200);
    const ownerCard = JobCardOwnerSchema.parse(JSON.parse(ownerRes.body));
    expect(ownerCard.assignedTo).toBe(SURESH.id);
    expect(ownerCard.cost).toBeNull();

    for (const actor of [TECH_RAVI, SALES_REP]) {
      const res = await app.inject({
        method: 'POST',
        url: `/v1/jobs/${J.unassignedPlain}/assign`,
        headers: { ...bearer(actor), 'if-match': String(await versionOf(J.unassignedPlain)) },
        payload: { technicianId: RAVI.id },
      });
      expect(res.statusCode, res.body).toBe(403);
      expect(envelopeOf(res.statusCode, res.body).code).toBe('FORBIDDEN');
    }
  });

  it('a dispatcher whose console flag is off is 409 FLAG_DISABLED', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/jobs/${J.unassignedPlain}/assign`,
      headers: { ...bearer(NO_FLAGS), 'if-match': String(await versionOf(J.unassignedPlain)) },
      payload: { technicianId: RAVI.id },
    });
    expect(res.statusCode, res.body).toBe(409);
    expect(envelopeOf(res.statusCode, res.body).code).toBe('FLAG_DISABLED');
  });

  it('an unknown job is 404', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/jobs/${crypto.randomUUID()}/assign`,
      headers: { ...bearer(DISPATCHER), 'if-match': '1' },
      payload: { technicianId: RAVI.id },
    });
    expect(res.statusCode, res.body).toBe(404);
  });
});

describe('two genuinely simultaneous assigns of one job', () => {
  it('one wins, the loser gets 409 naming the current assignee in details', async () => {
    // Both clients fire before either is awaited — genuinely concurrent.
    // Both act on the SAME version, so exactly one can win; which one is
    // decided by the row lock, and the assertions hold either way.
    const version = await versionOf(J.race);
    const [first, second] = await Promise.all([
      app.inject({
        method: 'POST',
        url: `/v1/jobs/${J.race}/assign`,
        headers: { ...bearer(DISPATCHER), 'if-match': String(version) },
        payload: { technicianId: RAVI.id },
      }),
      app.inject({
        method: 'POST',
        url: `/v1/jobs/${J.race}/assign`,
        headers: { ...bearer(DISPATCHER_BULK), 'if-match': String(version) },
        payload: { technicianId: ANITHA.id },
      }),
    ]);

    const responses = [first, second];
    expect(responses.map((r) => r.statusCode).sort((a, b) => a - b)).toEqual([200, 409]);

    const firstWon = first.statusCode === 200;
    const winner = firstWon ? first : second;
    const loser = firstWon ? second : first;
    const winnerTech = firstWon ? RAVI : ANITHA;
    const winnerActor = firstWon ? DISPATCHER.id : DISPATCHER_BULK.id;

    const winnerCard = JobCardDispatcherSchema.parse(JSON.parse(winner.body));
    expect(winnerCard.assignedTo).toBe(winnerTech.id);
    expect(winnerCard.status).toBe('assigned');

    const error = envelopeOf(loser.statusCode, loser.body);
    expect(error.code).toBe('VERSION_CONFLICT');
    // Done-when: the body names the winner — the string a dispatcher reads.
    expect(error.message).toContain(winnerTech.name);
    const details = error.details as {
      currentVersion: number;
      currentAssignee: { id: string; name: string };
    };
    expect(details.currentAssignee.id).toBe(winnerTech.id);
    expect(details.currentAssignee.name).toBe(winnerTech.name);
    expect(details.currentVersion).toBe(winnerCard.version);

    // Exactly one assignment happened, and it is the winner's.
    const row = await jobRowOf(J.race);
    expect(row.status).toBe('assigned');
    expect(row.assigned_to).toBe(winnerTech.id);
    expect(row.version).toBe(winnerCard.version);
    const events = await eventsOf(J.race);
    expect(events).toHaveLength(1);
    expect(events[0]!.event_type).toBe('assigned');
    expect(events[0]!.actor_id).toBe(winnerActor);
  });
});

describe('POST /v1/jobs/bulk-assign — the risky half (dispatch.bulk)', () => {
  it('a multi-select spanning an in_progress job returns partial results, the valid ones applied, the invalid one named', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/jobs/bulk-assign',
      headers: bearer(DISPATCHER_BULK),
      payload: {
        technicianId: ANITHA.id,
        // The failed one FIRST, so the response order proves results come
        // back in the picker's order, not the lock's.
        jobIds: [
          { id: J.bulkInProgress, ifMatch: await versionOf(J.bulkInProgress) },
          { id: J.bulkUnassigned, ifMatch: await versionOf(J.bulkUnassigned) },
          { id: J.bulkAssigned, ifMatch: await versionOf(J.bulkAssigned) },
        ],
      },
    });
    expect(res.statusCode, res.body).toBe(200);

    const body = parseBulk(res.body);
    expect(body.results).toHaveLength(3);
    expect(body.results[0]!.jobId).toBe(J.bulkInProgress);
    expect(body.results[1]!.jobId).toBe(J.bulkUnassigned);
    expect(body.results[2]!.jobId).toBe(J.bulkAssigned);

    // The invalid one is NAMED — job number and the person on site.
    const refused = body.results[0]!;
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.code).toBe('ILLEGAL_TRANSITION');
      expect(refused.jobNumber).toBe(JOB.bulkInProgress);
      expect(refused.message).toContain(ANITHA.name);
    }

    // The valid ones applied.
    expect(body.results[1]!.ok).toBe(true);
    expect(body.results[2]!.ok).toBe(true);
    if (body.results[1]!.ok && body.results[2]!.ok) {
      expect(body.results[1]!.job.assignedTo).toBe(ANITHA.id);
      expect(body.results[2]!.job.assignedTo).toBe(ANITHA.id);
    }

    // One transaction, honest state: exactly the two valid jobs moved.
    const moved = await jobRowOf(J.bulkUnassigned);
    expect(moved.status).toBe('assigned');
    expect(moved.assigned_to).toBe(ANITHA.id);
    const reassigned = await jobRowOf(J.bulkAssigned);
    expect(reassigned.status).toBe('assigned');
    expect(reassigned.assigned_to).toBe(ANITHA.id);
    const untouched = await jobRowOf(J.bulkInProgress);
    expect(untouched.status).toBe('in_progress');
    expect(untouched.assigned_to).toBe(ANITHA.id); // she keeps it
    const events = await eventsOf(J.bulkInProgress);
    expect(events).toHaveLength(0);
  });

  it('a stale per-job If-Match is a named partial result, not a whole-request failure', async () => {
    // Self-contained: act one version behind whatever the job is at now,
    // and name whoever actually holds it (read from the database, so the
    // assertion tracks the row rather than another test's outcome).
    const current = await versionOf(J.bulkStale);
    const holder = (
      await db.query<{ full_name: string }>(
        `SELECT e.full_name FROM job_cards j JOIN employees e ON e.id = j.assigned_to WHERE j.id = $1`,
        [J.bulkStale],
      )
    ).rows[0]!.full_name;
    const res = await app.inject({
      method: 'POST',
      url: '/v1/jobs/bulk-assign',
      headers: bearer(DISPATCHER_BULK),
      payload: {
        technicianId: SURESH.id,
        jobIds: [
          { id: J.bulkStale, ifMatch: current - 1 },
          { id: J.unassignedPlain, ifMatch: await versionOf(J.unassignedPlain) },
        ],
      },
    });
    expect(res.statusCode, res.body).toBe(200);

    const body = parseBulk(res.body);
    const refused = body.results.find((r) => r.jobId === J.bulkStale);
    const applied = body.results.find((r) => r.jobId === J.unassignedPlain);
    expect(refused).toBeDefined();
    expect(applied).toBeDefined();
    if (refused && !refused.ok) {
      expect(refused.code).toBe('VERSION_CONFLICT');
      expect(refused.message).toContain(holder); // who holds the job now
      expect(refused.jobNumber).toBe(JOB.bulkStale);
    } else {
      expect.unreachable('the stale entry must be refused');
    }
    if (applied && applied.ok) {
      expect(applied.job.assignedTo).toBe(SURESH.id);
    } else {
      expect.unreachable('the valid entry must be applied');
    }
  });

  it('bulk switched off while the single assign still works — the halves are separate flags', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/jobs/bulk-assign',
      headers: bearer(DISPATCHER), // console ON, bulk OFF
      payload: {
        technicianId: RAVI.id,
        jobIds: [{ id: J.ownerAssign, ifMatch: await versionOf(J.ownerAssign) }],
      },
    });
    expect(res.statusCode, res.body).toBe(409);
    expect(envelopeOf(res.statusCode, res.body).code).toBe('FLAG_DISABLED');

    // The working half is untouched by the bulk switch.
    const single = await app.inject({
      method: 'POST',
      url: `/v1/jobs/${J.unassignedPlain}/assign`,
      headers: { ...bearer(DISPATCHER), 'if-match': String(await versionOf(J.unassignedPlain)) },
      payload: { technicianId: RAVI.id },
    });
    expect(single.statusCode, single.body).toBe(200);
  });

  it('refuses the whole request when the target is not an active technician — nothing partial about it', async () => {
    const before = await jobRowOf(J.bulkUnassigned);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/jobs/bulk-assign',
      headers: bearer(DISPATCHER_BULK),
      payload: {
        technicianId: OWNER.id, // an owner, not a technician
        jobIds: [{ id: J.bulkUnassigned, ifMatch: before.version }],
      },
    });
    expect(res.statusCode, res.body).toBe(422);
    const after = await jobRowOf(J.bulkUnassigned);
    expect(after.version).toBe(before.version);
    expect(after.assigned_to).toBe(before.assigned_to);
  });

  it('an empty selection, duplicates, and a bad payload are 422', async () => {
    for (const jobIds of [
      [],
      [
        { id: J.bulkUnassigned, ifMatch: 1 },
        { id: J.bulkUnassigned, ifMatch: 1 },
      ],
      [{ id: 'not-a-uuid', ifMatch: 1 }],
    ]) {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/jobs/bulk-assign',
        headers: bearer(DISPATCHER_BULK),
        payload: { technicianId: RAVI.id, jobIds },
      });
      expect(res.statusCode, JSON.stringify(jobIds)).toBe(422);
    }
  });

  it('a technician and a sales rep are 403 at the door', async () => {
    for (const actor of [TECH_RAVI, SALES_REP]) {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/jobs/bulk-assign',
        headers: bearer(actor),
        payload: { technicianId: RAVI.id, jobIds: [{ id: J.bulkUnassigned, ifMatch: 1 }] },
      });
      expect(res.statusCode, res.body).toBe(403);
    }
  });
});

describe('GET /v1/technicians/load — the picker', () => {
  it('returns load and names, and no job_completions field', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/technicians/load', headers: bearer(DISPATCHER) });
    expect(res.statusCode, res.body).toBe(200);

    const rows = TechnicianLoadSchema.array().parse(JSON.parse(res.body));
    expect(rows.length).toBeGreaterThanOrEqual(3);

    const ravi = rows.find((row) => row.technicianName === RAVI.name);
    expect(ravi, 'Ravi is on the roster with his name').toBeDefined();
    expect(ravi!.employeeId).toBe(RAVI.id);
    expect(ravi!.openTotal).toBeGreaterThanOrEqual(1);
    // He is ON a job (in_progress with a promised start) — the picker shows since when.
    expect(ravi!.activeSince).not.toBeNull();

    const suresh = rows.find((row) => row.technicianName === SURESH.name);
    expect(suresh, 'Suresh is on the roster even at zero today').toBeDefined();
    // He holds one job (the owner's assignment above, no date on it); the
    // bulk-assigned one was reassigned away by the single-assign test, so
    // the total is 1 — and none of it is today.
    expect(suresh!.openTotal).toBe(1);
    expect(suresh!.openToday).toBe(0);
    expect(suresh!.doneToday).toBe(0);
    expect(suresh!.activeSince).toBeNull();

    // "no job_completions field" — asserted on the bytes, not the schema:
    // no completion-flavoured key exists anywhere in the payload.
    expect(res.body.toLowerCase()).not.toContain('completion');
    expect(res.body.toLowerCase()).not.toContain('cost');
  });

  it('a dispatcher without the console flag is 409; a technician and a rep are 403', async () => {
    const dark = await app.inject({
      method: 'GET',
      url: '/v1/technicians/load',
      headers: bearer(NO_FLAGS),
    });
    expect(dark.statusCode, dark.body).toBe(409);
    expect(envelopeOf(dark.statusCode, dark.body).code).toBe('FLAG_DISABLED');

    for (const actor of [TECH_RAVI, SALES_REP]) {
      const res = await app.inject({ method: 'GET', url: '/v1/technicians/load', headers: bearer(actor) });
      expect(res.statusCode, res.body).toBe(403);
      expect(envelopeOf(res.statusCode, res.body).code).toBe('FORBIDDEN');
    }
  });
});
