import type { LocationPingPayload, PingBatchResultParsed, PingRejectCode, TrackingHealth } from '@servgrid/shared';
import { sendDataOnly } from '../../lib/fcm.js';
import { getPool } from '../../db/pool.js';
import { UNAUTHENTICATED_MESSAGE } from '../../plugins/auth.js';
import { AppError } from '../../plugins/errors.js';
import { isWithinWorkWindow, type WorkWindow } from '../../lib/time.js';
import { SENDER_ID_MISMATCH, type NotificationLog } from '../notifications/service.js';
import * as notificationsRepo from '../notifications/repo.js';
import { isFlagOn } from '../flags/service.js';
import type {
  LocationRequest,
  LocationRequestMode,
  LocationRequestStatus,
  TrailPing,
  TrackedEmployeeLocation,
} from './schemas.js';
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

/** One repo row shaped for the wire — the projection myHealth and
 * rosterHealth share, so the chip and the roster cannot drift. */
function toHealth(row: repo.TrackingHealthRow): TrackingHealth {
  return {
    employeeId: row.employeeId,
    employeeName: row.employeeName,
    role: row.role as TrackingHealth['role'],
    deviceId: row.deviceId,
    locationPermission: row.locationPermission as TrackingHealth['locationPermission'],
    notificationsEnabled: row.notificationsEnabled,
    lastPingAt: row.lastPingAt,
    minutesSince: row.minutesSince,
    health: row.health as TrackingHealth['health'],
  };
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

    // T0 rollback tier first (PLAN-EXECUTION.md Phase 1 rollback table):
    // `tech.location` off means "server stops accepting". The batch still
    // answers HTTP 200 — a rejected ping is a normal outcome (§8), and a
    // per-ping DISABLED is what makes the handset clear its buffer
    // instead of retrying the batch forever.
    if (pings.length > 0 && !(await isFlagOn(employeeId, 'tech.location'))) {
      return {
        accepted: 0,
        flagged: [],
        rejected: pings.map((_, index) => ({ index, code: 'DISABLED' as const })),
      };
    }

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
    // insertPings returns the rows that actually landed — a key that
    // already existed from an earlier attempt (the retry case) is absent.
    const landed = await repo.insertPings(getPool(), employeeId, deviceId, batch.map((c) => c.insert));
    const landedMs = new Set(landed.map((l) => l.recordedAtMs));

    let accepted = 0;
    for (const candidate of batch) {
      if (!landedMs.has(candidate.insert.recordedAtMs)) {
        rejected.push({ index: candidate.index, code: 'DUPLICATE' });
        continue;
      }
      accepted += 1;
      if (candidate.insert.accuracyM > ACCURACY_FLAG_M) flagged.push(candidate.index);
    }

    // A device answering a locate-now request arrives as an `on_demand`
    // (fix) or `live` ping. Scheduled batches — the overwhelming common
    // case — skip this entirely: the fulfilment UPDATE only runs when an
    // answering source is present, so the hot path gains one comparison.
    const answer = batch
      .filter(
        (c) =>
          landedMs.has(c.insert.recordedAtMs) && (c.insert.source === 'on_demand' || c.insert.source === 'live'),
      )
      .sort((a, b) => a.insert.recordedAtMs - b.insert.recordedAtMs)[0];
    if (answer) {
      const ping = landed.find((l) => l.recordedAtMs === answer.insert.recordedAtMs);
      if (ping) {
        await repo.fulfilOpenRequests(getPool(), employeeId, ping.id, answer.insert.recordedAtMs);
      }
    }

    // Ascending by index: the client maps each outcome back onto its
    // buffered batch position, so the array must not depend on which
    // check fired first.
    rejected.sort((a, b) => a.index - b.index);
    return { accepted, rejected, flagged };
  }

  /**
   * GET /v1/location/health/me — the actor's own row of
   * `v_employee_tracking_health` (PLAN-BACKEND.md §8), the data behind the
   * profile's TrackingHealthChip. A dedicated self-scoped read, not the
   * owner's console query with a WHERE bolted on: the repo's predicate is
   * `employee_id = $1` bound to the token's subject, so there is no
   * parameter a future edit could forget. A missing row means the actor
   * was deactivated after this token was minted (the view carries active
   * employees only) — the same refusal `GET /v1/employees/me` gives.
   */
  async function myHealth(employeeId: string): Promise<TrackingHealth> {
    const row = await repo.findOwnHealth(getPool(), employeeId);
    if (!row) throw new AppError('UNAUTHENTICATED', UNAUTHENTICATED_MESSAGE);
    return toHealth(row);
  }

  /**
   * GET /v1/location/health — the roster's rows of the same view, for
   * the dispatcher's dashboard warning (T2.7) and the owner's Phase 4
   * console. One shape with `/health/me` on purpose: a health row means
   * the same thing everywhere it renders. The route's permission gate is
   * the matrix's `location.health` cell (dispatcher `all`, rep/tech
   * `own` — and their self-scoped surface is `/health/me`, not this).
   */
  async function rosterHealth(): Promise<TrackingHealth[]> {
    const rows = await repo.listRosterHealth(getPool());
    return rows.map(toHealth);
  }

  return { ingestPings, myHealth, rosterHealth };
}

