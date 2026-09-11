/**
 * T1.22 spike model — the pure filter/sort behind the Job Logs
 * prototype (UI/plan-2/05-DISPATCHER.md §D2). No React, no native —
 * everything takes rows and returns rows so the timing harness can
 * measure exactly the work a filter tap triggers.
 *
 * The D2 decisions encoded here:
 *
 * - **Overdue is a filter, not a status** — it rides the status chip as
 *   an option, never a rail colour, and **sorts first** in every result
 *   (`PLAN-FRONTEND.md` §9: "Overdue is a filter chip and sorts first").
 * - **Three chips: date, technician, status** + a clear affordance.
 * - Terminal work (completed/cancelled) is never overdue.
 * - Day arithmetic is IST (`business_date()`), as everywhere else.
 *
 * Filter change re-sorts **without animation** (§D2 Motion): the list
 * simply is the new rows. That is free here — nothing animates.
 */
import { TERMINAL_JOB_STATUSES, type JobStatus } from '@servgrid/shared';

import { istDateKey, type SpikeJob } from './mockJobs';

/** Date chip. `week` = today and the next six IST days. */
export type DateFilter = 'today' | 'tomorrow' | 'week' | 'all';

/** Technician chip: anyone, the unassigned queue, or one name. */
export type TechFilter =
  | { kind: 'anyone' }
  | { kind: 'unassigned' }
  | { kind: 'tech'; name: string };

/** Status chip. `overdue` is the filter option that is not a status. */
export type StatusFilter = 'any' | 'overdue' | JobStatus;

export interface JobLogsFilters {
  date: DateFilter;
  tech: TechFilter;
  status: StatusFilter;
}

/** [Today ▾][Anyone ▾][Any status ▾] — the bar's resting state. */
export const DEFAULT_FILTERS: JobLogsFilters = {
  date: 'today',
  tech: { kind: 'anyone' },
  status: 'any',
};

export function filtersAreDefault(f: JobLogsFilters): boolean {
  return f.date === DEFAULT_FILTERS.date && f.tech.kind === 'anyone' && f.status === 'any';
}

/** An open job whose slot has passed. Terminal work is never overdue. */
export function isOverdue(job: SpikeJob, now: Date): boolean {
  if ((TERMINAL_JOB_STATUSES as readonly string[]).includes(job.status)) return false;
  return new Date(job.scheduledFor).getTime() < now.getTime();
}

/** The IST day keys a date filter accepts, computed ONCE per filter
 * pass (not per job). null = the `all` filter — every day passes. */
function dateTargets(date: DateFilter, now: Date): Set<string> | null {
  if (date === 'all') return null;
  if (date === 'today') return new Set([istDateKey(now)]);
  if (date === 'tomorrow') return new Set([istDateKey(new Date(now.getTime() + 86_400_000))]);
  // week: today through +6 IST days.
  const keys = new Set<string>();
  for (let i = 0; i < 7; i += 1) keys.add(istDateKey(new Date(now.getTime() + i * 86_400_000)));
  return keys;
}

function matchesTech(job: SpikeJob, tech: TechFilter): boolean {
  if (tech.kind === 'anyone') return true;
  if (tech.kind === 'unassigned') return job.technician === null;
  return job.technician === tech.name;
}

/**
 * Filter + sort in one pass-of-two: the exact work one chip tap does at
 * 220 rows. Overdue first, then `scheduledFor` ascending, job number as
 * the tiebreak so the order is total and stable.
 */
export function applyFilters(jobs: readonly SpikeJob[], f: JobLogsFilters, now: Date): SpikeJob[] {
  const targets = dateTargets(f.date, now);
  const hit: SpikeJob[] = [];
  for (const job of jobs) {
    if (targets !== null && !targets.has(istDateKey(job.scheduledFor))) continue;
    if (!matchesTech(job, f.tech)) continue;
    if (f.status === 'overdue') {
      if (!isOverdue(job, now)) continue;
    } else if (f.status !== 'any' && job.status !== f.status) {
      continue;
    }
    hit.push(job);
  }
  return hit.sort((a, b) => {
    const oa = isOverdue(a, now) ? 0 : 1;
    const ob = isOverdue(b, now) ? 0 : 1;
    // Overdue first, then by slot — the D2 rule, nothing more.
    if (oa !== ob) return oa - ob;
    const ta = new Date(a.scheduledFor).getTime();
    const tb = new Date(b.scheduledFor).getTime();
    if (ta !== tb) return ta - tb;
    return a.jobNumber < b.jobNumber ? -1 : 1;
  });
}

/**
 * Search mode (§D2): a full-screen takeover over **job number, customer,
 * phone and area** — not technician, not title; the chips own those.
 * Runs against the already-date-filtered set, so "today" still scopes a
 * search. Case-insensitive substring; phones match on digits alone.
 */
export function matchesSearch(job: SpikeJob, rawQuery: string): boolean {
  const q = rawQuery.trim().toLowerCase();
  if (q === '') return true;
  const digits = q.replace(/\D/g, '');
  if (digits.length >= 3 && job.contactPhone.replace(/\D/g, '').includes(digits)) return true;
  return (
    job.jobNumber.toLowerCase().includes(q) ||
    job.customerName.toLowerCase().includes(q) ||
    job.area.toLowerCase().includes(q)
  );
}

/** Overdue count for the result line, computed once per filter change. */
export function countOverdue(jobs: readonly SpikeJob[], now: Date): number {
  let n = 0;
  for (const job of jobs) if (isOverdue(job, now)) n += 1;
  return n;
}

/** The always-visible result line (§D2): `24 jobs · 3 overdue`. */
export function formatResultCount(shown: number, overdue: number): string {
  if (overdue === 0) return `${shown} jobs`;
  return `${shown} jobs · ${overdue} overdue`;
}
