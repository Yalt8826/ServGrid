/**
 * Job Logs filter model (T2.8, UI/plan-2/05-DISPATCHER.md §D2) — the
 * pure half of the screen: filter types, the URL codec, the
 * `GET /v1/jobs` query builder, the D2 sort and the result-count line.
 * No React, no fetch — the route composes these with the api client and
 * the tests drive them directly.
 *
 * The D2 decisions encoded here:
 *
 * - **Filter state lives in the URL** — a filtered view survives a
 *   reload and can be shared. The codec is total: a stale or hand-edited
 *   param degrades to the resting view, never a crash.
 * - **Three chips: date, technician, status**; overdue is a status-chip
 *   OPTION, never a status (PLAN-DATA-MODEL.md §3.4) — it rides the
 *   server's own `overdue=true` and the card's `isOverdue` flag, so the
 *   list and the dashboard figure cannot disagree.
 * - Day arithmetic is IST (`business_date()`), as everywhere else.
 * - Overdue sorts first, then by slot, job number as the tiebreak — the
 *   order the prototype gate timed (T1.22), kept verbatim.
 */
import { JOB_STATUSES, type JobStatus } from '@servgrid/shared';

const DAY_MS = 24 * 60 * 60 * 1000;
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** Date chip. `week` = today and the next six IST days. */
export type JobLogsDateFilter = 'today' | 'tomorrow' | 'week' | 'all';

/**
 * Technician chip: anyone, or one named technician. The URL carries the
 * UUID (the api's `technicianId`); the chip label resolves the name from
 * the roster read, falling back to "Technician" for an unknown id.
 */
export type JobLogsTechFilter = { kind: 'anyone' } | { kind: 'tech'; technicianId: string; name: string };

/** Status chip. `overdue` is the filter option that is not a status. */
export type JobLogsStatusFilter = 'any' | 'overdue' | JobStatus;

export interface JobLogsFilters {
  date: JobLogsDateFilter;
  tech: JobLogsTechFilter;
  status: JobLogsStatusFilter;
}

/** [Today ▾][Anyone ▾][Any status ▾] — the bar's resting state. */
export const DEFAULT_JOB_LOGS_FILTERS: JobLogsFilters = {
  date: 'today',
  tech: { kind: 'anyone' },
  status: 'any',
};

/** The search mode's text rides the URL too — a shared link carries it. */
export const JOB_LOGS_SEARCH_PARAM = 'q';

/** expo-router params arrive as `string | string[] | undefined`. */
export type JobLogsParams = Record<string, string | string[] | undefined>;

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** The IST business date of an instant, `YYYY-MM-DD` — the shape the
 * api's `from`/`to` bounds and `business_date()` speak. */