export type LocationService = ReturnType<typeof createLocationService>;

// ── the owner console (T4.4, PLAN-BACKEND.md §8) ────────────────────────────

/** §8: `fix` expires in 2 minutes; `live` in 5. */
const REQUEST_TTL_MS: Record<LocationRequestMode, number> = { fix: 2 * 60_000, live: 5 * 60_000 };

/**
 * The data-only payload of a locate-now push. Unlike the §12.1 job wake
 * (`{"type":"sync"}` — content-free by contract), this message MUST
 * carry the instruction: `mode: "live"` is what tells the device to
 * switch to ~10s intervals and revert after five minutes. It carries ids
 * and a mode — never job or person content. Values are strings because
 * FCM v1 rejects maps (lib/fcm.ts).
 */
export const LOCATION_REQUEST_DATA_TYPE = 'location-request';

export function locationRequestData(request: { id: string; mode: LocationRequestMode }): Record<string, string> {
  return { type: LOCATION_REQUEST_DATA_TYPE, requestId: request.id, mode: request.mode };
}

/** The owner-console log sink — the same warn/error slice every send path takes. */
export type LocationRequestLog = NotificationLog;

/** 404 for a locate-now target that is not an active tracked employee. */
const REQUEST_TARGET_MESSAGE = 'Locate now follows field staff only — that employee is not tracked.';

/** The request-row reason when the target has no device we could wake. */
export const NO_PUSHABLE_DEVICE_REASON = 'no_pushable_device';

/** 404 for a path id that names nothing (the framework-agnostic phrasing). */
const GENERIC_NOT_FOUND_MESSAGE = "We couldn't find that. It may have been removed since you last synced.";

/**
 * The lifecycle status, derived from the row — never stored, so the
 * console and the row cannot disagree (see locationRequestStatusSchema
 * for the decision order).
 */
function statusOf(row: repo.LocationRequestRow, nowMs: number): LocationRequestStatus {
  if (row.fulfilledAt !== null) return 'fulfilled';
  if (row.failureReason !== null) return 'failed';
  if (Date.parse(row.expiresAt) <= nowMs) return 'expired';
  if (row.pushedAt !== null) return 'pushed';
  return 'requested';
}

function toRequest(row: repo.LocationRequestRow, nowMs: number): LocationRequest {
  return {
    id: row.id,
    requestedBy: row.requestedBy,
    targetEmployeeId: row.targetEmployeeId,
    mode: row.mode as LocationRequestMode,
    status: statusOf(row, nowMs),
    requestedAt: row.requestedAt,
    expiresAt: row.expiresAt,
    pushedAt: row.pushedAt,
    fulfilledAt: row.fulfilledAt,
    fulfilledPingId: row.fulfilledPingId,
    failureReason: row.failureReason,
  };
}

