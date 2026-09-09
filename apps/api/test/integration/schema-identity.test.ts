import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { runMigrations } from '../../src/db/migrate.js';

/**
 * Migrations 002–003 integration suite (PHASE-0-FOUNDATION.md T0.3):
 * the enum catalogue (PLAN-DATA-MODEL.md §2.1) and the identity tables
 * (§3.1). Runs against the real Postgres 16 from `docker compose up db`
 * — no mocked database anywhere (PLAN-BACKEND.md §14). The suite builds
 * its own scratch database from the server's admin connection and drops
 * it afterwards; a failed run leaves nothing behind.
 */

function databaseUrl(): string {
  // CI exports DATABASE_URL explicitly; locally the compose defaults are
  // the documented shape, so an unset variable falls back to them.
  return (
    process.env.DATABASE_URL ?? 'postgres://servgrid:servgrid@localhost:5432/servgrid'
  );
}

function adminUrlFor(url: string): string {
  const parsed = new URL(url);
  parsed.pathname = '/postgres';
  return parsed.toString();
}

const SCRATCH_DB = 'servgrid_identity_test';

/**
 * The catalogue, verbatim from PLAN-DATA-MODEL.md §2.1 — the authority.
 * The eighteen types migration 002 creates; the three contract types
 * ship with migration 015 and must NOT appear yet. Declared order is
 * creation order, and the diff asserts it, so the file reads in the same
 * order the catalogue does.
 */
const EXPECTED_ENUMS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['employee_role', ['owner', 'dispatcher', 'technician', 'sales_rep']],
  [
    'job_status',
    ['unassigned', 'assigned', 'en_route', 'in_progress', 'completed', 'cancelled'],
  ],
  ['job_priority', ['low', 'normal', 'high', 'urgent']],
  [
    'cancellation_reason',
    [
      'customer_unavailable',
      'customer_cancelled',
      'duplicate',
      'wrong_details',
      'no_access',
      'parts_unavailable',
      'rescheduled_by_office',
      'contract_cancelled',
      'other',
    ],
  ],
  [
    'job_event_type',
    [
      'created',
      'assigned',
      'reassigned',
      'status_changed',
      'rescheduled',
      'completed',
      'completion_amended',
      'cancelled',
      'attachment_added',
      'stack_updated',
    ],
  ],
  ['event_source', ['mobile', 'web', 'system']],
  ['collection_mode', ['cash', 'upi', 'card', 'bank_transfer', 'none']],
  ['payment_mode', ['cash', 'upi', 'card', 'cheque', 'bank_transfer']],
  ['payment_status', ['collected', 'void']],
  ['sales_card_status', ['draft', 'confirmed', 'void']],
  ['product_category', ['ups', 'battery', 'inverter', 'accessory', 'spare']],
  [
    'attachment_owner_type',
    [
      'job_card',
      'job_completion',
      'payment',
      'sales_card',
      'customer',
      'employee',
      'service_contract',
    ],
  ],
  ['attachment_kind', ['photo', 'signature', 'document']],
  ['reconciliation_status', ['submitted', 'confirmed', 'disputed']],
  ['ping_source', ['scheduled', 'on_demand', 'live', 'manual']],
  ['location_request_mode', ['fix', 'live']],
  ['device_location_permission', ['none', 'foreground', 'background']],
  ['consent_kind', ['location_tracking']],
];

const CONTRACT_ENUMS = ['contract_billing', 'contract_status', 'visit_status'];

let admin: Pool;
let db: Pool;

beforeAll(async () => {
  admin = new Pool({ connectionString: adminUrlFor(databaseUrl()), max: 2 });
  await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${SCRATCH_DB}`);

  const url = new URL(databaseUrl());
  url.pathname = `/${SCRATCH_DB}`;
  db = new Pool({ connectionString: url.toString(), max: 5 });
  await runMigrations({ pool: db });
});

afterAll(async () => {
  await db?.end();
  if (admin) {
    // WITH (FORCE): the scratch pools are closed above, but a failed
    // test may have abandoned a client — never wedge the suite.
    await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
    await admin.end();
  }
});

/** Insert an employee, returning its id. */
async function insertEmployee(username: string, role = 'technician'): Promise<string> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO employees (username, password_hash, full_name, role)
     VALUES ($1, 'test-argon2id-hash', $2, $3)
     RETURNING id`,
    [username, `Test ${username}`, role],
  );
  return r.rows[0]!.id;
}