export function istBusinessDateKey(instant: Date): string {
  return new Date(instant.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

export function jobLogsFiltersAreDefault(f: JobLogsFilters): boolean {
  return f.date === DEFAULT_JOB_LOGS_FILTERS.date && f.tech.kind === 'anyone' && f.status === 'any';
}

/**
 * filters + search text → URL params. Defaults are OMITTED, so the
 * resting URL stays clean and a shared link carries exactly the delta
 * the dispatcher set — `?status=overdue` reads as "overdue", not as a
 * restatement of the defaults.
 */
export function jobLogsFiltersToParams(filters: JobLogsFilters, query: string): Record<string, string> {
  const params: Record<string, string> = {};
  if (filters.date !== DEFAULT_JOB_LOGS_FILTERS.date) params.date = filters.date;
  if (filters.tech.kind === 'tech') params.tech = filters.tech.technicianId;
  if (filters.status !== 'any') params.status = filters.status;
  const q = query.trim();
  if (q !== '') params[JOB_LOGS_SEARCH_PARAM] = q;
  return params;
}

/**
 * The patch `router.setParams` should be given: the codec's delta with
 * every key it left out spelled `undefined`.
 *
 * `setParams` MERGES into the params already in the URL, and the codec
 * above omits a filter that is back at its default — so the old value
 * stayed in the URL and the screen read it straight back. Clear was a
 * dead button: `?date=all` survived every press (found on the handset,
 * 2026-09-17). Naming the defaults `undefined` makes the merge DELETE
 * them, which keeps both halves: the resting URL stays clean, and a
 * filter can come off again.
 *
 * (A `router.replace` of the rebuilt href fixes Clear the same way, but
 * it re-resolves the route on every keystroke and the search field — a
 * controlled input fed by the params — silently drops characters. A/B on
 * the handset: `replace` typed "A" of "AMC", `setParams` typed all of it.)
 */
export function jobLogsParamsPatch(filters: JobLogsFilters, query: string): Record<string, string | undefined> {
  const delta = jobLogsFiltersToParams(filters, query);
  return {
    date: delta.date,
    tech: delta.tech,
    status: delta.status,
    [JOB_LOGS_SEARCH_PARAM]: delta[JOB_LOGS_SEARCH_PARAM],
  };
}

const DATE_VALUES: readonly JobLogsDateFilter[] = ['today', 'tomorrow', 'week', 'all'];
const STATUS_VALUES: readonly JobLogsStatusFilter[] = ['any', 'overdue', ...JOB_STATUSES];

/**
 * URL params → filters + search text. Total by construction: anything
 * the codec did not write (a hand-typed value, a param from an older
 * build) reads as the default, because a filter URL this app did not
 * mint is a stale link, not a crash.
 */
export function jobLogsFiltersFromParams(params: JobLogsParams): { filters: JobLogsFilters; query: string } {
  const filters: JobLogsFilters = { ...DEFAULT_JOB_LOGS_FILTERS, tech: { kind: 'anyone' } };

  const date = firstParam(params.date);
  if (date !== undefined && (DATE_VALUES as readonly string[]).includes(date)) {
    filters.date = date as JobLogsDateFilter;
  }
  const tech = firstParam(params.tech);
  if (tech !== undefined && tech !== 'anyone') {
    // The name is not in the URL — the chip label resolves it from the
    // roster read; an id the roster does not know still filters (the api
    // answers the empty set it deserves) and reads as "Technician".
    filters.tech = { kind: 'tech', technicianId: tech, name: '' };
  }
  const status = firstParam(params.status);
  if (status !== undefined && (STATUS_VALUES as readonly string[]).includes(status)) {
    filters.status = status as JobLogsStatusFilter;
  }
  const query = firstParam(params[JOB_LOGS_SEARCH_PARAM]) ?? '';
  return { filters, query };
}

/**
 * The `GET /v1/jobs` query string the current view reads — every filter
 * translated to what the server already implements (§6.3), so filtering
 * happens against the whole roster volume, never a truncated page:
 *
 * - date → inclusive `from`/`to` IST business dates (`week` spans today
 *   through +6; `all` sends neither);
 * - technician → `technicianId`;
 * - status option `overdue` → `overdue=true`; a real status → `status=`;
 * - search mode's text → `q` (the api searches job number, customer and
 *   phone — the dispatcher card carries no area to search).
 *
 * `limit`/`cursor` stay the route's business (pagination, not filters).
 */
export function jobLogsListQuery(filters: JobLogsFilters, query: string, now: Date): string {
  const params = new URLSearchParams();
  if (filters.date !== 'all') {
    const today = istBusinessDateKey(now);
    if (filters.date === 'today') {
      params.set('from', today);
      params.set('to', today);
    } else if (filters.date === 'tomorrow') {
      const tomorrow = istBusinessDateKey(new Date(now.getTime() + DAY_MS));
      params.set('from', tomorrow);
      params.set('to', tomorrow);
    } else {
      params.set('from', today);
      params.set('to', istBusinessDateKey(new Date(now.getTime() + 6 * DAY_MS)));
    }
  }
  if (filters.tech.kind === 'tech') params.set('technicianId', filters.tech.technicianId);
  if (filters.status === 'overdue') {
    params.set('overdue', 'true');
  } else if (filters.status !== 'any') {
    params.set('status', filters.status);
  }
  const q = query.trim();
  if (q !== '') params.set('q', q.slice(0, 100));
  return params.toString();
}

/** The chip's resting label — `Today`, `Anyone`, `Any status`. */
export function jobLogsChipLabel(
  key: 'date' | 'tech' | 'status',
  filters: JobLogsFilters,
  technicianNameOf: (technicianId: string) => string | null,
): string {
  if (key === 'date') return DATE_LABELS[filters.date];
  if (key === 'tech') {
    // "Unassigned" is reachable from the person chip as well as the status
    // one (2026-09-17) — both describe the same fact, so the chip reads
    // the status rather than keeping a second copy of it.
    if (filters.status === 'unassigned') return 'Unassigned';
    if (filters.tech.kind === 'anyone') return 'Anyone';
    return technicianNameOf(filters.tech.technicianId) ?? 'Technician';
  }
  if (filters.status === 'any') return 'Any status';
  return STATUS_LABELS[filters.status];
}

const DATE_LABELS: Record<JobLogsDateFilter, string> = {
  today: 'Today',
  tomorrow: 'Tomorrow',
  week: 'This week',
  all: 'All days',
};

/** The status words, one map for the chip label and the screen's sheet —
 * they were two verbatim copies in one directory until 2026-09-17. */
export const STATUS_LABELS: Record<JobLogsStatusFilter, string> = {
  any: 'Any status',
  overdue: 'Overdue',
  unassigned: 'Unassigned',
  assigned: 'Assigned',
  en_route: 'En route',
  in_progress: 'In progress',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

/** One row of the list — the route's card read, already named. */
export interface JobLogsJob {
  id: string;
  jobNumber: string;
  title: string;
  customerName: string;
  status: JobStatus;
  /** The VIEW's `is_overdue` (server-judged) — a filter, not a status. */
  overdue: boolean;
  scheduledFor: string | null;
  /** Resolved from the roster read; null when the job is unassigned. */
  technicianName: string | null;
}

/**
 * The D2 order, kept verbatim from the prototype gate: overdue first,
 * then by slot ascending, job number as the tiebreak so the order is
 * total and stable. Applied over the loaded page — the server owns the
 * page's membership, the screen owns the scan order.
 */
export function sortJobLogs(jobs: readonly JobLogsJob[]): JobLogsJob[] {
  return [...jobs].sort((a, b) => {
    if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;
    const ta = a.scheduledFor === null ? Number.POSITIVE_INFINITY : Date.parse(a.scheduledFor);
    const tb = b.scheduledFor === null ? Number.POSITIVE_INFINITY : Date.parse(b.scheduledFor);
    if (ta !== tb) return ta - tb;
    if (a.jobNumber !== b.jobNumber) return a.jobNumber < b.jobNumber ? -1 : 1;
    return 0;
  });
}

/** Overdue count for the result line, one pass over the shown rows. */
export function countOverdueRows(jobs: readonly JobLogsJob[]): number {
  let n = 0;
  for (const job of jobs) if (job.overdue) n += 1;
  return n;
}

/** The always-visible result line (§D2): `24 jobs · 3 overdue`. */
export function formatResultCount(shown: number, overdue: number): string {
  const noun = `${shown} ${shown === 1 ? 'job' : 'jobs'}`;
  if (overdue === 0) return noun;
  return `${noun} · ${overdue} overdue`;
}

/** `JC-2627-00044` → `JC-…0044` — the anatomy's short form. */
export function shortJobNumber(jobNumber: string): string {
  if (jobNumber === '') return 'a selected job';
  return `JC-…${jobNumber.slice(-4)}`;
}
