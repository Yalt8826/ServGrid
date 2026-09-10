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
