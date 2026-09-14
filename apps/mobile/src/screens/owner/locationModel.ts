/**
 * Pure model for the O3 location console (T4.10, UI/plan-2/07-OWNER.md
 * §O3). The wire shapes mirror `apps/api/src/modules/location/schemas.ts`
 * (T4.4) client-side, api-local on purpose — the schemas' own header
 * notes `packages/shared` is serial across a phase, so the console reads
 * the shapes off the wire rather than dragging every parallel task
 * through a shared-file edit.
 *
 * Everything here answers one of the spec's two questions:
 * - "Is tracking actually working?" — the roster sorted by HEALTH
 *   SEVERITY, not alphabetically: the person with a problem is at the
 *   top, because the roster is how the owner NOTICES a problem.
 * - "Where was he, and why is the device not answering now?" — the
 *   trail's time labels at DIRECTION CHANGES only, and the locate-now
 *   state view that says why a request died instead of spinning.
 */

import { SEMANTIC } from '@servgrid/shared';

/** One row of `GET /v1/location/employees` (T4.4 wire shape). */
export interface RosterRow {
  employeeId: string;
  employeeName: string;
  role: string;
  locationPermission: 'none' | 'foreground' | 'background' | null;
  notificationsEnabled: boolean | null;
  health: 'permission_missing' | 'never_reported' | 'stale' | 'active';
  lastPingAt: string | null;
  minutesSince: number | null;
  position: {
    latitude: number;
    longitude: number;
    recordedAt: string;
    accuracyM: number | null;
    batteryPct: number | null;
    source: 'scheduled' | 'on_demand' | 'live' | 'manual';
  } | null;
}

/** One ping of `GET /v1/location/employees/:id/trail` (T4.4 wire shape). */
export interface TrailPoint {
  recordedAt: string;
  latitude: number;
  longitude: number;
  source: 'scheduled' | 'on_demand' | 'live' | 'manual';
}

/** One locate-now request, as POST returns it and the poll refreshes it. */
export interface LocateRequest {
  id: string;
  targetEmployeeId: string;
  mode: 'fix' | 'live';
  status: 'requested' | 'pushed' | 'fulfilled' | 'expired' | 'failed';
  requestedAt: string;
  expiresAt: string;
  failureReason: string | null;
  fulfilledAt: string | null;
}

/** Health severity — the roster's sort key. Red before amber before
 * green; the person with a problem is at the top (§O3). */
export function severityRank(health: RosterRow['health']): 0 | 1 | 2 {
  switch (health) {
    case 'permission_missing':
    case 'never_reported':
      return 0;
    case 'stale':
      return 1;
    case 'active':
      return 2;
  }
}

export interface HealthView {
  /** The chip word — a rail never appears without its word (§1.6). */
  label: string;
  color: string;
}

/** The health chip: same feedback colours as the TrackingHealthChip. */
export function healthView(health: RosterRow['health']): HealthView {
  switch (health) {
    case 'permission_missing':
      return { label: 'No permit', color: SEMANTIC.feedback.danger };
    case 'never_reported':
      return { label: 'Never reported', color: SEMANTIC.feedback.danger };
    case 'stale':
      return { label: 'Stale', color: SEMANTIC.feedback.warning };
    case 'active':
      return { label: 'Active', color: SEMANTIC.feedback.success };
  }
}

/** "6 min ago" / "2h ago" — the last-seen column. Null is honest: the
 * device has never reported, and the row reads that way. */
export function formatLastSeen(minutesSince: number | null): string {
  if (minutesSince === null) return 'Never reported';
  if (minutesSince < 60) return `${Math.max(1, Math.round(minutesSince))} min ago`;
  return `${Math.round(minutesSince / 60)}h ago`;
}

/**
 * The roster, worst first. Severity rank asc; within one rank the
 * longer-unseen row is the worse row (a 6-hour-stale technician above a
 * 50-minute-stale one); ties fall back to name so the order is stable
 * across polls — a roster that reshuffles every 30 seconds is a roster
 * nobody can scan.
 */
export function sortRoster(rows: readonly RosterRow[]): RosterRow[] {
  const copy = [...rows];
  copy.sort((a, b) => {
    const rank = severityRank(a.health) - severityRank(b.health);
    if (rank !== 0) return rank;
    const ageA = a.minutesSince ?? Number.POSITIVE_INFINITY;
    const ageB = b.minutesSince ?? Number.POSITIVE_INFINITY;
    if (ageA !== ageB) return ageB - ageA; // worse (older) first
    return a.employeeName.localeCompare(b.employeeName);
  });
  return copy;
}

// ── locate-now: the state view that must not lie ────────────────────────────

/** The three whys the spec names, plus the honest fallback. */
export type NoAnswerWhy =
  | 'push failed'
  | 'permission missing'
  | 'no recent ping'
  | 'device has not answered';

export const NO_ANSWER_TEXT: Record<NoAnswerWhy, string> = {
  'push failed': 'Push failed — the request never reached the device.',
  'permission missing': 'Background permission is missing on the device.',
  'no recent ping': 'No recent ping — the device has not reported today.',
  'device has not answered': 'The device has not answered.',
};

