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
export interface LandedPing {
  /** The identity column — what fulfilment records as `fulfilled_ping_id`. */
  id: number;
  recordedAtMs: number;
}

export async function insertPings(
  db: Db,
  employeeId: string,
  deviceId: string,
  pings: readonly PingInsert[],
): Promise<LandedPing[]> {
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
  const r = await db.query<{ id: string; recorded_at_ms: number }>(
    `INSERT INTO location_pings
       (employee_id, device_id, recorded_at, latitude, longitude, accuracy_m,
        altitude_m, speed_mps, heading_deg, battery_pct, is_moving, source)
     VALUES ${rows.join(', ')}
     ON CONFLICT (employee_id, recorded_at) DO NOTHING
     RETURNING id, EXTRACT(EPOCH FROM recorded_at)::float8 * 1000 AS recorded_at_ms`,
    values,
  );
  return r.rows.map((row) => ({ id: Number(row.id), recordedAtMs: row.recorded_at_ms }));
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

/**
 * The whole roster's health rows (PLAN-BACKEND.md §8 `GET
 * /v1/location/health`, T2.7): the dispatcher's dashboard warning and
 * the owner's Phase 4 console read the same projection. The selection is
 * the VIEW — active employees only, health value and last-ping age, and
 * no coordinate column exists to select — so this read cannot grow a
 * position without a migration changing the view first, exactly the
 * reviewable chokepoint §5 wants. This is a `location.health` read, never
 * a step towards `location.read`.
 */
export async function listRosterHealth(db: Db): Promise<TrackingHealthRow[]> {
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
     ORDER BY employee_name`,
  );
  return r.rows;
}

// ── locate-now requests (§8, T4.4) ───────────────────────────────────────

/** One `location_requests` row as the repo hands it to the service:
 * timestamps already serialised (the `to_json(...)#>>'{}'` pattern above),
 * the bigint ping id widened to float8 — exact well past any identity
 * value this table will ever hold. */
export interface LocationRequestRow {
  id: string;
  requestedBy: string;
  targetEmployeeId: string;
  mode: string;
  requestedAt: string;
  expiresAt: string;
  pushedAt: string | null;
  fulfilledAt: string | null;
  fulfilledPingId: number | null;
  failureReason: string | null;
}

const REQUEST_COLUMNS = `id,
       requested_by AS "requestedBy",
       target_employee_id AS "targetEmployeeId",
       mode::text AS mode,
       to_json(requested_at)#>>'{}' AS "requestedAt",
       to_json(expires_at)#>>'{}' AS "expiresAt",
       to_json(pushed_at)#>>'{}' AS "pushedAt",
       to_json(fulfilled_at)#>>'{}' AS "fulfilledAt",
       fulfilled_ping_id::float8 AS "fulfilledPingId",
       failure_reason AS "failureReason"`;

export interface RequestInsert {
  requestedBy: string;
  targetEmployeeId: string;
  mode: 'fix' | 'live';
  /** Epoch millis — the caller's clock, so tests can pin the instant. */
  requestedAtMs: number;
  expiresAtMs: number;
}

/**
 * INSERT the request FIRST (§8: "inserts a location_requests row, THEN
 * sends a data-only FCM push"). The row existing before the push is the
 * whole point — a push that dies leaves a queryable request, which is
 * what keeps the console honest instead of spinning.
 */
export async function insertLocationRequest(db: Db, r: RequestInsert): Promise<LocationRequestRow> {
  const result = await db.query<LocationRequestRow>(
    `INSERT INTO location_requests
       (requested_by, target_employee_id, mode, requested_at, expires_at)
     VALUES ($1::uuid, $2::uuid, $3::location_request_mode, $4::timestamptz, $5::timestamptz)
     RETURNING ${REQUEST_COLUMNS}`,
    [r.requestedBy, r.targetEmployeeId, r.mode, new Date(r.requestedAtMs).toISOString(), new Date(r.expiresAtMs).toISOString()],
  );
  return result.rows[0]!;
}

/**
 * The polled read (`GET /v1/location/requests/:id`). No scoping predicate
 * on purpose: the route's matrix cell is `location.read` × `read`, whose
 * only `all` is the owner — a dispatcher is refused at the door, not
 * handed a narrower row.
 */
export async function findLocationRequest(db: Db, id: string): Promise<LocationRequestRow | null> {
  const result = await db.query<LocationRequestRow>(
    `SELECT ${REQUEST_COLUMNS} FROM location_requests WHERE id = $1::uuid`,
    [id],
  );
  return result.rows[0] ?? null;
}

/** The push has been attempted — stamp when, and any FCM-level outcome
 * (§3.8: `failure_reason` records the FCM-level outcome). NULL reason
 * means at least one device accepted the message. */
export async function recordPushOutcome(
  db: Db,
  id: string,
  pushedAtMs: number,
  failureReason: string | null,
): Promise<void> {
  await db.query(
    `UPDATE location_requests
     SET pushed_at = $2::timestamptz, failure_reason = $3
     WHERE id = $1::uuid`,
    [id, new Date(pushedAtMs).toISOString(), failureReason],
  );
}

/**
 * The answer arrived: a ping with source `on_demand` or `live` from the
 * target closes every open request the ping could have been answering —
 * asked-for AFTER the ping instant never matches (`requested_at <=
 * recorded_at`), and a request the sweep or a push failure already
 * closed stays closed (`fulfilled_at IS NULL AND failure_reason IS NULL`
 * — one terminal write per row, whichever came first).
 */
export async function fulfilOpenRequests(
  db: Db,
  targetEmployeeId: string,
  pingId: number,
  recordedAtMs: number,
): Promise<number> {
  const result = await db.query<{ id: string }>(
    `UPDATE location_requests
     SET fulfilled_at = now(), fulfilled_ping_id = $3::bigint
     WHERE target_employee_id = $1::uuid
       AND fulfilled_at IS NULL
       AND failure_reason IS NULL
       AND requested_at <= $2::timestamptz
     RETURNING id`,
    [targetEmployeeId, new Date(recordedAtMs).toISOString(), pingId],
  );
  return result.rowCount ?? 0;
}

/**
 * `expire-location-requests` (§12: every minute) — close every request
 * past its `expires_at` that no ping and no push outcome has closed
 * already, with the reason the console can say out loud: the device has
 * not answered. Rows a push failure closed keep their FCM-level reason;
 * this sweep only ever names the silence.
 */
export const EXPIRED_UNANSWERED_REASON = 'unanswered';

export async function expireLocationRequests(db: Db, nowMs: number): Promise<string[]> {
  const result = await db.query<{ id: string }>(
    `UPDATE location_requests
     SET failure_reason = $2
     WHERE expires_at <= $1::timestamptz
       AND fulfilled_at IS NULL
       AND failure_reason IS NULL
     RETURNING id`,
    [new Date(nowMs).toISOString(), EXPIRED_UNANSWERED_REASON],
  );
  return result.rows.map((row) => row.id);
}

// ── owner console reads (§8's Phase 4 rows — `location.read`) ────────────

/** One row of the roster read, before the service nests the position. */
export interface TrackedEmployeeRow {
  employeeId: string;
  employeeName: string;
  role: string;
  deviceId: string | null;
  locationPermission: string | null;
  notificationsEnabled: boolean | null;
  health: string;
  lastPingAt: string | null;
  minutesSince: number | null;
  latitude: number | null;
  longitude: number | null;
  recordedAt: string | null;
  accuracyM: number | null;
  batteryPct: number | null;
  source: string | null;
}

/**
 * Latest position + health per TRACKED employee (`GET
 * /v1/location/employees`). The health half is the same
 * `v_employee_tracking_health` the Phase 1 chip and the Phase 2 roster
 * warning read — one view, so health cannot mean something different on
 * the owner's console — narrowed to the tracked roles (the view's own
 * `not_tracked` rows are the office) — and then a LATERAL over the trail
 * index adds the one thing the view deliberately does not have: WHERE
 * the latest fix was. This join is the line between `location.health`
 * and `location.read`; it exists here and in no dispatcher-reachable
 * query (the lint rule that guards repo.dispatcher.ts keeps that true).
 */
export async function listTrackedEmployeeLocations(db: Db): Promise<TrackedEmployeeRow[]> {
  const result = await db.query<TrackedEmployeeRow>(
    `SELECT v.employee_id AS "employeeId",
            v.employee_name AS "employeeName",
            v.role::text AS role,
            v.device_id AS "deviceId",
            v.location_permission AS "locationPermission",
            v.notifications_enabled AS "notificationsEnabled",
            v.health,
            to_json(v.last_ping_at)#>>'{}' AS "lastPingAt",
            v.minutes_since::float8 AS "minutesSince",
            p.latitude,
            p.longitude,
            to_json(p.recorded_at)#>>'{}' AS "recordedAt",
            p.accuracy_m::float8 AS "accuracyM",
            p.battery_pct AS "batteryPct",
            p.source::text AS source
     FROM v_employee_tracking_health v
     LEFT JOIN LATERAL (
       SELECT latitude, longitude, recorded_at, accuracy_m, battery_pct, source
       FROM location_pings lp
       WHERE lp.employee_id = v.employee_id
       ORDER BY lp.recorded_at DESC
       LIMIT 1
     ) p ON true
     WHERE v.role IN ('technician', 'sales_rep')
     ORDER BY v.employee_name`,
  );
  return result.rows;
}

/** One trail ping, shaped for the wire (timestamps serialised in SQL). */
export interface TrailPingRow {
  recordedAt: string;
  latitude: number;
  longitude: number;
  accuracyM: number | null;
  altitudeM: number | null;
  speedMps: number | null;
  headingDeg: number | null;
  batteryPct: number | null;
  isMoving: boolean | null;
  source: string;
}

/**
 * A day's ordered pings (`GET /v1/location/employees/:id/trail?date=`).
 * The `business_date` filter rides the generated column (migration 009)
 * — the IST day the ping belongs to is the database's own derivation,
 * not a range the caller can get wrong at a DST-free but offset-ful
 * boundary — and the ORDER BY is the trail's defining property: the map
 * draws it in time order.
 */
export async function listTrail(db: Db, employeeId: string, businessDate: string): Promise<TrailPingRow[]> {
  const result = await db.query<TrailPingRow>(
    `SELECT to_json(recorded_at)#>>'{}' AS "recordedAt",
            latitude,
            longitude,
            accuracy_m::float8 AS "accuracyM",
            altitude_m::float8 AS "altitudeM",
            speed_mps::float8 AS "speedMps",
            heading_deg::float8 AS "headingDeg",
            battery_pct AS "batteryPct",
            is_moving AS "isMoving",
            source::text AS source
     FROM location_pings
     WHERE employee_id = $1::uuid AND business_date = $2::date
     ORDER BY recorded_at ASC`,
    [employeeId, businessDate],
  );
  return result.rows;
}

/** The trail endpoint's 404 — the employee row is gone (never existed or
 * since deleted; the table keeps no history of former employees). */
export async function employeeExists(db: Db, employeeId: string): Promise<boolean> {
  const result = await db.query<{ id: string }>(
    `SELECT id FROM employees WHERE id = $1::uuid`,
    [employeeId],
  );
  return result.rows.length > 0;
}

/**
 * A locate-now TARGET must be someone the system actually follows: an
 * ACTIVE employee in a tracked role. The office roles are `not_tracked`
 * in the health view — a request for one would be a row no device could
 * ever answer — and a deactivated employee has no reachable handset.
 * Both come back as absent, which the service refuses with 404.
 */
export async function findTrackedEmployee(db: Db, employeeId: string): Promise<{ id: string } | null> {
  const result = await db.query<{ id: string }>(
    `SELECT id FROM employees
     WHERE id = $1::uuid AND is_active AND role IN ('technician', 'sales_rep')`,
    [employeeId],
  );
  return result.rows[0] ?? null;
}
