/**
 * Route-level wiring for the dispatcher's D1 dashboard (T2.7). The
 * screen is pure over injected data; this module is the seam that feeds
 * it — and, because the dispatcher is ONLINE-ONLY (PLAN-FRONTEND.md §4:
 * an explicit error state on every section), the
 * seam is a set of react-query reads against the api client:
 *
 * - **figures** — `GET /v1/jobs/summary`, the four figures counted
 *   server-side from `v_job_cards_dispatcher`; the client never derives
 *   a count by paging.
 * - **load + health** — `GET /v1/technicians/load` joined to
 *   `GET /v1/location/health` by employee id. The health read is the
 *   roster warning's `location.health` surface: health value and
 *   last-ping age, and NO coordinates arrive to render.
 * - **attention** — three `GET /v1/jobs` pages (overdue; unassigned;
 *   assigned today), with "past their scheduled time" judged against
 *   the injected clock. The jobs' technician names come from the load
 *   read — `GET /v1/employees` is owner-only.
 * - **offline** — `expo-network`'s reachability, unknown treated as
 *   online (a fetch that fails raises its section's error instead; a
 *   guess that the network is down must not dim live figures).
 * - **flag** — `dispatch.console` gates the screen, evaluated from
 *   `GET /v1/auth/me` like every flag (PLAN-EXECUTION.md §3).
 *
 * The mapping helpers below are pure and exported: the route composes
 * the screen's deps from them, and they are where IST "today" lives.
 */
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';

import type {
  AuthMeResponse,
  DispatcherSummary,
  FeatureFlagState,
  JobCardDispatcher,
  TechnicianLoad,
  TrackingHealth,
} from '@servgrid/shared';
import { defaultFeatureFlags } from '@servgrid/shared';
import { api } from '../../lib/api';
import { cachedFeatureFlags, setFeatureFlags } from '../../state/featureFlags';
import type {
  AttentionJob,
  AttentionSection,
  DashboardLoadRow,
  DispatcherFigure,
} from './dashboard';

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The IST business date of an instant, `YYYY-MM-DD` — the same shape
 * the api's `from`/`to` bounds and `business_date()` speak. */