/**
 * Why a request died, most definite cause first. A recorded
 * `failure_reason` is fact (the push path wrote what happened); the
 * roster row's health is the circumstantial evidence for the rest.
 */
export function whyNoAnswer(row: RosterRow | null, request: LocateRequest | null): NoAnswerWhy {
  if (request !== null && request.failureReason !== null) return 'push failed';
  if (row !== null && row.locationPermission !== 'background') return 'permission missing';
  if (row !== null && (row.health === 'stale' || row.health === 'never_reported')) return 'no recent ping';
  return 'device has not answered';
}

/** "less than a minute ago" / "2 min ago" — the expired line's age. */
export function requestedAgo(ms: number): string {
  if (ms < 60_000) return 'less than a minute ago';
  return `${Math.floor(ms / 60_000)} min ago`;
}

export type RequestStateView =
  | { kind: 'idle' }
  /** Open window — "Requested — waiting for the device" + counting seconds. */
  | { kind: 'sent'; seconds: number }
  /** The dot moved, the trail extended — the honest "yes". */
  | { kind: 'fulfilled' }
  /** Window closed or push failed — the honest "no", with the why. */
  | { kind: 'closed'; ago: string; why: NoAnswerWhy };

/**
 * The request's state, derived from the row's own fields and the
 * injected clock — never a spinner, because a spinner implies the
 * answer is coming and the whole point of persisting the request is to
 * be able to say it is not (§O3).
 */
export function requestViewOf(
  request: LocateRequest | null,
  row: RosterRow | null,
  nowMs: number,
): RequestStateView {
  if (request === null) return { kind: 'idle' };
  switch (request.status) {
    case 'fulfilled':
      return { kind: 'fulfilled' };
    case 'requested':
    case 'pushed': {
      if (Date.parse(request.expiresAt) <= nowMs) break; // the read reports expiry the instant it passes
      return { kind: 'sent', seconds: Math.max(0, Math.floor((nowMs - Date.parse(request.requestedAt)) / 1000)) };
    }
    case 'expired':
    case 'failed':
      break;
  }
  return {
    kind: 'closed',
    ago: requestedAgo(nowMs - Date.parse(request.requestedAt)),
    why: whyNoAnswer(row, request),
  };
}

// ── the trail: time labels at direction changes, not at every point ─────────

/** A trail vertex worth a label: the path's ends, and every point where
 * the heading changes by more than `DIRECTION_CHANGE_DEG`. */
export interface TrailStop {
  latitude: number;
  longitude: number;
  recordedAt: string;
  /** HH:MM, IST — the wall clock the rest of the app speaks. */
  label: string;
}

/** Degrees of heading change that make a vertex worth labelling. Below
 * this the path is drift, and a label per point is noise (§O3). */
export const DIRECTION_CHANGE_DEG = 30;

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** The IST business date of an instant, `YYYY-MM-DD` — the trail
 * query's `?date=` (same formula as the dispatcher dashboard's). */
export function istBusinessDate(instantMs: number): string {
  return new Date(instantMs + IST_OFFSET_MS).toISOString().slice(0, 10);
}

function istTimeLabel(iso: string): string {
  return new Date(Date.parse(iso) + IST_OFFSET_MS).toISOString().slice(11, 16);
}

function bearingDeg(from: TrailPoint, to: TrailPoint): number {
  const dy = to.latitude - from.latitude;
  const dx = to.longitude - from.longitude;
  if (dx === 0 && dy === 0) return 0;
  return (Math.atan2(dy, dx) * 180) / Math.PI;
}

function turnDegrees(a: number, b: number): number {
  const raw = Math.abs(a - b) % 360;
  return raw > 180 ? 360 - raw : raw;
}

/**
 * The labelled vertices of a day trail, in time order — first point,
 * every direction change over the threshold, last point. A straight
 * corridor yields exactly two labels; a basement wander labels each
 * real turn. Drawing (and reading) the path in time order is
 * information, not decoration (§O3 Motion).
 */
export function trailStops(points: readonly TrailPoint[]): TrailStop[] {
  if (points.length === 0) return [];
  const stops: TrailStop[] = [{ ...points[0]!, label: istTimeLabel(points[0]!.recordedAt) }];
  for (let i = 1; i < points.length - 1; i += 1) {
    const before = bearingDeg(points[i - 1]!, points[i]!);
    const after = bearingDeg(points[i]!, points[i + 1]!);
    if (turnDegrees(before, after) > DIRECTION_CHANGE_DEG) {
      stops.push({ ...points[i]!, label: istTimeLabel(points[i]!.recordedAt) });
    }
  }
  const last = points[points.length - 1]!;
  if (points.length > 1) stops.push({ ...last, label: istTimeLabel(last.recordedAt) });
  return stops;
}

/** Live window length — the console's five-minute pulse rides the same
 * constant the device's cadence revert uses, so the two windows agree. */
export const LIVE_WINDOW_MS = 5 * 60_000;

/** Is the five-minute live window of a `live` locate-now still open? */
export function liveWindowOpen(request: LocateRequest | null, nowMs: number): boolean {
  if (request === null || request.mode !== 'live') return false;
  if (request.status === 'failed' || request.status === 'expired') return false;
  return nowMs - Date.parse(request.requestedAt) < LIVE_WINDOW_MS;
}