export function createLocationConsoleService(log?: LocationRequestLog) {
  /**
   * POST /v1/location/requests (§8) — owner only. THE ORDER IS THE
   * FEATURE: the row is inserted before any push is attempted, so a push
   * failure still leaves a queryable request. The push itself is the
   * §12.1 shape done honestly: every failure mode is priced in, a stale
   * token clears the device's `fcm_token` and records `failure_reason`
   * there (an unreachable device is a tracking-health finding), and the
   * request row records the FCM-level outcome for the console.
   */
  async function createRequest(
    ownerId: string,
    input: { employeeId: string; mode: LocationRequestMode },
    nowMs: number = Date.now(),
  ): Promise<LocationRequest> {
    const pool = getPool();

    // The request targets a TRACKED employee: an active technician or
    // sales rep. The office roles are not followed (the health view
    // marks them not_tracked), so a request for one is a 404 rather
    // than a row that could never be answered.
    if (!(await repo.findTrackedEmployee(pool, input.employeeId))) {
      throw new AppError('NOT_FOUND', REQUEST_TARGET_MESSAGE);
    }

    const row = await repo.insertLocationRequest(pool, {
      requestedBy: ownerId,
      targetEmployeeId: input.employeeId,
      mode: input.mode,
      requestedAtMs: nowMs,
      expiresAtMs: nowMs + REQUEST_TTL_MS[input.mode],
    });

    // §8's honest bookkeeping, per device: delivered → clear any stale
    // failure; unreachable → clear the token and record why (the same
    // repo functions the assignment-push path uses, so "stale" means
    // exactly the same thing on every send path).
    const devices = await notificationsRepo.listPushableDevices(pool, input.employeeId);
    if (devices.length === 0) {
      // Nobody to wake. Not an error — a finding: the row closes with
      // the reason, and the console says "no pushable device" instead
      // of waiting out a window no push could ever answer.
      await repo.recordPushOutcome(pool, row.id, nowMs, NO_PUSHABLE_DEVICE_REASON);
      log?.warn({ requestId: row.id, employeeId: input.employeeId }, 'locate-now: no pushable device');
    } else {
      let delivered = 0;
      let lastError: string | null = null;
      for (const device of devices) {
        const result = await sendDataOnly({
          token: device.fcm_token,
          data: locationRequestData({ id: row.id, mode: input.mode }),
        });
        if (result.ok) {
          delivered += 1;
          // The token demonstrably works; a recorded failure is stale history.
          await notificationsRepo.clearFailureReason(pool, device.id);
          continue;
        }
        lastError = result.error ?? `HTTP ${result.httpStatus ?? '?'}`;
        if (result.unregistered || SENDER_ID_MISMATCH.test(lastError)) {
          await notificationsRepo.recordStaleToken(pool, device.id, lastError);
        }
        log?.warn({ requestId: row.id, deviceId: device.id, error: lastError }, 'locate-now: push failed');
      }
      // One accepted send is a pushed request: the failure on a second
      // device is already recorded on THAT device, where the health
      // chip reads it. The request stays open for the device to answer.
      await repo.recordPushOutcome(pool, row.id, nowMs, delivered > 0 ? null : lastError);
    }

    // Re-read so the response carries the post-push state — the console
    // renders it immediately, before the first poll.
    const after = await repo.findLocationRequest(pool, row.id);
    return toRequest(after ?? row, nowMs);
  }

  /**
   * GET /v1/location/requests/:id — the poll. The status is derived per
   * read, so `expired` shows the instant the window closes, not when the
   * sweep's next minute-tick lands; the sweep's write is the durable
   * record (`failure_reason` = unanswered) that survives into history.
   */
  async function getRequest(id: string, nowMs: number = Date.now()): Promise<LocationRequest> {
    const row = await repo.findLocationRequest(getPool(), id);
    if (!row) throw new AppError('NOT_FOUND', GENERIC_NOT_FOUND_MESSAGE);
    return toRequest(row, nowMs);
  }

  /**
   * GET /v1/location/employees — latest position + health per tracked
   * employee (§8's Phase 4 row). The health fields come off the same
   * view as every other health surface; the position is the console's
   * alone (`location.read`, owner `all`, no other role has a cell).
   */
  async function trackedEmployees(): Promise<TrackedEmployeeLocation[]> {
    const rows = await repo.listTrackedEmployeeLocations(getPool());
    return rows.map((row) => ({
      employeeId: row.employeeId,
      employeeName: row.employeeName,
      role: row.role as TrackedEmployeeLocation['role'],
      deviceId: row.deviceId,
      locationPermission: row.locationPermission as TrackedEmployeeLocation['locationPermission'],
      notificationsEnabled: row.notificationsEnabled,
      health: row.health as TrackedEmployeeLocation['health'],
      lastPingAt: row.lastPingAt,
      minutesSince: row.minutesSince,
      position:
        row.latitude !== null && row.longitude !== null && row.recordedAt !== null
          ? {
              latitude: row.latitude,
              longitude: row.longitude,
              recordedAt: row.recordedAt,
              accuracyM: row.accuracyM,
              batteryPct: row.batteryPct,
              source: row.source as NonNullable<TrackedEmployeeLocation['position']>['source'],
            }
          : null,
    }));
  }

  /**
   * GET /v1/location/employees/:id/trail?date= — a day's ordered pings.
   * Ordered by `recorded_at` in the query (the map draws the trail in
   * time order); scoped to the requested business date by the generated
   * column, so nothing outside the day can leak into the line.
   */
  async function trail(employeeId: string, date: string): Promise<TrailPing[]> {
    if (!(await repo.employeeExists(getPool(), employeeId))) {
      throw new AppError('NOT_FOUND', GENERIC_NOT_FOUND_MESSAGE);
    }
    const rows = await repo.listTrail(getPool(), employeeId, date);
    return rows.map((row) => ({
      recordedAt: row.recordedAt,
      latitude: row.latitude,
      longitude: row.longitude,
      accuracyM: row.accuracyM,
      altitudeM: row.altitudeM,
      speedMps: row.speedMps,
      headingDeg: row.headingDeg,
      batteryPct: row.batteryPct,
      isMoving: row.isMoving,
      source: row.source as TrailPing['source'],
    }));
  }

  return { createRequest, getRequest, trackedEmployees, trail };
}

export type LocationConsoleService = ReturnType<typeof createLocationConsoleService>;
