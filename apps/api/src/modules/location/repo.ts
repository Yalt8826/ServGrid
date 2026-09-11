import type { QueryResult, QueryResultRow } from 'pg';

/**
 * Location SQL (PLAN-BACKEND.md §2: routes/service/repo per module;
 * hand-written queries, no ORM). Every function takes its executor
 * explicitly — the Pool for autocommit writes, or a transaction's
 * PoolClient when an idempotency key opened one.
 */

/** Anything with `.query` — a `Pool` or the `PoolClient` of a transaction. */
export interface Db {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<R>>;
}

export interface PingInsert {
  /** Epoch milliseconds — normalised from the payload's ISO string, so the
   * UNIQUE (employee_id, recorded_at) key and the RETURNING mapping below
   * compare like for like. */
  recordedAtMs: number;
  latitude: number;
  longitude: number;
  accuracyM: number;
  altitudeM?: number;
  speedMps?: number;
  headingDeg?: number;
  batteryPct?: number;
  isMoving?: boolean;
  source: string;
}

/**
 * Append the batch (PLAN-DATA-MODEL.md §3.8). One statement for the whole
 * batch; `ON CONFLICT (employee_id, recorded_at) DO NOTHING` makes a
 * retried batch free — the replayed pings conflict with what the first
 * attempt already landed and are skipped, while fresh pings in the same
 * statement still insert (the same statement cannot conflict with itself
 * into an error: DO NOTHING absorbs that too). Rows are normalised to
 * millisecond precision before they get here, so the returned instants map
 * back onto the caller's list exactly.
 */
export async function insertPings(
  db: Db,
  employeeId: string,
  deviceId: string,
  pings: readonly PingInsert[],
): Promise<number[]> {
  if (pings.length === 0) return [];
  const COLUMNS = 12;
  const values: unknown[] = [];
  const rows: string[] = [];
  pings.forEach((p, i) => {
    const base = i * COLUMNS;
    rows.push(
      `($${base + 1}::uuid, $${base + 2}::uuid, $${base + 3}::timestamptz, $${base + 4}::float8, ` +
        `$${base + 5}::float8, $${base + 6}::float8, $${base + 7}::float8, $${base + 8}::float8, ` +
        `$${base + 9}::float8, $${base + 10}::int2, $${base + 11}::bool, $${base + 12}::ping_source)`,
    );
    values.push(
      employeeId,
      deviceId,
      new Date(p.recordedAtMs).toISOString(),
      p.latitude,
      p.longitude,
      p.accuracyM,
      p.altitudeM ?? null,
      p.speedMps ?? null,
      p.headingDeg ?? null,
      p.batteryPct ?? null,
      p.isMoving ?? null,
      p.source,
    );
  });
  const r = await db.query<{ recorded_at_ms: number }>(
    `INSERT INTO location_pings
       (employee_id, device_id, recorded_at, latitude, longitude, accuracy_m,
        altitude_m, speed_mps, heading_deg, battery_pct, is_moving, source)
     VALUES ${rows.join(', ')}
     ON CONFLICT (employee_id, recorded_at) DO NOTHING
     RETURNING EXTRACT(EPOCH FROM recorded_at)::float8 * 1000 AS recorded_at_ms`,
    values,
  );
  return r.rows.map((row) => row.recorded_at_ms);
}

/** One row of `v_employee_tracking_health`, shaped for the wire. The
 * nullable columns ride through the view's LEFT JOINs — no device install
 * yet, or no ping ever, is NULL on the wire, not an absent field.
 * `lastPingAt` is serialised in SQL (`to_json(...)#>>'{}'`, the jobs
 * repo's pattern) because pg would otherwise hand back a Date object the
 * response schema cannot assert on. */
export interface TrackingHealthRow {
  employeeId: string;
  employeeName: string;
  role: string;
  deviceId: string | null;
  locationPermission: string | null;
  notificationsEnabled: boolean | null;
  lastPingAt: string | null;
  minutesSince: number | null;
  health: string;
}

/**
 * The actor's own health row (PLAN-BACKEND.md §8 `/v1/location/health/me`).
 * The self-scoping is the predicate in this query text — `WHERE
 * employee_id = $1`, bound to the token's subject, never to a path
 * parameter — so the endpoint cannot return anyone else's row by
 * construction, and the view itself carries no coordinates to leak. The
 * view only holds ACTIVE employees; NULL comes back for an actor
 * deactivated after his token was minted, and the service refuses that.
 */
export async function findOwnHealth(db: Db, employeeId: string): Promise<TrackingHealthRow | null> {
  const r = await db.query<TrackingHealthRow>(
    `SELECT employee_id AS "employeeId",
            employee_name AS "employeeName",
            role::text    AS role,
            device_id     AS "deviceId",
            location_permission AS "locationPermission",
            notifications_enabled AS "notificationsEnabled",
            to_json(last_ping_at)#>>'{}' AS "lastPingAt",
            minutes_since::float8 AS "minutesSince",
            health
     FROM v_employee_tracking_health
     WHERE employee_id = $1::uuid`,
    [employeeId],
  );
  return r.rows[0] ?? null;
}