export function istBusinessDate(instant: Date): string {
  return new Date(instant.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

function istParts(instant: Date): { day: number; weekday: string; month: string; hour: number; minute: number } {
  const shifted = new Date(instant.getTime() + IST_OFFSET_MS);
  const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return {
    day: shifted.getUTCDate(),
    weekday: weekdays[shifted.getUTCDay()] ?? '',
    month: months[shifted.getUTCMonth()] ?? '',
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
  };
}

/** The anatomy's header date — `Mon 6 Sep`, IST. */
export function todayLabelOf(now: Date): string {
  const p = istParts(now);
  return `${p.weekday} ${p.day} ${p.month}`;
}

function timeLabelOf(instant: string): string {
  const p = istParts(new Date(instant));
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

/** Whole IST days between the promise and now — "3 days overdue". */
function daysLate(now: Date, scheduledFor: string | null): number {
  if (scheduledFor === null) return 0;
  const promised = Date.parse(`${scheduledFor.slice(0, 10)}T00:00:00Z`);
  const today = Date.parse(`${istBusinessDate(now)}T00:00:00Z`);
  return Math.max(0, Math.round((today - promised) / DAY_MS));
}

/** The four figures in display order — OVERDUE FIRST (§D1). */
export function figuresOf(summary: DispatcherSummary): DispatcherFigure[] {
  return [
    { key: 'overdue', label: 'overdue', value: summary.overdue },
    { key: 'unassigned', label: 'unassigned', value: summary.unassigned },
    { key: 'today', label: 'today', value: summary.today },
    { key: 'done', label: 'done', value: summary.doneToday },
  ];
}

/** Load rows joined to the roster health by employee id. */
export function loadRowsOf(load: TechnicianLoad[], health: TrackingHealth[]): DashboardLoadRow[] {
  const healthBy = new Map(health.map((h) => [h.employeeId, h]));
  return load.map((row) => {
    const h = healthBy.get(row.employeeId);
    return {
      employeeId: row.employeeId,
      name: row.technicianName,
      load: row.openTotal,
      health: h === undefined ? null : { health: h.health, minutesSince: h.minutesSince },
    };
  });
}

function jobOf(now: Date, card: JobCardDispatcher, nameOf: (id: string | null) => string | null): AttentionJob {
  return {
    id: card.id,
    jobNumber: card.jobNumber,
    title: card.title,
    customerName: card.customerName,
    technician: nameOf(card.assignedTo),
    note:
      card.status === 'unassigned'
        ? card.scheduledFor === null
          ? 'no date yet'
          : `due ${timeLabelOf(card.scheduledFor)}`
        : card.isOverdue && card.scheduledFor !== null
          ? `${daysLate(now, card.scheduledFor)} ${daysLate(now, card.scheduledFor) === 1 ? 'day' : 'days'} overdue`
          : card.scheduledFor !== null
            ? `due ${timeLabelOf(card.scheduledFor)}, not set off`
            : 'not set off',
  };
}

/**
 * The three NEEDS ATTENTION sections, in the spec's order: overdue
 * jobs, then unassigned, then jobs still `assigned` past their
 * scheduled time (UI/plan-2/05-DISPATCHER.md §D1).
 */
export function sectionsOf(
  now: Date,
  overdue: JobCardDispatcher[],
  unassigned: JobCardDispatcher[],
  assignedToday: JobCardDispatcher[],
  nameOf: (id: string | null) => string | null,
): AttentionSection[] {
  const late = assignedToday.filter(
    (card) => card.status === 'assigned' && card.scheduledFor !== null && new Date(card.scheduledFor).getTime() <= now.getTime(),
  );
  return [
    { key: 'overdue', heading: 'Overdue', jobs: overdue.map((card) => jobOf(now, card, nameOf)) },
    { key: 'unassigned', heading: 'Unassigned', jobs: unassigned.map((card) => jobOf(now, card, nameOf)) },
    { key: 'late', heading: 'Assigned, not set off', jobs: late.map((card) => jobOf(now, card, nameOf)) },
  ];
}

/**
 * Reachability now lives in `lib/network.ts` — every role reads it since
 * the app went online-only (2026-09-15). Re-exported for the console
 * hooks that already import it from here.
 */
import { useIsOnline } from '../../lib/network';
export { useIsOnline };

export interface DispatcherScreenFlags {
  flagsReady: boolean;
  flagOn: boolean;
}

/** `dispatch.console` gates the screen — evaluated from `/v1/auth/me`
 * like every flag; until an answer exists it reads off (dark), and a
 * failed fetch keeps the last known answer. */
export function useDispatchConsoleFlag(): DispatcherScreenFlags {
  const cached = cachedFeatureFlags();
  const [state, setState] = useState<DispatcherScreenFlags>(() =>
    cached === null ? { flagsReady: false, flagOn: false } : { flagsReady: true, flagOn: cached['dispatch.console'] },
  );
  useEffect(() => {
    if (cachedFeatureFlags() !== null) return;
    let alive = true;
    void (async (): Promise<FeatureFlagState | null> => {
      const res = await api.request<AuthMeResponse>('GET', '/v1/auth/me');
      if (!res.ok || res.data === null) return null;
      const flags = { ...defaultFeatureFlags(), ...res.data.featureFlags };
      setFeatureFlags(flags);
      return flags;
    })()
      .then((flags) => {
        if (alive && flags !== null) setState({ flagsReady: true, flagOn: flags['dispatch.console'] });
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  return state;
}

async function fetchJson<T>(path: string): Promise<T> {
  const res = await api.request<T>('GET', path);
  if (!res.ok || res.data === null) {
    throw new Error(res.error?.message ?? 'The request did not go through. Try again.');
  }
  return res.data;
}

interface JobListEnvelope {
  items: JobCardDispatcher[];
  nextCursor: string | null;
}

export interface DispatcherDashboardData {
  offline: boolean;
  figures: DispatcherFigure[] | null;
  figuresError: string | null;
  load: DashboardLoadRow[] | null;
  loadError: string | null;
  sections: AttentionSection[] | null;
  sectionsError: string | null;
  retry: (section: 'figures' | 'load' | 'attention') => void;
  /** uuid → technician name, for attention rows (load read is the roster). */
  nameOf: (id: string | null) => string | null;
}

/** The dashboard's reads, as one hook. Each section fails alone: the
 * error the section shows is the server's message, and Retry re-runs
 * only that section's queries (§D1, States/error). */
export function useDispatcherDashboard(now: Date): DispatcherDashboardData {
  const offline = !useIsOnline();
  const today = istBusinessDate(now);

  const summary = useQuery({
    queryKey: ['dispatch', 'summary'],
    queryFn: () => fetchJson<DispatcherSummary>('/v1/jobs/summary'),
  });
  const load = useQuery({
    queryKey: ['dispatch', 'technician-load'],
    queryFn: () => fetchJson<TechnicianLoad[]>('/v1/technicians/load'),
  });
  const health = useQuery({
    queryKey: ['dispatch', 'roster-health'],
    queryFn: () => fetchJson<TrackingHealth[]>('/v1/location/health'),
  });
  const overdue = useQuery({
    queryKey: ['dispatch', 'attention', 'overdue'],
    queryFn: () => fetchJson<JobListEnvelope>('/v1/jobs?overdue=true&limit=50'),
  });
  const unassigned = useQuery({
    queryKey: ['dispatch', 'attention', 'unassigned'],
    queryFn: () => fetchJson<JobListEnvelope>('/v1/jobs?status=unassigned&limit=50'),
  });
  const assignedToday = useQuery({
    queryKey: ['dispatch', 'attention', 'assigned-today', today],
    queryFn: () =>
      fetchJson<JobListEnvelope>(
        `/v1/jobs?status=assigned&from=${encodeURIComponent(today)}&to=${encodeURIComponent(today)}&limit=200`,
      ),
  });

  const message = (error: { message: string } | null): string =>
    error?.message ?? 'This section could not be read. Try again.';

  const nameOf = (id: string | null): string | null =>
    id === null ? null : (load.data ?? []).find((row) => row.employeeId === id)?.technicianName ?? null;

  const loadRows =
    load.data === undefined || load.data === null
      ? null
      : loadRowsOf(load.data, health.data ?? []);
  const sections =
    overdue.data === undefined ||
    overdue.data === null ||
    unassigned.data === undefined ||
    unassigned.data === null ||
    assignedToday.data === undefined ||
    assignedToday.data === null
      ? null
      : sectionsOf(now, overdue.data.items, unassigned.data.items, assignedToday.data.items, nameOf);

  return {
    offline,
    figures: summary.data === undefined || summary.data === null ? null : figuresOf(summary.data),
    figuresError: summary.isError ? message(summary.error) : null,
    load: loadRows,
    loadError: load.isError || health.isError ? message(load.error ?? health.error) : null,
    sections,
    sectionsError:
      overdue.isError || unassigned.isError || assignedToday.isError
        ? message(overdue.error ?? unassigned.error ?? assignedToday.error)
        : null,
    retry: (section) => {
      if (section === 'figures') void summary.refetch();
      if (section === 'load') {
        void load.refetch();
        void health.refetch();
      }
      if (section === 'attention') {
        void overdue.refetch();
        void unassigned.refetch();
        void assignedToday.refetch();
      }
    },
    nameOf,
  };
}
