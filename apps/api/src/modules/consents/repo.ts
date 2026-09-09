import type { ConsentKind, ConsentObligation } from '@servgrid/shared';
import type { Db } from '../auth/repo.js';

/**
 * Consent SQL (PLAN-BACKEND.md §4). Every function takes its executor
 * explicitly — the same rule auth/repo.ts runs under. The rows are
 * append-only DPDP evidence (migration 003 carries no updated_at and no
 * version counter on purpose), so there is no UPDATE in this module and
 * there never will be one.
 */

export interface ConsentRecord {
  kind: ConsentKind;
  version: string;
  accepted_at: Date;
  device_id: string | null;
  ip_address: string | null;
}

/**
 * host(ip_address), not ip_address::text — the text cast carries the
 * netmask ("127.0.0.1/32"), and the API contract is the address the
 * request actually presented, which is what a client compares against.
 */
const CONSENT_COLUMNS = 'kind::text, version, accepted_at, device_id, host(ip_address) AS ip_address';

export interface InsertConsent {
  employeeId: string;
  kind: ConsentKind;
  version: string;
  deviceId: string | null;
  ipAddress: string | null;
}

/**
 * The acceptance write. `ON CONFLICT DO NOTHING` is what makes a double-tap
 * free (UNIQUE (employee_id, kind, version) — §4 says no idempotency key):
 * when a row is returned this tap wrote it; when null, the earlier tap's row
 * already held the constraint and the caller selects it instead, so both
 * taps of a double-tap return one result.
 */
export async function insertConsent(db: Db, input: InsertConsent): Promise<ConsentRecord | null> {
  const r = await db.query<ConsentRecord>(
    `INSERT INTO consents (employee_id, kind, version, device_id, ip_address)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (employee_id, kind, version) DO NOTHING
     RETURNING ${CONSENT_COLUMNS}`,
    [input.employeeId, input.kind, input.version, input.deviceId, input.ipAddress],
  );
  return r.rows[0] ?? null;
}

/** The earlier acceptance of a double-tap — the loser of the race reads it here. */
export async function findConsent(
  db: Db,
  employeeId: string,
  kind: ConsentKind,
  version: string,
): Promise<ConsentRecord | null> {
  const r = await db.query<ConsentRecord>(
    `SELECT ${CONSENT_COLUMNS} FROM consents
     WHERE employee_id = $1 AND kind = $2::consent_kind AND version = $3`,
    [employeeId, kind, version],
  );
  return r.rows[0] ?? null;
}

/**
 * The kinds and versions this actor still owes (§4): the copy the build
 * presents, minus what `consents` already holds. `unnest` carries the
 * current obligations as arrays, so a second consent kind ships as one more
 * array element, not a new query; only an acceptance of the *current*
 * version clears an obligation, which is what makes a version bump
 * re-require everyone.
 */
export async function findRequiredConsents(
  db: Db,
  employeeId: string,
  current: readonly ConsentObligation[],
): Promise<ConsentObligation[]> {
  const r = await db.query<ConsentObligation>(
    `SELECT o.kind::text AS kind, o.version
     FROM unnest($2::consent_kind[], $3::text[]) AS o(kind, version)
     WHERE NOT EXISTS (
       SELECT 1 FROM consents c
       WHERE c.employee_id = $1 AND c.kind = o.kind AND c.version = o.version
     )`,
    [employeeId, current.map((o) => o.kind), current.map((o) => o.version)],
  );
  return r.rows;
}

/** A device named as the witness of an acceptance must belong to the acceptor. */
export async function deviceBelongsTo(db: Db, deviceId: string, employeeId: string): Promise<boolean> {
  const r = await db.query<{ ok: boolean }>(
    'SELECT EXISTS (SELECT 1 FROM devices WHERE id = $1 AND employee_id = $2) AS ok',
    [deviceId, employeeId],
  );
  return r.rows[0]?.ok === true;
}
