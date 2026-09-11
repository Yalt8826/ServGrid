/**
 * The pure model behind the T3 job detail screen (T1.18,
 * UI/plan-2/04-TECHNICIAN.md §T3, 03-COMPONENTS.md `StatusStepper`).
 * No react-native, no React — the same division as `jobView.ts`: the
 * screen renders what these functions decide, and the tests run the
 * decisions without a device.
 *
 * Three decisions live here:
 *
 * - **The stepper's shape** (`stepperStateOf`): four nodes — Assigned →
 *   En route → In progress → Completed. A skipped `en_route` renders
 *   dimmed-but-present, never removed (a technician who went straight
 *   to work sees he skipped a step, not a stepper that changed shape).
 *   Cancelled is a fifth rendering, not a fifth node: the line freezes
 *   at the node the job reached and a terminal cap carries the word.
 * - **The timeline** (`timelineForJob`): §T3 reads `job_events`, which
 *   the technician's sync contract does not carry. What this device
 *   DOES have is its own outbox — every optimistic op it queued, in
 *   seq order, each stamped with the instant the tap happened
 *   (`occurred_at` for status moves). The section renders that local
 *   truth and says so; the office's history arrives with sync.
 * - **The chips** (`warrantyChipOf`, `detailContractChipOf`): the
 *   warranty chip carries the expiry date, and the contract chip leads
 *   with **prepaid** when the billing is upfront — the load-bearing
 *   word (§T3, §T4).
 */
import type { JobStatus } from '@servgrid/shared';

import type { OutboxRow } from '../../sync/outbox';
import { operationBodyOf } from '../../sync/outbox';
import { istDateKey, istTimeLabel, statusPillOf, type JobView, type UnitView } from './jobView';

// ── the stepper's shape ──────────────────────────────────────────────────────

/** The four positions on the line, in walk order (§T3 anatomy). */
export const STEPPER_NODES = [
  { key: 'assigned', label: 'Assigned' },
  { key: 'en_route', label: 'En route' },
  { key: 'in_progress', label: 'In progress' },
  { key: 'completed', label: 'Completed' },
] as const;

export type StepperNodeKey = (typeof STEPPER_NODES)[number]['key'];

/** Where a status sits on the line. `unassigned` never reaches a
 * technician's screen but maps to the first node if it did; `cancelled`
 * is never read here — its freeze point comes from the history. */
const NODE_INDEX: Record<JobStatus, number> = {
  unassigned: 0,
  assigned: 0,
  en_route: 1,
  in_progress: 2,
  completed: 3,
  cancelled: 0,
};

export interface StepperNode {
  key: StepperNodeKey;
  label: string;
  /** The job stood on this node (it fills in the node's colour). */
  reached: boolean;
  /** The node the job sits at — the ringed one. */
  current: boolean;
  /** Skipped `en_route`: rendered dimmed-but-present, never removed. */
  dimmed: boolean;
}

export interface StepperModel {
  nodes: StepperNode[];
  /** Index of the node the job sits at (0–3; the freeze point). */
  reachedIndex: number;
  /** Cancelled: a frozen line plus a terminal cap, never an animation. */
  cancelled: boolean;
}

/**
 * The stepper's rendering for a status, given the statuses this device
 * has recorded for the job (`statusHistoryOf`).
 *
 * `en_route` is skippable (`PLAN-BACKEND.md` §6.1: `assigned →
 * in_progress` is legal). A job standing at In progress or Completed
 * whose history never passed through En route renders that node dimmed
 * (0.4, and its word in the disabled ink) — present, so the shape never
 * changes, dimmed, so the skip is visible.
 *
 * A cancelled job freezes at the furthest node its history proves — the
 * frozen position IS the information (`cancelled after arriving` and
 * `cancelled before setting off` are different events). Without local
 * history the freeze is at Assigned: "before setting off" is the honest
 * default, and the office's `job_events` will refine it when they sync.
 */
export function stepperStateOf(status: JobStatus, localHistory: readonly JobStatus[] = []): StepperModel {
  if (status === 'cancelled') {
    let reachedIndex = 0;
    for (const past of localHistory) {
      if (past !== 'cancelled') reachedIndex = Math.max(reachedIndex, NODE_INDEX[past]);
    }
    const nodes: StepperNode[] = STEPPER_NODES.map((node, i) => ({
      key: node.key,
      label: node.label,
      reached: i <= reachedIndex,
      current: i === reachedIndex,
      dimmed: false,
    }));
    return { nodes, reachedIndex, cancelled: true };
  }

  const reachedIndex = NODE_INDEX[status];
  const skippedEnRoute = reachedIndex >= NODE_INDEX.in_progress && !localHistory.includes('en_route');
  const nodes: StepperNode[] = STEPPER_NODES.map((node, i) => {
    const dimmed = node.key === 'en_route' && skippedEnRoute;
    return {
      key: node.key,
      label: node.label,
      reached: i <= reachedIndex && !dimmed,
      current: i === reachedIndex && !dimmed,
      dimmed,
    };
  });
  return { nodes, reachedIndex, cancelled: false };
}

