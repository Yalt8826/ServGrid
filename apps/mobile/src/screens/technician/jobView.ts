/**
 * The pure model behind the technician's Dashboard and Jobs screens
 * (T1.17, UI/plan-2/04-TECHNICIAN.md §T1, §T2). No react-native, no
 * React, no I/O — everything here takes rows and returns rows, so the
 * screens' behaviour is testable without a device and the route file
 * stays a pure seam.
 *
 * Two facts about the data shape drive every decision here:
 *
 * - **The mirror is the source** (PLAN-FRONTEND.md §4). Jobs read from
 *   SQLite joined to their customer; there is no fetch behind the
 *   figures, and no field the technician's job card does not carry —
 *   which is also why no money can appear: `JobCardTechnician` has no
 *   amount to leak (§6.3, money-free by construction).
 * - **Local truth lives in the outbox** (T1.14). A job with a
 *   `queued`/`inflight` row is *stale* (its rail state is local truth
 *   the server has not seen); a job whose newest row is `rejected`
 *   keeps its real status rail but carries the server's refusal message
 *   verbatim. Rows are never deleted, so the completion instant used
 *   for "done today" and the Completed sort reads the completion row's
 *   `created_at` — the moment the work happened on this device.
 *
 * All day arithmetic is IST (`business_date()`, migration 001): the
 * technician's "today" is Kolkata's, never the handset's timezone.
 */
import type { JobStatus } from '@servgrid/shared';
import { STATUS } from '@servgrid/shared';
import type { MirrorJob } from '../../db/mirror';
import type { OutboxRow } from '../../sync/outbox';

/** One renderable job: mirror row joined to its customer and annotated
 * with the outbox's judgement of its local edits. */
export interface JobView {
  job: MirrorJob;
  /** `customers.name` — the card's heading. */
  customerName: string;
  /** The short place line under the name (area/city), or ''. */
  area: string;
  /** Navigation target for *Navigate*: `google.navigation:q=lat,lng`. */
  coordinates: { latitude: number; longitude: number } | null;
  /** An outbox row for this job is queued or inflight — the stale inset. */
  pending: boolean;
  /** The newest rejected row's server message, verbatim — else null. */
  rejectedMessage: string | null;
  /**
   * The unit the job is for (§T3), when the mirror can name it
   * unambiguously. The technician's job-card sync contract carries no
   * `customer_product_id` (`JobCardTechnicianSchema`), so `readJobData`
   * attaches the site's unit only when the customer has exactly one —
   * never a guessed one. Absent otherwise; optional so pre-T1.18
   * constructors stay valid.
   */
  unit?: UnitView | null;
}

/** The unit line of the job detail: name, brand, serial, warranty expiry. */
export interface UnitView {
  /** Product name (with capacity label) or the free-text third-party name. */
  name: string;
  brand: string | null;
  serialNumber: string;
  /** `YYYY-MM-DD`, the mirror's `customer_products.warranty_expires_on`. */
  warrantyExpiresOn: string | null;
}

/** Statuses that are the technician's live work. */
export const ACTIVE_STATUSES: readonly JobStatus[] = ['assigned', 'en_route', 'in_progress'];

export function isActiveStatus(status: JobStatus): boolean {
  return ACTIVE_STATUSES.includes(status);
}

// ── IST day arithmetic ───────────────────────────────────────────────────────

/** `YYYY-MM-DD` in Asia/Kolkata for an instant (`en-CA` formats plain ISO). */
export function istDateKey(instant: Date | string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(
    typeof instant === 'string' ? new Date(instant) : instant,
  );
}

/** `HH:MM` in Asia/Kolkata — the card's scheduled time. */
export function istTimeLabel(iso: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso));
}