/** Run a query expected to fail; return the Postgres error code. */
async function errorCodeOf(query: Promise<unknown>): Promise<string> {
  try {
    await query;
  } catch (err) {
    return (err as { code?: string }).code ?? '';
  }
  throw new Error('expected the query to fail, but it succeeded');
}

describe('migration 002 — the enum catalogue (PLAN-DATA-MODEL.md §2.1)', () => {
  it('has all 18 types with exactly the catalogue values, in catalogue order', async () => {
    const r = await db.query<{ name: string; labels: string[] }>(
      `SELECT t.typname AS name,
              array_agg(e.enumlabel::text ORDER BY e.enumsortorder) AS labels
       FROM pg_type t
       JOIN pg_enum e ON e.enumtypid = t.oid
       JOIN pg_namespace n ON n.oid = t.typnamespace
       WHERE n.nspname = 'public' AND t.typtype = 'e'
       GROUP BY t.typname`,
    );
    // One diff for missing types, extra types and value typos alike —
    // a typo here would otherwise surface as a 500 in Phase 3.
    const actual = Object.fromEntries(r.rows.map((row) => [row.name, row.labels]));
    const expected = Object.fromEntries(EXPECTED_ENUMS);
    expect(actual).toEqual(expected);
  });

  it('does not create the three contract types early — they land with migration 015', async () => {
    const r = await db.query<{ name: string }>(
      `SELECT t.typname AS name
       FROM pg_type t
       JOIN pg_namespace n ON n.oid = t.typnamespace
       WHERE n.nspname = 'public' AND t.typtype = 'e'
         AND t.typname = ANY($1)`,
      [CONTRACT_ENUMS],
    );
    expect(r.rows.map((row) => row.name)).toEqual([]);
  });
});

describe('migration 003 — employees', () => {
  it('must_change_password defaults true so the owner can hand over a temp credential', async () => {
    const id = await insertEmployee('priya.t');
    const r = await db.query<{ must_change_password: boolean }>(
      'SELECT must_change_password FROM employees WHERE id = $1',
      [id],
    );
    expect(r.rows[0]?.must_change_password).toBe(true);
  });

  it.each<[string, string]>([
    ['AB', 'too short'],
    ['has space', 'space is not in the shape'],
    ['Ünicode', 'non-ascii is not in the shape'],
    ['RAVI.K', 'uppercase is not in the shape — the CHECK casts to text'],
  ])('rejects username %j (%s)', async (username) => {
    // The shape CHECK, not something else, must be what fires.
    const code = await errorCodeOf(
      db.query(
        `INSERT INTO employees (username, password_hash, full_name, role)
         VALUES ($1, 'test-argon2id-hash', 'Shape Probe', 'technician')`,
        [username],
      ),
    );
    expect(code).toBe('23514');
  });

  it('accepts ravi.k and enforces the UNIQUE on an exact repeat', async () => {
    await insertEmployee('ravi.k');
    const code = await errorCodeOf(
      db.query(
        `INSERT INTO employees (username, password_hash, full_name, role)
         VALUES ('ravi.k', 'test-argon2id-hash', 'Duplicate Probe', 'technician')`,
      ),
    );
    expect(code).toBe('23505');
  });
});

describe('migration 003 — devices', () => {
  it('rejects a second row with the same (employee_id, install_id)', async () => {
    const employeeId = await insertEmployee('device.dupe');
    await db.query('INSERT INTO devices (employee_id, install_id) VALUES ($1, $2)', [
      employeeId,
      'install-0001',
    ]);
    const code = await errorCodeOf(
      db.query('INSERT INTO devices (employee_id, install_id) VALUES ($1, $2)', [
        employeeId,
        'install-0001',
      ]),
    );
    expect(code).toBe('23505');
  });

  it('stores the four diagnostics with unconfirmed defaults', async () => {
    const employeeId = await insertEmployee('device.diag');
    const r = await db.query<{
      location_permission: string;
      battery_opt_exempt: boolean;
      autostart_confirmed: boolean;
      notifications_enabled: boolean;
    }>(
      `INSERT INTO devices (employee_id, install_id) VALUES ($1, 'install-diag')
       RETURNING location_permission, battery_opt_exempt, autostart_confirmed,
                 notifications_enabled`,
      [employeeId],
    );
    // A device that has not reported yet reads as unhealthy, not silently
    // healthy — the defaults are the unconfirmed state.
    expect(r.rows[0]?.location_permission).toBe('none');
    expect(r.rows[0]?.battery_opt_exempt).toBe(false);
    expect(r.rows[0]?.autostart_confirmed).toBe(false);
    expect(r.rows[0]?.notifications_enabled).toBe(false);
  });
});

