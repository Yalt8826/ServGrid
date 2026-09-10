import type { LocationPingPayload, PingBatchResultParsed, PingRejectCode } from '@servgrid/shared';
import { getPool } from '../../db/pool.js';
import { isWithinWorkWindow, type WorkWindow } from '../../lib/time.js';
import * as repo from './repo.js';

/**
 * Location ingest service (PLAN-BACKEND.md §8). The device filters pings
 * to the work window before they are buffered; the server checks again,
 * per ping, because a rule governing staff should not trust the device
 * clock. A rejected ping is a normal batch outcome — the response stays
 * HTTP 200 even when every ping is rejected — and `PingRejectCode`
 * is deliberately not an `ErrorCode`, so a client cannot mistake an
 * out-of-window ping for a request failure and retry it forever.
 *
 * Validation order per ping: temporal sanity first (FUTURE, TOO_OLD),
 * then the work window, then the insert. The spec lists the window first,
 * but an instant that is not even plausible is not a candidate for window
 * evaluation — and this order keeps each code deterministic at whatever
 * hour the server runs: an 8-day-old ping is TOO_OLD whether or not its
 * IST wall clock is inside the window, not OUT_OF_WINDOW on night shifts.
 */

/** §8: `recorded_at` may lead the server clock by at most this skew. */
export const PING_MAX_FUTURE_MS = 5 * 60_000;

/** §8: `recorded_at` older than this is TOO_OLD. */
export const PING_MAX_AGE_MS = 7 * 24 * 60 * 60_000;

/** §8: above this, the ping is recorded but flagged — a fix this coarse is
 * the OEM/GPS investigation's data point, not a refusal. */
export const ACCURACY_FLAG_M = 2000;

export interface PingBatchResult extends PingBatchResultParsed {
  /**
   * Indices of accepted pings whose `accuracyM` exceeded
   * ACCURACY_FLAG_M (§8: "recorded but flagged"). They are in the trail;
   * the flag rides the response and the structured log so the Phase 5
   * handset investigation can find them without re-reading the table.
   */
  flagged: number[];
}

export interface LocationServiceDeps {
  /** From config: WORK_WINDOW_START/END (§13). */
  workWindow: WorkWindow;
}

/** One ping's verdict before it reaches the database. */
function temporalOrWindowCode(ping: LocationPingPayload, nowMs: number, window: WorkWindow): PingRejectCode | null {
  const recordedAtMs = Date.parse(ping.recordedAt);
  if (recordedAtMs > nowMs + PING_MAX_FUTURE_MS) return 'FUTURE';
  if (recordedAtMs < nowMs - PING_MAX_AGE_MS) return 'TOO_OLD';
  if (!isWithinWorkWindow(new Date(recordedAtMs), window)) return 'OUT_OF_WINDOW';
  return null;
}

export function createLocationService(deps: LocationServiceDeps) {
  /**
   * POST /v1/location/pings — validate per ping, insert the survivors in
   * one statement, and report per-ping outcomes. A retried batch costs
   * nothing: pings already on disk (from this batch's earlier attempt or
   * the same batch listed twice) come back DUPLICATE, not an error.
   */
  async function ingestPings(
    employeeId: string,
    deviceId: string,
    pings: readonly LocationPingPayload[],
    nowMs: number = Date.now(),
  ): Promise<PingBatchResult> {
    const rejected: Array<{ index: number; code: PingRejectCode }> = [];
    const flagged: number[] = [];

    // Candidates that passed validation, deduplicated within the batch:
    // the table's own key is (employee_id, recorded_at), so a second ping
    // with the same recorded_at IS a duplicate by definition — the first
    // occurrence wins, later ones are reported, nothing errors.
    const candidates = new Map<number, { index: number; insert: repo.PingInsert }>();
    for (const [index, ping] of pings.entries()) {
      const code = temporalOrWindowCode(ping, nowMs, deps.workWindow);
      if (code !== null) {
        rejected.push({ index, code });
        continue;
      }
      const recordedAtMs = Date.parse(ping.recordedAt);
      if (candidates.has(recordedAtMs)) {
        rejected.push({ index, code: 'DUPLICATE' });
        continue;
      }
      candidates.set(recordedAtMs, {
        index,
        insert: {
          recordedAtMs,
          latitude: ping.latitude,
          longitude: ping.longitude,
          accuracyM: ping.accuracyM,
          altitudeM: ping.altitudeM,
          speedMps: ping.speedMps,
          headingDeg: ping.headingDeg,
          batteryPct: ping.batteryPct,
          isMoving: ping.isMoving,
          source: ping.source,
        },
      });
    }

    const batch = [...candidates.values()];
    // insertPings returns the instants that actually landed — a key that
    // already existed from an earlier attempt (the retry case) is absent.
    const landedMs = new Set(await repo.insertPings(getPool(), employeeId, deviceId, batch.map((c) => c.insert)));

    let accepted = 0;
    for (const candidate of batch) {
      if (!landedMs.has(candidate.insert.recordedAtMs)) {
        rejected.push({ index: candidate.index, code: 'DUPLICATE' });
        continue;
      }
      accepted += 1;
      if (candidate.insert.accuracyM > ACCURACY_FLAG_M) flagged.push(candidate.index);
    }

    // Ascending by index: the client maps each outcome back onto its
    // buffered batch position, so the array must not depend on which
    // check fired first.
    rejected.sort((a, b) => a.index - b.index);
    return { accepted, rejected, flagged };
  }

  return { ingestPings };
}

export type LocationService = ReturnType<typeof createLocationService>;