/** Time-of-day greeting for the dashboard header, judged in IST. */
export function istGreeting(now: Date): string {
  const hour = Number(
    new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', hour12: false }).format(now),
  );
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

// ── the outbox's judgement of a job ──────────────────────────────────────────

/**
 * Fold one employee's outbox rows onto their jobs: pending (queued or
 * inflight — the stale inset) and the newest rejected message. Rows are
 * read in seq order, so "newest" is the last rejection written.
 */
export function annotateWithOutbox(
  rows: readonly OutboxRow[],
  jobIdOf: (row: OutboxRow) => string | null,
): (jobId: string) => { pending: boolean; rejectedMessage: string | null } {
  const pending = new Set<string>();
  const rejected = new Map<string, string>();
  for (const row of rows) {
    const jobId = jobIdOf(row);
    if (jobId === null) continue;
    if (row.status === 'queued' || row.status === 'inflight') pending.add(jobId);
    if (row.status === 'rejected') {
      rejected.set(jobId, row.errorMessage ?? row.errorCode ?? 'The office could not accept this job.');
    }
  }
  return (jobId: string) => ({
    pending: pending.has(jobId),
    rejectedMessage: rejected.get(jobId) ?? null,
  });
}

// ── bucketing, sorting, figures ──────────────────────────────────────────────

export type JobsTab = 'today' | 'upcoming' | 'completed';

/** Which tab holds the job. `cancelled` lands nowhere — terminal and not
 * his work — unless a rejection is outstanding, in which case the job is
 * still open server-side anyway (the rejection said so) and stays in its
 * status bucket with the danger inset. */
export function bucketOf(view: JobView, todayKey: string): JobsTab | null {
  const { status, scheduledFor } = view.job;
  if (status === 'completed') return 'completed';
  if (!isActiveStatus(status)) return null;
  if (scheduledFor === null) return 'today'; // actionable now; sorts last
  const day = istDateKey(scheduledFor);
  if (day <= todayKey) return 'today'; // carry-over: yesterday's unfinished work is today's
  return 'upcoming';
}

/** An open job whose slot has passed. A job with no slot is never overdue. */
export function isOverdue(view: JobView, now: Date): boolean {
  return (
    isActiveStatus(view.job.status) &&
    view.job.scheduledFor !== null &&
    new Date(view.job.scheduledFor).getTime() < now.getTime()
  );
}

function byScheduledAsc(a: JobView, b: JobView): number {
  const ai = a.job.scheduledFor === null ? Infinity : new Date(a.job.scheduledFor).getTime();
  const bi = b.job.scheduledFor === null ? Infinity : new Date(b.job.scheduledFor).getTime();
  if (ai !== bi) return ai - bi;
  return a.job.jobNumber.localeCompare(b.job.jobNumber);
}

/** Today's order (§T2): overdue first, then `scheduled_for` ascending.
 * Jobs with no slot come last, in job-number order. */
export function sortForToday(views: readonly JobView[], now: Date): JobView[] {
  return [...views].sort((a, b) => {
    const overdueA = isOverdue(a, now) ? 0 : 1;
    const overdueB = isOverdue(b, now) ? 0 : 1;
    if (overdueA !== overdueB) return overdueA - overdueB;
    return byScheduledAsc(a, b);
  });
}

/** Upcoming: `scheduled_for` ascending. */
export function sortForUpcoming(views: readonly JobView[]): JobView[] {
  return [...views].sort(byScheduledAsc);
}

/**
 * The instant a completion happened on this device, from the completion
 * row the optimistic write enqueued (rows are kept forever). Jobs the
 * office closed have no local row — they sort by their slot, honestly
 * undated, at the end.
 */
export function completedAtOf(view: JobView, completedAtById: Readonly<Record<string, string>>): string | null {
  return completedAtById[view.job.id] ?? view.job.scheduledFor;
}

/** Completed: newest first (§T2 `completed_at` descending; local
 * completion instant standing in for it — see `completedAtOf`). */
export function sortForCompleted(
  views: readonly JobView[],
  completedAtById: Readonly<Record<string, string>>,
): JobView[] {
  return [...views].sort((a, b) => {
    const ai = completedAtOf(a, completedAtById);
    const bi = completedAtOf(b, completedAtById);
    const at = ai === null ? -Infinity : new Date(ai).getTime();
    const bt = bi === null ? -Infinity : new Date(bi).getTime();
    if (at !== bt) return bt - at;
    return b.job.jobNumber.localeCompare(a.job.jobNumber);
  });
}

/** The three dashboard figures — and only three (§T1): today's open,
 * done today, overdue. "Today's open" includes yesterday's unfinished
 * carry-over (it is work he must do today); "overdue" counts open jobs
 * whose slot has passed. */
export function dashboardFigures(
  views: readonly JobView[],
  completedAtById: Readonly<Record<string, string>>,
  now: Date,
): { open: number; doneToday: number; overdue: number } {
  const todayKey = istDateKey(now);
  let open = 0;
  let doneToday = 0;
  let overdue = 0;
  for (const view of views) {
    if (isActiveStatus(view.job.status)) {
      if (bucketOf(view, todayKey) === 'today') open += 1;
      if (isOverdue(view, now)) overdue += 1;
    }
    if (view.job.status === 'completed') {
      const at = completedAtById[view.job.id];
      // A local completion row dates the work; an office-closed job with
      // only a slot falls back to it — scheduled today, done today.
      if ((at !== undefined && istDateKey(at) === todayKey) || (at === undefined && view.job.scheduledFor !== null && istDateKey(view.job.scheduledFor) === todayKey)) {
        doneToday += 1;
      }
    }
  }
  return { open, doneToday, overdue };
}

/** NEXT — the single next job: the first of today's sort. */
export function nextJobOf(views: readonly JobView[], now: Date): JobView | null {
  const todayKey = istDateKey(now);
  const today = views.filter((v) => bucketOf(v, todayKey) === 'today');
  return sortForToday(today, now)[0] ?? null;
}

/** LATER TODAY — today's work after NEXT, as compact rows. */
export function laterTodayOf(views: readonly JobView[], now: Date): JobView[] {
  const todayKey = istDateKey(now);
  const today = views.filter((v) => bucketOf(v, todayKey) === 'today');
  return sortForToday(today, now).slice(1);
}

// ── tab list assembly ────────────────────────────────────────────────────────

export interface TabSection {
  today: JobView[];
  upcoming: JobView[];
  completed: JobView[];
}

export function tabSections(
  views: readonly JobView[],
  completedAtById: Readonly<Record<string, string>>,
  now: Date,
): TabSection {
  const todayKey = istDateKey(now);
  const today: JobView[] = [];
  const upcoming: JobView[] = [];
  const completed: JobView[] = [];
  for (const view of views) {
    const bucket = bucketOf(view, todayKey);
    if (bucket === 'today') today.push(view);
    else if (bucket === 'upcoming') upcoming.push(view);
    else if (bucket === 'completed') completed.push(view);
  }
  return {
    today: sortForToday(today, now),
    upcoming: sortForUpcoming(upcoming),
    completed: sortForCompleted(completed, completedAtById),
  };
}

// ── search (§T2: only when the tab holds more than 12) ──────────────────────

/** A tab shows its search field from 13 jobs up. */
export const SEARCH_THRESHOLD = 12;

export function needsSearch(count: number): boolean {
  return count > SEARCH_THRESHOLD;
}

/** Case-insensitive match over customer, area, job number and title. */
export function matchesSearch(view: JobView, rawQuery: string): boolean {
  const query = rawQuery.trim().toLowerCase();
  if (query === '') return true;
  return (
    view.customerName.toLowerCase().includes(query) ||
    view.area.toLowerCase().includes(query) ||
    view.job.jobNumber.toLowerCase().includes(query) ||
    view.job.title.toLowerCase().includes(query)
  );
}

// ── presentation helpers ─────────────────────────────────────────────────────

/** The status pill: word + colour — never colour alone (§X7). */
export function statusPillOf(status: JobStatus): { label: string; color: string } {
  switch (status) {
    case 'unassigned':
      return { label: 'Unassigned', color: STATUS.unassigned };
    case 'assigned':
      return { label: 'Assigned', color: STATUS.unassigned };
    case 'en_route':
      return { label: 'En route', color: STATUS.en_route };
    case 'in_progress':
      return { label: 'In progress', color: STATUS.in_progress };
    case 'completed':
      return { label: 'Completed', color: STATUS.completed };
    case 'cancelled':
      return { label: 'Cancelled', color: STATUS.cancelled };
  }
}

/** The card's leading rail colour — the card's real status, kept under
 * the rejected inset (§T2: the rail is not repainted red). `assigned`
 * shares `unassigned`'s slate: it is the "waiting" colour on both. */
export function railColorOf(status: JobStatus): string {
  return status === 'assigned' ? STATUS.unassigned : STATUS[status];
}

/** The primary action's label on the NEXT card: where the job stands
 * decides the verb (§T1: *Start job* / *Arrive*). */
export function primaryActionOf(status: JobStatus): { label: string; to: JobStatus } | null {
  switch (status) {
    case 'assigned':
      return { label: 'Start job', to: 'en_route' };
    case 'en_route':
      return { label: 'Arrive', to: 'in_progress' };
    default:
      // Completed, cancelled: nothing to start. `in_progress` opens the
      // detail (its stepper owns advancing to complete) — no local move.
      return null;
  }
}

/** The optimistic status move: the mirror's UPDATE plus the outbox row
 * the route enqueues. `occurredAt` is the device instant of the tap. */
export function statusChangeOp(
  jobId: string,
  to: JobStatus,
  now: Date,
): { path: string; body: { to: JobStatus; occurredAt: string } } {
  return { path: `/v1/jobs/${jobId}/status`, body: { to, occurredAt: now.toISOString() } };
}