describe('migration 003 — identity round-trip with version incrementing', () => {
  it('inserts and updates the mutable identity tables, each UPDATE bumping version', async () => {
    // employees
    const employeeId = await insertEmployee('round.trip');
    const employee = await db.query<{ version: number }>(
      'UPDATE employees SET full_name = $2 WHERE id = $1 RETURNING version',
      [employeeId, 'Round Trip Kumar'],
    );
    expect(employee.rows[0]?.version).toBe(2);

    // devices — insert, then the real update shape: the app reports
    // diagnostics.
    await db.query('INSERT INTO devices (employee_id, install_id) VALUES ($1, $2)', [
      employeeId,
      'install-roundtrip',
    ]);
    const device = await db.query<{ id: string; version: number }>(
      `UPDATE devices SET location_permission = 'background', battery_opt_exempt = true,
                          autostart_confirmed = true, notifications_enabled = true,
                          last_seen_at = now()
       WHERE employee_id = $1 RETURNING id, version`,
      [employeeId],
    );
    expect(device.rows[0]?.version).toBe(2);

    // refresh_tokens — the real update shape: rotation revokes the old
    // row and points it at its replacement.
    const issued = await db.query<{ id: string; token_hash: string }>(
      `INSERT INTO refresh_tokens (token_hash, employee_id, device_id, expires_at)
       VALUES (encode(sha256('token-a'::bytea), 'hex'), $1, $2, now() + interval '30 days')
       RETURNING id, token_hash`,
      [employeeId, device.rows[0]!.id],
    );
    const oldToken = issued.rows[0]!;
    const replacement = await db.query<{ id: string }>(
      `INSERT INTO refresh_tokens (token_hash, employee_id, device_id, expires_at)
       VALUES (encode(sha256('token-b'::bytea), 'hex'), $1, $2, now() + interval '30 days')
       RETURNING id`,
      [employeeId, device.rows[0]!.id],
    );
    const rotated = await db.query<{ version: number }>(
      `UPDATE refresh_tokens SET revoked_at = now(), replaced_by = $2
       WHERE id = $1 RETURNING version`,
      [oldToken.id, replacement.rows[0]!.id],
    );
    expect(rotated.rows[0]?.version).toBe(2);
    const reuse = await errorCodeOf(
      db.query(
        `INSERT INTO refresh_tokens (token_hash, employee_id, expires_at)
         VALUES ($1, $2, now() + interval '30 days')`,
        [oldToken.token_hash, employeeId],
      ),
    );
    expect(reuse).toBe('23505');

    // consents — append-only evidence: one accepted row per (employee,
    // kind, version); re-acceptance of the same version is refused, and
    // the row carries no version counter to bump (§3.1 gives the name
    // `version` to the consent text's date-string version).
    const accepted = await db.query<{ version: number; accepted_at: string }>(
      `INSERT INTO consents (employee_id, kind, version, device_id, ip_address)
       VALUES ($1, 'location_tracking', '2026-04-01', $2, '10.0.0.1')
       RETURNING version, accepted_at`,
      [employeeId, device.rows[0]!.id],
    );
    expect(accepted.rows[0]?.accepted_at).toBeTruthy();
    const reAccept = await errorCodeOf(
      db.query(
        `INSERT INTO consents (employee_id, kind, version) VALUES ($1, 'location_tracking', '2026-04-01')`,
        [employeeId],
      ),
    );
    expect(reAccept).toBe('23505');
    const newerConsent = await db.query<{ id: string }>(
      `INSERT INTO consents (employee_id, kind, version) VALUES ($1, 'location_tracking', '2026-07-01')
       RETURNING id`,
      [employeeId],
    );
    expect(newerConsent.rows[0]?.id).toBeTruthy();
  });
});