// ── the timeline, from this device's outbox ──────────────────────────────────

/** One line of the detail's timeline: what happened, and the instant of
 * the tap — `occurred_at` for status moves, the enqueue instant for the
 * rest (the honest local approximation, `PLAN-DATA-MODEL.md` §3.4). */
export interface JobTimelineEntry {
  /** The outbox row's id — stable list key. */
  id: string;
  /** The status word, or `Completed` / `Cancelled` for the closers. */
  label: string;
  /** ISO instant the event happened on this device. */
  at: string;
  /** The status the move went to, when the event was a status move. */
  to: JobStatus | null;
}

interface StatusOpBody {
  to?: unknown;
  occurredAt?: unknown;
}

/** Fold one outbox row into a timeline entry, or null when the row is
 * not this job's (or not a human-visible event at all). */
export function timelineEntryOf(row: OutboxRow): JobTimelineEntry | null {
  if (row.entityType !== 'job') return null;
  if (row.path.endsWith('/status')) {
    const body = (operationBodyOf(row) ?? {}) as StatusOpBody;
    if (typeof body.to !== 'string') return null;
    const to = body.to as JobStatus;
    return {
      id: row.id,
      label: statusPillOf(to).label,
      at: typeof body.occurredAt === 'string' ? body.occurredAt : row.createdAt,
      to,
    };
  }
  if (row.path.endsWith('/completions')) {
    return { id: row.id, label: statusPillOf('completed').label, at: row.createdAt, to: 'completed' };
  }
  if (row.path.endsWith('/cancellations')) {
    return { id: row.id, label: statusPillOf('cancelled').label, at: row.createdAt, to: 'cancelled' };
  }
  return null;
}

/** This device's events for one job, in the order they were queued. */
export function timelineForJob(rows: readonly OutboxRow[], jobId: string): JobTimelineEntry[] {
  const entries: JobTimelineEntry[] = [];
  for (const row of rows) {
    if (row.entityLocalId !== jobId) continue;
    const entry = timelineEntryOf(row);
    if (entry !== null) entries.push(entry);
  }
  return entries;
}

/** Every job's events in one pass — the route feeds screens from this
 * instead of re-walking the outbox per navigation. */
export function timelineByJob(rows: readonly OutboxRow[]): Record<string, JobTimelineEntry[]> {
  const byJob: Record<string, JobTimelineEntry[]> = {};
  for (const row of rows) {
    const entry = timelineEntryOf(row);
    if (entry === null) continue;
    (byJob[row.entityLocalId] ??= []).push(entry);
  }
  return byJob;
}

/**
 * The statuses this device recorded for the job, in order — the input
 * `stepperStateOf` reads to detect a skipped `en_route` and to place a
 * cancelled job's freeze point.
 */
export function statusHistoryOf(entries: readonly JobTimelineEntry[]): JobStatus[] {
  const history: JobStatus[] = [];
  for (const entry of entries) {
    if (entry.to !== null) history.push(entry.to);
  }
  return history;
}

// ── the chips ────────────────────────────────────────────────────────────────

/**
 * The warranty chip — carries the expiry date (§T3 worst moment: deciding
 * whether this unit is under warranty in a basement). `YYYY-MM-DD`
 * compares lexically against today's IST key. Forward-looking reads
 * `In warranty · to 14 Mar 2027`; an expired warranty still names its
 * date — "Warranty to 14 Mar 2026" — because the date is the fact.
 */
export function warrantyChipOf(unit: UnitView | null | undefined, now: Date): string | null {
  const expiry = unit?.warrantyExpiresOn ?? null;
  if (expiry === null) return null;
  const day = new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${expiry}T00:00:00Z`));
  return expiry >= istDateKey(now) ? `In warranty · to ${day}` : `Warranty to ${day}`;
}

/**
 * The contract chip, detail edition. The word **prepaid** is the
 * load-bearing part (§T3): an upfront-billed contract visit is the one
 * where the complete sheet will show no amount field at all, and the
 * technician must be able to see that BEFORE he opens the sheet.
 */
export function detailContractChipOf(contract: JobView['job']['contract']): string | null {
  if (contract === null) return null;
  const visits = `${contract.visitsRemaining} visit${contract.visitsRemaining === 1 ? '' : 's'} left`;
  const prepaid = contract.billing === 'upfront' ? ' · prepaid' : '';
  return `${contract.number} · ${visits}${prepaid}`;
}

// ── labels ───────────────────────────────────────────────────────────────────

/** A timeline stamp: `D MMM · HH:MM`, IST (§6: relative stops at 1h, and
 * a timeline outlives an hour). */
export function timelineTimeLabel(iso: string): string {
  const day = new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    timeZone: 'Asia/Kolkata',
  }).format(new Date(iso));
  return `${day} · ${istTimeLabel(iso)}`;
}

/** The closed thumb bar's line (§T3 Closed state): `Completed 16:42`. */
export function closedLineOf(status: JobStatus, at: string | null): string {
  const word = statusPillOf(status).label;
  return at === null ? word : `${word} ${istTimeLabel(at)}`;
}
